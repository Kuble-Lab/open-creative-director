'use strict';

// The cut of an explainer video (WP37b): lib/explainer-edit.js (pure) and the node "Cut explainer video" (explainer.edit) with the real
// ffmpeg on made-up media: scenes of one colour each, voices that are one tone each (so that a voice can be found in the film by its
// pitch), music that is another tone.
//   - the timeline in whole frames, the shot list, the sound graph, the merged word times, the SRT, the length note (pure)
//   - the voices stand exactly at the start of their scene: cut and crossfade, 12 scenes (cut in batches), no drift
//   - the crossfade shortens the film by the overlap and the picture fades while the voice of the next scene begins
//   - the subtitle file and the captions JSON are in the times of the film (shifted by the start of every scene)
//   - music: quiet and loud, looped under a long film, lowered under the voice (and not lowered without ducking), the voice is not touched
//   - intro and outro (hard cut, their own sound), clips of the shots (trimmed, slowed down, held), 16:9 and 9:16
//   - the length against the target (a warning above 15 %), the codes of the errors, no scratch folders left behind
//   - the caption script reaches the encoder once, shifted (with a stand-in for libass where the ffmpeg has none)
//   - the sound is brought to -16 LUFS (measured by loudnorm, one gain, a limiter): the helpers (pure), a quiet sine and a loud one measured
//     with another meter (ebur128), the film, the log line, a film without sound, a call that fails (the sound stays as it is)
// A private copy of the app runs in a temp directory; nothing is paid, nothing leaves the machine. Skipped when ffmpeg is missing.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');

const { createIsolatedApp } = require('./support/isolated-app');
const { createAssStandIn } = require('./support/fake-ffmpeg');
const { parseAss } = require('./support/ass-reader');
const { toneWav, amplitudeAt, onsetOf, endOf, createMedia } = require('./support/explainer-media');

const STAFF = 'staff1@staff.example.com';
const near = (actual, expected, tolerance, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} !== ${expected} (±${tolerance})`.trim());
const errorOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
};

const restorers = [];
function restoreAll() {
  while (restorers.length) restorers.pop()();
}

/* ---------- the pure part ---------- */

function testPure({ editLib, cuesLib, musicEdit }) {
  // the timeline: the scenes one after the other, under a crossfade the next one fades in over the end of the one before
  const cut = editLib.planTimeline({ durations: [2.4, 1.9, 2.9], fps: 30, transition: 'cut' });
  assert.deepEqual(cut.frames, [72, 57, 87]);
  assert.deepEqual(cut.owns, [72, 57, 87]);
  assert.deepEqual(cut.starts, [0, 72, 129]);
  assert.equal(cut.totalFrames, 216);
  assert.equal(cut.total, 7.2);
  assert.equal(cut.overlap, 0);
  const fade = editLib.planTimeline({ durations: [2.4, 1.9, 2.9], fps: 30, transition: 'crossfade' });
  assert.equal(fade.overlap, 8, 'a quarter second is 8 frames at 30 fps (7.5 rounded)');
  assert.deepEqual(fade.fades, [0, 8, 8]);
  assert.deepEqual(fade.owns, [64, 49, 87], 'what a scene keeps until the next one begins');
  assert.deepEqual(fade.starts, [0, 64, 113]);
  assert.equal(fade.totalFrames, 200);
  assert.equal(fade.totalFrames, fade.frames.reduce((sum, value) => sum + value, 0) - 16, 'the film is as much shorter as the fades overlap');
  // hard cuts (next to the person on camera): one frame of fade only
  const hard = editLib.planTimeline({ durations: [2, 2.4, 1.9, 1.5], hardCuts: [false, true, false, true], fps: 30, transition: 'crossfade' });
  assert.deepEqual(hard.fades, [0, 1, 8, 1]);
  assert.equal(hard.totalFrames, 60 + 72 + 57 + 45 - 10);
  // a very short shot never fades longer than it lasts
  const short = editLib.planTimeline({ durations: [1, 0.1, 1], fps: 30, transition: 'crossfade' });
  assert.ok(short.owns.every((frames) => frames >= 1), JSON.stringify(short.owns));
  assert.equal(short.starts[2] + short.owns[2], short.totalFrames);
  assert.throws(() => editLib.planTimeline({ durations: [] }), /no scenes/);
  // the shot list says the same thing, in seconds, for buildEditPlan: its frames are those of the timeline
  const shots = editLib.shotsOf({ timeline: hard, kinds: ['person', 'motion', 'clip', 'person'], aspectRatio: '16:9', hardCuts: [false, true, false, true], fits: ['pad', null, 'crop', 'pad'] });
  assert.equal(shots.aspect_ratio, '16:9');
  assert.deepEqual(shots.shots.map((shot) => shot.kind), ['performance', 'performance', 'story', 'performance'], 'only a generated clip may be slowed down');
  assert.deepEqual(shots.shots.map((shot) => shot.fit || null), ['pad', null, 'crop', 'pad']);
  assert.deepEqual(shots.shots.map((shot) => Boolean(shot.hardCut)), [false, true, false, true]);
  for (const kind of ['cut', 'crossfade']) {
    const timeline = editLib.planTimeline({ durations: [2.4, 1.9, 2.9, 2.0], hardCuts: [false, false, false, true], fps: 30, transition: kind });
    const plan = musicEdit.buildEditPlan({
      shots: editLib.shotsOf({ timeline, kinds: ['motion', 'motion', 'motion', 'person'], aspectRatio: '16:9', hardCuts: [false, false, false, true] }),
      order: [1, 2, 3, 4],
      infos: [{ audio: true, video: false, duration: 20 }, ...[2.4, 1.9, 2.9, 2.0].map((duration) => ({ video: true, audio: false, duration, width: 160, height: 90 }))],
      params: { transition: kind, resolution: '720p', fps: 30, fit: 'crop', fade_out: 0 }
    });
    assert.equal(plan.frames, timeline.totalFrames, `${kind}: the picture and the sound plan have the same number of frames`);
    near(plan.seconds, timeline.total, 1e-9);
    assert.deepEqual(plan.summary.map((entry) => entry.frames), timeline.owns, `${kind}: every shot has the frames the sound gave it`);
  }

  // the sound
  const sound = editLib.soundtrackArgs({
    voices: [{ file: '/v/a.mp3' }, { file: null }, { file: '/v/c.mp3' }],
    music: { file: '/m.mp3', level: 0.25, duck: true },
    timeline: cut,
    outputFile: '/out.wav'
  });
  assert.deepEqual(sound.inputs, ['/v/a.mp3', '/v/c.mp3', '/m.mp3']);
  const perFrame = 48000 / 30;
  assert.ok(sound.graph.includes(`atrim=end_sample=${72 * perFrame},asetpts=PTS-STARTPTS,apad=whole_len=${72 * perFrame}[s0]`), 'every voice is cut or padded to the frames of its scene');
  assert.ok(sound.graph.includes(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=end_sample=${57 * perFrame}`), 'a scene without a voice is silence of the same length');
  assert.ok(sound.graph.includes('concat=n=3:v=0:a=1[voice]'));
  assert.ok(sound.graph.includes('sidechaincompress') && sound.graph.includes('asplit=2'));
  assert.ok(sound.graph.includes('alimiter'));
  assert.ok(sound.argv.join(' ').includes('-stream_loop -1 -i /m.mp3'), 'the music loops');
  assert.equal(sound.argv[sound.argv.length - 1], '/out.wav');
  const plain = editLib.soundtrackArgs({ voices: [{ file: '/v/a.mp3' }, { file: '/v/b.mp3' }, { file: '/v/c.mp3' }], timeline: cut, outputFile: '/o.wav' });
  assert.ok(plain.graph.endsWith('[voice]anull[sound]') && !plain.graph.includes('sidechain'), 'no music: only the voices');
  const noDuck = editLib.soundtrackArgs({ voices: [{ file: '/a' }, { file: '/b' }, { file: '/c' }], music: { file: '/m', level: 0.12, duck: false }, timeline: cut, outputFile: '/o' });
  assert.ok(!noDuck.graph.includes('sidechain') && noDuck.graph.includes('amix=inputs=2'));
  assert.ok(!editLib.soundtrackArgs({ voices: [{ file: '/a' }, { file: '/b' }, { file: '/c' }], music: { file: '/m', level: 0, duck: true }, timeline: cut, outputFile: '/o' }).graph.includes('amix'), 'level 0: no music');
  assert.throws(() => editLib.soundtrackArgs({ voices: [{ file: '/a' }], timeline: cut, outputFile: '/o' }), /Every scene needs a voice/);
  assert.throws(() => editLib.soundtrackArgs({ voices: [{}, {}, {}], timeline: { ...cut, fps: 29.97 }, outputFile: '/o' }), /does not divide/);
  assert.deepEqual(editLib.MUSIC_LEVELS, { off: 0, quiet: 0.12, medium: 0.25, loud: 0.45 });

  // the loudness: the call that measures, what is read from it, the gain (between -12 and +20 dB, steps of 0.1 dB), the call that applies it
  assert.deepEqual(editLib.loudnessProbeArgs('/f.wav'), ['-nostdin', '-hide_banner', '-nostats', '-i', '/f.wav', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']);
  assert.ok(!editLib.loudnessProbeArgs('/f.wav').includes('-v'), 'no "-v error": loudnorm writes its block at the level info');
  const block = '[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-23.45",\n\t"input_tp" : "-4.50",\n\t"input_lra" : "5.40",\n\t"input_thresh" : "-33.94",\n\t"output_i" : "-16.41",\n\t"target_offset" : "0.41"\n}\n';
  assert.equal(editLib.readLoudness(`Input #0, wav, from 'x.wav':\n  Duration: 00:00:05.00\n${block}[out#0/null @ 0x2] video:0KiB audio:1875KiB`), -23.45);
  assert.equal(editLib.readLoudness(`{"input_i":"-30.1"}\n${block}`), -23.45, 'the last block counts');
  assert.equal(editLib.readLoudness('{broken json}\n{"input_i":"-20.5"}'), -20.5, 'a block that is no JSON is passed over');
  assert.equal(editLib.readLoudness('{"input_i": -19.2}'), -19.2, 'a number as well as a text');
  for (const nothing of ['{"input_i" : "-inf", "input_tp" : "-inf"}', '{"input_i":"inf"}', '{"input_tp":"-3"}', '{"input_i":""}', '{"input_i":"abc"}', '{"input_i":null}', '[1,2]', 'no block at all', '', undefined, null]) {
    assert.equal(editLib.readLoudness(nothing), null, `nothing to read in ${JSON.stringify(nothing)}`);
  }
  assert.equal(editLib.TARGET_LUFS, -16);
  assert.equal(editLib.gainFor(-23), 7);
  assert.equal(editLib.gainFor(-23.04), 7, 'rounded to 0.1 dB');
  assert.equal(editLib.gainFor(-23.06), 7.1);
  assert.equal(editLib.gainFor(-9.3), -6.7);
  assert.equal(editLib.gainFor(-16), 0);
  assert.ok(Object.is(editLib.gainFor(-16.04), 0), 'a gain that rounds to nothing is 0, not -0');
  assert.equal(editLib.gainFor(-36), 20, 'exactly +20 dB is still allowed');
  assert.equal(editLib.gainFor(-40), 20, 'a very quiet sound: at most +20 dB');
  assert.equal(editLib.gainFor(-70), 20);
  assert.equal(editLib.gainFor(-4), -12, 'exactly -12 dB is still allowed');
  assert.equal(editLib.gainFor(-2), -12, 'a very loud sound: at most -12 dB');
  assert.equal(editLib.gainFor(0), -12);
  assert.deepEqual([editLib.GAIN_MIN_DB, editLib.GAIN_MAX_DB], [-12, 20]);
  for (const nothing of [null, undefined, NaN, -Infinity, Infinity, '-20', {}]) assert.equal(editLib.gainFor(nothing), null, `no gain for ${String(nothing)}`);
  assert.deepEqual(editLib.normalizeArgs({ inputFile: '/in.wav', outputFile: '/out.wav', gainDb: 7 }), ['-nostdin', '-v', 'error', '-y', '-i', '/in.wav', '-af', 'volume=7dB,alimiter=limit=0.84:attack=5:release=50:level=disabled', '-c:a', 'pcm_s16le', '-ar', '48000', '/out.wav']);
  assert.equal(editLib.normalizeArgs({ inputFile: 'a', outputFile: 'b', gainDb: -7.3 })[7], 'volume=-7.3dB,alimiter=limit=0.84:attack=5:release=50:level=disabled');
  assert.equal(editLib.normalizeArgs({ inputFile: 'a', outputFile: 'b', gainDb: 0 })[7], 'volume=0dB,alimiter=limit=0.84:attack=5:release=50:level=disabled', 'the limiter works at 0 dB too');
  assert.throws(() => editLib.normalizeArgs({ inputFile: 'a', outputFile: 'b', gainDb: NaN }), /Invalid number/);
  assert.equal(editLib.SOUND_LIMIT, 0.84);
  assert.ok(Math.abs(20 * Math.log10(editLib.SOUND_LIMIT) + 1.5) < 0.05, 'the limit is about -1.5 dBFS');
  assert.equal(editLib.levelNote(7), 'sound: +7.0 dB to -16 LUFS');
  assert.equal(editLib.levelNote(-7.3), 'sound: -7.3 dB to -16 LUFS');
  assert.equal(editLib.levelNote(0), 'sound: +0.0 dB to -16 LUFS');

  // the word times of the scenes in the times of the film
  const first = cuesLib.timingOf([{ text: 'Eins.', start: 0.2, end: 0.6 }, { text: 'Zwei', start: 0.8, end: 1.1 }, { text: 'drei.', start: 1.2, end: 1.6 }], 1.7);
  const second = cuesLib.timingOf([{ text: 'Vier', start: 0.3, end: 0.7 }], 0.8);
  const merged = editLib.mergeTimings([first, cuesLib.silentTiming(4), second], [0, 2.4, 6.9], 9.5);
  assert.equal(merged.duration, 9.5);
  assert.equal(merged.source, 'speech');
  assert.deepEqual(merged.words.map((word) => [word.text, word.start]), [['Eins.', 0.2], ['Zwei', 0.8], ['drei.', 1.2], ['Vier', 7.2]], 'a scene without words adds none');
  assert.deepEqual(merged.words.map((word) => word.line), [0, 1, 1, 2], 'the words keep their lines, counted over the whole film');
  assert.deepEqual(merged.lines.map((line) => [line.text, line.start, line.end]), [['Eins.', 0.2, 0.6], ['Zwei drei.', 0.8, 1.6], ['Vier', 7.2, 7.6]]);

  // the SRT
  assert.equal(editLib.srtTime(3661.0075), '01:01:01,008');
  assert.equal(editLib.srtTime(0), '00:00:00,000');
  assert.equal(editLib.srtTime(-3), '00:00:00,000');
  const srt = editLib.srtOf(merged.lines, 9.5);
  assert.equal(srt, '1\n00:00:00,200 --> 00:00:00,760\nEins.\n\n2\n00:00:00,800 --> 00:00:01,850\nZwei drei.\n\n3\n00:00:07,200 --> 00:00:07,850\nVier\n');
  assert.ok(editLib.srtOf([{ text: 'x', start: 9.4, end: 9.45 }], 9.5).includes('00:00:09,500'), 'the last entry stays inside the film');
  assert.equal(editLib.srtOf([], 5), '');
  assert.equal(editLib.srtOf([{ text: 'late', start: 12, end: 13 }], 9.5), '', 'a line after the end is dropped');

  // the length
  assert.equal(editLib.lengthNote(120, 120), null);
  assert.equal(editLib.lengthNote(137, 120), null, '14 % is inside');
  assert.match(editLib.lengthNote(141, 120), /141 s long, 18 % above the 120 s/);
  assert.match(editLib.lengthNote(90, 120), /90 s long, 25 % below the 120 s/);
  assert.equal(editLib.lengthNote(90, null), null);
  assert.equal(editLib.lengthNote(0, 120), null);

  // a voice that is longer than the frames its scene keeps is cut off by the soundtrack: voiceCuts names it (scene and seconds)
  const cutTimeline = editLib.planTimeline({ durations: [1.2, 2.0, 3.0], fps: 30, transition: 'cut' });
  const notes = editLib.voiceCuts([{ label: 'Scene s1', seconds: 2 }, { label: 'Scene s2', seconds: 1.6 }, null], cutTimeline);
  assert.equal(notes.length, 1, 'only the first voice is cut');
  assert.match(notes[0], /^Scene s1: the voice is 2 s long, but the scene shows 1\.2 s: the last 0\.8 s of the narration are cut off/);
  assert.deepEqual(editLib.voiceCuts([{ label: 'a', seconds: 1.2 }, { label: 'b', seconds: 2.0 }, { label: 'c', seconds: 3.0 }], cutTimeline), [], 'a voice as long as its scene is not cut');
  assert.deepEqual(editLib.voiceCuts([{ label: 'a', seconds: 1.2 + 0.4 / 30 }], editLib.planTimeline({ durations: [1.2], fps: 30, transition: 'cut' })), [], 'less than half a frame is no cut');
  assert.equal(editLib.voiceCuts([{ label: 'a', seconds: 1.2 + 0.7 / 30 }], editLib.planTimeline({ durations: [1.2], fps: 30, transition: 'cut' })).length, 1, 'more than half a frame is');
  // a crossfade takes frames from the end of the scene: the voice has to fit in what the scene keeps
  const faded = editLib.planTimeline({ durations: [2, 2], fps: 30, transition: 'crossfade' });
  assert.ok(faded.owns[0] < faded.frames[0], 'the first scene keeps less than it has');
  assert.equal(editLib.voiceCuts([{ label: 'a', seconds: 2 }, { label: 'b', seconds: 2 }], faded).length, 1, 'the fade eats the end of the first voice');
}

/* ---------- the node ---------- */

async function run(iso) {
  const store = iso.load('lib/store');
  const assets = iso.load('lib/nodes/assets');
  const ffmpegLib = iso.load('lib/ffmpeg');
  const registryModule = iso.load('lib/nodes/registry');
  const editLib = iso.load('lib/explainer-edit');
  const cuesLib = iso.load('lib/explainer-cues');
  const musicEdit = iso.load('lib/music-video-edit');
  const { textValue, listValue } = iso.load('lib/nodes/types');
  const real = registryModule.registry;

  testPure({ editLib, cuesLib, musicEdit });

  const bins = ffmpegLib.binaries();
  if (!bins.available) {
    console.log('ffmpeg not found: the parts with real audio and video are skipped');
    return;
  }

  /* ---------- definition ---------- */

  const def = real.get('explainer.edit');
  assert.equal(def.category, 'edit-video');
  assert.equal(def.paid, false);
  assert.equal(def.cost.unit, 'local');
  assert.ok(def.timeoutMs >= 20 * 60 * 1000, 'a long film may take its time');
  const ports = (list) => list.map((port) => [port.id, port.type, Boolean(port.required), Boolean(port.multiple)]);
  assert.deepEqual(ports(def.inputs), [
    ['scenes', 'video', true, true], ['audio', 'audio', true, true], ['timing', 'text', true, true], ['shots', 'text', true, false],
    ['clips', 'video', false, true], ['music', 'audio', false, false], ['intro', 'video', false, false], ['outro', 'video', false, false]
  ]);
  assert.equal(def.inputs.find((port) => port.id === 'clips').max, 2);
  assert.deepEqual(ports(def.outputs), [['video', 'video', false, false], ['subtitles', 'text', false, false], ['captions', 'text', false, false]]);
  const defaults = real.normalizeParams(def, {});
  assert.deepEqual(defaults, { transition: 'crossfade', resolution: '1080p', fps: '30', captions: 'lines', captions_position: 'bottom', music_level: 'quiet', ducking: true, fade_out: 1, fit: 'crop' });
  assert.deepEqual(def.params.find((param) => param.id === 'music_level').options, ['quiet', 'medium', 'loud']);
  assert.deepEqual(def.params.find((param) => param.id === 'captions').options, ['off', 'lines', 'words']);
  assert.deepEqual(def.params.find((param) => param.id === 'transition').options, ['cut', 'crossfade']);

  /* ---------- helpers ---------- */

  const workDir = await fsp.mkdtemp(path.join(iso.root, 'explainer-edit-'));
  const media = createMedia({ ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe, dir: workDir });
  const session = await store.createSession();
  const sessionId = session.id;
  const otherSession = await store.createSession();
  async function assetOf(bytes, ext, owner = sessionId) {
    const saved = await store.saveAsset(owner, { kind: 'upload', buffer: bytes, ext, prompt: 'seed' });
    return assets.valueFromAsset(owner, saved.id);
  }
  const fileAsset = async (file, owner = sessionId) => assetOf(await fsp.readFile(file), path.extname(file), owner);
  const scratchLeft = async () => (await fsp.readdir(store.sessionAssetDir(sessionId))).filter((name) => name.startsWith('.nodes-'));
  function makeCtx(owner = sessionId) {
    const controller = new AbortController();
    const logs = [];
    return {
      workflowId: 'wf-test',
      runId: 'r-test',
      nodeId: 'n1',
      sessionId: owner,
      user: STAFF,
      config: {},
      signal: controller.signal,
      log: (line) => logs.push(line),
      saveOutputFile: (options) => assets.saveOutputFile(owner, options),
      withLocalSlot: (fn) => fn(),
      logs
    };
  }
  const fileOf = (value) => assets.assetFilePath(value);
  // The cut brings the sound to -16 LUFS and logs the gain ("sound: -7.3 dB to -16 LUFS"). The level assertions of this test were made for the
  // voices and the music as they are made (a tone of 0.5, music at a quarter of that), so the sound of a film is read back by the gain of its
  // log (filmPcm) and the numbers mean what they always meant; that the film is really at -16 LUFS is measured on its own (the loudness
  // tests below), and a gain that the log names wrongly would show in these levels.
  const gains = new Map();
  const gainOf = (ctx) => {
    const found = ctx.logs.map((line) => /^sound: ([+-]\d+(?:\.\d+)?) dB to -16 LUFS$/.exec(line)).find(Boolean);
    return found ? Number(found[1]) : null;
  };
  const exec = async (ctx, inputs, raw = {}) => {
    const result = await def.execute(ctx, inputs, real.normalizeParams(def, { resolution: '720p', captions: 'off', music_level: 'medium', ...raw }));
    gains.set(fileOf(result.variants[0].video), gainOf(ctx));
    return result;
  };
  const filmPcm = async (file) => {
    const pcm = await media.pcm(file);
    const gain = gains.get(file);
    if (typeof gain !== 'number') return pcm;
    const back = 10 ** (-gain / 20);
    return { ...pcm, samples: pcm.samples.map((value) => value * back) };
  };
  // Another meter than the one the node uses (loudnorm): ebur128 gives the integrated loudness (LUFS) and the true peak (dBFS) of a file.
  const meter = async (file) => {
    const { stderr } = await ffmpegLib.runProcess(bins.ffmpeg, ['-nostdin', '-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
    const summary = stderr.slice(stderr.lastIndexOf('Summary'));
    return { lufs: Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)[1]), peak: Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)[1]) };
  };

  // voices: one tone each; the scene is the voice plus 0.4 s
  const TONES = [1000, 1500, 2000, 2500, 3000, 3500];
  const COLOURS = ['ff0000', '00ff00', '0000ff', 'ffff00', 'ff00ff', '00ffff', 'ff8000', '8000ff', '80ff00', '0080ff', 'ff0080', '808080'];
  const wordsOf = (voice) => [
    { text: 'Eins', start: 0.2, end: 0.5 },
    { text: 'zwei.', start: 0.55, end: 0.9 },
    { text: 'Drei', start: Math.min(voice - 0.3, 1.0), end: voice - 0.05 }
  ];
  // A made-up film: scenes with their voices, timings and the shot list.
  async function filmOf(voices, { kinds = [], colours = COLOURS, format = 'landscape', size = '160x90', target = null, tones = TONES } = {}) {
    const scenes = [];
    const audio = [];
    const timing = [];
    for (let index = 0; index < voices.length; index += 1) {
      const voice = voices[index];
      const spoken = voice > 0;
      const seconds = cuesLib.sceneDuration(spoken ? voice : 4);
      scenes.push(await fileAsset(await media.colourClip(colours[index % colours.length], seconds, { size })));
      audio.push(await assetOf(spoken ? toneWav(voice, tones[index % tones.length]) : toneWav(4, 100, { amplitude: 0 }), '.wav'));
      timing.push(textValue(JSON.stringify(spoken ? cuesLib.timingOf(wordsOf(voice).filter((word) => word.end > word.start), voice) : cuesLib.silentTiming(4))));
    }
    const shots = {
      version: 1,
      language: 'de',
      format,
      visual_mode: 'mix',
      duration: 10,
      target_seconds: target,
      scenes: voices.map((voice, index) => ({ id: `s${index + 1}`, index, kind: kinds[index] ? kinds[index].kind : 'motion', role: 'point', est_seconds: 5, spoken: voice > 0, narration: index, brief: index, image: null, clip: kinds[index] && kinds[index].clip !== undefined ? kinds[index].clip : null }))
    };
    return {
      voices,
      inputs: { scenes: listValue('video', scenes), audio: listValue('audio', audio), timing: listValue('text', timing), shots: textValue(JSON.stringify(shots)) },
      scenes,
      audio,
      timing,
      shots
    };
  }
  const withInputs = (film, extra) => ({ ...film.inputs, ...extra });
  const frameOf = (seconds) => Math.round(seconds * 30);

  /* ---------- the voices stand at the start of their scene: cut ---------- */

  const voices = [2.0, 1.5, 2.5];
  const film = await filmOf(voices);
  {
    const ctx = makeCtx();
    const result = await exec(ctx, film.inputs, { transition: 'cut', fps: '30' });
    const out = result.variants[0];
    const file = fileOf(out.video);
    const info = await media.probe(file);
    assert.equal(info.width, 1280);
    assert.equal(info.height, 720);
    assert.equal(info.fps, 30);
    near(info.frames, 216, 1, 'the frames of the three scenes');
    near(info.duration, 7.2, 0.06);
    assert.ok(info.hasAudio);
    near(info.audioDuration, 7.2, 0.08, 'the sound is as long as the film');
    // the pictures
    assert.equal(await media.colourAt(file, 1.0), COLOURS[0]);
    assert.equal(await media.colourAt(file, 3.0), COLOURS[1]);
    assert.equal(await media.colourAt(file, 5.5), COLOURS[2]);
    // the voices: each begins exactly where its scene begins, ends with its length, and the 0.4 s after it are silent
    const { samples, rate } = await filmPcm(file);
    const starts = [0, 2.4, 4.3];
    voices.forEach((voice, index) => {
      const onset = onsetOf(samples, rate, TONES[index], { from: Math.max(0, starts[index] - 0.2) });
      near(onset, starts[index], 0.03, `voice ${index + 1} begins with its scene`);
      const end = endOf(samples, rate, TONES[index]);
      near(end, starts[index] + voice, 0.03, `voice ${index + 1} is as long as it is`);
      assert.ok(amplitudeAt(samples, rate, TONES[index], starts[index] + voice + 0.05, starts[index] + voice + 0.35) < 0.02, `silence after voice ${index + 1}`);
      for (let other = 0; other < 3; other += 1) {
        if (other !== index) assert.ok(amplitudeAt(samples, rate, TONES[other], starts[index] + 0.2, starts[index] + voice - 0.2) < 0.02, `only voice ${index + 1} speaks in its scene`);
      }
    });
    near(amplitudeAt(samples, rate, 1000, 0.3, 1.8), 0.5, 0.06, 'the voice is not changed in level');
    // the log: real length, and no warning without a wish
    assert.ok(ctx.logs.some((line) => /3 scenes, 7.2 s at 30 fps, 1280x720/.test(line)), ctx.logs.join(' | '));
    assert.ok(!ctx.logs.some((line) => /Warning/.test(line)));
    // the sound: the log names the gain, and another meter finds the film at -16 LUFS, under the limit of -1.5 dBFS (a little more for the
    // encoder)
    assert.equal(ctx.logs.filter((line) => /^sound: /.test(line)).length, 1, 'one line about the sound');
    assert.match(ctx.logs.find((line) => /^sound: /.test(line)), /^sound: -\d+\.\d dB to -16 LUFS$/, 'the tones of the test are loud: the film is made quieter');
    const loudFilm = await meter(file);
    near(loudFilm.lufs, -16, 1.5, `the film is at -16 LUFS: ${loudFilm.lufs}`);
    assert.ok(loudFilm.peak < -1, `the peak stays under the limit: ${loudFilm.peak} dBFS`);
    assert.deepEqual(await scratchLeft(), [], 'no scratch folder is left');
    // the subtitles and the captions of the film
    const lines = out.subtitles.value.split('\n\n');
    assert.ok(lines.length >= 3, out.subtitles.value);
    assert.match(lines[0], /^1\n00:00:00,200 --> /);
    const captions = JSON.parse(out.captions.value);
    assert.equal(captions.duration, 7.2);
    assert.equal(captions.words.length, 9);
    near(captions.words[3].start, 2.4 + 0.2, 0.001, 'the first word of scene 2 is shifted by the start of its scene');
    near(captions.words[6].start, 4.3 + 0.2, 0.001);
    assert.equal(out.subtitles.value.split('\n').filter((line) => /-->/.test(line)).length, captions.lines.length);
  }

  /* ---------- crossfade: shorter by the overlap, the voice at the beginning of the picture ---------- */

  {
    const ctx = makeCtx();
    const result = await exec(ctx, film.inputs, { transition: 'crossfade', fps: '30' });
    const file = fileOf(result.variants[0].video);
    const info = await media.probe(file);
    near(info.frames, 200, 1, 'three scenes, two fades of 8 frames');
    near(info.duration, 200 / 30, 0.06);
    const starts = [0, 64 / 30, 113 / 30];
    const { samples, rate } = await filmPcm(file);
    voices.forEach((voice, index) => {
      near(onsetOf(samples, rate, TONES[index], { from: Math.max(0, starts[index] - 0.2) }), starts[index], 0.03, `voice ${index + 1} at the start of its picture`);
      near(endOf(samples, rate, TONES[index]), starts[index] + voice, 0.03);
    });
    // the picture fades: before the fade the first scene, in the middle of it a mix, after it the second
    assert.equal(await media.colourAt(file, starts[1] - 0.1), COLOURS[0]);
    const [r, g] = await media.rgbAt(file, starts[1] + 4 / 30);
    assert.ok(r > 40 && g > 40 && r < 215 && g < 215, `a mix of red and green in the middle of the fade: ${r},${g}`);
    assert.equal(await media.colourAt(file, starts[1] + 0.5), COLOURS[1]);
    assert.equal(await media.colourAt(file, starts[2] + 0.5), COLOURS[2]);
    const captions = JSON.parse(result.variants[0].captions.value);
    near(captions.words[3].start, starts[1] + 0.2, 0.001, 'the captions follow the voice, not the cut');
    assert.equal(captions.duration, 6.667);
    assert.ok(ctx.logs.some((line) => /3 scenes, 6.7 s at 30 fps/.test(line)), ctx.logs.join(' | '));
    assert.deepEqual(await scratchLeft(), []);
  }

  /* ---------- 12 scenes: cut in batches, no drift ---------- */

  {
    const many = Array.from({ length: 12 }, () => 1.0);
    const bigFilm = await filmOf(many);
    const ctx = makeCtx();
    const result = await exec(ctx, bigFilm.inputs, { transition: 'crossfade', fps: '30' });
    const file = fileOf(result.variants[0].video);
    const timeline = editLib.planTimeline({ durations: many.map((voice) => cuesLib.sceneDuration(voice)), fps: 30, transition: 'crossfade' });
    const info = await media.probe(file);
    near(info.frames, timeline.totalFrames, 1);
    const { samples, rate } = await filmPcm(file);
    for (let index = 0; index < 12; index += 1) {
      const start = timeline.starts[index] / 30;
      const frequency = TONES[index % TONES.length];
      near(onsetOf(samples, rate, frequency, { from: Math.max(0, start - 0.2) }), start, 0.03, `scene ${index + 1} of 12: the voice is where the picture is`);
      assert.equal(await media.colourAt(file, start + 0.3 + (index === 0 ? 0 : 0)), COLOURS[index], `scene ${index + 1} of 12: its picture`);
    }
    assert.ok(ctx.logs.some((line) => /batches/.test(line)), `many scenes are cut in batches: ${ctx.logs.join(' | ')}`);
    assert.deepEqual(await scratchLeft(), []);
  }

  /* ---------- the sources card has no voice: silence, no words ---------- */

  const withCard = await filmOf([2.0, 1.0, 0]);
  {
    const result = await exec(makeCtx(), withCard.inputs, { transition: 'cut', fps: '30' });
    const file = fileOf(result.variants[0].video);
    const info = await media.probe(file);
    near(info.duration, 2.4 + 1.4 + 4.4, 0.1);
    const captions = JSON.parse(result.variants[0].captions.value);
    assert.equal(captions.words.length, 6, 'the card adds no words');
  }

  /* ---------- the loudness: a quiet sound is brought to -16 LUFS, a loud one down, the limiter holds the peaks ---------- */

  {
    // the helpers on real files, measured with the other meter: a sine at -30 dBFS (about -33 LUFS) goes up by 17 dB, a loud one down by the
    // 12 dB that are allowed at most
    const through = async (name, amplitude, { frequency = 1000, gainDb = null } = {}) => {
      const input = path.join(workDir, `${name}.wav`);
      await fsp.writeFile(input, toneWav(6, frequency, { amplitude }));
      const before = await meter(input);
      const measured = editLib.readLoudness((await ffmpegLib.runProcess(bins.ffmpeg, editLib.loudnessProbeArgs(input))).stderr);
      const gain = gainDb === null ? editLib.gainFor(measured) : gainDb;
      const output = path.join(workDir, `${name}-level.wav`);
      await ffmpegLib.runProcess(bins.ffmpeg, editLib.normalizeArgs({ inputFile: input, outputFile: output, gainDb: gain }));
      return { before, measured, gain, after: await meter(output), samples: (await media.pcm(output)).samples };
    };
    const quietSine = await through('quiet-sine', 10 ** (-30 / 20));
    near(quietSine.measured, quietSine.before.lufs, 0.3, 'loudnorm and ebur128 agree on the loudness of the sound');
    near(quietSine.gain, 17, 0.5);
    near(quietSine.after.lufs, -16, 1.5, `a sine at -30 dBFS is brought to -16 LUFS: ${quietSine.after.lufs}`);
    const loudSine = await through('loud-sine', 0.9);
    assert.equal(loudSine.gain, -12, 'a sound that is 12 dB or more above the target is lowered by 12 dB');
    near(loudSine.after.lufs, loudSine.before.lufs - 12, 0.3, 'by exactly the gain');
    near(loudSine.after.lufs, -16, 1.5);
    // the limiter: 6 dB more than the sound has room for is held under 0.84 (about -1.5 dBFS), not cut off flat
    const limited = await through('limited-sine', 0.5, { gainDb: 6 });
    assert.ok(limited.after.peak <= -1.2, `held under the limit: ${limited.after.peak} dBFS`);
    const top = limited.samples.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
    assert.ok(top <= 0.85 && top > 0.7, `the highest sample is at the limit of 0.84: ${top}`);
    // and a sound that is at the target already (a sine whose peak is at -13 dBFS: -16 LUFS) is left where it is
    const even = await through('even-sine', 10 ** (-13 / 20));
    near(even.after.lufs, -16, 1.5);
    assert.ok(Math.abs(even.gain) <= 0.5 + 1e-9, `already near the target: ${even.gain} dB`);

    // a film without any sound to measure (silent scenes only): the film is made, the log says that the sound stays as it is
    const mute = await filmOf([0, 0]);
    const muteCtx = makeCtx();
    const muteResult = await exec(muteCtx, mute.inputs, { transition: 'cut', fps: '30' });
    assert.ok(muteCtx.logs.some((line) => /^sound: the loudness could not be measured \(no sound to measure\): left as it is$/.test(line)), muteCtx.logs.join(' | '));
    assert.ok(!muteCtx.logs.some((line) => /dB to -16 LUFS/.test(line)));
    assert.ok((await media.probe(fileOf(muteResult.variants[0].video))).hasAudio, 'the film has its (silent) sound');
    assert.deepEqual(await scratchLeft(), []);

    // a call that fails does not end the node: the sound stays as it is, the log says why. Once for the measuring, once for the change.
    const realRun = ffmpegLib.runProcess;
    const failing = (text) => async (command, args, options) => {
      if (args.some((arg) => String(arg).includes(text))) throw new Error(`ffmpeg ist fehlgeschlagen (Exit 1): No such filter: ${text}`);
      return realRun(command, args, options);
    };
    const quietFilm = await filmOf([2.0, 1.5]);
    for (const text of ['loudnorm', 'alimiter']) {
      ffmpegLib.runProcess = failing(text);
      let broken;
      try {
        broken = makeCtx();
        const result = await exec(broken, quietFilm.inputs, { transition: 'cut', fps: '30' });
        const file = fileOf(result.variants[0].video);
        assert.ok(broken.logs.some((line) => new RegExp(`^sound: the loudness could not be set \\(ffmpeg ist fehlgeschlagen \\(Exit 1\\): No such filter: ${text}\\): left as it is$`).test(line)), broken.logs.join(' | '));
        assert.equal(gains.get(file), null, 'no gain was applied');
        const level = amplitudeAt((await media.pcm(file)).samples, 48000, 1000, 0.3, 1.8);
        near(level, 0.5, 0.06, `${text} fails: the voice is at the level it has been made with`);
      } finally {
        ffmpegLib.runProcess = realRun;
      }
      assert.deepEqual(await scratchLeft(), []);
    }
    // the end of the run is not a failure to be passed over: an abort ends the node
    const stopping = makeCtx();
    const controller = new AbortController();
    stopping.signal = controller.signal;
    ffmpegLib.runProcess = async (command, args, options) => {
      if (args.some((arg) => String(arg).includes('loudnorm'))) {
        controller.abort();
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      return realRun(command, args, options);
    };
    try {
      const aborted = await errorOf(exec(stopping, quietFilm.inputs, { transition: 'cut', fps: '30' }));
      assert.ok(aborted, 'an abort while the sound is measured ends the node');
      assert.ok(!stopping.logs.some((line) => /left as it is/.test(line)), 'and is not taken for a failed measurement');
    } finally {
      ffmpegLib.runProcess = realRun;
    }
    assert.deepEqual(await scratchLeft(), []);
  }

  /* ---------- music ---------- */

  {
    const music = await assetOf(toneWav(1.0, 200, { amplitude: 0.5 }), '.wav');
    // a film with a silent card at the end: there the music is back at its own level
    const cardFilm = await filmOf([2.0, 1.5, 0]);
    const run = async (extra, raw = {}) => {
      const result = await exec(makeCtx(), withInputs(cardFilm, { music, ...extra }), { transition: 'cut', fps: '30', fade_out: 0, ...raw });
      const file = fileOf(result.variants[0].video);
      return { ...(await filmPcm(file)), info: await media.probe(file) };
    };
    const cardStart = 2.4 + 1.9;
    const medium = await run({}, { music_level: 'medium', ducking: false });
    const duckingOff = {
      voice: amplitudeAt(medium.samples, medium.rate, 200, 0.3, 1.8),
      card: amplitudeAt(medium.samples, medium.rate, 200, cardStart + 1.0, cardStart + 3.5)
    };
    near(duckingOff.card, 0.5 * 0.25, 0.02, 'the music at a quarter of its level, in the silence of the card');
    near(duckingOff.voice, duckingOff.card, 0.02, 'without ducking the music stays where it is under the voice');
    near(amplitudeAt(medium.samples, medium.rate, 1000, 0.3, 1.8), 0.5, 0.06, 'the voice is not changed in level by the music');
    near(medium.info.duration, 2.4 + 1.9 + 4.4, 0.1);
    // the music is only 1 s long: it is looped under the whole film
    assert.ok(amplitudeAt(medium.samples, medium.rate, 200, cardStart + 3.0, cardStart + 3.9) > 0.05, 'the music runs to the end of the film');

    const ducked = await run({}, { music_level: 'medium', ducking: true });
    const duckedVoice = amplitudeAt(ducked.samples, ducked.rate, 200, 0.3, 1.8);
    const duckedCard = amplitudeAt(ducked.samples, ducked.rate, 200, cardStart + 1.0, cardStart + 3.5);
    assert.ok(duckedVoice < 0.5 * duckingOff.voice, `the music gives way under the voice: ${duckedVoice} against ${duckingOff.voice}`);
    near(duckedCard, duckingOff.card, 0.025, 'and comes back where nobody speaks');
    near(amplitudeAt(ducked.samples, ducked.rate, 1000, 0.3, 1.8), 0.5, 0.06, 'the voice is the same with ducking');

    const quiet = await run({}, { music_level: 'quiet', ducking: false });
    const loud = await run({}, { music_level: 'loud', ducking: false });
    const level = (result) => amplitudeAt(result.samples, result.rate, 200, cardStart + 1.0, cardStart + 3.5);
    near(level(quiet), 0.5 * 0.12, 0.015);
    near(level(loud), 0.5 * 0.45, 0.03);
    assert.ok(level(loud) > 3 * level(quiet));
    // no music: nothing at that pitch
    const none = await exec(makeCtx(), cardFilm.inputs, { transition: 'cut', fps: '30', fade_out: 0 });
    const noMusic = await filmPcm(fileOf(none.variants[0].video));
    assert.ok(amplitudeAt(noMusic.samples, noMusic.rate, 200, cardStart + 1.0, cardStart + 3.5) < 0.005);
    // the fade-out at the end takes the sound down with the picture
    const faded = await exec(makeCtx(), withInputs(cardFilm, { music }), { transition: 'cut', fps: '30', fade_out: 2, music_level: 'loud', ducking: false });
    const fadedAudio = await filmPcm(fileOf(faded.variants[0].video));
    const total = (await media.probe(fileOf(faded.variants[0].video))).duration;
    assert.ok(amplitudeAt(fadedAudio.samples, fadedAudio.rate, 200, total - 0.3, total - 0.05) < 0.5 * amplitudeAt(fadedAudio.samples, fadedAudio.rate, 200, cardStart + 1, cardStart + 1.25));
    assert.deepEqual(await scratchLeft(), []);
  }

  /* ---------- intro and outro: hard cuts, their own sound ---------- */

  {
    const introAudio = path.join(workDir, 'intro.wav');
    const outroAudio = path.join(workDir, 'outro.wav');
    await fsp.writeFile(introAudio, toneWav(2.0, 700));
    await fsp.writeFile(outroAudio, toneWav(1.5, 900));
    const intro = await fileAsset(await media.colourClip('c0c0c0', 2.0, { audioFile: introAudio }));
    const outro = await fileAsset(await media.colourClip('808080', 1.5, { audioFile: outroAudio }));
    const twoScenes = await filmOf([2.0, 1.5]);
    const ctx = makeCtx();
    const result = await exec(ctx, withInputs(twoScenes, { intro, outro }), { transition: 'crossfade', fps: '30', fade_out: 0 });
    const file = fileOf(result.variants[0].video);
    const info = await media.probe(file);
    // 60 + 72 + 57 + 45 frames, less one frame at each hard cut and the fade between the scenes
    near(info.frames, 224, 1);
    const { samples, rate } = await filmPcm(file);
    near(onsetOf(samples, rate, 700), 0, 0.03, 'the intro speaks from the first moment');
    near(endOf(samples, rate, 700), 59 / 30, 0.05, 'its sound is not faded away (one frame is the price of a hard cut)');
    near(onsetOf(samples, rate, 1000, { from: 1.5 }), 59 / 30, 0.03, 'the first voice comes with the first scene');
    near(onsetOf(samples, rate, 1500, { from: 3.5 }), 123 / 30, 0.03, 'the second voice at the start of its scene');
    near(onsetOf(samples, rate, 900, { from: 5 }), 179 / 30, 0.03, 'the outro begins where its picture begins');
    near(endOf(samples, rate, 900), 179 / 30 + 1.5, 0.05);
    assert.equal(await media.colourAt(file, 1.0), 'c0c0c0');
    assert.equal(await media.colourAt(file, 3.0), COLOURS[0]);
    assert.equal(await media.colourAt(file, info.duration - 0.5), '808080');
    // no fade between the person and a scene: the picture changes within a frame
    assert.equal(await media.colourAt(file, 59 / 30 - 0.04), 'c0c0c0');
    assert.equal(await media.colourAt(file, 59 / 30 + 0.1), COLOURS[0]);
    // the captions only carry the words of the scenes, after the intro
    const captions = JSON.parse(result.variants[0].captions.value);
    near(captions.words[0].start, 59 / 30 + 0.2, 0.002);
    assert.ok(ctx.logs.some((line) => /with intro and outro/.test(line)));
    // an intro without a sound is silence at its place
    const silentIntro = await fileAsset(await media.colourClip('c0c0c0', 2.0));
    const silent = await exec(makeCtx(), withInputs(twoScenes, { intro: silentIntro }), { transition: 'cut', fps: '30' });
    const silentSound = await filmPcm(fileOf(silent.variants[0].video));
    near(onsetOf(silentSound.samples, silentSound.rate, 1000), 2.0, 0.03, 'the first voice after two seconds of silence');
    assert.deepEqual(await scratchLeft(), []);
  }

  /* ---------- clips by the shots: trimmed, slowed down, held ---------- */

  {
    // the scenes 2 and 3 are clip scenes: their stand-in is what the scene node made, the clips come from the clips input
    const kinds = [{ kind: 'motion' }, { kind: 'clip', clip: 0 }, { kind: 'clip', clip: 1 }];
    const clipFilm = await filmOf([2.0, 4.0, 4.0], { kinds });
    // slow: 3.6 s (red then blue at 1.8 s) for 4.4 s; hold: 2 s (red then blue at 1 s)
    const slow = await fileAsset(await media.colourClip('ff0000', 3.6, { second: '0000ff', switchAt: 1.8 }));
    const hold = await fileAsset(await media.colourClip('ff0000', 2.0, { second: '0000ff', switchAt: 1.0 }));
    const ctx = makeCtx();
    const result = await exec(ctx, withInputs(clipFilm, { clips: listValue('video', [slow, hold]) }), { transition: 'cut', fps: '30', fade_out: 0 });
    const file = fileOf(result.variants[0].video);
    const info = await media.probe(file);
    near(info.duration, 2.4 + 4.4 + 4.4, 0.08, 'the clips take the length of the scenes they stand in for');
    const secondStart = 2.4;
    const thirdStart = 2.4 + 4.4;
    // slowed to 4.4 s: the switch moves from 1.8 s to 2.2 s
    assert.equal(await media.colourAt(file, secondStart + 2.0), 'ff0000');
    assert.equal(await media.colourAt(file, secondStart + 2.45), '0000ff');
    assert.equal(await media.colourAt(file, secondStart + 4.3), '0000ff', 'the slowed clip fills its scene');
    // too short even slowed to 0.8: it runs at 0.8 (the switch at 1.25 s) and holds its last frame
    assert.equal(await media.colourAt(file, thirdStart + 1.1), 'ff0000');
    assert.equal(await media.colourAt(file, thirdStart + 1.4), '0000ff');
    assert.equal(await media.colourAt(file, thirdStart + 4.3), '0000ff', 'the last frame is held to the end of the scene');
    // the voice of a clip scene is the voice of the scene
    const { samples, rate } = await filmPcm(file);
    near(onsetOf(samples, rate, TONES[1], { from: secondStart - 0.2 }), secondStart, 0.03);
    near(onsetOf(samples, rate, TONES[2], { from: thirdStart - 0.2 }), thirdStart, 0.03);

    // trimmed: a clip of 6 s (red, blue from 3 s) is cut off at 4.4 s, not slowed down
    const long = await fileAsset(await media.colourClip('ff0000', 6.0, { second: '0000ff', switchAt: 3.0 }));
    const trimFilm = await filmOf([2.0, 4.0], { kinds: [{ kind: 'motion' }, { kind: 'clip', clip: 0 }] });
    const trimmed = await exec(makeCtx(), withInputs(trimFilm, { clips: listValue('video', [long]) }), { transition: 'cut', fps: '30', fade_out: 0 });
    const trimmedFile = fileOf(trimmed.variants[0].video);
    near((await media.probe(trimmedFile)).duration, 2.4 + 4.4, 0.08);
    assert.equal(await media.colourAt(trimmedFile, 2.4 + 2.8), 'ff0000');
    assert.equal(await media.colourAt(trimmedFile, 2.4 + 3.2), '0000ff', 'cut off, not slowed: the switch stays at 3 s');
    // a clip scene without its clip: the plain scene stays, and the log says so
    const missing = makeCtx();
    const kept = await exec(missing, trimFilm.inputs, { transition: 'cut', fps: '30' });
    assert.ok(missing.logs.some((line) => /plan wants a clip but none arrived/.test(line)));
    assert.equal(await media.colourAt(fileOf(kept.variants[0].video), 2.4 + 1), COLOURS[1]);
    assert.deepEqual(await scratchLeft(), []);
  }

  /* ---------- the two formats ---------- */

  {
    const portrait = await filmOf([1.5, 1.5], { format: 'portrait', size: '90x160' });
    const result = await exec(makeCtx(), portrait.inputs, { transition: 'cut', fps: '30' });
    const info = await media.probe(fileOf(result.variants[0].video));
    assert.deepEqual([info.width, info.height], [720, 1280], '9:16');
    const wide = await media.probe(fileOf((await exec(makeCtx(), film.inputs, { transition: 'cut', fps: '30', resolution: '1080p' })).variants[0].video));
    assert.deepEqual([wide.width, wide.height], [1920, 1080], '16:9 at 1080p');
    const fps25 = await media.probe(fileOf((await exec(makeCtx(), film.inputs, { transition: 'cut', fps: '25' })).variants[0].video));
    assert.equal(fps25.fps, 25);
    near(fps25.duration, 7.2, 0.1);
  }

  /* ---------- a voice longer than its scene: the cut is told ---------- */

  {
    const long = await filmOf([2.0, 1.5]);
    const shorter = await fileAsset(await media.colourClip('ff0000', 1.2, { size: '160x90' }));
    const ctx = makeCtx();
    await exec(ctx, withInputs(long, { scenes: listValue('video', [shorter, long.scenes[1]]) }), { transition: 'cut', fps: '30' });
    const warnings = ctx.logs.filter((line) => /^Warning: Scene s1: the voice is 2 s long, but the scene shows 1\.2 s: the last 0\.8 s of the narration are cut off/.test(line));
    assert.equal(warnings.length, 1, ctx.logs.join(' | '));
    assert.ok(!ctx.logs.some((line) => /Scene s2: the voice/.test(line)), 'the second scene is as long as its voice');
    const quiet = makeCtx();
    await exec(quiet, long.inputs, { transition: 'cut', fps: '30' });
    assert.ok(!quiet.logs.some((line) => /narration are cut off/.test(line)), 'scenes that fit say nothing');
  }

  /* ---------- the length against the target ---------- */

  {
    const ctx = makeCtx();
    const far = await filmOf([2.0, 1.5], { target: 100 });
    await exec(ctx, far.inputs, { transition: 'cut', fps: '30' });
    assert.ok(ctx.logs.some((line) => /^Warning: The film is 4 s long, 96 % below the 100 s that were asked for/.test(line)), ctx.logs.join(' | '));
    const close = makeCtx();
    const near5 = await filmOf([2.0, 1.5], { target: 4.2 });
    await exec(close, near5.inputs, { transition: 'cut', fps: '30' });
    assert.ok(!close.logs.some((line) => /Warning/.test(line)));
    assert.ok(close.logs.some((line) => /Length of the scenes: 4 s, asked for 4 s/.test(line)), close.logs.join(' | '));
  }

  /* ---------- errors ---------- */

  {
    const mismatch = await errorOf(exec(makeCtx(), { ...film.inputs, audio: listValue('audio', film.audio.slice(0, 2)) }, {}));
    assert.equal(mismatch.code, 'EXPLAINER_EDIT_MISMATCH');
    assert.deepEqual(mismatch.data, { scenes: 3, audio: 2, timing: 3, shots: 3 });
    const noShots = await errorOf(exec(makeCtx(), { ...film.inputs, shots: textValue('{"scenes":[]}') }, {}));
    assert.equal(noShots.code, 'EXPLAINER_SHOTS_INVALID');
    assert.equal((await errorOf(exec(makeCtx(), { ...film.inputs, shots: textValue('nonsense') }, {}))).code, 'EXPLAINER_SHOTS_INVALID');
    const badTiming = await errorOf(exec(makeCtx(), { ...film.inputs, timing: listValue('text', [textValue('x'), film.timing[1], film.timing[2]]) }, {}));
    assert.equal(badTiming.code, 'EXPLAINER_TIMING_INVALID');
    assert.match(badTiming.message, /timing 1/);
    const noPicture = await errorOf(exec(makeCtx(), { ...film.inputs, scenes: listValue('video', [await assetOf(toneWav(1, 500), '.wav'), film.scenes[1], film.scenes[2]]) }, {}));
    assert.ok(noPicture, 'a file without a picture is refused');
    assert.equal(noPicture.code, 'EXPLAINER_EDIT_NO_VIDEO');
    const foreign = await errorOf(exec(makeCtx(), { ...film.inputs, music: await assetOf(toneWav(1, 200), '.wav', otherSession.id) }, {}));
    assert.match(foreign.message, /belongs to another session/);
    assert.deepEqual(await scratchLeft(), [], 'a refused run leaves nothing behind');
    // an abort in the middle: nothing is made, nothing is left
    const aborting = makeCtx();
    const controller = new AbortController();
    aborting.signal = controller.signal;
    const pending = exec(aborting, film.inputs, { transition: 'crossfade', fps: '30' });
    controller.abort();
    assert.ok(await errorOf(pending), 'an abort ends the node');
    assert.deepEqual(await scratchLeft(), []);
  }

  /* ---------- the captions ---------- */

  {
    const standIn = await createAssStandIn(workDir, { real: bins.ffmpeg });
    const original = process.env.FFMPEG_PATH;
    const use = (file) => {
      if (file === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = file;
      ffmpegLib.resetFilterCache();
    };
    restorers.push(() => use(original));
    const hasLibass = ffmpegLib.hasFilter('ass');
    if (!hasLibass) {
      // an ffmpeg without libass: the plan is refused before anything is made
      const issues = def.validate(real.normalizeParams(def, { captions: 'lines' }), {});
      assert.equal(issues.length, 1);
      assert.equal(issues[0].code, 'CAPTIONS_NO_LIBASS');
      assert.deepEqual(def.validate(real.normalizeParams(def, { captions: 'off' }), {}), []);
      const refused = await errorOf(exec(makeCtx(), film.inputs, { captions: 'lines', transition: 'cut', fps: '30' }));
      assert.equal(refused.code, 'CAPTIONS_NO_LIBASS');
      // off: no script, the film is made
      const off = await exec(makeCtx(), film.inputs, { captions: 'off', transition: 'cut', fps: '30' });
      assert.ok(off.variants[0].video);
    }
    use(standIn.file);
    await standIn.reset();
    assert.deepEqual(def.validate(real.normalizeParams(def, { captions: 'lines' }), {}), [], 'with the filter (the stand-in lists it) the plan is accepted');
    const ctx = makeCtx();
    const result = await exec(ctx, film.inputs, { captions: 'lines', transition: 'crossfade', fps: '30', captions_position: 'middle' });
    const scripts = await standIn.scripts();
    assert.equal(scripts.length, 1, 'ONE script for the encoder');
    const ass = parseAss(scripts[0].text);
    assert.equal(ass.info.PlayResX, '1280');
    assert.equal(ass.info.PlayResY, '720');
    assert.ok(ass.events.length >= 3);
    // the first event of the second scene begins at its scene start (64 frames) plus the first word (0.2 s) less the lead-in of a caption
    // line, in hundredths (a line is shown a little before its first word)
    const starts = ass.events.map((event) => event.start);
    const lead = iso.load('lib/captions-ass').LEAD_IN_SEC;
    assert.ok(starts.some((start) => start >= Math.round((64 / 30 + 0.2 - lead) * 100) - 3 && start <= Math.round((64 / 30 + 0.2) * 100) + 3), `the captions of scene 2 begin around its first word, shifted by the start of the scene: ${starts}`);
    assert.ok(starts.every((start, index) => index === 0 || start >= starts[index - 1]), 'in order');
    assert.ok(ctx.logs.some((line) => /captions \(lines\)/.test(line)));
    assert.ok(result.variants[0].subtitles.value.includes('-->'));
    // words: the same words, one event per word or per line as the style says
    await standIn.reset();
    await exec(makeCtx(), film.inputs, { captions: 'words', transition: 'cut', fps: '30' });
    assert.equal((await standIn.scripts()).length, 1);
    // a film without any word: the captions are on, but there is nothing to burn in
    await standIn.reset();
    const card = makeCtx();
    const cardOnly = await filmOf([0, 0]);
    await exec(card, cardOnly.inputs, { captions: 'lines', transition: 'cut', fps: '30' });
    assert.deepEqual(await standIn.scripts(), []);
    assert.ok(card.logs.some((line) => /No words to show/.test(line)));
    use(original);
  }
}

async function main() {
  const iso = await createIsolatedApp({ env: { ADMIN_EMAILS: 'admin@example.com', SUPERADMIN_EMAILS: '', INTERNAL_EMAIL_DOMAINS: 'staff.example.com', GTS_API_TOKEN: '', PUBLIC_BASE_URL: '' } });
  try {
    await run(iso);
  } finally {
    restoreAll();
    await iso.cleanup();
  }
  console.log('test-explainer-edit.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
