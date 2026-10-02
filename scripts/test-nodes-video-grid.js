'use strict';

// video.grid (WP28 part 3): two to four videos on one canvas. The layout is a pure function of the probes (planVideoGrid):
// arrangements, which side is made equal, gap, size limit. The rest runs on real ffmpeg output from small videos made with
// lavfi in this test: 2, 3 and 4 videos, mixed sizes and aspect ratios, the labels (drawn with resvg), the length (the longest
// video keeps its last frame on screen, or the shortest decides) and the sound (none, or the first video). Also the checks of
// the node (count, colour), the texts of the page in German, English and Spanish and a run through the engine. No provider is
// contacted. The ffmpeg part is skipped when ffmpeg/ffprobe are missing.

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFile } = require('child_process');
const { promisify } = require('util');

const store = require('../lib/store');
const ffmpeg = require('../lib/ffmpeg');
const ops = require('../lib/nodes/ffmpeg-ops');
const edit = require('../lib/nodes/nodes-edit');
const assets = require('../lib/nodes/assets');
const nodesBasic = require('../lib/nodes/nodes-basic');
const { createRegistry } = require('../lib/nodes/registry');
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
const { createEngine } = require('../lib/nodes/engine');

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '..');

const registry = createRegistry();
nodesBasic.registerAll(registry);
edit.registerAll(registry);

const def = registry.get('video.grid');
assert.ok(def, 'video.grid is registered');
const params = (raw = {}) => registry.normalizeParams(def, raw);

const probeOf = (width, height, extra = {}) => ({
  video: { codec: 'h264', width, height, fps: 25 },
  audio: null,
  duration: 2,
  ...extra
});

/* ---------- registry ---------- */

function testRegistry() {
  assert.equal(def.category, 'edit-video');
  assert.equal(def.paid, false);
  assert.equal(def.cost.unit, 'local');
  assert.deepEqual(
    def.inputs.map((port) => [port.id, port.type, Boolean(port.multiple), port.min || null, port.max || null, port.param || null]),
    [
      ['videos', 'video', true, 2, 4, null],
      ['labels', 'text', false, null, null, 'labels']
    ]
  );
  assert.equal(def.inputs[0].required, true);
  assert.deepEqual(def.outputs.map((port) => [port.id, port.type]), [['video', 'video']]);
  assert.deepEqual(
    def.params.map((param) => param.id),
    ['layout', 'length', 'audio', 'labels', 'label_position', 'font_size', 'match', 'size', 'gap', 'background']
  );
  assert.deepEqual(params(), {
    layout: 'auto',
    length: 'longest',
    audio: 'none',
    labels: '',
    label_position: 'bottom',
    font_size: 0,
    match: 'auto',
    size: 0,
    gap: 0,
    background: '#000000'
  });
  assert.deepEqual(def.params.find((param) => param.id === 'layout').options, ['auto', 'side_by_side', 'stacked', 'grid']);
  assert.deepEqual(def.params.find((param) => param.id === 'length').options, ['longest', 'shortest']);
  assert.deepEqual(def.params.find((param) => param.id === 'audio').options, ['none', 'first_video']);
  assert.equal(registry.checkParams(def, params({ layout: 'row' })).length, 1, 'an unknown layout is reported');

  // the count and the colour
  const issues = (raw, count) => def.validate(params(raw), { videos: { connected: count > 0, count } });
  assert.deepEqual(issues({}, 2), []);
  assert.deepEqual(issues({}, 4), []);
  assert.deepEqual(issues({}, 0), [], 'no connection is reported as a missing input by the engine');
  const one = issues({}, 1);
  assert.equal(one.length, 1);
  assert.equal(one[0].code, 'grid_videos');
  assert.equal(one[0].port, 'videos');
  assert.deepEqual(one[0].data, { min: 2, max: 4, count: 1 });
  assert.equal(issues({}, 5)[0].code, 'grid_videos');
  assert.equal(issues({ background: 'red' }, 2).length, 1);
  assert.equal(def.available() === true || typeof def.available() === 'string', true);
}

/* ---------- the layout ---------- */

function testPlan() {
  const landscape = probeOf(160, 90);
  const portrait = probeOf(90, 160);
  const wide = probeOf(200, 100);
  const cellsOf = (plan) => plan.cells.map((cell) => [cell.x, cell.y, cell.w, cell.h]);

  // two and three videos: next to each other, one height
  let plan = ops.planVideoGrid(params(), [landscape, landscape]);
  assert.equal(plan.layout, 'side_by_side');
  assert.deepEqual([plan.width, plan.height, plan.cols, plan.rows], [320, 90, 2, 1]);
  assert.deepEqual(cellsOf(plan), [[0, 0, 160, 90], [160, 0, 160, 90]]);
  plan = ops.planVideoGrid(params(), [landscape, landscape, landscape]);
  assert.deepEqual([plan.layout, plan.width, plan.height], ['side_by_side', 480, 90]);

  // four videos: 2 x 2
  plan = ops.planVideoGrid(params(), [landscape, landscape, landscape, landscape]);
  assert.deepEqual([plan.layout, plan.cols, plan.rows, plan.width, plan.height], ['grid', 2, 2, 320, 180]);
  assert.deepEqual(cellsOf(plan), [[0, 0, 160, 90], [160, 0, 160, 90], [0, 90, 160, 90], [160, 90, 160, 90]]);
  // three videos in a 2 x 2 grid leave the last place empty (the background shows)
  plan = ops.planVideoGrid(params({ layout: 'grid' }), [landscape, landscape, landscape]);
  assert.deepEqual([plan.cols, plan.rows, plan.width, plan.height], [2, 2, 320, 180]);
  assert.deepEqual(cellsOf(plan)[2], [0, 90, 160, 90]);
  // two videos in "2 x 2" are one row
  plan = ops.planVideoGrid(params({ layout: 'grid' }), [landscape, landscape]);
  assert.deepEqual([plan.cols, plan.rows, plan.width, plan.height], [2, 1, 320, 90]);

  // one below the other: the width is made equal
  plan = ops.planVideoGrid(params({ layout: 'stacked' }), [landscape, landscape, landscape]);
  assert.deepEqual([plan.layout, plan.match, plan.cols, plan.rows, plan.width, plan.height], ['stacked', 'width', 1, 3, 160, 270]);
  assert.deepEqual(cellsOf(plan), [[0, 0, 160, 90], [0, 90, 160, 90], [0, 180, 160, 90]]);

  // other sizes and aspect ratios: the smallest height decides, the width follows the ratio, nothing is cut or stretched
  plan = ops.planVideoGrid(params(), [landscape, landscape, portrait]);
  assert.deepEqual(cellsOf(plan), [[0, 0, 160, 90], [160, 0, 160, 90], [320, 0, 50, 90]]);
  assert.equal(plan.width, 370);
  plan = ops.planVideoGrid(params(), [landscape, portrait, wide]);
  assert.deepEqual(plan.cells.map((cell) => cell.h), [90, 90, 90]);
  assert.deepEqual(plan.cells.map((cell) => cell.w), [160, 50, 180]);
  // a 2 x 2 grid with a slot per column and row: the smaller video sits in the middle of its slot
  plan = ops.planVideoGrid(params(), [landscape, landscape, portrait, wide]);
  assert.deepEqual([plan.width, plan.height], [340, 180]);
  assert.deepEqual(cellsOf(plan), [[0, 0, 160, 90], [170, 0, 160, 90], [54, 90, 50, 90], [160, 90, 180, 90]]);
  // equal widths in a row: the heights differ, the rows are centred
  plan = ops.planVideoGrid(params({ layout: 'side_by_side', match: 'width' }), [landscape, portrait]);
  assert.deepEqual(plan.cells.map((cell) => [cell.w, cell.h]), [[90, 50], [90, 160]]);
  assert.deepEqual([plan.width, plan.height], [180, 160]);
  assert.equal(plan.cells[0].y, 54);
  // equal heights in a column
  plan = ops.planVideoGrid(params({ layout: 'stacked', match: 'height' }), [landscape, portrait]);
  assert.deepEqual(plan.cells.map((cell) => [cell.w, cell.h]), [[160, 90], [50, 90]]);
  assert.deepEqual([plan.width, plan.height], [160, 180]);

  // size, gap
  plan = ops.planVideoGrid(params({ size: 180 }), [landscape, landscape]);
  assert.deepEqual([plan.width, plan.height], [640, 180]);
  plan = ops.planVideoGrid(params({ gap: 10 }), [landscape, landscape, landscape]);
  assert.deepEqual(cellsOf(plan), [[0, 0, 160, 90], [170, 0, 160, 90], [340, 0, 160, 90]]);
  assert.equal(plan.width, 500);
  plan = ops.planVideoGrid(params({ gap: 7 }), [landscape, landscape]);
  assert.equal(plan.cells[1].x, 166, 'the gap is rounded down to an even number');
  // the canvas never grows beyond the limit
  plan = ops.planVideoGrid(params({ size: 2160 }), [probeOf(3840, 2160), probeOf(3840, 2160), probeOf(3840, 2160), probeOf(3840, 2160)]);
  assert.ok(plan.width <= ops.GRID_MAX_EDGE && plan.height <= ops.GRID_MAX_EDGE, `${plan.width}x${plan.height}`);
  assert.equal(plan.width % 2, 0);
  assert.equal(plan.height % 2, 0);
  for (const cell of plan.cells) assert.equal((cell.x % 2) + (cell.y % 2) + (cell.w % 2) + (cell.h % 2), 0);

  // length and rate
  const clips = [probeOf(160, 90, { duration: 2, video: { codec: 'h264', width: 160, height: 90, fps: 25 } }), probeOf(160, 90, { duration: 4.5, video: { codec: 'h264', width: 160, height: 90, fps: 30 } })];
  assert.equal(ops.planVideoGrid(params(), clips).duration, 4.5);
  assert.equal(ops.planVideoGrid(params({ length: 'shortest' }), clips).duration, 2);
  assert.equal(ops.planVideoGrid(params(), clips).fps, 30, 'the highest rate of the videos');
  assert.throws(() => ops.planVideoGrid(params(), [probeOf(160, 90), probeOf(160, 90, { duration: null })]), /duration/);

  // errors
  assert.throws(() => ops.planVideoGrid(params(), [landscape]), /2 to 4/);
  assert.throws(() => ops.planVideoGrid(params(), Array(5).fill(landscape)), /2 to 4/);
  assert.throws(() => ops.planVideoGrid(params({ layout: 'row' }), [landscape, landscape]), /Unknown layout/);
  assert.throws(() => ops.planVideoGrid(params(), [landscape, { video: null, audio: null, duration: 2 }]), /no image/);
}

function testBuilder() {
  const clip = probeOf(160, 90);
  const withSound = probeOf(160, 90, { audio: { codec: 'aac', sampleRate: 44100, channels: 2, channelLayout: 'stereo' } });
  let spec = ops.buildVideoGrid(params(), [clip, clip]);
  assert.match(spec.graph, /^color=c=0x000000:s=320x90:r=25:d=2,format=yuv420p\[bg\]/);
  assert.match(spec.graph, /\[0:v\]setpts=PTS-STARTPTS,fps=25,scale=160:90:flags=lanczos,setsar=1,format=yuv420p\[v0\]/);
  assert.match(spec.graph, /\[bg\]\[v0\]overlay=x=0:y=0:eof_action=repeat:format=yuv420\[t0\]/);
  assert.match(spec.graph, /\[t0\]\[v1\]overlay=x=160:y=0:eof_action=repeat:format=yuv420\[t1\]/);
  assert.match(spec.graph, /\[t1\]format=yuv420p\[out\]$/);
  assert.deepEqual(spec.outputs, [{ kind: 'video', maps: ['[out]'], noAudio: true, args: ['-t', '2'] }]);
  // sound only when asked for and when the first video has some
  spec = ops.buildVideoGrid(params({ audio: 'first_video' }), [withSound, clip]);
  assert.deepEqual(spec.outputs[0].maps, ['[out]', '[sound]']);
  assert.equal(spec.outputs[0].noAudio, false);
  assert.match(spec.graph, /\[0:a\]aresample=48000,aformat=channel_layouts=stereo,apad\[sound\]/);
  spec = ops.buildVideoGrid(params({ audio: 'first_video' }), [clip, withSound]);
  assert.equal(spec.outputs[0].noAudio, true, 'the first video has no sound: the result has none');
  spec = ops.buildVideoGrid(params(), [withSound, withSound]);
  assert.equal(spec.outputs[0].noAudio, true);
  // labels: the picture of a label follows the videos in the inputs
  const pill = probeOf(300, 72, { duration: null });
  spec = ops.buildVideoGrid(params(), [clip, clip, pill], { labels: [null, 2] });
  assert.doesNotMatch(spec.graph, /\[0:v\]format=rgba/);
  assert.match(spec.graph, /\[2:v\]format=rgba,scale=\d+:\d+:flags=lanczos\[l1\]/);
  assert.match(spec.graph, /\[t1\]\[l1\]overlay=x=\d+:y=\d+:format=auto\[u1\]/);
  assert.match(spec.graph, /\[u1\]format=yuv420p\[out\]$/);
  const top = ops.buildVideoGrid(params({ label_position: 'top' }), [clip, clip, pill], { labels: [null, 2] });
  const bottom = ops.buildVideoGrid(params(), [clip, clip, pill], { labels: [null, 2] });
  const yOf = (spec2) => Number(/\[l1\]overlay=x=\d+:y=(\d+)/.exec(spec2.graph)[1]);
  assert.ok(yOf(top) < 20 && yOf(bottom) > 60, `top ${yOf(top)}, bottom ${yOf(bottom)}`);
  assert.throws(() => ops.buildVideoGrid(params({ label_position: 'middle' }), [clip, clip]), /label position/);
  assert.throws(() => ops.buildVideoGrid(params({ audio: 'second' }), [clip, clip]), /audio mode/);
  assert.throws(() => ops.buildVideoGrid(params({ background: 'red' }), [clip, clip]), /Invalid colour/);
}

function testLabelHelpers() {
  assert.deepEqual(edit.gridLabels('Alpha\nBeta', 3), ['Alpha', 'Beta', '']);
  assert.deepEqual(edit.gridLabels('  Alpha  \r\n\nGamma', 3), ['Alpha', '', 'Gamma']);
  assert.deepEqual(edit.gridLabels('', 2), ['', '']);
  assert.deepEqual(edit.gridLabels(undefined, 2), ['', '']);
  assert.equal(edit.gridLabels('x'.repeat(200), 1)[0].length, 80);
  assert.deepEqual(edit.gridLabels('A\nB\nC\nD\nE', 2), ['A', 'B'], 'lines beyond the videos are ignored');
  // resvg cannot draw colour emoji and would turn the whole label into boxes: they are left out, the rest stays
  assert.deepEqual(edit.gridLabels('Müller 😀 ok\n😀\nFlag 🇨🇭\n👍🏽 Nice\nFamily 👨‍👩‍👧 here', 5), ['Müller ok', '', 'Flag', 'Nice', 'Family here']);
  assert.deepEqual(edit.gridLabels('♥ ✓ ★ © ™ → ❤️', 1), ['♥ ✓ ★ © ™ → ❤'], 'symbols of a text font are drawn and stay');
  assert.deepEqual(edit.gridLabels('Señal ¿Qué? 日本語 « » ; [0:v] %{n}', 1), ['Señal ¿Qué? 日本語 « » ; [0:v] %{n}'], 'other text is not touched');
  assert.equal(edit.stripEmoji('1️⃣ eins'), '1 eins');
  assert.equal(edit.stripEmoji(undefined), '');
  if (edit.definitions.find((definition) => definition.type === 'image.text_render').available() !== true) return;
  const { svg, width, height } = edit.buildGridLabelSvg('Model <A> & "B"');
  assert.match(svg, /^<svg /);
  assert.ok(svg.includes('&lt;A&gt; &amp; &quot;B&quot;'), 'the text is escaped');
  assert.equal(height, 72);
  assert.ok(width > height, `the pill is wider than high: ${width}`);
  const wider = edit.buildGridLabelSvg('A much longer label for the second model');
  assert.ok(wider.width > width, 'the width follows the text');
  // a label with an emoji is drawn like the one without (not as a row of boxes)
  const plain = edit.buildGridLabelSvg('Müller ok');
  const emoji = edit.buildGridLabelSvg('Müller 😀 ok');
  assert.equal(emoji.svg, plain.svg);
  assert.ok(Buffer.compare(edit.renderSvg(emoji.svg).png, edit.renderSvg(plain.svg).png) === 0);
  assert.doesNotMatch(emoji.svg, /😀/u);
}

/* ---------- real ffmpeg ---------- */

async function ff(args) {
  const binaries = ffmpeg.binaries();
  await execFileAsync(binaries.ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args]);
}

async function probeRaw(file) {
  const binaries = ffmpeg.binaries();
  const { stdout } = await execFileAsync(binaries.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  const data = JSON.parse(stdout);
  const video = data.streams.find((stream) => stream.codec_type === 'video');
  const audio = data.streams.find((stream) => stream.codec_type === 'audio');
  return {
    width: video?.width,
    height: video?.height,
    pixFmt: video?.pix_fmt,
    videoCodec: video?.codec_name,
    hasAudio: Boolean(audio),
    audioDuration: audio ? Number(audio.duration) || Number(data.format.duration) : null,
    duration: Number(data.format.duration)
  };
}

// Raw RGB bytes of a region of one frame.
async function region(file, x, y, w, h, time = 0) {
  const binaries = ffmpeg.binaries();
  const { stdout } = await execFileAsync(
    binaries.ffmpeg,
    ['-nostdin', '-v', 'error', '-ss', String(time), '-i', file, '-vf', `crop=${w}:${h}:${x}:${y},format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-'],
    { encoding: 'buffer' }
  );
  return stdout;
}

async function pixelAt(file, x, y, time = 0) {
  return [...(await region(file, x, y, 1, 1, time))];
}

function near(actual, expected, tolerance = 24) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) <= tolerance, `pixel ${JSON.stringify(actual)} is not near ${JSON.stringify(expected)}`);
  });
}

// Largest difference between two regions: x264 may change a few values next to a change, so "the same" and "different"
// are told apart with margins.
function maxDiff(left, right) {
  assert.equal(left.length, right.length);
  let largest = 0;
  for (let index = 0; index < left.length; index += 1) largest = Math.max(largest, Math.abs(left[index] - right[index]));
  return largest;
}
const same = (left, right, message) => assert.ok(maxDiff(left, right) <= 8, `${message || 'regions differ'}: ${maxDiff(left, right)}`);
const differ = (left, right, message) => assert.ok(maxDiff(left, right) > 40, `${message || 'regions are the same'}: ${maxDiff(left, right)}`);

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const YELLOW = [255, 255, 0];
const BLACK = [0, 0, 0];

async function testWithFfmpeg() {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-nodes-grid-'));
  const bus = createEventBus();
  const wfStore = createWorkflowsStore({ dir: tmpDir, registry, events: bus });
  const created = [];
  const { workflow } = await wfStore.createWorkflow({ name: 'grid test', graph: { nodes: [], edges: [] } });
  created.push(workflow.id);
  const sessionId = workflow.sessionId;
  try {
    const src = (name) => path.join(tmpDir, name);
    const colour = (name, hex, size, seconds, { sound = 0, rate = 25 } = {}) => {
      const args = ['-f', 'lavfi', '-i', `color=c=${hex}:s=${size}:r=${rate}`];
      if (sound) args.push('-f', 'lavfi', '-i', `sine=frequency=${sound}:sample_rate=44100`);
      args.push('-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p');
      if (sound) args.push('-c:a', 'aac');
      args.push(src(name));
      return ff(args);
    };
    await colour('red.mp4', '0xff0000', '160x90', 2, { sound: 440 });
    await colour('green.mp4', '0x00ff00', '160x90', 4, { sound: 880 });
    await colour('blue.mp4', '0x0000ff', '90x160', 3);
    await colour('yellow.mp4', '0xffff00', '200x100', 1);
    // a clip that changes: red for the first two seconds, then green (to see the last frame stay)
    await ff([
      '-f', 'lavfi', '-i', 'color=c=0xff0000:s=160x90:r=25:d=1', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=160x90:r=25:d=1',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src('red-green.mp4')
    ]);

    const upload = async (file) => {
      const saved = await store.saveAsset(sessionId, { kind: 'upload', buffer: await fsp.readFile(src(file)), ext: '.mp4', prompt: file, cost: null });
      return assets.valueFromAsset(sessionId, saved.id);
    };
    const red = await upload('red.mp4');
    const green = await upload('green.mp4');
    const blue = await upload('blue.mp4');
    const yellow = await upload('yellow.mp4');
    const redGreen = await upload('red-green.mp4');
    const listOf = (...items) => ({ type: 'list', base: 'video', items });

    const controller = new AbortController();
    const makeCtx = () => ({
      workflowId: 'wf-test',
      runId: 'r-test',
      nodeId: 'n1',
      sessionId,
      user: 'tester',
      config: {},
      signal: controller.signal,
      log: () => {},
      saveOutputFile: (options) => assets.saveOutputFile(sessionId, options),
      withLocalSlot: (fn) => fn()
    });
    let lastValue = null;
    const run = async (videos, raw = {}, inputs = {}) => {
      const result = await def.execute(makeCtx(), { videos: listOf(...videos), ...inputs }, params(raw));
      assert.equal(result.variants.length, 1);
      assert.equal(result.variants[0].video.type, 'video');
      lastValue = result.variants[0].video;
      return assets.assetFilePath(lastValue);
    };
    const ledgerKind = async (value) => (await store.readLedger(sessionId)).find((entry) => entry.id === value.assetId);

    /* ----- two videos: next to each other, the longest decides, the last frame of the shorter stays ----- */
    {
      const file = await run([red, green]);
      const probe = await probeRaw(file);
      assert.deepEqual([probe.width, probe.height], [320, 90]);
      assert.equal(probe.videoCodec, 'h264');
      assert.equal(probe.pixFmt, 'yuv420p');
      assert.equal(probe.hasAudio, false, 'no sound by default');
      assert.ok(Math.abs(probe.duration - 4) < 0.2, `longest: ${probe.duration}`);
      near(await pixelAt(file, 40, 45), RED);
      near(await pixelAt(file, 240, 45), GREEN);
      // the red video ends after 2 s: its last frame stays on screen until the end
      near(await pixelAt(file, 40, 45, 3.5), RED);
      near(await pixelAt(file, 240, 45, 3.5), GREEN);
      assert.equal((await ledgerKind(lastValue)).kind, 'video');
      assert.equal(lastValue.file.endsWith('.mp4'), true);
      assert.ok(lastValue.duration > 3.5, 'the ledger stores the duration');
      assert.equal((await ledgerKind(lastValue)).cost, 0);

      const clipped = await probeRaw(await run([red, green], { length: 'shortest' }));
      assert.ok(Math.abs(clipped.duration - 2) < 0.2, `shortest: ${clipped.duration}`);
      assert.deepEqual([clipped.width, clipped.height], [320, 90]);

      // the last frame (not the first) stays: a video that turns from red to green
      const changing = await run([redGreen, green]);
      near(await pixelAt(changing, 40, 45, 0.2), RED);
      near(await pixelAt(changing, 40, 45, 3.5), GREEN);
    }

    /* ----- three videos with other sizes and ratios ----- */
    {
      const file = await run([red, green, blue]);
      const probe = await probeRaw(file);
      assert.deepEqual([probe.width, probe.height], [370, 90]);
      near(await pixelAt(file, 80, 45), RED);
      near(await pixelAt(file, 240, 45), GREEN);
      near(await pixelAt(file, 345, 45), BLUE);
      assert.ok(Math.abs(probe.duration - 4) < 0.2);
      // the same videos one below the other: the width is made equal
      const stacked = await run([red, green, blue], { layout: 'stacked' });
      const stackedProbe = await probeRaw(stacked);
      assert.equal(stackedProbe.width, 90, 'the smallest width decides');
      near(await pixelAt(stacked, 45, 10), RED);
      near(await pixelAt(stacked, 45, stackedProbe.height - 10), BLUE);
      assert.equal(stackedProbe.width % 2 + stackedProbe.height % 2, 0);
    }

    /* ----- four videos in 2 x 2, a gap, a background, a size ----- */
    {
      const file = await run([red, green, blue, yellow]);
      const probe = await probeRaw(file);
      assert.deepEqual([probe.width, probe.height], [340, 180]);
      near(await pixelAt(file, 80, 45), RED);
      near(await pixelAt(file, 250, 45), GREEN);
      near(await pixelAt(file, 80, 135), BLUE);
      near(await pixelAt(file, 250, 135), YELLOW);
      near(await pixelAt(file, 10, 135), BLACK, 12); // beside the narrow portrait video
      near(await pixelAt(file, 165, 45), BLACK, 12); // beside the green video in its wider column
      // the last frame of the yellow video (1 s) stays too
      near(await pixelAt(file, 250, 135, 3.5), YELLOW);

      const spaced = await run([red, green, blue, yellow], { gap: 10, background: '#808080', size: 100 });
      const spacedProbe = await probeRaw(spaced);
      assert.equal(spacedProbe.height, 100 * 2 + 10);
      near(await pixelAt(spaced, 5, 105), [128, 128, 128], 12);
      near(await pixelAt(spaced, 30, 50), RED);

      const layoutGrid = await run([red, green, blue], { layout: 'grid' });
      const gridProbe = await probeRaw(layoutGrid);
      assert.equal(gridProbe.height, 180);
      near(await pixelAt(layoutGrid, gridProbe.width - 5, gridProbe.height - 5), BLACK, 12); // the empty place shows the background
    }

    /* ----- sound ----- */
    {
      const none = await probeRaw(await run([red, green], { audio: 'none' }));
      assert.equal(none.hasAudio, false);
      const first = await probeRaw(await run([red, green], { audio: 'first_video' }));
      assert.equal(first.hasAudio, true, 'the sound of the first video');
      assert.ok(Math.abs(first.audioDuration - first.duration) < 0.3, `sound ${first.audioDuration} s, video ${first.duration} s`);
      assert.ok(Math.abs(first.duration - 4) < 0.2, 'silence pads the sound of the shorter first video');
      const cut = await probeRaw(await run([green, red], { audio: 'first_video', length: 'shortest' }));
      assert.equal(cut.hasAudio, true);
      assert.ok(Math.abs(cut.duration - 2) < 0.2 && Math.abs(cut.audioDuration - 2) < 0.3, `cut: ${cut.duration} / ${cut.audioDuration}`);
      const silent = await probeRaw(await run([blue, red], { audio: 'first_video' }));
      assert.equal(silent.hasAudio, false, 'the first video has no sound: none in the result');
    }

    /* ----- labels ----- */
    if (edit.definitions.find((definition) => definition.type === 'image.text_render').available() === true) {
      const plain = await run([red, green, blue]);
      const labelled = await run([red, green, blue], { labels: 'Alpha\nBeta' });
      const plainProbe = await probeRaw(plain);
      const labelledProbe = await probeRaw(labelled);
      assert.deepEqual([labelledProbe.width, labelledProbe.height], [plainProbe.width, plainProbe.height], 'labels do not change the size');
      // first video: the pill (white text on a dark bar) sits at the bottom edge, the rest is unchanged
      const bottomPlain = await region(plain, 0, 60, 160, 30);
      const bottomLabelled = await region(labelled, 0, 60, 160, 30);
      differ(bottomPlain, bottomLabelled, 'the first video has a label at the bottom');
      same(await region(plain, 0, 0, 160, 50), await region(labelled, 0, 0, 160, 50), 'the top of the first video');
      let maxGreen = 0;
      for (let index = 1; index < bottomLabelled.length; index += 3) maxGreen = Math.max(maxGreen, bottomLabelled[index]);
      assert.ok(maxGreen > 60, `white text in the label (the video itself has no green): ${maxGreen}`);
      // second video has a label, the third none
      differ(await region(plain, 160, 60, 160, 30), await region(labelled, 160, 60, 160, 30), 'the second video has a label');
      same(await region(plain, 320, 0, 50, 90), await region(labelled, 320, 0, 50, 90), 'the third video has no label');
      // top
      const top = await run([red, green, blue], { labels: 'Alpha', label_position: 'top' });
      differ(await region(plain, 0, 0, 160, 30), await region(top, 0, 0, 160, 30), 'the label is at the top');
      same(await region(plain, 0, 60, 160, 30), await region(top, 0, 60, 160, 30), 'nothing at the bottom');
      // a very long label stays inside its video
      const long = await run([red, green, blue], { labels: 'W'.repeat(60) });
      differ(await region(plain, 0, 60, 160, 30), await region(long, 0, 60, 160, 30), 'the long label is drawn');
      same(await region(plain, 160, 0, 210, 90), await region(long, 160, 0, 210, 90), 'the long label stays in its video');
      // a connected text replaces the field; a font size changes the pill
      const connected = await run([red, green, blue], { labels: 'Ignored' }, { labels: { type: 'text', value: 'Alpha\nBeta' } });
      same(await region(labelled, 0, 60, 160, 30), await region(connected, 0, 60, 160, 30), 'the connected text wins');
      const big = await run([red, green], { labels: 'Alpha', font_size: 40 });
      const small = await run([red, green], { labels: 'Alpha', font_size: 8 });
      differ(await region(big, 0, 0, 160, 90), await region(small, 0, 0, 160, 90), 'the font size changes the pill');
    } else {
      console.log('SKIP resvg fehlt (Beschriftungen nicht geprüft)');
    }

    /* ----- refusals before anything runs ----- */
    {
      await assert.rejects(run([red]), /connect 2 to 4 videos/);
      await assert.rejects(run([red, green, blue, yellow, red]), /connect 2 to 4 videos/);
      await assert.rejects(def.execute(makeCtx(), {}, params()), /connect 2 to 4 videos/);
      const names = await fsp.readdir(store.sessionAssetDir(sessionId));
      assert.deepEqual(names.filter((name) => name.startsWith('.')), [], 'no scratch directory is left');
    }

    /* ----- engine: three videos, labels from a text node, no cost, cache ----- */
    {
      const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => ({}), limits: { jobPollMs: 20 } });
      const node = (id, type, nodeParams = {}, x = 0) => ({ id, type, typeVersion: 1, x, y: 0, params: nodeParams });
      const edge = (id, from, fromPort, to, toPort) => ({ id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
      const { workflow: wf } = await wfStore.createWorkflow({ name: 'Grid chain', graph: { nodes: [], edges: [] } });
      created.push(wf.id);
      const own = {};
      for (const [name, value] of [['red', red], ['green', green], ['blue', blue]]) own[name] = await assets.copyAsset(sessionId, value.assetId, wf.sessionId);
      const saved = await wfStore.saveGraph(wf.id, {
        baseRev: wf.rev,
        graph: {
          nodes: [
            node('n1', 'input.video', { asset: own.red }),
            node('n2', 'input.video', { asset: own.green }, 0),
            node('n3', 'input.video', { asset: own.blue }, 0),
            node('n4', 'input.text', { text: 'Alpha\nBeta\nGamma' }, 0),
            node('n5', 'video.grid', { audio: 'none' }, 400),
            node('n6', 'media.info', {}, 800),
            node('n7', 'output.result', { label: 'Result' }, 1200)
          ],
          edges: [
            edge('e1', 'n1', 'video', 'n5', 'videos'),
            edge('e2', 'n2', 'video', 'n5', 'videos'),
            edge('e3', 'n3', 'video', 'n5', 'videos'),
            edge('e4', 'n4', 'text', 'n5', 'labels'),
            edge('e5', 'n5', 'video', 'n6', 'media'),
            edge('e6', 'n5', 'video', 'n7', 'inputs')
          ]
        }
      });
      const plan = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(plan.valid, true, JSON.stringify(plan.issues));
      assert.equal(plan.totals.paidNodes, 0, 'the grid costs nothing');
      const record = await engine.whenFinished(wf.id, await engine.start(wf.id, { mode: 'all', user: 'tester' }));
      assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
      const results = await wfStore.readResults(wf.id);
      const entry = results.nodes.n5.history[0];
      assert.equal(entry.cost.usd, null, 'a local op reports no cost');
      const video = entry.variants[0].video;
      assert.equal(video.sessionId, wf.sessionId);
      const probe = await probeRaw(assets.assetFilePath(video));
      assert.deepEqual([probe.width, probe.height], [370, 90]);
      assert.equal(results.nodes.n6.history[0].variants[0].width.value, 370);
      assert.ok(Math.abs(results.nodes.n6.history[0].variants[0].duration.value - 4) < 0.3);
      const cached = await engine.whenFinished(wf.id, await engine.start(wf.id, { mode: 'all' }));
      assert.equal(cached.nodes.n5.status, 'cached');

      // two videos only and a wrong count are reported before the run
      await wfStore.saveGraph(wf.id, {
        baseRev: saved.rev,
        graph: {
          nodes: [node('n1', 'input.video', { asset: own.red }), node('n5', 'video.grid', {}, 400)],
          edges: [edge('e1', 'n1', 'video', 'n5', 'videos')]
        }
      });
      const bad = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(bad.valid, false);
      const issue = bad.issues.find((item) => item.nodeId === 'n5' && item.code === 'grid_videos');
      assert.ok(issue, JSON.stringify(bad.issues));
      assert.deepEqual(issue.data, { min: 2, max: 4, count: 1 });
    }
  } finally {
    for (const id of created) await wfStore.deleteWorkflow(id).catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

/* ---------- texts ---------- */

function testTexts() {
  const registryModule = require('../lib/nodes/registry');
  const payload = JSON.parse(JSON.stringify(registryModule.publicRegistry()));
  const descriptor = payload.nodeTypes.find((item) => item.type === 'video.grid');
  assert.ok(descriptor);
  const dictionaries = {};
  for (const lang of ['de', 'en', 'es']) {
    const storage = new Map([['vcd-lang', lang]]);
    const window = {
      document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
      navigator: { language: lang },
      localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) }
    };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'i18n.js'), 'utf8'), { window }, { filename: 'public/i18n.js' });
    vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'nodes', 'i18n-nodes.js'), 'utf8'), { window }, { filename: 'public/nodes/i18n-nodes.js' });
    dictionaries[lang] = window.I18N[lang];
  }
  const keys = [
    'nodes.type.video.grid.label',
    'nodes.type.video.grid.keywords',
    'nodes.type.video.grid.help',
    'nodes.type.video.grid.example',
    'nodes.type.video.grid.tip.1',
    'nodes.type.video.grid.tip.2',
    'nodes.type.video.grid.tip.3',
    'nodes.portdesc.video.grid.videos',
    'nodes.portdesc.video.grid.labels',
    'nodes.portdesc.video.grid.video',
    'nodes.issue.grid_videos',
    ...descriptor.params.map((param) => `nodes.param.${param.id}`),
    ...['auto', 'side_by_side', 'stacked', 'grid', 'longest', 'shortest', 'none', 'first_video', 'bottom', 'top', 'height', 'width'].map(
      (value) => `nodes.option.${value}`
    )
  ];
  for (const lang of ['de', 'en', 'es']) {
    for (const key of keys) {
      assert.ok(dictionaries[lang][key], `${lang} lacks ${key}`);
      assert.equal(dictionaries[lang][key].includes('ß'), false, `${lang}.${key} has a sharp s`);
    }
  }
  assert.equal(dictionaries.de['nodes.type.video.grid.label'], 'Videos nebeneinander');
  assert.equal(dictionaries.en['nodes.type.video.grid.label'], 'Videos side by side');
  assert.equal(dictionaries.es['nodes.type.video.grid.label'], 'Vídeos lado a lado');
  for (const word of ['nebeneinander', 'Raster', 'Vergleich', 'Beschriftung']) {
    assert.ok(dictionaries.de['nodes.type.video.grid.keywords'].includes(word), `keyword ${word}`);
  }
  assert.match(dictionaries.de['nodes.issue.grid_videos'], /\{min\}/);
  assert.match(dictionaries.de['nodes.issue.grid_videos'], /\{count\}/);
}

async function main() {
  testRegistry();
  testPlan();
  testBuilder();
  testLabelHelpers();
  testTexts();
  if (!ffmpeg.binaries().available) {
    console.log('SKIP ffmpeg fehlt (nur reine Tests gelaufen)');
    console.log('test-nodes-video-grid.js: ok (ohne ffmpeg)');
    return;
  }
  await testWithFfmpeg();
  console.log('test-nodes-video-grid.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
