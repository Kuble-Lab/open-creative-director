'use strict';

// Tests for the node "Burn in captions" (video.captions): the definition and its checks (pure), the way it reaches ffmpeg (a stand-in
// binary records the call and the caption script), and - only when this ffmpeg has libass - the picture. The lyrics are invented.
// A machine without libass runs everything except the picture and says so.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const store = require('../lib/store');
const ffmpeg = require('../lib/ffmpeg');
const captions = require('../lib/captions-ass');
const ops = require('../lib/nodes/ffmpeg-ops');
const edit = require('../lib/nodes/nodes-edit');
const { createRegistry } = require('../lib/nodes/registry');
const { createEditHarness } = require('./support/edit-harness');
const { createFakeFfmpeg } = require('./support/fake-ffmpeg');

const restorers = [];
function withEnv(name, value) {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restorers.push(() => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  });
}
function restoreAll() {
  while (restorers.length) restorers.pop()();
  ffmpeg.resetFilterCache();
}

const SONG = {
  version: 1,
  source: 'align',
  duration: 30,
  words: [
    { text: 'Copper', start: 1.0, end: 1.5, line: 0 },
    { text: 'kites', start: 1.5, end: 2.0, line: 0 },
    { text: 'over', start: 2.0, end: 2.5, line: 0 },
    { text: 'the', start: 2.5, end: 2.8, line: 0 },
    { text: 'bay', start: 2.8, end: 4.0, line: 0 }
  ],
  lines: [{ text: 'Copper kites over the bay', start: 1.0, end: 4.0 }]
};
const SONG_TEXT = JSON.stringify(SONG);
const INSTRUMENTAL = JSON.stringify({ version: 1, source: 'align', duration: 30, words: [], lines: [] });

const text = (value) => ({ type: 'text', value });

const probeOf = (width, height, { audio = { codec: 'aac' } } = {}) => ({ video: { codec: 'h264', width, height, fps: 25 }, audio, duration: 5 });

/* ---------- definition and builder ---------- */

function testDefinition() {
  const registry = createRegistry();
  edit.registerAll(registry);
  const node = registry.get('video.captions');
  assert.ok(node, 'the node is registered');
  assert.equal(node.category, 'edit-video');
  assert.equal(node.paid, false);
  assert.equal(node.cost.unit, 'local');
  assert.deepEqual(node.inputs.map((port) => [port.id, port.type, port.required === true]), [['video', 'video', true], ['timing', 'text', true]]);
  assert.deepEqual(node.outputs.map((port) => [port.id, port.type]), [['video', 'video']]);
  assert.deepEqual(registry.paramDefaults(node), {
    style: 'karaoke',
    position: 'bottom',
    text_size: 0,
    color: '#ffffff',
    highlight_color: '#ffd400',
    outline_color: '#000000',
    outline: 8,
    font: 'dejavu-sans',
    uppercase: false,
    offset: 0
  });
  assert.deepEqual(registry.checkParams(node, registry.paramDefaults(node)), []);
  for (const bad of [{ style: 'blink' }, { position: 'left' }, { font: 'comic' }]) {
    assert.ok(registry.checkParams(node, { ...registry.paramDefaults(node), ...bad }).length > 0, `${JSON.stringify(bad)} is refused`);
  }
  // numbers are brought into their range
  const limited = registry.normalizeParams(node, { text_size: 40, offset: 9999, outline: -5 });
  assert.deepEqual([limited.text_size, limited.offset, limited.outline], [15, 600, 0]);
  assert.equal(registry.normalizeParams(node, { outline: 900 }).outline, 25, 'the outline has an upper bound too');
  assert.equal(registry.normalizeParams(node, { offset: -9999 }).offset, -600);
  assert.deepEqual(node.params.find((param) => param.id === 'style').options, ['karaoke', 'words', 'lines']);
  assert.deepEqual(node.params.find((param) => param.id === 'position').options, ['bottom', 'middle', 'top']);
  assert.ok(node.params.find((param) => param.id === 'font').options.includes('liberation-sans'));
  assert.ok(node.keywords.length >= 3);

  // checks before the run
  const issues = (raw) => node.validate(registry.normalizeParams(node, raw), {}) || [];
  const noLibass = (list) => list.filter((issue) => issue && issue.code === 'CAPTIONS_NO_LIBASS');
  const hasLibass = ffmpeg.hasFilter('ass');
  assert.equal(noLibass(issues({})).length, hasLibass || !ffmpeg.binaries().available ? 0 : 1, 'refused when ffmpeg has no libass');
  assert.match(issues({ color: 'red' }).find((issue) => typeof issue === 'string'), /hex colour/);
  assert.match(issues({ highlight_color: 'x' }).find((issue) => typeof issue === 'string'), /highlight_color/);
  assert.match(issues({ outline_color: 'x' }).find((issue) => typeof issue === 'string'), /outline_color/);

  // the op spec
  const spec = ops.buildCaptions({}, [probeOf(320, 180)], { assFile: '/tmp/x/captions.ass', events: 3 });
  assert.equal(spec.graph, '[0:v]ass=filename=/tmp/x/captions.ass[out]');
  assert.deepEqual(spec.outputs[0].maps, ['[out]', '0:a?']);
  assert.equal(spec.outputs[0].audioCopy, true, 'AAC sound is passed on as it is');
  assert.equal(ops.buildCaptions({}, [probeOf(320, 180, { audio: { codec: 'vorbis' } })], { assFile: '/tmp/x/c.ass', events: 1 }).outputs[0].audioCopy, false);
  assert.equal(ops.buildCaptions({}, [probeOf(320, 180, { audio: null })], { assFile: '/tmp/x/c.ass', events: 1 }).outputs[0].audioCopy, false);
  const args = ops.assembleArgs(spec, ['/in.mp4'], ['/out.mp4']);
  assert.ok(args.includes('-filter_complex') && args.includes('libx264'));
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
  // nothing to show: the video passes through
  const through = ops.buildCaptions({}, [probeOf(320, 180)], { assFile: '/tmp/x/c.ass', events: 0 });
  assert.equal(through.graph, null);
  assert.equal(through.outputs[0].copyAll, true);
  assert.ok(ops.assembleArgs(through, ['/in.mp4'], ['/out.mp4']).includes('copy'));
  assert.throws(() => ops.buildCaptions({}, [{ video: null, audio: null }], { assFile: '/tmp/x/c.ass' }), /no image/);
}

/* ---------- availability ---------- */

async function testAvailability(h) {
  const registry = h.registry;
  const node = h.def('video.captions');
  const withAss = await createFakeFfmpeg(h.dir, { filters: ['ass'], name: 'ffmpeg-with-ass' });
  const withoutAss = await createFakeFfmpeg(h.dir, { filters: [], name: 'ffmpeg-without-ass' });
  try {
    withEnv('FFMPEG_PATH', withAss.file);
    ffmpeg.resetFilterCache();
    assert.equal(registry.availability(node), true);
    assert.equal(edit.libassAvailable(), true);
    assert.deepEqual((node.validate(h.params('video.captions'), {}) || []).filter((issue) => issue.code), []);
    // the other editing nodes do not care about libass
    assert.equal(registry.availability(h.def('video.soundwave')), true);

    withEnv('FFMPEG_PATH', withoutAss.file);
    ffmpeg.resetFilterCache();
    assert.equal(registry.availability(node), edit.LIBASS_REASON, 'unavailable, with the reason the interface translates');
    assert.equal(edit.LIBASS_REASON, 'ffmpeg has no libass (filter "ass")');
    assert.equal(registry.availability(h.def('video.soundwave')), true);
    assert.equal(registry.availability(h.def('video.trim')), true);
    const issues = node.validate(h.params('video.captions'), {});
    assert.deepEqual(
      issues.filter((issue) => issue.code).map((issue) => issue.code),
      ['CAPTIONS_NO_LIBASS'],
      'a run is refused before anything starts'
    );
    assert.match(issues.find((issue) => issue.code).message, /libass/);

    withEnv('FFMPEG_PATH', '/definitely/not/here/ffmpeg');
    ffmpeg.resetFilterCache();
    assert.match(registry.availability(node), /ffmpeg\/ffprobe not found/, 'no ffmpeg at all: the plain reason');
    assert.deepEqual((node.validate(h.params('video.captions'), {}) || []).filter((issue) => issue.code), [], 'one reason is enough');
  } finally {
    restoreAll();
  }
}

/* ---------- the way to ffmpeg ---------- */

async function testWiring(h) {
  await h.ff(['-f', 'lavfi', '-i', 'color=c=0x000000:s=320x180:r=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', h.src('clip.mp4')]);
  await h.ff(['-f', 'lavfi', '-i', 'color=c=0x000000:s=180x320:r=25', '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', h.src('portrait.mp4')]);
  const clip = await h.upload('clip.mp4', '.mp4');
  const portrait = await h.upload('portrait.mp4', '.mp4');
  const fake = await createFakeFfmpeg(h.dir, { filters: ['ass'], name: 'ffmpeg-record' });
  const noAss = await createFakeFfmpeg(h.dir, { filters: [], name: 'ffmpeg-record-no-ass' });
  try {
    withEnv('FFMPEG_PATH', fake.file);
    ffmpeg.resetFilterCache();

    // the call: the script of the size of the video in the filter, the sound copied
    const out = await h.run('video.captions', { video: clip, timing: text(SONG_TEXT) }, { style: 'karaoke', position: 'top', color: '#112233', highlight_color: '#aabbcc', uppercase: true, offset: 2 });
    assert.equal(out.video.type, 'video');
    const [call] = await fake.calls();
    assert.ok(call, 'ffmpeg was called');
    assert.match(call.graph, /^\[0:v\]ass=filename=.*captions\.ass\[out\]$/);
    assert.ok(call.argv.includes('-c:a') && call.argv[call.argv.indexOf('-c:a') + 1] === 'copy', 'the sound is copied');
    assert.deepEqual(call.argv.slice(call.argv.indexOf('-map'), call.argv.indexOf('-map') + 4), ['-map', '[out]', '-map', '0:a?']);
    assert.ok(call.ass, `the script was there when ffmpeg ran: ${call.assError}`);
    assert.match(call.assFile, /captions\.ass$/);
    // the script: size of the video, the style and position, the shift
    assert.match(call.ass, /PlayResX: 320\nPlayResY: 180\n/);
    assert.match(call.ass, /Style: Default,DejaVu Sans,11,&H00CCBBAA,&H00332211,/, '6 % of 180 = 11, highlight is the primary colour of a karaoke line');
    assert.match(call.ass, /,8,16,16,11,1\n/, 'aligned to the top');
    assert.match(call.ass, /Dialogue: 0,0:00:02\.60,0:00:05\.00,Default,,0,0,0,,\{\\k40\\kf50\}COPPER /, '1.0 + 2 s shift - 0.4 lead-in = 2.6; the line would end at 6.4, the film (5 s) ends first');
    // the scratch folder, and the script in it, are gone
    const names = await fsp.readdir(store.sessionAssetDir(h.sessionId));
    assert.deepEqual(names.filter((name) => name.startsWith('.')), [], 'scratch directory removed');
    await assert.rejects(fsp.stat(call.assFile), /ENOENT/);

    // the size of the video is the size of the script
    await fake.reset();
    await h.run('video.captions', { video: portrait, timing: text(SONG_TEXT) }, { style: 'lines', text_size: 10 });
    const [tall] = await fake.calls();
    assert.match(tall.ass, /PlayResX: 180\nPlayResY: 320\n/);
    assert.match(tall.ass, /Style: Default,DejaVu Sans,32,/, '10 % of 320');
    assert.match(tall.ass, /,2,9,9,19,1\n/, 'bottom, margins of the picture');

    // a duration limit: the film is 5 s long, lines after it are not written
    await fake.reset();
    const late = JSON.stringify({ version: 1, lines: [{ text: 'in time', start: 1, end: 2 }, { text: 'too late', start: 9, end: 10 }] });
    await h.run('video.captions', { video: clip, timing: text(late) }, { style: 'lines' });
    const [limited] = await fake.calls();
    assert.equal((limited.ass.match(/^Dialogue:/gm) || []).length, 1);
    assert.ok(!limited.ass.includes('too late'));

    // a timing without anything to sing: the video passes through, no filter, no libass needed
    await fake.reset();
    const passed = await h.run('video.captions', { video: clip, timing: text(INSTRUMENTAL) }, {});
    const [copy] = await fake.calls();
    assert.equal(copy.graph, undefined, 'no filter graph');
    assert.ok(copy.argv.includes('copy'));
    assert.ok(!copy.argv.some((arg) => String(arg).includes('ass=')));
    assert.equal(passed.video.type, 'video');

    // a timing that cannot be read
    await fake.reset();
    for (const bad of ['', 'not json', '{"lines": "x"}', '[]']) {
      await assert.rejects(h.run('video.captions', { video: clip, timing: text(bad) }, {}), (err) => err.code === 'CAPTIONS_TIMING_INVALID', JSON.stringify(bad));
    }
    assert.deepEqual(await fake.calls(), [], 'ffmpeg was not started for them');

    // an ffmpeg without libass: nothing is started
    withEnv('FFMPEG_PATH', noAss.file);
    ffmpeg.resetFilterCache();
    await assert.rejects(h.run('video.captions', { video: clip, timing: text(SONG_TEXT) }, {}), (err) => err.code === 'CAPTIONS_NO_LIBASS' && /libass/.test(err.message));
    assert.deepEqual(await noAss.calls(), [], 'no process was started');
    const names2 = await fsp.readdir(store.sessionAssetDir(h.sessionId));
    assert.deepEqual(names2.filter((name) => name.startsWith('.')), [], 'scratch directory removed after the refusal');
    // ... but a video that has nothing to burn in passes through even then
    await h.run('video.captions', { video: clip, timing: text(INSTRUMENTAL) }, {});
    assert.equal((await noAss.calls()).length, 1);
  } finally {
    restoreAll();
  }
}

/* ---------- the picture (needs libass) ---------- */

async function testPicture(h) {
  if (!ffmpeg.hasFilter('ass')) {
    console.log('SKIP picture: this ffmpeg has no libass (filter "ass"); the call to ffmpeg and the script were checked, the burnt-in picture was not');
    return;
  }
  const W = 320;
  const H = 180;
  await h.ff(['-f', 'lavfi', '-i', `color=c=0x000000:s=${W}x${H}:r=25`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '14', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', h.src('black.mp4')]);
  const black = await h.upload('black.mp4', '.mp4');
  const source = await h.probe(h.src('black.mp4'));
  const timing = JSON.stringify({ version: 1, lines: [{ text: 'MMMMMM MMMMMM', start: 2, end: 10, words: [{ text: 'MMMMMM', start: 2, end: 6 }, { text: 'MMMMMM', start: 6, end: 10 }] }] });
  const white = (r, g, b) => r > 200 && g > 200 && b > 200;
  const yellow = (r, g, b) => r > 200 && g > 150 && g < 245 && b < 90;
  const whole = { x0: 0, y0: 0, x1: W, y1: H };
  const upper = { x0: 0, y0: 0, x1: W, y1: H / 2 };

  // a font must exist, or libass draws nothing at all
  const probe = await h.run('video.captions', { video: black, timing: text(JSON.stringify({ version: 1, lines: [{ text: 'MMMM MMMM', start: 1, end: 3 }] })) }, { style: 'lines', text_size: 15 });
  const probeFrame = await h.frame(await h.fileOf(probe.video), 2, W, H);
  if (h.count(probeFrame, W, whole, white) < 50) {
    console.log('SKIP picture: libass found no font on this machine, it draws nothing even for a plain script');
    return;
  }

  for (const position of ['bottom', 'top']) {
    const out = await h.run('video.captions', { video: black, timing: text(timing) }, { style: 'karaoke', position, text_size: 12 });
    const file = await h.fileOf(out.video);
    const info = await h.probe(file);
    assert.deepEqual([info.width, info.height], [W, H]);
    assert.ok(Math.abs(info.duration - source.duration) < 0.15, 'same length');
    assert.equal(info.audioCodec, 'aac', 'the sound is still there');
    assert.ok(Math.abs(info.audioDuration - source.audioDuration) < 0.1);
    const frames = {};
    for (const time of [0.5, 1.8, 6, 10.1, 11.5]) frames[time] = await h.frame(file, time, W, H);
    const count = (time, test) => h.count(frames[time], W, whole, test);
    assert.equal(count(0.5, white) + count(0.5, yellow), 0, `${position}: nothing before the line comes`);
    assert.ok(count(1.8, white) > 40 && count(1.8, yellow) === 0, `${position}: the line stands in the base colour`);
    assert.ok(count(6, white) > 40 && count(6, yellow) > 40, `${position}: the first word is filled, the second is not`);
    assert.ok(count(10.1, yellow) > count(6, yellow) && count(10.1, white) < count(6, white), `${position}: both words are filled at the end`);
    assert.equal(count(11.5, white) + count(11.5, yellow), 0, `${position}: gone after the hold`);
    const inUpper = h.count(frames[6], W, upper, white) + h.count(frames[6], W, upper, yellow);
    const total = count(6, white) + count(6, yellow);
    if (position === 'top') assert.ok(inUpper > total * 0.9, 'at the top');
    else assert.ok(inUpper < total * 0.1, 'at the bottom');
  }
  // the words come one after the other in the style "words"
  {
    const out = await h.run('video.captions', { video: black, timing: text(timing) }, { style: 'words', text_size: 12 });
    const file = await h.fileOf(out.video);
    const first = await h.frame(file, 4, W, H);
    const second = await h.frame(file, 8, W, H);
    assert.ok(h.count(first, W, whole, yellow) > 40 && h.count(first, W, whole, white) > 40, 'one word lit, the other not');
    assert.ok(h.count(second, W, whole, yellow) > 40 && h.count(second, W, whole, white) > 40);
  }
}

async function main() {
  testDefinition();
  if (!ffmpeg.binaries().available) {
    console.log('SKIP ffmpeg is missing (only the definition was tested)');
    console.log('test-nodes-video-captions.js: ok');
    return;
  }
  const h = await createEditHarness({ prefix: 'ocd-captions-node-' });
  try {
    await testAvailability(h);
    await testWiring(h);
    await testPicture(h);
  } finally {
    restoreAll();
    await h.cleanup();
  }
  console.log('test-nodes-video-captions.js: ok');
}

main().catch((err) => {
  restoreAll();
  console.error(err);
  process.exit(1);
});
