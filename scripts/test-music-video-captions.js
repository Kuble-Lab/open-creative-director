'use strict';

// The lyrics in the music video (WP35): the captions of the cutting node "Cut to the beat" (music_video.edit). What is covered:
//   - the numbers the script is made from: size and length of the film, where it starts in the song (lib/music-video-edit.js geometry,
//     captionScript), and that the times of the script are the times of the film
//   - the filter graph: the captions are drawn once at the end of the graph, before the fade-out, in the one process of a short film
//     and in the one encoder behind the batches of a long one - never in a batch - with every transition
//   - the node: the new input and parameters, the checks before a run (libass asked for and not there, the times not connected)
//   - runs on real clips with ffmpeg: a stand-in for libass takes the filter `ass` out of the graph and writes down the script it was
//     given, so the whole path (script, scratch folder, batches, encoder, fade) is run on a machine without libass; a song without
//     words makes a clean film without any caption filter; unreadable times and a missing libass stop before anything is started
//   - the picture itself, only where this ffmpeg has libass (otherwise the test says that it was skipped)
// The lyrics are invented. Nothing is paid and nothing leaves the machine.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const store = require('../lib/store');
const ffmpeg = require('../lib/ffmpeg');
const captions = require('../lib/captions-ass');
const editLib = require('../lib/music-video-edit');
const musicVideoNodes = require('../lib/nodes/nodes-music-video');
const edit = require('../lib/nodes/nodes-edit');
const { textValue, listValue } = require('../lib/nodes/types');
const { createEditHarness } = require('./support/edit-harness');
const { createFakeFfmpeg, createAssStandIn } = require('./support/fake-ffmpeg');
const { parseAss, lex, karaokeWords } = require('./support/ass-reader');

const restorers = [];
function useFfmpeg(file) {
  const original = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = file;
  ffmpeg.resetFilterCache();
  restorers.push(() => {
    if (original === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = original;
    ffmpeg.resetFilterCache();
  });
}
function restoreAll() {
  while (restorers.length) restorers.pop()();
  ffmpeg.resetFilterCache();
}

/* ---------- the invented song and its scenes ---------- */

const timingOf = (lines) => ({
  version: 1,
  source: 'align',
  duration: 30,
  words: lines.flatMap((line, index) => {
    const words = line.text.split(' ');
    const slot = (line.end - line.start) / words.length;
    return words.map((text, position) => ({ text, start: line.start + slot * position, end: line.start + slot * (position + 1), line: index }));
  }),
  lines: lines.map((line) => ({ text: line.text, start: line.start, end: line.end }))
});
// lines of the song, in song time
const SONG_LINES = [
  { text: 'Copper kites over the bay', start: 0.6, end: 1.9 },
  { text: 'Paper boats hum in the rain', start: 2.3, end: 3.9 },
  { text: 'Velvet skies', start: 4.2, end: 5.4 }
];
const TIMING = JSON.stringify(timingOf(SONG_LINES));
const INSTRUMENTAL = JSON.stringify({ version: 1, source: 'transcribe', duration: 30, words: [], lines: [] });

// scenes of a film: [[start, end], ...] of story scenes with clips 0, 1, 2 ...
const shotsOf = (scenes, { aspect = '16:9' } = {}) => ({
  version: 1,
  duration: scenes[scenes.length - 1][1],
  bpm: 120,
  aspect_ratio: aspect,
  cut_on: 'beats',
  brief: '',
  story: scenes.length,
  performance: 0,
  shots: scenes.map(([start, end], index) => ({ index, start, end, duration: end - start, kind: 'story', clip: index, section: 'A', line: null, prompt: 'p', motion: 'm', character: null }))
});

const probeOf = (width = 160, height = 90, duration = 5) => ({ video: { codec: 'h264', width, height, fps: 25 }, audio: null, duration });
const songInfo = { video: null, audio: { codec: 'pcm_s16le' }, duration: 12 };
const infosFor = (count) => [songInfo, ...Array.from({ length: count }, () => probeOf())];
const orderFor = (count) => Array.from({ length: count }, (_unused, index) => index + 1);

/* ---------- the numbers of the film ---------- */

function testGeometry() {
  const params = { transition: 'cut', resolution: '720p', fps: '25', fit: 'crop', fade_out: 1 };
  const shots = parse(shotsOf([[0, 2], [2, 4], [4, 6]]));
  assert.deepEqual(editLib.geometry({ shots, params }), { width: 1280, height: 720, fps: 25, start: 0, total: 6 });
  assert.deepEqual(editLib.geometry({ shots: parse(shotsOf([[0, 2]], { aspect: '9:16' })), params: { ...params, resolution: '1080p' } }), { width: 1080, height: 1920, fps: 25, start: 0, total: 2 });
  assert.deepEqual(editLib.geometry({ shots: parse(shotsOf([[0, 2]], { aspect: '1:1' })), params }), { width: 720, height: 720, fps: 25, start: 0, total: 2 });
  assert.equal(editLib.geometry({ shots, params: { ...params, fps: '30' } }).fps, 30);
  assert.equal(editLib.geometry({ shots, params: { ...params, fps: '31' } }).fps, 25, 'an unknown rate is 25');
  // the first scene need not start at the beginning of the song: the film starts there
  const late = parse(shotsOf([[2, 4], [4, 6.04]]));
  const film = editLib.geometry({ shots: late, params });
  assert.equal(film.start, 2);
  assert.equal(film.total, 4.04, 'the rounding to frames is the one of the cut');
  assert.throws(() => editLib.geometry({ shots: { shots: [] }, params }), /no scenes/);
  // the same numbers as the plan of the cut
  const plan = editLib.buildEditPlan({ shots: late, order: orderFor(2), infos: infosFor(2), params });
  assert.deepEqual([plan.width, plan.height, plan.fps, plan.seconds], [film.width, film.height, film.fps, film.total]);
}

function parse(object) {
  return require('../lib/music-video-plan').parseShots(JSON.stringify(object));
}

function testCaptionScript() {
  const params = { transition: 'cut', resolution: '720p', fps: '25', fit: 'crop', fade_out: 1 };
  const shots = parse(shotsOf([[0, 2], [2, 4], [4, 6]]));
  const script = editLib.captionScript({ shots, params, timing: TIMING, style: 'lines', position: 'bottom' });
  const ass = parseAss(script.text);
  assert.equal(ass.info.PlayResX, '1280');
  assert.equal(ass.info.PlayResY, '720');
  assert.equal(ass.style.Fontsize, '43');
  assert.equal(ass.style.Alignment, '2');
  assert.equal(script.events, 3);
  // times of the song are times of the film when the film starts with the song: 0.6 - 0.4 = 0.2; lines that follow each other closely
  // share the time between their words (1.9 and 2.3: 2.1, 3.9 and 4.2: 4.05)
  assert.deepEqual(ass.events.map((event) => [event.start, event.end]), [[20, 210], [210, 405], [405, 580]]);
  assert.equal(lex(ass.events[0].text).visible, 'Copper kites over the bay');
  // each line is in the film, nothing is beyond its end (6 s)
  for (const event of ass.events) assert.ok(event.end <= 600);

  // the film starts at 2 s of the song: a line of the song at 2.3 s is at 0.3 s of the film
  const late = parse(shotsOf([[2, 4], [4, 6]]));
  const shifted = parseAss(editLib.captionScript({ shots: late, params, timing: TIMING, style: 'lines' }).text);
  assert.equal(shifted.events.length, 2, 'the first line ended before the film starts');
  assert.deepEqual(
    shifted.events.map((event) => [event.start, event.end]),
    [[0, 205], [205, 380]],
    'the second line begins 0.3 s into the film, 0.4 s ahead of it: at 0; the third at 2.2 s and ends 3.4 + 0.4 s; the two share 1.9 to 2.2 s'
  );
  // the size follows the format
  const tall = parseAss(editLib.captionScript({ shots: parse(shotsOf([[0, 6]], { aspect: '9:16' })), params: { ...params, resolution: '1080p' }, timing: TIMING }).text);
  assert.equal(tall.info.PlayResX, '1080');
  assert.equal(tall.info.PlayResY, '1920');
  // positions and styles
  assert.equal(parseAss(editLib.captionScript({ shots, params, timing: TIMING, position: 'top' }).text).style.Alignment, '8');
  assert.equal(parseAss(editLib.captionScript({ shots, params, timing: TIMING, position: 'middle' }).text).style.Alignment, '5');
  const karaoke = parseAss(editLib.captionScript({ shots, params, timing: TIMING }).text);
  assert.equal(karaoke.events.length, 3, 'karaoke is the default style: a line is one event');
  assert.equal(karaokeWords(karaoke.events[0].text).length, 5);
  assert.ok(parseAss(editLib.captionScript({ shots, params, timing: TIMING, style: 'words' }).text).events.length > 10);
  // a song without words: nothing to show
  assert.equal(editLib.captionScript({ shots, params, timing: INSTRUMENTAL }).events, 0);
  assert.equal(editLib.captionScript({ shots, params, timing: { version: 1, words: [], lines: [] } }).events, 0);
}

/* ---------- the graph ---------- */

function testGraph() {
  const params = { transition: 'cut', resolution: '720p', fps: '25', fit: 'crop', fade_out: 1 };
  const three = parse(shotsOf([[0, 2], [2, 4], [4, 6]]));
  const file = '/tmp/work/captions.ass';
  const filter = 'ass=filename=/tmp/work/captions.ass';
  const plan = (shots, extra = {}, extraParams = {}) =>
    editLib.buildEditPlan({ shots, order: orderFor(shots.shots.length), infos: infosFor(shots.shots.length), params: { ...params, ...extraParams }, ...extra });

  // one process: the captions come after the joined film and before the fade-out
  const plain = plan(three);
  const withCaptions = plan(three, { captionsFile: file });
  assert.equal(plain.mode, 'single');
  assert.equal(plain.captions, false);
  assert.equal(withCaptions.captions, true);
  assert.ok(plain.spec.graph.includes('[vx]fade=t=out:st=5:d=1[v]'), plain.spec.graph);
  assert.ok(withCaptions.spec.graph.includes(`[vx]${filter},fade=t=out:st=5:d=1[v]`), withCaptions.spec.graph);
  assert.equal(withCaptions.spec.graph.replace(`${filter},`, ''), plain.spec.graph, 'nothing else in the graph changes');
  assert.equal(withCaptions.spec.graph.split('ass=').length - 1, 1, 'drawn once');
  // without a fade-out the film goes straight into the filter
  assert.ok(plan(three, { captionsFile: file }, { fade_out: 0 }).spec.graph.includes(`[vx]${filter}[v]`));
  assert.ok(plan(three, {}, { fade_out: 0 }).spec.graph.includes('[vx]null[v]'), 'as before without captions');
  // every transition, one scene
  for (const transition of ['crossfade', 'flash']) {
    const made = plan(three, { captionsFile: file }, { transition });
    assert.equal(made.spec.graph.split('ass=').length - 1, 1, transition);
    assert.match(made.spec.graph, /\[vx\]ass=filename=\/tmp\/work\/captions\.ass,fade=/, transition);
  }
  const one = plan(parse(shotsOf([[0, 2]])), { captionsFile: file });
  assert.match(one.spec.graph, /\[v0\]ass=filename=\/tmp\/work\/captions\.ass,fade=/, 'a single scene is the film itself');
  // the audio line is the same as without captions
  assert.equal(withCaptions.spec.graph.split(';').pop(), plain.spec.graph.split(';').pop());

  // a path with characters that mean something in a graph
  const awkward = plan(three, { captionsFile: "/tmp/it's here/c:d,e[1].ass" });
  assert.ok(awkward.spec.graph.includes(`[vx]${captions.assFilter("/tmp/it's here/c:d,e[1].ass")},fade=`), awkward.spec.graph);

  // many scenes: batches draw nothing, the one encoder draws once
  const six = parse(shotsOf([[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]]));
  for (const transition of ['cut', 'crossfade', 'flash']) {
    const batched = plan(six, { captionsFile: file }, { transition });
    assert.equal(batched.mode, 'batched', transition);
    assert.equal(batched.captions, true);
    assert.equal(batched.final.graph.split('ass=').length - 1, 1, `${transition}: the encoder draws the captions`);
    assert.ok(batched.final.graph.startsWith(`[0:v]${filter},fade=t=out:`), batched.final.graph);
    for (const batch of batched.batches) assert.ok(!batch.graph.includes('ass='), `${transition}: no batch draws captions`);
    const without = plan(six, {}, { transition });
    assert.equal(without.captions, false);
    assert.equal(batched.final.graph.replace(`${filter},`, ''), without.final.graph);
    assert.deepEqual(batched.batches.map((batch) => batch.graph), without.batches.map((batch) => batch.graph), 'the batches are the same');
    const args = require('../lib/nodes/ffmpeg-ops').assembleArgs(batched.final, ['pipe:0', '/song.wav'], ['/out.mp4']);
    assert.ok(args[args.indexOf('-filter_complex') + 1].includes(filter));
  }
}

/* ---------- the node ---------- */

async function testDefinition(h) {
  const registry = h.registry;
  const node = h.def('music_video.edit');
  assert.deepEqual(node.inputs.map((port) => [port.id, port.type, port.required === true]), [
    ['song', 'audio', true],
    ['shots', 'text', true],
    ['story', 'video', true],
    ['performance', 'video', false],
    ['captions', 'text', false]
  ]);
  assert.deepEqual(registry.paramDefaults(node), { transition: 'cut', resolution: '720p', fps: '25', fit: 'crop', fade_out: 1, captions: 'off', captions_position: 'bottom' });
  assert.deepEqual(node.params.find((param) => param.id === 'captions').options, ['off', 'karaoke', 'words', 'lines']);
  assert.deepEqual(node.params.find((param) => param.id === 'captions_position').options, ['bottom', 'middle', 'top']);
  assert.deepEqual(node.params.find((param) => param.id === 'captions_position').showIf, { param: 'captions', in: ['karaoke', 'words', 'lines'] }, 'the position matters only with captions');
  assert.deepEqual(registry.checkParams(node, registry.paramDefaults(node)), []);
  assert.ok(registry.checkParams(node, { ...registry.paramDefaults(node), captions: 'blink' }).length > 0);

  const withAss = await createFakeFfmpeg(h.dir, { filters: ['ass'], name: 'mv-with-ass' });
  const withoutAss = await createFakeFfmpeg(h.dir, { filters: [], name: 'mv-without-ass' });
  const issues = (raw, ports = {}) => (node.validate(registry.normalizeParams(node, raw), ports) || []).map((issue) => ({ level: issue.level || 'error', code: issue.code }));
  try {
    // off: libass is not needed, whatever ffmpeg has
    useFfmpeg(withoutAss.file);
    assert.deepEqual(issues({}), []);
    assert.deepEqual(issues({ captions: 'off' }, { captions: { connected: true, count: 1 } }), []);
    assert.equal(registry.availability(node), true, 'the node itself works without libass');
    // asked for and not there: refused, before anything starts
    assert.deepEqual(issues({ captions: 'karaoke' }, { captions: { connected: true, count: 1 } }), [{ level: 'error', code: 'CAPTIONS_NO_LIBASS' }]);
    for (const style of ['words', 'lines']) assert.deepEqual(issues({ captions: style }, { captions: { connected: true, count: 1 } }).map((issue) => issue.code), ['CAPTIONS_NO_LIBASS']);
    // ... and the times are not connected: nothing to burn in
    assert.deepEqual(issues({ captions: 'karaoke' }), [
      { level: 'error', code: 'CAPTIONS_NO_LIBASS' },
      { level: 'warning', code: 'MUSICVIDEO_NO_CAPTIONS_TIMING' }
    ]);
    // libass is there
    useFfmpeg(withAss.file);
    assert.deepEqual(issues({ captions: 'karaoke' }, { captions: { connected: true, count: 1 } }), []);
    assert.deepEqual(issues({ captions: 'lines' }), [{ level: 'warning', code: 'MUSICVIDEO_NO_CAPTIONS_TIMING' }]);
    // no ffmpeg at all: the plain reason is enough
    useFfmpeg('/definitely/not/here/ffmpeg');
    assert.deepEqual(issues({ captions: 'karaoke' }, { captions: { connected: true, count: 1 } }), []);
    assert.match(registry.availability(node), /ffmpeg/);
  } finally {
    restoreAll();
  }
  // the same codes and the same reason as the standalone node
  assert.equal(edit.noLibassIssue().code, 'CAPTIONS_NO_LIBASS');
}

/* ---------- runs on real clips ---------- */

async function testRuns(h) {
  const W = 1280;
  const H = 720;
  const colours = ['ff0000', '00c000', '0000ff', 'c0c000', 'c000c0', '00c0c0'];
  // the clips are 5 s long and 160x90; the song 12 s
  const clipOf = async (hex) => {
    await h.ff(['-f', 'lavfi', '-i', `color=c=0x${hex}:s=160x90:r=25:d=5`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-an', h.src(`clip-${hex}.mp4`)]);
    return h.upload(`clip-${hex}.mp4`, '.mp4');
  };
  const clips = [];
  for (const hex of colours) clips.push(await clipOf(hex));
  await h.ff(['-f', 'lavfi', '-i', 'aevalsrc=0.2*sin(2*PI*220*t):s=44100:d=12', '-c:a', 'pcm_s16le', h.src('song.wav')]);
  const song = await h.upload('song.wav', '.wav');
  const inputsFor = (scenes, extra = {}, options = {}) => ({
    song,
    shots: textValue(JSON.stringify(shotsOf(scenes, options))),
    story: listValue('video', clips.slice(0, scenes.length)),
    ...extra
  });
  const THREE = [[0, 2], [2, 4], [4, 6]];
  const SIX = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]];
  const realFfmpeg = ffmpeg.binaries().ffmpeg;
  const standIn = await createAssStandIn(h.dir, { real: realFfmpeg });
  const noAss = await createFakeFfmpeg(h.dir, { filters: [], name: 'mv-run-no-ass' });
  const scratchLeft = async () => (await fsp.readdir(store.sessionAssetDir(h.sessionId))).filter((name) => name.startsWith('.'));
  const info = async (value) => h.probe(await h.fileOf(value));

  try {
    // 1. captions off, the times connected: nothing is drawn, nothing is asked of libass
    useFfmpeg(standIn.file);
    await standIn.reset();
    let out = await h.run('music_video.edit', inputsFor(THREE, { captions: textValue(TIMING) }), { captions: 'off' });
    let film = await info(out.video);
    assert.deepEqual([film.width, film.height], [W, H]);
    assert.ok(Math.abs(film.duration - 6) < 0.1);
    assert.deepEqual((await standIn.calls()).filter((call) => call.graph), [], 'no caption filter');

    // 2. karaoke, one process: the script is written for this film and the filter is in the graph once
    await standIn.reset();
    out = await h.run('music_video.edit', inputsFor(THREE, { captions: textValue(TIMING) }), { captions: 'karaoke', captions_position: 'top' });
    film = await info(out.video);
    assert.ok(Math.abs(film.duration - 6) < 0.1, 'as long as before');
    assert.equal(film.hasAudio, true, 'the song is still underneath');
    assert.ok(Math.abs(film.audioDuration - 6) < 0.1);
    let calls = await standIn.calls();
    assert.equal(calls.length, 1, 'three scenes: one process');
    assert.equal(calls[0].scripts.length, 1);
    assert.ok(calls[0].graph.includes('ass=filename='));
    assert.ok(calls[0].graph.indexOf('ass=filename=') < calls[0].graph.indexOf('fade=t=out'), 'the captions are drawn before the fade-out');
    let script = parseAss(calls[0].scripts[0].text);
    assert.equal(script.info.PlayResX, '1280');
    assert.equal(script.info.PlayResY, '720');
    assert.equal(script.style.Alignment, '8', 'the position of the node');
    assert.equal(script.events.length, 3);
    assert.equal(script.events[0].start, 20, 'the lines are where the song has them: 0.6 s - 0.4 s');
    assert.equal(karaokeWords(script.events[0].text).map((word) => word.text).join(' '), 'Copper kites over the bay');
    assert.deepEqual(await scratchLeft(), [], 'the folder with the script is removed');

    // 3. words and lines
    for (const [style, position, alignment] of [['words', 'bottom', '2'], ['lines', 'middle', '5']]) {
      await standIn.reset();
      await h.run('music_video.edit', inputsFor(THREE, { captions: textValue(TIMING) }), { captions: style, captions_position: position });
      script = parseAss((await standIn.scripts())[0].text);
      assert.equal(script.style.Alignment, alignment, style);
      assert.equal(script.style.PrimaryColour, '&H00FFFFFF', `${style}: the line is white, the highlight is for the word`);
      if (style === 'lines') assert.equal(script.events.length, 3);
      else assert.ok(script.events.length > 10);
    }

    // 4. the film starts later in the song: the times follow the film
    await standIn.reset();
    await h.run('music_video.edit', inputsFor([[2, 4], [4, 6]], { captions: textValue(TIMING) }), { captions: 'lines' });
    script = parseAss((await standIn.scripts())[0].text);
    assert.deepEqual(script.events.map((event) => [event.start, event.end]), [[0, 205], [205, 380]], 'seconds of the song minus the start of the film');

    // 5. a long film is cut in batches: the one encoder draws the captions, once
    await standIn.reset();
    const sixInputs = inputsFor(SIX, { captions: textValue(TIMING) });
    out = await h.run('music_video.edit', sixInputs, { captions: 'karaoke', transition: 'crossfade' });
    film = await info(out.video);
    assert.ok(Math.abs(film.duration - 6) < 0.1);
    assert.equal(film.hasAudio, true);
    calls = await standIn.calls();
    assert.ok(calls.length >= 3, `batches and an encoder (${calls.length} processes)`);
    const drawing = calls.filter((call) => call.scripts.length);
    assert.equal(drawing.length, 1, 'one process draws');
    assert.ok(drawing[0].argv.includes('pipe:0'), 'the encoder, which takes the frames of the batches');
    assert.equal(drawing[0].scripts.length, 1);
    assert.equal(parseAss(drawing[0].scripts[0].text).events.length, 3);
    assert.deepEqual(await scratchLeft(), []);

    // 6. a song without words: a clean film, no caption filter at all (and so no libass needed: the real ffmpeg is used)
    useFfmpeg(realFfmpeg);
    out = await h.run('music_video.edit', inputsFor(THREE, { captions: textValue(INSTRUMENTAL) }), { captions: 'karaoke' });
    film = await info(out.video);
    assert.ok(Math.abs(film.duration - 6) < 0.1);
    assert.equal(film.hasAudio, true);
    out = await h.run('music_video.edit', inputsFor(SIX, { captions: textValue(INSTRUMENTAL) }), { captions: 'words' });
    assert.ok(Math.abs((await info(out.video)).duration - 6) < 0.1, 'in batches, too');
    useFfmpeg(standIn.file);
    await standIn.reset();
    await h.run('music_video.edit', inputsFor(THREE, { captions: textValue(INSTRUMENTAL) }), { captions: 'lines' });
    assert.deepEqual((await standIn.calls()).filter((call) => call.graph), [], 'no filter was given to ffmpeg');
    assert.deepEqual(await scratchLeft(), []);

    // 7. the times that cannot be read: an error with a code, before anything is cut
    await standIn.reset();
    for (const bad of ['', 'not json', '{"lines": 3}']) {
      await assert.rejects(h.run('music_video.edit', inputsFor(THREE, { captions: textValue(bad) }), { captions: 'karaoke' }), (err) => err.code === 'CAPTIONS_TIMING_INVALID', JSON.stringify(bad));
    }
    assert.deepEqual(await standIn.calls(), []);
    // the times are connected but captions are off: they are not read at all
    out = await h.run('music_video.edit', inputsFor(THREE, { captions: textValue('not json') }), { captions: 'off' });
    assert.ok(Math.abs((await info(out.video)).duration - 6) < 0.1);
    // asked for, but no times connected: a film without captions
    await standIn.reset();
    await h.run('music_video.edit', inputsFor(THREE), { captions: 'karaoke' });
    assert.deepEqual((await standIn.calls()).filter((call) => call.graph), []);

    // 8. no libass in the ffmpeg: refused with the code, nothing started, nothing left behind
    useFfmpeg(noAss.file);
    await assert.rejects(h.run('music_video.edit', inputsFor(THREE, { captions: textValue(TIMING) }), { captions: 'karaoke' }), (err) => err.code === 'CAPTIONS_NO_LIBASS' && /libass/.test(err.message));
    assert.deepEqual(await noAss.calls(), [], 'no process was started');
    assert.deepEqual(await scratchLeft(), []);
  } finally {
    restoreAll();
  }
}

/* ---------- the picture (needs libass) ---------- */

async function testPicture(h) {
  if (!ffmpeg.hasFilter('ass')) {
    console.log('SKIP picture: this ffmpeg has no libass (filter "ass"); the graph, the script and the whole run were checked with a stand-in, the burnt-in picture was not');
    return;
  }
  const W = 320;
  const H = 180;
  await h.ff(['-f', 'lavfi', '-i', 'color=c=0x000000:s=160x90:r=25:d=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-an', h.src('black.mp4')]);
  const black = await h.upload('black.mp4', '.mp4');
  await h.ff(['-f', 'lavfi', '-i', 'aevalsrc=0.2*sin(2*PI*220*t):s=44100:d=12', '-c:a', 'pcm_s16le', h.src('song.wav')]);
  const song = await h.upload('song.wav', '.wav');
  const timing = JSON.stringify(timingOf([{ text: 'MMMMMM MMMMMM', start: 1, end: 5 }]));
  const white = (r, g, b) => r > 200 && g > 200 && b > 200;
  const yellow = (r, g, b) => r > 200 && g > 150 && g < 245 && b < 90;
  const whole = { x0: 0, y0: 0, x1: W, y1: H };
  const make = (position, style = 'karaoke') =>
    h.run('music_video.edit', { song, shots: textValue(JSON.stringify(shotsOf([[0, 8]]))), story: listValue('video', [black]), captions: textValue(timing) }, { captions: style, captions_position: position, fade_out: 0 });
  const out = await make('bottom');
  const file = await h.fileOf(out.video);
  // a font must exist, or libass draws nothing
  const during = await h.frame(file, 3, W, H);
  if (h.count(during, W, whole, white) + h.count(during, W, whole, yellow) < 50) {
    console.log('SKIP picture: libass found no font on this machine, it draws nothing');
    return;
  }
  const before = await h.frame(file, 0.4, W, H);
  assert.equal(h.count(before, W, whole, white) + h.count(before, W, whole, yellow), 0, 'nothing before the line comes');
  const early = await h.frame(file, 0.8, W, H);
  assert.ok(h.count(early, W, whole, white) > 40 && h.count(early, W, whole, yellow) === 0, 'the line stands in the base colour before its first word');
  assert.ok(h.count(during, W, whole, yellow) > 20 && h.count(during, W, whole, white) > 20, 'the fill is half way in the middle of the line');
  const end = await h.frame(file, 5.1, W, H);
  assert.ok(h.count(end, W, whole, yellow) > h.count(during, W, whole, yellow) && h.count(end, W, whole, white) < h.count(during, W, whole, white), 'filled at the end');
  const gone = await h.frame(file, 6.5, W, H);
  assert.equal(h.count(gone, W, whole, white) + h.count(gone, W, whole, yellow), 0, 'gone after the hold');
  const lower = h.count(during, W, { x0: 0, y0: H / 2, x1: W, y1: H }, white) + h.count(during, W, { x0: 0, y0: H / 2, x1: W, y1: H }, yellow);
  assert.ok(lower > 50, 'at the bottom');
  const top = await make('top');
  const topFrame = await h.frame(await h.fileOf(top.video), 3, W, H);
  const upper = h.count(topFrame, W, { x0: 0, y0: 0, x1: W, y1: H / 2 }, white) + h.count(topFrame, W, { x0: 0, y0: 0, x1: W, y1: H / 2 }, yellow);
  assert.ok(upper > 50, 'at the top');
}

async function main() {
  testGeometry();
  testCaptionScript();
  testGraph();
  if (!ffmpeg.binaries().available) {
    console.log('SKIP ffmpeg is missing (only the pure parts were tested)');
    console.log('test-music-video-captions.js: ok');
    return;
  }
  const h = await createEditHarness({ prefix: 'ocd-mv-captions-', extraRegister: (registry) => musicVideoNodes.registerAll(registry) });
  try {
    await testDefinition(h);
    await testRuns(h);
    await testPicture(h);
  } finally {
    restoreAll();
    await h.cleanup();
  }
  console.log('test-music-video-captions.js: ok');
}

main().catch((err) => {
  restoreAll();
  console.error(err);
  process.exit(1);
});
