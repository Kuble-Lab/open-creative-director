'use strict';

// Tests for the node "Sound wave" (video.soundwave): the filter graph (pure) and a run on clips made with lavfi - length, sound, picture
// size, and that pixels of the wave colour appear in the area of the wave and nowhere else. Local and free: no network, no provider.

const assert = require('assert/strict');
const ffmpeg = require('../lib/ffmpeg');
const ops = require('../lib/nodes/ffmpeg-ops');
const edit = require('../lib/nodes/nodes-edit');
const { createRegistry } = require('../lib/nodes/registry');
const { createEditHarness } = require('./support/edit-harness');

const probeOf = (width, height, { audio = { codec: 'aac' }, fps = 25, duration = 3 } = {}) => ({
  video: { codec: 'h264', width, height, fps },
  audio,
  duration
});
const audioOnly = (duration = 5) => ({ video: null, audio: { codec: 'pcm_s16le' }, duration });

/* ---------- the graph ---------- */

function testGraph() {
  const registry = createRegistry();
  edit.registerAll(registry);
  const wave = registry.get('video.soundwave');
  assert.ok(wave, 'the node is registered');
  assert.equal(wave.category, 'edit-video');
  assert.equal(wave.paid, false);
  assert.equal(wave.cost.unit, 'local');
  assert.deepEqual(wave.inputs.map((port) => [port.id, port.type, Boolean(port.required)]), [['video', 'video', true], ['audio', 'audio', false]]);
  assert.deepEqual(wave.outputs.map((port) => [port.id, port.type]), [['video', 'video']]);
  assert.deepEqual(registry.paramDefaults(wave), { mode: 'cline', position: 'bottom', height: 20, color: '#ffffff', opacity: 1 });
  assert.deepEqual(registry.checkParams(wave, registry.paramDefaults(wave)), []);
  assert.deepEqual(ops.WAVE_MODES, ['line', 'p2p', 'cline', 'point', 'bars']);
  assert.deepEqual(ops.WAVE_POSITIONS, ['bottom', 'middle', 'top']);
  assert.ok(registry.checkParams(wave, { ...registry.paramDefaults(wave), mode: 'zigzag' }).length > 0, 'an unknown mode is refused');
  assert.ok(wave.keywords.length >= 3, 'search words');
  assert.equal(typeof registry.publicDescriptor(wave).available, registry.publicDescriptor(wave).available === true ? 'boolean' : 'string');

  const build = (raw, infos) => ops.buildSoundwave({ mode: 'cline', position: 'bottom', height: 20, color: '#ffffff', opacity: 1, ...raw }, infos);
  const base = [probeOf(320, 180)];

  // the shapes of the filter showwaves, and the bars of showfreqs
  for (const mode of ['line', 'p2p', 'cline', 'point']) {
    const spec = build({ mode }, base);
    assert.match(spec.graph, new RegExp(`showwaves=s=320x36:mode=${mode}:rate=25:`), mode);
    assert.ok(!spec.graph.includes('showfreqs'));
  }
  const bars = build({ mode: 'bars' }, base);
  assert.match(bars.graph, /showfreqs=s=320x36:mode=bar:rate=25:/);
  assert.ok(!bars.graph.includes('showwaves'));

  // size and place: height in % of the picture (even), as wide as the picture; 4 % from the edge at the top and the bottom
  assert.match(build({}, base).graph, /overlay=x=0:y=136:/, 'bottom: 180 - 36 - 8');
  assert.match(build({ position: 'top' }, base).graph, /overlay=x=0:y=8:/);
  assert.match(build({ position: 'middle' }, base).graph, /overlay=x=0:y=72:/, '(180 - 36) / 2');
  assert.match(build({ height: 50 }, base).graph, /s=320x90:/);
  assert.match(build({ height: 50 }, base).graph, /y=82:/, '180 - 90 - 8');
  assert.match(build({ height: 100 }, base).graph, /s=320x180:.*y=0:/, 'the whole picture');
  assert.match(build({ height: 100, position: 'top' }, base).graph, /y=0:/);
  assert.match(build({ height: 2 }, base).graph, /s=320x16:/, 'never thinner than 16 pixels');
  assert.match(build({}, [probeOf(1280, 720)]).graph, /showwaves=s=1280x144:.*y=546:/, '20 % of 720, 4 % margin rounded to even');
  assert.match(build({}, [probeOf(1281, 721)]).graph, /s=1282x144:/, 'even sizes only');
  assert.match(build({}, [probeOf(320, 180, { fps: 30 })]).graph, /rate=30:/, 'the wave moves at the frame rate of the video');
  assert.match(build({}, [probeOf(320, 180, { fps: null })]).graph, /rate=25:/);

  // colour and opacity
  assert.match(build({ color: '#ff8800' }, base).graph, /colors=0xff8800\[w\]/);
  assert.ok(!build({}, base).graph.includes('colorchannelmixer'), 'full opacity: no extra step');
  assert.match(build({ opacity: 0.4 }, base).graph, /format=rgba,colorchannelmixer=aa=0\.4\[w\]/);

  // sound: from the video, else from the audio input; the video keeps its own sound
  const own = build({}, base);
  assert.match(own.graph, /^\[0:a:0\]aformat=channel_layouts=mono,showwaves/);
  assert.deepEqual(own.outputs[0].maps, ['[out]', '0:a:0']);
  assert.equal(own.outputs[0].audioCopy, true, 'AAC goes into the MP4 as it is');
  assert.equal(build({}, [probeOf(320, 180, { audio: { codec: 'vorbis' } })]).outputs[0].audioCopy, false, 'what MP4 does not take is encoded');
  const other = build({}, [probeOf(320, 180), audioOnly()]);
  assert.match(other.graph, /^\[1:a:0\]aformat=channel_layouts=mono,showwaves/, 'the wave of the audio input');
  assert.deepEqual(other.outputs[0].maps, ['[out]', '0:a:0'], 'the sound stays the sound of the video');
  assert.deepEqual(other.outputs[0].args, []);
  const silent = build({}, [probeOf(320, 180, { audio: null }), audioOnly()]);
  assert.match(silent.graph, /^\[1:a:0\]asplit=2\[snd0\]\[src\];\[snd0\]apad\[snd\];\[src\]aformat=channel_layouts=mono,showwaves/);
  assert.deepEqual(silent.outputs[0].maps, ['[out]', '[snd]'], 'a video without sound gets the audio input as its sound');
  assert.deepEqual(silent.outputs[0].args, ['-shortest']);
  assert.equal(silent.outputs[0].audioCopy, false);

  assert.throws(() => build({}, [probeOf(320, 180, { audio: null })]), /no sound/);
  assert.throws(() => build({}, [probeOf(320, 180), { video: null, audio: null }]), /no audio/);
  assert.throws(() => build({ mode: 'zigzag' }, base), /Unknown wave mode/);
  assert.throws(() => build({ position: 'left' }, base), /Unknown wave position/);
  assert.throws(() => build({}, [{ video: null, audio: { codec: 'aac' } }]), /no image/);

  // the whole argument list
  const args = ops.assembleArgs(own, ['/v.mp4'], ['/out.mp4']);
  assert.deepEqual(args.slice(0, 5), ['-nostdin', '-v', 'error', '-y', '-i']);
  assert.ok(args.includes('-filter_complex') && args.includes('-c:a') && args[args.indexOf('-c:a') + 1] === 'copy');
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4), ['-map', '[out]', '-map', '0:a:0']);

  // checks before a run
  const issues = (raw) => wave.validate(registry.normalizeParams(wave, raw), {}) || [];
  assert.deepEqual(issues({}), []);
  assert.match(issues({ color: 'red' })[0], /hex colour/);
}

/* ---------- a run on real clips ---------- */

const isRed = (r, g, b) => r > 170 && g < 100 && b < 100;
const isReddish = (r, g, b) => r > g + 40 && r > b + 40;

async function testRuns() {
  const h = await createEditHarness({ prefix: 'ocd-wave-' });
  try {
    const W = 320;
    const H = 180;
    // a dark blue background (no red in it); a loud 220 Hz tone with a slow swell, so there is something to draw all the time
    const tone = 'aevalsrc=0.9*sin(2*PI*220*t)*(0.7+0.3*sin(2*PI*1.5*t)):s=44100:d=3';
    await h.ff(['-f', 'lavfi', '-i', `color=c=0x203050:s=${W}x${H}:r=25`, '-f', 'lavfi', '-i', tone, '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', h.src('with-sound.mp4')]);
    await h.ff(['-f', 'lavfi', '-i', `color=c=0x203050:s=${W}x${H}:r=25`, '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', h.src('silent.mp4')]);
    await h.ff(['-f', 'lavfi', '-i', 'aevalsrc=0.9*sin(2*PI*330*t):s=44100:d=5', '-c:a', 'pcm_s16le', h.src('long.wav')]);
    await h.ff(['-f', 'lavfi', '-i', 'aevalsrc=0.9*sin(2*PI*330*t):s=44100:d=1', '-c:a', 'pcm_s16le', h.src('short.wav')]);
    const withSound = await h.upload('with-sound.mp4', '.mp4');
    const silent = await h.upload('silent.mp4', '.mp4');
    const longAudio = await h.upload('long.wav', '.wav');
    const shortAudio = await h.upload('short.wav', '.wav');
    assert.equal(withSound.type, 'video');
    assert.equal(longAudio.type, 'audio');

    const source = await h.probe(h.src('with-sound.mp4'));
    // the area of a wave of the default height (20 % = 36 pixels) with 8 pixels to the edge; the test looks 3 pixels beyond it
    const AREA = {
      bottom: { y0: 136, y1: 172 },
      middle: { y0: 72, y1: 108 },
      top: { y0: 8, y1: 44 }
    };
    const inside = (position) => ({ x0: 0, x1: W, ...AREA[position] });
    const outside = (position) => [
      { x0: 0, x1: W, y0: 0, y1: Math.max(0, AREA[position].y0 - 3) },
      { x0: 0, x1: W, y0: Math.min(H, AREA[position].y1 + 3), y1: H }
    ];

    // every shape, at every place: length, sound, size, and the colour of the wave only in its area
    for (const mode of ['line', 'p2p', 'cline', 'point', 'bars']) {
      for (const position of mode === 'cline' || mode === 'bars' ? ['bottom', 'middle', 'top'] : ['bottom']) {
        const out = await h.run('video.soundwave', { video: withSound }, { mode, position, color: '#ff0000' });
        assert.equal(out.video.type, 'video');
        const file = await h.fileOf(out.video);
        const probe = await h.probe(file);
        const label = `${mode} ${position}`;
        assert.deepEqual([probe.width, probe.height], [W, H], `${label}: same picture size`);
        assert.ok(Math.abs(probe.duration - source.duration) < 0.15, `${label}: same length (${probe.duration} vs ${source.duration})`);
        assert.equal(probe.hasAudio, true, `${label}: the sound stays`);
        assert.equal(probe.audioCodec, 'aac');
        assert.equal(probe.sampleRate, source.sampleRate);
        assert.ok(Math.abs(probe.audioDuration - source.audioDuration) < 0.1, `${label}: sound as long as before`);
        // the picture with the wave at a moment in the middle of the clip
        const frame = await h.frame(file, 1.2, W, H);
        const red = h.count(frame, W, inside(position), isRed);
        assert.ok(red >= (mode === 'bars' ? 20 : 80), `${label}: ${red} pixels of the wave colour in the area of the wave`);
        for (const area of outside(position)) assert.equal(h.count(frame, W, area, isReddish), 0, `${label}: nothing of the wave outside its area`);
        // the same moment of the source has none
        const plain = await h.frame(await h.fileOf(withSound), 1.2, W, H);
        assert.equal(h.count(plain, W, { x0: 0, y0: 0, x1: W, y1: H }, isReddish), 0, 'the source has no red');
      }
    }

    // height: half of the picture
    {
      const out = await h.run('video.soundwave', { video: withSound }, { mode: 'line', position: 'bottom', height: 50, color: '#ff0000' });
      const frame = await h.frame(await h.fileOf(out.video), 1.2, W, H);
      const lower = h.count(frame, W, { x0: 0, y0: 82, x1: W, y1: 172 }, isRed);
      const upper = h.count(frame, W, { x0: 0, y0: 0, x1: W, y1: 79 }, isReddish);
      assert.ok(lower > 400, `a taller wave fills more of the picture (${lower})`);
      assert.equal(upper, 0);
    }

    // opacity: the colour is mixed with the background
    {
      const out = await h.run('video.soundwave', { video: withSound }, { mode: 'line', position: 'bottom', color: '#ff0000', opacity: 0.5 });
      const frame = await h.frame(await h.fileOf(out.video), 1.2, W, H);
      assert.equal(h.count(frame, W, inside('bottom'), isRed), 0, 'no pixel in the pure colour');
      const mixed = h.count(frame, W, inside('bottom'), (r, g, b) => r > 100 && r < 190 && g < 90 && b < 110);
      assert.ok(mixed > 100, `${mixed} pixels of the colour mixed with the background`);
    }

    // the colour is the colour that was asked for
    {
      const out = await h.run('video.soundwave', { video: withSound }, { mode: 'line', color: '#00ff00' });
      const frame = await h.frame(await h.fileOf(out.video), 1.2, W, H);
      assert.ok(h.count(frame, W, inside('bottom'), (r, g, b) => g > 170 && r < 100 && b < 100) > 80);
    }

    // the wave moves: two moments of the clip look different
    {
      const out = await h.run('video.soundwave', { video: withSound }, { mode: 'cline', color: '#ff0000' });
      const file = await h.fileOf(out.video);
      const a = await h.frame(file, 0.4, W, H);
      const b = await h.frame(file, 1.05, W, H);
      let differ = 0;
      for (let at = 0; at < a.length; at += 1) if (a[at] !== b[at]) differ += 1;
      assert.ok(differ > 200, 'the wave changes from one moment to the next');
    }

    // a wave from an audio input; the video has its own sound, which stays
    {
      const out = await h.run('video.soundwave', { video: withSound, audio: longAudio }, { mode: 'line', color: '#ff0000' });
      const file = await h.fileOf(out.video);
      const probe = await h.probe(file);
      assert.ok(Math.abs(probe.duration - source.duration) < 0.15, 'the length of the video, not of the longer audio');
      assert.equal(probe.audioCodec, 'aac');
      assert.ok(Math.abs(probe.audioDuration - source.audioDuration) < 0.1);
      assert.ok(h.count(await h.frame(file, 1.2, W, H), W, inside('bottom'), isRed) > 80);
    }

    // a video without sound takes the sound of the audio input, as long as the video
    for (const [label, audio, expected] of [['longer audio', longAudio, 3], ['shorter audio', shortAudio, 3]]) {
      const out = await h.run('video.soundwave', { video: silent, audio }, { mode: 'line', color: '#ff0000' });
      const file = await h.fileOf(out.video);
      const probe = await h.probe(file);
      assert.equal(probe.hasAudio, true, `${label}: the silent video has sound now`);
      assert.equal(probe.audioCodec, 'aac');
      assert.ok(Math.abs(probe.duration - expected) < 0.15, `${label}: ${probe.duration} s, the length of the video`);
      assert.ok(Math.abs(probe.videoDuration - expected) < 0.1, `${label}: the picture keeps its length`);
      assert.ok(Math.abs(probe.width - W) === 0 && probe.height === H);
      assert.ok(h.count(await h.frame(file, 0.5, W, H), W, inside('bottom'), isRed) > 80, `${label}: wave while the audio plays`);
      if (audio === shortAudio) {
        assert.equal(h.count(await h.frame(file, 2.4, W, H), W, { x0: 0, y0: 0, x1: W, y1: H }, isReddish), 0, 'no wave after the short audio is over');
      }
    }

    // nothing to draw the wave from
    await assert.rejects(h.run('video.soundwave', { video: silent }, {}), /no sound/);
    // a bad colour is caught before the run, not by ffmpeg
    assert.match((h.def('video.soundwave').validate(h.params('video.soundwave', { color: 'nope' }), {}) || [])[0], /hex colour/);
  } finally {
    await h.cleanup();
  }
}

async function main() {
  testGraph();
  if (!ffmpeg.binaries().available) {
    console.log('SKIP ffmpeg is missing (only the filter graph was tested)');
  } else {
    await testRuns();
  }
  console.log('test-nodes-video-soundwave.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
