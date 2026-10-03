'use strict';

// The music video nodes and their starter workflow (WP34): audio.beats, audio.lyrics_timing, music_video.plan and music_video.edit
// (lib/nodes/nodes-music-video.js) and the template "Music video from a song". What is covered:
//   - the texts of the four nodes and of their messages in German, English and Spanish, and that they follow the constants
//   - the definitions: ports, parameters and their ranges, validation (the stable codes), the price of the timing by the length
//   - the tool lyrics_timing (lib/tools.js) with ElevenLabs replaced: align and transcribe, the cost journal, every refusal before
//     anything is sent, the budget of participants, the key never in a message, node view only
//   - the planning node with the language model replaced: a good answer, a bad one then a good one, two bad ones (plain prompts),
//     a partial one, share 0 (empty lists), no lyric times, abort, and the song slices (exact to the sample)
//   - the cutting node on lavfi clips: every scene shows its own clip (by colour), the length, the sound, a clip that is too short,
//     crossfade, and the codes of a wrong number of clips; a film of nine scenes, which is cut in batches (a few scenes per process, one
//     encoder), with the log, an abort and a batch that is killed in the middle (no scratch folder is left, no asset is made)
//   - the template through the real engine: the real nodes for the song, the times, the plan and the cut, doubles only for the
//     three provider nodes (image, video, lip sync); the lists keep their order from the plan to the cut, a share of 0 and a song
//     without lyric times give empty lists and still a video, the prices before and after the plan has run
//   - the captions of the template (WP35): the lyric times reach the cut as ONE script for the encoder, an instrumental song and the
//     switch "off" give no script, an ffmpeg without libass refuses the plan before anything is paid; the variant of the template with
//     moving images runs through the engine with the real zoom node (the cut runs with a stand-in for libass, see the comment there)
//   - the Director's way: the run service prepares the template, asks for what is missing, and shows the plan with the unknown prices
// A private copy of the app runs in a temp directory (own data folders). ElevenLabs, the language model and the provider nodes are
// replaced, and a fetch guard refuses everything except localhost: nothing is paid and nothing leaves the machine. The parts that
// need ffmpeg are skipped when it is missing.

const assert = require('assert/strict');
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const vm = require('vm');
const { promisify } = require('util');

const { createIsolatedApp } = require('./support/isolated-app');
const { createAssStandIn, createFakeFfmpeg } = require('./support/fake-ffmpeg');
const { parseAss, lex } = require('./support/ass-reader');

const execFileAsync = promisify(execFile);
const ADMIN = 'admin@example.com';
const STAFF = 'staff1@staff.example.com';
const P1 = 'p1@gmail.example';
const P2 = 'p2@gmail.example';
const KEY = 'el-secret-key-0123456789';
const root = path.resolve(__dirname, '..');

const near = (actual, expected, tolerance, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} !== ${expected} (±${tolerance})`.trim());

const restorers = [];
function patch(target, key, value) {
  const original = target[key];
  target[key] = value;
  restorers.push(() => {
    target[key] = original;
  });
}
function restoreAll() {
  while (restorers.length) restorers.pop()();
}

// Nothing but localhost may be reached, whatever a code path tries.
function guardFetch() {
  const original = global.fetch;
  const attempts = [];
  global.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
      attempts.push(url);
      return Promise.reject(new Error(`network access refused in the test: ${url}`));
    }
    return original(input, init);
  };
  return {
    attempts,
    restore() {
      global.fetch = original;
    }
  };
}

/* ---------- the audio and the colours ---------- */

// 16 bit mono PCM as a WAV file
function wavFile(samples, rate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[index] * 32767))), index * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const RATE = 22050;
// A made-up song: a click at every beat of 120 BPM (the first at 0.3 s) over a quiet, slowly changing tone, so that every slice of it
// is different from every other.
function songSamples(seconds, { bpm = 120 } = {}) {
  const samples = new Float32Array(Math.round(seconds * RATE));
  for (let index = 0; index < samples.length; index += 1) samples[index] = 0.05 * Math.sin((2 * Math.PI * (200 + 3 * (index / RATE))) * (index / RATE));
  for (let time = 0.3; time < seconds - 0.05; time += 60 / bpm) {
    const from = Math.round(time * RATE);
    for (let index = 0; index < 220 && from + index < samples.length; index += 1) samples[from + index] += 0.8 * Math.sin((2 * Math.PI * 1000 * index) / RATE) * Math.exp(-index / 40);
  }
  return samples;
}

// The PCM samples of a WAV file as ffmpeg writes it (chunks in any order).
function wavSamples(buffer) {
  let at = 12;
  while (at + 8 <= buffer.length) {
    const id = buffer.toString('latin1', at, at + 4);
    const size = buffer.readUInt32LE(at + 4);
    if (id === 'data') {
      const count = Math.floor(Math.min(size, buffer.length - at - 8) / 2);
      return Float32Array.from({ length: count }, (_unused, index) => buffer.readInt16LE(at + 8 + index * 2) / 32767);
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

// Colours that a pixel can tell apart after the codec: the scenes are named by them.
const PALETTE = ['ff0000', '00ff00', '0000ff', 'ffff00', 'ff00ff', '00ffff', 'ff8000', '8000ff', '80ff00', '0080ff', 'ff0080', '808080', 'c0c0c0', '804000', '008040'];
const rgbOf = (hex) => [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
function nearestColour(rgb) {
  let best = null;
  for (const hex of PALETTE) {
    const [r, g, b] = rgbOf(hex);
    const distance = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
    if (!best || distance < best.distance) best = { hex, distance };
  }
  return best.hex;
}

/* ---------- the texts ---------- */

function testTexts({ planLib, editLib, tools }) {
  const window = { I18N: { de: {}, en: {}, es: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'nodes', 'i18n-nodes.js'), 'utf8'), { window });
  const need = (lang, key) => {
    const value = window.I18N[lang][key];
    assert.ok(typeof value === 'string' && value.trim(), `${lang}: ${key}`);
    return value;
  };
  const types = ['audio.beats', 'audio.lyrics_timing', 'music_video.plan', 'music_video.edit', 'video.captions', 'video.soundwave'];
  for (const lang of ['de', 'en', 'es']) {
    for (const type of types) {
      for (const part of ['label', 'keywords', 'help', 'example', 'tip.1', 'tip.2']) need(lang, `nodes.type.${type}.${part}`);
      if (type !== 'audio.beats') need(lang, `nodes.type.${type}.tip.3`);
      assert.equal(need(lang, `nodes.type.${type}.help`).includes('ß'), false);
    }
    // the messages of the codes, with the placeholders their data fills
    for (const code of ['BEATS_AUDIO_TOO_SHORT', 'TIMING_NO_LYRICS', 'TIMING_AUDIO_TOO_LONG', 'TIMING_BAD_ARGUMENT', 'MUSICVIDEO_ANALYSIS_INVALID', 'MUSICVIDEO_SHOTS_INVALID', 'MUSICVIDEO_STORY_MISMATCH', 'MUSICVIDEO_PERFORMANCE_MISMATCH', 'MUSICVIDEO_NO_TIMING', 'MUSICVIDEO_NO_CAPTIONS_TIMING', 'CAPTIONS_NO_LIBASS', 'CAPTIONS_TIMING_INVALID']) {
      const text = need(lang, `nodes.issue.${code}`);
      assert.equal(text.includes('ß'), false, `${lang}: ${code} has no sharp s`);
    }
    assert.match(need(lang, 'nodes.issue.TIMING_AUDIO_TOO_LONG'), /\{minutes\}/);
    for (const code of ['MUSICVIDEO_STORY_MISMATCH', 'MUSICVIDEO_PERFORMANCE_MISMATCH']) {
      assert.match(need(lang, `nodes.issue.${code}`), /\{expected\}/);
      assert.match(need(lang, `nodes.issue.${code}`), /\{got\}/);
    }
    assert.match(need(lang, 'nodes.issue.MUSICVIDEO_SHOTS_INVALID'), /\{message\}/);
    // the numbers in the texts are the numbers of the code
    assert.match(need(lang, 'nodes.type.music_video.plan.tip.2'), new RegExp(`${planLib.LIPSYNC_MIN_SEC} (bis|to|a) ${planLib.PERFORMANCE_MAX_SEC}\\b`), `${lang}: the length of a singer scene`);
    assert.match(need(lang, 'nodes.type.music_video.plan.help'), new RegExp(`\\b${planLib.MAX_SCENES}\\b`), `${lang}: the limit of scenes`);
    assert.match(need(lang, 'nodes.type.music_video.edit.help'), new RegExp(`\\b${String(editLib.MIN_SPEED).replace('.', '[.,]')}\\b`), `${lang}: the slowest speed`);
    assert.match(need(lang, 'nodes.type.audio.lyrics_timing.tip.3'), new RegExp(`\\b${tools.TIMING_MAX_SECONDS / 60}\\b`), `${lang}: the longest song`);
    assert.match(need(lang, 'nodes.type.music_video.edit.tip.3'), new RegExp(`\\b${planLib.MAX_SCENES}\\b`), `${lang}: the number of clips`);
    assert.match(need(lang, 'nodes.type.music_video.edit.tip.3'), new RegExp(`\\b${editLib.BATCH_SCENES}\\b`), `${lang}: the scenes of a batch`);
  }
  // the names people search for
  assert.equal(window.I18N.de['nodes.type.music_video.plan.label'], 'Musikvideo planen');
  assert.equal(window.I18N.en['nodes.type.music_video.edit.label'], 'Cut to the beat');
  assert.equal(window.I18N.de['nodes.type.audio.beats.label'], 'Song analysieren');
}

/* ---------- the definitions ---------- */

function testDefinitions({ registry, registryModule, tools, planLib, editLib }) {
  for (const type of ['audio.beats', 'audio.lyrics_timing', 'music_video.plan', 'music_video.edit']) assert.ok(registry.get(type), `${type} is registered`);
  const ports = (list) => list.map((port) => [port.id, port.type, Boolean(port.required), Boolean(port.multiple)]);

  const beats = registry.get('audio.beats');
  assert.equal(beats.category, 'audio');
  assert.equal(beats.paid, false);
  assert.equal(beats.cost.unit, 'local');
  assert.deepEqual(ports(beats.inputs), [['audio', 'audio', true, false], ['plan', 'text', false, false]]);
  assert.deepEqual(ports(beats.outputs), [['analysis', 'text', false, false], ['bpm', 'number', false, false]]);

  const timing = registry.get('audio.lyrics_timing');
  assert.equal(timing.paid, true);
  assert.equal(registryModule.providerOf(timing), 'elevenlabs');
  assert.equal(timing.cost.history, false, 'the length of the song is not a thing to guess from an earlier run');
  assert.deepEqual(ports(timing.inputs), [['audio', 'audio', true, false], ['lyrics', 'text', false, false]]);
  assert.equal(timing.inputs.find((port) => port.id === 'lyrics').param, 'lyrics', 'the text can be typed into the node');
  assert.deepEqual(ports(timing.outputs), [['timing', 'text', false, false], ['lyrics', 'text', false, false]]);
  assert.deepEqual(timing.params.find((param) => param.id === 'method').options, tools.TIMING_METHODS);
  assert.equal(timing.params.find((param) => param.id === 'method').default, 'auto');

  const plan = registry.get('music_video.plan');
  assert.equal(plan.paid, true);
  assert.equal(registryModule.providerOf(plan), 'llm');
  assert.deepEqual(ports(plan.inputs), [
    ['analysis', 'text', true, false], ['timing', 'text', false, false], ['brief', 'text', true, false], ['characters', 'text', false, false], ['song', 'audio', true, false]
  ]);
  assert.deepEqual(ports(plan.outputs).map(([id, type]) => `${id}:${type}`), ['shots:text', 'story_prompts:text[]', 'story_motion:text[]', 'performance_prompts:text[]', 'performance_audio:audio[]']);
  const defaults = registry.normalizeParams(plan, {});
  assert.deepEqual(
    [defaults.shots_per_minute, defaults.performance_share, defaults.cut_on, defaults.clip_seconds, defaults.aspect_ratio],
    [14, 0.3, 'lines', 5, '16:9']
  );
  // the sliders hold their ranges, a value outside a list is named by the check before a run
  const wild = registry.normalizeParams(plan, { shots_per_minute: 99, performance_share: 2, clip_seconds: 1 });
  assert.deepEqual([wild.shots_per_minute, wild.performance_share, wild.clip_seconds], [30, 1, 2]);
  assert.deepEqual(registry.checkParams(plan, defaults), []);
  assert.equal(registry.checkParams(plan, registry.normalizeParams(plan, { cut_on: 'sideways' })).length, 1);
  assert.deepEqual(plan.params.find((param) => param.id === 'cut_on').options, planLib.CUT_MODES);
  assert.deepEqual(plan.params.find((param) => param.id === 'aspect_ratio').options, planLib.ASPECT_RATIOS);

  const edit = registry.get('music_video.edit');
  assert.equal(edit.category, 'edit-video');
  assert.equal(edit.paid, false);
  assert.deepEqual(ports(edit.inputs), [['song', 'audio', true, false], ['shots', 'text', true, false], ['story', 'video', true, true], ['performance', 'video', false, true], ['captions', 'text', false, false]]);
  assert.equal(edit.inputs.find((port) => port.id === 'story').max, planLib.MAX_SCENES);
  assert.equal(edit.inputs.find((port) => port.id === 'performance').max, planLib.MAX_SCENES);
  assert.deepEqual(ports(edit.outputs), [['video', 'video', false, false]]);
  assert.deepEqual(edit.params.find((param) => param.id === 'transition').options, editLib.TRANSITIONS);
  assert.deepEqual(edit.params.find((param) => param.id === 'resolution').options, editLib.RESOLUTIONS);
  assert.deepEqual(edit.params.find((param) => param.id === 'fps').options, editLib.FPS_VALUES.map(String));
  assert.deepEqual(registry.normalizeParams(edit, {}), { transition: 'cut', resolution: '720p', fps: '25', fit: 'crop', fade_out: 1, captions: 'off', captions_position: 'bottom' });
  assert.deepEqual(edit.params.find((param) => param.id === 'captions').options, ['off', 'karaoke', 'words', 'lines']);
  assert.deepEqual(edit.params.find((param) => param.id === 'captions_position').options, ['bottom', 'middle', 'top']);
  assert.deepEqual(edit.params.find((param) => param.id === 'captions_position').showIf, { param: 'captions', in: ['karaoke', 'words', 'lines'] }, 'the position is only shown when captions are on');
  assert.equal(registry.normalizeParams(edit, { fade_out: 99 }).fade_out, 10);

  // validation: the stable codes the page translates
  const unconnected = (...ids) => Object.fromEntries(ids.map((id) => [id, { connected: false, count: 0 }]));
  const issue = (def, params, connected) => def.validate(registry.normalizeParams(def, params), connected);
  assert.deepEqual(issue(timing, { method: 'align' }, unconnected('lyrics')).map((item) => [item.code, item.port]), [['TIMING_NO_LYRICS', 'lyrics']]);
  assert.deepEqual(issue(timing, { method: 'align', lyrics: 'a line' }, unconnected('lyrics')), []);
  assert.deepEqual(issue(timing, { method: 'align' }, { lyrics: { connected: true, count: 1 } }), []);
  assert.deepEqual(issue(timing, { method: 'auto' }, unconnected('lyrics')), []);
  assert.deepEqual(issue(timing, { method: 'transcribe' }, unconnected('lyrics')), []);
  const noTiming = issue(plan, {}, unconnected('timing'));
  assert.deepEqual(noTiming.map((item) => [item.level, item.code, item.port]), [['warning', 'MUSICVIDEO_NO_TIMING', 'timing']]);
  assert.deepEqual(issue(plan, {}, { timing: { connected: true, count: 1 } }), []);
  assert.deepEqual(issue(plan, { cut_on: 'beats', performance_share: 0 }, unconnected('timing')), [], 'nothing to warn about when no times are needed');
  assert.equal(issue(plan, { cut_on: 'beats', performance_share: 0.2 }, unconnected('timing')).length, 1, 'a singer needs the times');
  assert.deepEqual(issue(plan, { cut_on: 'lines', performance_share: 0 }, unconnected('timing')).length, 1, 'cutting on lines needs them');
  // captions (WP35): off by default and then nothing to check; asked for without lyric times the cut warns (whether ffmpeg has libass is
  // checked in test-music-video-captions.js with a stand-in, because it depends on the machine)
  const captionsWarning = (params, connected) => issue(edit, params, connected).filter((item) => item.code === 'MUSICVIDEO_NO_CAPTIONS_TIMING').map((item) => [item.level, item.port]);
  assert.deepEqual(issue(edit, {}, unconnected('captions')), []);
  assert.deepEqual(captionsWarning({ captions: 'karaoke' }, unconnected('captions')), [['warning', 'captions']]);
  assert.deepEqual(captionsWarning({ captions: 'lines' }, { captions: { connected: true, count: 1 } }), []);

  // the price of the timing: by the length of the song, none while it is not known
  const estimate = (audio) => timing.cost.estimate({}, { inputs: audio === undefined ? {} : { audio } });
  assert.equal(estimate({ type: 'audio', duration: 120 }), tools.lyricsTimingUsd(120));
  near(tools.lyricsTimingUsd(120), (120 / 3600) * 0.4, 1e-6, 'the default is 0.40 USD per hour');
  assert.equal(estimate({ type: 'audio' }), null, 'an uploaded file carries no length');
  assert.equal(estimate({ type: 'audio', duration: 0 }), null);
  assert.equal(estimate({ type: 'list', itemType: 'audio', items: [] }), null);
  assert.equal(estimate(undefined), null);
  assert.equal(timing.cost.estimate({}, undefined), null);
  assert.equal(tools.toolEstimateUsd('lyrics_timing', { duration_seconds: 120 }), tools.lyricsTimingUsd(120));
  // the reservation of the tool itself counts a ten minute song while the length is not known, and never more than the longest song
  near(tools.lyricsTimingUsd(null), (600 / 3600) * 0.4, 1e-6);
  assert.equal(tools.toolEstimateUsd('lyrics_timing', {}), tools.lyricsTimingUsd(null));
  near(tools.lyricsTimingUsd(99999), (tools.TIMING_MAX_SECONDS / 3600) * 0.4, 1e-6);
  const before = process.env.ELEVENLABS_TIMING_USD_PER_HOUR;
  try {
    process.env.ELEVENLABS_TIMING_USD_PER_HOUR = '0.22';
    near(tools.lyricsTimingUsd(600), (600 / 3600) * 0.22, 1e-6, 'the price is set in the environment');
    process.env.ELEVENLABS_TIMING_USD_PER_HOUR = 'nonsense';
    near(tools.lyricsTimingUsd(600), (600 / 3600) * 0.4, 1e-6);
  } finally {
    if (before === undefined) delete process.env.ELEVENLABS_TIMING_USD_PER_HOUR;
    else process.env.ELEVENLABS_TIMING_USD_PER_HOUR = before;
  }
}

/* ---------- main ---------- */

async function main() {
  const guard = guardFetch();
  const iso = await createIsolatedApp({
    env: {
      ADMIN_EMAILS: ADMIN,
      SUPERADMIN_EMAILS: '',
      INTERNAL_EMAIL_DOMAINS: 'staff.example.com',
      OPENROUTER_API_KEY: 'sk-or-v1-test-key-with-enough-length',
      ELEVENLABS_API_KEY: KEY,
      FAL_KEY: 'fal-test-key-with-enough-length',
      PUBLIC_BASE_URL: '',
      ACCESS_ALLOWLIST_FILE: '',
      ACCESS_ALLOWLIST_ROUTE: '',
      GTS_API_TOKEN: ''
    }
  });
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  try {
    await run(iso);
  } finally {
    restoreAll();
    guard.restore();
    await iso.cleanup();
  }
  assert.deepEqual(guard.attempts, [], 'no request left the machine');
  console.log('Musikvideo: Texte, Definitionen, Preis der Zeiten, Werkzeug, Plan, Schnitt, Vorlage durch die Engine und der Weg des Directors sind korrekt.');
  console.log('test-nodes-music-video.js: ok');
}

async function run(iso) {
  const store = iso.load('lib/store');
  const assets = iso.load('lib/nodes/assets');
  const tools = iso.load('lib/tools');
  const elevenlabs = iso.load('lib/elevenlabs');
  const llm = iso.load('lib/nodes/llm');
  const costs = iso.load('lib/costs');
  const ffmpegLib = iso.load('lib/ffmpeg');
  const access = iso.load('lib/access');
  const registryModule = iso.load('lib/nodes/registry');
  const nodesBasic = iso.load('lib/nodes/nodes-basic');
  const musicVideoNodes = iso.load('lib/nodes/nodes-music-video');
  const editNodes = iso.load('lib/nodes/nodes-edit');
  const planLib = iso.load('lib/music-video-plan');
  const editLib = iso.load('lib/music-video-edit');
  const renderLib = iso.load('lib/music-video-render');
  const templatesLib = iso.load('lib/nodes/templates');
  const runServiceLib = iso.load('lib/nodes/run-service');
  const { createRegistry } = registryModule;
  const { createEventBus } = iso.load('lib/nodes/events');
  const { createWorkflowsStore } = iso.load('lib/nodes/workflows-store');
  const { createEngine } = iso.load('lib/nodes/engine');
  const { textValue, listValue } = iso.load('lib/nodes/types');
  const real = registryModule.registry;

  testTexts({ planLib, editLib, tools });
  testDefinitions({ registry: real, registryModule, tools, planLib, editLib });

  const bins = ffmpegLib.binaries();
  if (!bins.available) {
    console.log('ffmpeg not found: the parts with real audio and video are skipped');
    return;
  }

  /* ---------- helpers: ffmpeg, files, assets ---------- */

  const ff = (args) => execFileAsync(bins.ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args]);
  async function probeFile(file) {
    const { stdout } = await execFileAsync(bins.ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file], { maxBuffer: 16 * 1024 * 1024 });
    const data = JSON.parse(stdout);
    const video = data.streams.find((stream) => stream.codec_type === 'video');
    const audio = data.streams.find((stream) => stream.codec_type === 'audio');
    return {
      duration: Number(data.format.duration),
      frames: video ? Number(video.nb_read_frames) : 0,
      width: video ? video.width : 0,
      height: video ? video.height : 0,
      hasAudio: Boolean(audio),
      audioDuration: audio ? Number(audio.duration) : 0
    };
  }
  // The colour of a picture at a moment of a video (the nearest colour of the palette).
  async function colourAt(file, seconds) {
    const { stdout } = await execFileAsync(
      bins.ffmpeg,
      ['-nostdin', '-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'scale=1:1:flags=area,format=rgb24', '-f', 'rawvideo', '-'],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 }
    );
    assert.equal(stdout.length, 3, `a picture at ${seconds} s of ${path.basename(file)}`);
    return nearestColour([stdout[0], stdout[1], stdout[2]]);
  }

  const workDir = await fsp.mkdtemp(path.join(iso.root, 'music-video-'));
  let fileCounter = 0;
  const clipCache = new Map();
  // A clip of one colour (and, with `audioFile`, with the sound of a file, as long as the shorter of the two).
  async function colourClip(hex, seconds, { audioFile = null } = {}) {
    const key = `${hex}/${seconds}/${audioFile || ''}`;
    if (clipCache.has(key)) return clipCache.get(key);
    fileCounter += 1;
    const file = path.join(workDir, `clip-${fileCounter}.mp4`);
    const args = ['-f', 'lavfi', '-i', `color=c=0x${hex}:s=160x90:r=25:d=${seconds}`];
    if (audioFile) args.push('-i', audioFile);
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast');
    if (audioFile) args.push('-c:a', 'aac', '-shortest');
    else args.push('-an');
    args.push(file);
    await ff(args);
    clipCache.set(key, file);
    return file;
  }

  const session = await store.createSession();
  const sessionId = session.id;
  const sessionDir = store.sessionAssetDir(sessionId);
  async function asset(bytes, ext, owner = sessionId) {
    const saved = await store.saveAsset(owner, { kind: 'upload', buffer: bytes, ext, prompt: 'seed' });
    return assets.valueFromAsset(owner, saved.id);
  }
  const scratchLeft = async (owner = sessionId) => (await fsp.readdir(store.sessionAssetDir(owner))).filter((name) => name.startsWith('.nodes-'));

  /* ---------- the providers, replaced ---------- */

  // ElevenLabs: four words per line of 0.7 s each, 0.8 s apart, the line k starting at starts[k]
  const eleven = { align: [], stt: [], starts: [4, 8, 12, 16, 20, 24], fail: null, silent: false };
  const wordsAt = (lines, starts) =>
    lines.flatMap((line, index) =>
      line.split(/\s+/).map((word, position) => ({ text: word, start: starts[index] + position * 0.8, end: starts[index] + position * 0.8 + 0.7, loss: 1.1 }))
    );
  patch(elevenlabs, 'forcedAlignment', async (args) => {
    eleven.align.push(args);
    if (eleven.fail) throw eleven.fail;
    return { words: wordsAt(args.text.split('\n'), eleven.starts), loss: 1.2 };
  });
  patch(elevenlabs, 'speechToText', async (args) => {
    eleven.stt.push(args);
    if (eleven.fail) throw eleven.fail;
    const words = eleven.silent ? [] : wordsAt(LYRICS, eleven.starts).map((word) => ({ ...word, type: 'word' }));
    return { words, text: words.map((word) => word.text).join(' '), language: 'eng', duration: args.durationSec };
  });
  // six invented lines of four words
  const LYRICS = ['amber lanterns drift slowly', 'across the quiet harbour', 'silver echoes call us home', 'while the morning wakes the sea', 'carry every little spark', 'into the open sky tonight'];
  const LYRICS_TEXT = LYRICS.join('\n');

  const journal = [];
  const recordCost = costs.recordCost;
  patch(costs, 'recordCost', async (entry) => {
    journal.push(entry);
    return recordCost.call(costs, entry);
  });

  // The language model: it answers for the scenes it is shown. Every image prompt names the colour of its scene.
  const llmCalls = [];
  let llmScript = [];
  const sceneRowsOf = (prompt) => [...String(prompt).matchAll(/^\{"index":(\d+),"kind":"(story|performance)"/gm)].map((match) => ({ index: Number(match[1]), kind: match[2] }));
  // a token makes the prompts of one run differ from those of the run before (the engine reuses the items of a list that did not change)
  const llmRun = { token: '' };
  const answerFor = (rows) => ({
    scenes: rows.map((row) => ({
      index: row.index,
      image_prompt: `scene ${row.index} ${row.kind} colour #${PALETTE[row.index % PALETTE.length]}${llmRun.token}`,
      motion: row.kind === 'story' ? `motion of scene ${row.index}` : '',
      character: ''
    }))
  });
  const LLM_USD = 0.002;
  patch(llm, 'completeText', async (options) => {
    llmCalls.push(options);
    const next = llmScript.length ? llmScript.shift() : (request) => answerFor(sceneRowsOf(request.prompt));
    const value = typeof next === 'function' ? next(options) : next;
    if (value instanceof Error) throw value;
    return { text: typeof value === 'string' ? value : JSON.stringify(value), usd: LLM_USD };
  });
  const resetProviders = () => {
    eleven.align.length = 0;
    eleven.stt.length = 0;
    eleven.fail = null;
    eleven.silent = false;
    eleven.starts = [4, 8, 12, 16, 20, 24];
    llmCalls.length = 0;
    llmScript = [];
    journal.length = 0;
  };

  const logsOf = new Map();
  function makeCtx(owner = sessionId, user = STAFF) {
    const controller = new AbortController();
    const logs = [];
    const config = { defaultBrain: 'vendor/default-brain', brainModels: ['vendor/default-brain'], imageModel: 'openai/gpt-image-2', videoModel: 'bytedance/seedance-2.5' };
    const ctx = {
      workflowId: 'wf-test',
      runId: 'r-test',
      nodeId: 'n1',
      sessionId: owner,
      user,
      config,
      signal: controller.signal,
      toolCtx: { nodeView: true, sessionId: owner, config, user, emit() {}, signal: controller.signal },
      log: (line) => logs.push(line),
      saveOutputFile: (options) => assets.saveOutputFile(owner, options),
      withLocalSlot: (fn) => fn(),
      logs,
      controller
    };
    logsOf.set(ctx, logs);
    return ctx;
  }
  const exec = (type, ctx, inputs, raw = {}) => {
    const def = real.get(type);
    return def.execute(ctx, inputs, real.normalizeParams(def, raw));
  };
  const errorOf = async (promise) => {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    return null;
  };

  const SONG_SECONDS = 30;
  const songBytes = wavFile(songSamples(SONG_SECONDS), RATE);
  const song = await asset(songBytes, '.wav');

  /* ---------- the tool lyrics_timing ---------- */

  {
    const short = await asset(wavFile(songSamples(12), RATE), '.wav');
    const toolCtx = (user = STAFF) => ({ nodeView: true, sessionId, config: {}, user, emit() {}, signal: new AbortController().signal });
    const call = (args, ctx = toolCtx()) => tools.executeTool(ctx, 'lyrics_timing', args);
    resetProviders();

    // with a text: aligned. The text sent is only what is sung, the length is measured (the figure of the caller is not believed)
    const withText = await call({ audio_asset_id: short.assetId, text: '[Verse 1]\n\none two three four\nfive six seven eight\n(ahh)', duration_seconds: 999 });
    assert.equal(withText.method, 'align');
    assert.equal(eleven.align.length, 1);
    assert.equal(eleven.stt.length, 0);
    const sent = eleven.align[0];
    assert.equal(sent.text, 'one two three four\nfive six seven eight');
    assert.deepEqual(sent.audio, await fsp.readFile(path.join(sessionDir, short.file)), 'the bytes of the file go to ElevenLabs');
    assert.equal(sent.filename, short.file);
    assert.equal(sent.mime, 'audio/wav');
    near(sent.durationSec, 12, 0.01, 'the measured length');
    assert.equal(withText.timing.lines.length, 2);
    assert.equal(withText.timing.words.length, 8);
    assert.equal(withText.timing.source, 'align');
    assert.match(withText.readable, /^0:04\.0–0:\d\d\.\d one two three four\n0:08\.0–0:\d\d\.\d five six seven eight$/);
    near(withText.durationSeconds, 12, 0.01);
    near(withText.costUsd, tools.lyricsTimingUsd(withText.durationSeconds), 1e-9, 'the cost follows the measured length, not the figure of the caller');
    assert.equal(journal.length, 1);
    assert.deepEqual(
      { type: journal[0].type, model: journal[0].model, billing: journal[0].billing, user: journal[0].user, sessionId: journal[0].sessionId },
      { type: 'speech', model: 'elevenlabs/forced-alignment', billing: 'Schaetzung (Dauer)', user: STAFF, sessionId }
    );
    assert.equal(journal[0].cost, withText.costUsd);

    // without a text: Scribe, the lines from the pauses
    resetProviders();
    const noText = await call({ audio_asset_id: short.assetId });
    assert.equal(noText.method, 'transcribe');
    assert.equal(eleven.stt.length, 1);
    assert.equal(eleven.align.length, 0);
    assert.equal(journal[0].model, `elevenlabs/${elevenlabs.STT_MODEL_ID}`);
    assert.equal(noText.timing.source, 'transcribe');
    assert.ok(noText.timing.lines.length >= 1);
    // an explicit method wins over the automatic one
    resetProviders();
    assert.equal((await call({ audio_asset_id: short.assetId, text: 'one two three four', method: 'transcribe' })).method, 'transcribe');
    assert.equal(eleven.stt.length, 1);

    // refused before anything is sent: nothing reaches ElevenLabs, nothing is booked
    resetProviders();
    const nothingSent = (message) => {
      assert.deepEqual([eleven.align.length, eleven.stt.length, journal.length], [0, 0, 0], message);
    };
    const noLyrics = await errorOf(call({ audio_asset_id: short.assetId, method: 'align', text: '[Verse]\n(ahh)' }));
    assert.equal(noLyrics.code, 'TIMING_NO_LYRICS');
    nothingSent('no sung line');
    assert.match((await errorOf(call({ audio_asset_id: short.assetId, method: 'sideways' }))).message, /method muss/);
    assert.match((await errorOf(call({}))).message, /audio_asset_id fehlt/);
    assert.match((await errorOf(call({ audio_asset_id: 'aud-999' }))).message, /existiert nicht/);
    const picture = await asset(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), '.png');
    assert.match((await errorOf(call({ audio_asset_id: picture.assetId }))).message, /keine Audio-Datei/);
    const garbage = await asset(Buffer.from('this is not audio at all, only words'), '.wav');
    const unreadable = await errorOf(call({ audio_asset_id: garbage.assetId }));
    assert.equal(unreadable.code, 'TIMING_BAD_ARGUMENT');
    // a song of 21 minutes (a quiet file of 4 kHz): longer than the node takes
    const long = await asset(wavFile(new Float32Array(4000 * 1260), 4000), '.wav');
    const tooLong = await errorOf(call({ audio_asset_id: long.assetId, text: 'one two three four' }));
    assert.equal(tooLong.code, 'TIMING_AUDIO_TOO_LONG');
    assert.deepEqual(tooLong.data, { minutes: 20 });
    nothingSent('refusals');
    // the key is checked first
    const savedKey = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = '';
    try {
      const noKey = await errorOf(call({ audio_asset_id: short.assetId, text: 'one two three four' }));
      assert.ok(noKey && /ELEVENLABS/.test(noKey.message), noKey && noKey.message);
      assert.equal(noKey.message.includes(KEY), false);
      nothingSent('no key');
    } finally {
      process.env.ELEVENLABS_API_KEY = savedKey;
    }
    // a failure of ElevenLabs is passed on and costs nothing
    eleven.fail = new Error('ElevenLabs answered 500');
    assert.match((await errorOf(call({ audio_asset_id: short.assetId, text: 'one two three four' }))).message, /ElevenLabs answered 500/);
    assert.equal(journal.length, 0, 'a failed call is not booked');
    assert.equal(eleven.align.length, 1, 'the call did reach the (replaced) service');
    eleven.fail = null;

    // the tool is for the node view only
    resetProviders();
    assert.ok(!tools.toolDefinitions().some((definition) => definition.function.name === 'lyrics_timing'), 'the Director does not see it');
    await assert.rejects(tools.executeTool({ sessionId, config: {}, user: STAFF, emit() {} }, 'lyrics_timing', { audio_asset_id: short.assetId }), /nur in der Node-Ansicht/);
    nothingSent('node view only');

    // participants: the call needs budget left, and the estimate for the measured length must fit
    const team = (await iso.request('/api/teams', { method: 'POST', as: ADMIN, json: { name: 'Klein', budgetUsd: 0.0001 } })).body.team;
    assert.equal((await iso.request(`/api/teams/${team.id}/members`, { method: 'POST', as: ADMIN, json: { emails: [P1] } })).status, 201);
    const richTeam = (await iso.request('/api/teams', { method: 'POST', as: ADMIN, json: { name: 'Gross', budgetUsd: 5 } })).body.team;
    assert.equal((await iso.request(`/api/teams/${richTeam.id}/members`, { method: 'POST', as: ADMIN, json: { emails: [P2] } })).status, 201);
    const fourMinutes = await asset(wavFile(new Float32Array(4000 * 240), 4000), '.wav');
    const refused = await errorOf(call({ audio_asset_id: fourMinutes.assetId, text: 'one two three four' }, toolCtx(P1)));
    assert.ok(refused && /^BUDGET_(INSUFFICIENT|EXHAUSTED)$/.test(refused.code), `${refused && refused.code}: ${refused && refused.message}`);
    nothingSent('over the budget of a participant');
    const allowed = await call({ audio_asset_id: fourMinutes.assetId, text: 'one two three four' }, toolCtx(P2));
    near(allowed.costUsd, tools.lyricsTimingUsd(240), 1e-9);
    assert.equal(journal.at(-1).user, P2, 'booked for the person');
    resetProviders();
  }

  /* ---------- the song analysis ---------- */

  const analysisOf = async (value, raw = {}) => {
    const result = await exec('audio.beats', makeCtx(), { audio: value }, raw);
    return { analysis: JSON.parse(result.variants[0].analysis.value), bpm: result.variants[0].bpm.value };
  };
  const analysed = await analysisOf(song);
  near(analysed.bpm, 120, 1.5, 'the tempo of the made-up song');
  near(analysed.analysis.duration, SONG_SECONDS, 0.1);
  assert.ok(analysed.analysis.beats.length >= 50 && analysed.analysis.sections.length >= 1);
  assert.equal(analysed.analysis.bpm, analysed.bpm);
  assert.deepEqual(await scratchLeft(), []);

  /* ---------- the plan ---------- */

  // The analysis and the lyric times as the nodes before pass them on
  const analysisText = textValue(JSON.stringify(analysed.analysis));
  const timingFor = (starts = [4, 8, 12, 16, 20, 24]) => ({
    version: 1,
    lines: LYRICS.map((text, index) => ({ text, start: starts[index], end: starts[index] + 3.1 })),
    words: []
  });
  const timingText = textValue(JSON.stringify(timingFor()));
  const planInputs = (extra = {}) => ({ analysis: analysisText, timing: timingText, brief: textValue('A drummer crosses a quiet harbour town at dawn.'), song, ...extra });
  const planParams = { brief: 'x', shots_per_minute: 12, performance_share: 0.3, cut_on: 'lines', clip_seconds: 5 };
  const shotsOf = (result) => planLib.parseShots(result.variants[0].shots.value);

  {
    resetProviders();
    const ctx = makeCtx();
    const result = await exec('music_video.plan', ctx, planInputs({ characters: textValue('Mia: the singer, short dark hair') }), { ...planParams, style: 'warm film look' });
    const variant = result.variants[0];
    const shots = shotsOf(result);
    assert.equal(llmCalls.length, 1, 'one request for the whole song');
    const request = llmCalls[0];
    assert.equal(request.json, true);
    assert.equal(request.model, 'vendor/default-brain');
    assert.equal(request.sessionId, sessionId);
    assert.equal(request.system, planLib.systemPrompt());
    assert.match(request.prompt, /^Brief:\nA drummer crosses a quiet harbour town at dawn\./);
    assert.match(request.prompt, /Style:\nwarm film look/);
    assert.match(request.prompt, /Characters:\nMia: the singer, short dark hair/);
    assert.match(request.prompt, /Format: 16:9 video\./);
    assert.match(request.prompt, new RegExp(`Scenes \\(${shots.shots.length}\\):`));
    assert.equal(shots.cut_on, 'lines');
    assert.ok(shots.story >= 3 && shots.performance >= 1, `${shots.story} story and ${shots.performance} singer scenes`);
    near(shots.duration, SONG_SECONDS, 0.1);
    // the lists follow the scenes: story and singer apart, each in scene order
    const story = shots.shots.filter((shot) => shot.kind === 'story');
    const performance = shots.shots.filter((shot) => shot.kind === 'performance');
    assert.deepEqual(variant.story_prompts.items.map((item) => item.value), story.map((shot) => shot.prompt));
    assert.deepEqual(variant.story_motion.items.map((item) => item.value), story.map((shot) => shot.motion));
    assert.ok(story.every((shot) => /^motion of scene \d+$/.test(shot.motion)));
    assert.deepEqual(variant.performance_prompts.items.map((item) => item.value), performance.map((shot) => shot.prompt));
    assert.equal(variant.story_prompts.type, 'list');
    assert.equal(variant.performance_audio.type, 'list');
    assert.equal(variant.performance_audio.of, 'audio');
    assert.equal(variant.performance_audio.items.length, performance.length);
    assert.ok(performance.every((shot) => shot.motion === ''), 'the singer scenes have no motion');
    story.forEach((shot, position) => assert.equal(shot.clip, position));
    performance.forEach((shot, position) => assert.equal(shot.clip, position));
    assert.deepEqual(result.cost, { usd: LLM_USD });
    assert.ok(ctx.logs.some((line) => new RegExp(`^${shots.shots.length} scenes \\(${shots.story} story, ${shots.performance} singer\\)`).test(line)), ctx.logs.join(' | '));
    assert.deepEqual(await scratchLeft(), [], 'no scratch folder is left');

    // the slices of the song: exactly the part of the scene, to the sample
    const original = wavSamples(songBytes);
    for (const [position, shot] of performance.entries()) {
      const slice = variant.performance_audio.items[position];
      assert.equal(slice.type, 'audio');
      near(slice.duration, shot.duration, 0.01, `slice ${position}`);
      assert.ok(slice.duration >= planLib.PERFORMANCE_MIN_SEC - 0.01, 'long enough for the lip sync');
      const samples = wavSamples(await fsp.readFile(path.join(sessionDir, slice.file)));
      const from = Math.round(shot.start * RATE);
      const length = Math.min(samples.length, 4000);
      let offsetFound = null;
      for (const offset of [0, -1, 1, -2, 2]) {
        let same = true;
        for (let index = 0; index < length && same; index += 1) if (Math.abs(samples[index] - original[from + offset + index]) > 2 / 32767) same = false;
        if (same) {
          offsetFound = offset;
          break;
        }
      }
      assert.notEqual(offsetFound, null, `slice ${position} is the song from ${shot.start} s`);
      near(samples.length / RATE, shot.duration, 0.01, 'its length');
      const entry = (await store.readLedger(sessionId)).find((item) => item.id === slice.assetId);
      assert.match(entry.prompt, /^Song slice \d+:\d\d\.\d-\d+:\d\d\.\d$/);
    }
  }

  // bad answer, then a good one: the second request tells what was wrong
  {
    resetProviders();
    llmScript = ['this is not JSON at all'];
    const ctx = makeCtx();
    const result = await exec('music_video.plan', ctx, planInputs(), planParams);
    assert.equal(llmCalls.length, 2);
    assert.doesNotMatch(llmCalls[0].prompt, /previous answer had these problems/);
    assert.match(llmCalls[1].prompt, /Your previous answer had these problems/);
    assert.deepEqual(result.cost, { usd: 2 * LLM_USD }, 'both requests are paid');
    assert.ok(ctx.logs.some((line) => /asking once more/.test(line)));
    assert.ok(!ctx.logs.some((line) => /plain prompts/.test(line)), 'nothing is made up when the second answer is good');
    const shots = shotsOf(result);
    assert.ok(shots.shots.every((shot) => /^scene \d+ (story|performance) colour #[0-9a-f]{6}$/.test(shot.prompt)));
  }

  // two bad answers: the plain prompts of the app, the plan still works
  {
    resetProviders();
    llmScript = ['nothing useful', '{"scenes":[]}'];
    const ctx = makeCtx();
    const result = await exec('music_video.plan', ctx, planInputs(), planParams);
    assert.equal(llmCalls.length, 2, 'asked once more, not a third time');
    const shots = shotsOf(result);
    assert.ok(shots.shots.every((shot) => shot.prompt.length > 20), 'every scene has a prompt');
    assert.ok(shots.shots.filter((shot) => shot.kind === 'story').every((shot) => shot.motion.length > 10), 'and every story scene a motion');
    assert.ok(ctx.logs.some((line) => new RegExp(`^${shots.shots.length} of ${shots.shots.length} scenes got plain prompts`).test(line)), ctx.logs.join(' | '));
    assert.deepEqual(result.cost, { usd: 2 * LLM_USD });
  }

  // a story scene without a motion counts as missing; a singer scene needs none
  {
    resetProviders();
    llmScript = [(request) => ({ scenes: answerFor(sceneRowsOf(request.prompt)).scenes.map((scene) => ({ ...scene, motion: '' })) })];
    const result = await exec('music_video.plan', makeCtx(), planInputs(), planParams);
    assert.equal(llmCalls.length, 2, 'the missing motions are asked for once more');
    assert.ok(shotsOf(result).shots.filter((shot) => shot.kind === 'story').every((shot) => /^motion of scene \d+$/.test(shot.motion)));
  }

  // an answer for some scenes only: the rest comes from the second request
  {
    resetProviders();
    llmScript = [(request) => ({ scenes: answerFor(sceneRowsOf(request.prompt)).scenes.slice(0, 3) })];
    const result = await exec('music_video.plan', makeCtx(), planInputs(), planParams);
    assert.equal(llmCalls.length, 2);
    assert.match(llmCalls[1].prompt, /Your previous answer had these problems/);
    const shots = shotsOf(result);
    assert.ok(shots.shots.every((shot) => /^scene \d+ /.test(shot.prompt)), 'all scenes are written by the model');
  }

  // the model fails: the first request is needed, a failure of the second leaves the prompts of the first (and plain ones)
  {
    resetProviders();
    llmScript = [new Error('the language model is down')];
    assert.match((await errorOf(exec('music_video.plan', makeCtx(), planInputs(), planParams))).message, /language model is down/);
    assert.equal(llmCalls.length, 1);
    assert.deepEqual(await scratchLeft(), []);

    resetProviders();
    llmScript = [(request) => ({ scenes: answerFor(sceneRowsOf(request.prompt)).scenes.slice(0, 2) }), new Error('429 too many requests')];
    const ctx = makeCtx();
    const result = await exec('music_video.plan', ctx, planInputs(), planParams);
    assert.equal(llmCalls.length, 2);
    assert.ok(ctx.logs.some((line) => /second request to the language model failed/.test(line)));
    const shots = shotsOf(result);
    assert.match(shots.shots[0].prompt, /^scene 0 /, 'what the first answer delivered stays');
    assert.ok(shots.shots.every((shot) => shot.prompt.length > 20));
    assert.deepEqual(result.cost, { usd: LLM_USD }, 'only the answer that came is paid');

    // an abort is not swallowed
    resetProviders();
    llmScript = [(request) => ({ scenes: answerFor(sceneRowsOf(request.prompt)).scenes.slice(0, 2) }), Object.assign(new Error('aborted'), { name: 'AbortError' })];
    assert.equal((await errorOf(exec('music_video.plan', makeCtx(), planInputs(), planParams))).name, 'AbortError');
  }

  // share 0: no singer scene, the lists are empty (not missing), the rest of the plan is the same
  {
    resetProviders();
    const result = await exec('music_video.plan', makeCtx(), planInputs(), { ...planParams, performance_share: 0 });
    const shots = shotsOf(result);
    assert.equal(shots.performance, 0);
    assert.ok(shots.story >= 5);
    const variant = result.variants[0];
    for (const port of ['performance_prompts', 'performance_audio']) {
      assert.equal(variant[port].type, 'list', port);
      assert.deepEqual(variant[port].items, [], port);
    }
    assert.equal(variant.performance_audio.of, 'audio');
    assert.equal(variant.story_prompts.items.length, shots.story);
    assert.ok(llmCalls[0].prompt.indexOf('"kind":"performance"') === -1, 'the model is not shown a singer scene');
    near(shots.shots.reduce((sum, shot) => sum + shot.duration, 0), SONG_SECONDS, 0.01);
  }

  // no lyric times: warned, cut on the beats, no singer scene; an instrumental song is the same
  {
    resetProviders();
    const ctx = makeCtx();
    const result = await exec('music_video.plan', ctx, planInputs({ timing: undefined }), planParams);
    const shots = shotsOf(result);
    assert.equal(shots.cut_on, 'beats');
    assert.equal(shots.performance, 0);
    assert.ok(ctx.logs.some((line) => /^No lyric times/.test(line)), ctx.logs.join(' | '));
    resetProviders();
    const instrumental = makeCtx();
    const second = await exec('music_video.plan', instrumental, planInputs({ timing: textValue(JSON.stringify({ version: 1, lines: [], words: [] })) }), planParams);
    assert.equal(shotsOf(second).performance, 0);
    assert.ok(instrumental.logs.some((line) => /^No lyric times|No scene for the singer/.test(line)), instrumental.logs.join(' | '));
  }

  // what is wrong with the inputs is named by a code or a message, before the model is asked
  {
    resetProviders();
    assert.match((await errorOf(exec('music_video.plan', makeCtx(), planInputs({ brief: textValue('   ') }), planParams))).message, /brief/);
    const bad = await errorOf(exec('music_video.plan', makeCtx(), planInputs({ analysis: textValue('nothing') }), planParams));
    assert.equal(bad.code, 'MUSICVIDEO_ANALYSIS_INVALID');
    assert.equal(llmCalls.length, 0, 'the model was not asked');
    assert.deepEqual(await scratchLeft(), []);
  }

  /* ---------- the cut ---------- */

  const handShots = (extra = {}) => ({
    version: 1,
    duration: 12,
    bpm: 120,
    aspect_ratio: '16:9',
    cut_on: 'beats',
    brief: '',
    story: 3,
    performance: 1,
    shots: [
      { index: 0, start: 0, end: 3, duration: 3, kind: 'story', clip: 0, section: 'A', line: null, prompt: 'a', motion: 'm', character: null },
      { index: 1, start: 3, end: 6, duration: 3, kind: 'performance', clip: 0, section: 'A', line: null, prompt: 'b', motion: '', character: null },
      { index: 2, start: 6, end: 9, duration: 3, kind: 'story', clip: 1, section: 'B', line: null, prompt: 'c', motion: 'm', character: null },
      { index: 3, start: 9, end: 12, duration: 3, kind: 'story', clip: 2, section: 'B', line: null, prompt: 'd', motion: 'm', character: null }
    ],
    ...extra
  });
  const videoAsset = async (hex, seconds, owner = sessionId) => asset(await fsp.readFile(await colourClip(hex, seconds)), '.mp4', owner);
  const editSong = await asset(wavFile(songSamples(12), RATE), '.wav');
  {
    const red = await videoAsset('ff0000', 5);
    const green = await videoAsset('00ff00', 2); // shorter than its scene of 3 s: slowed down, then held
    const blue = await videoAsset('0000ff', 5);
    const yellow = await videoAsset('ffff00', 3);
    const editInputs = (extra = {}) => ({
      song: editSong,
      shots: textValue(JSON.stringify(handShots())),
      story: listValue('video', [red, green, blue]),
      performance: listValue('video', [yellow]),
      ...extra
    });
    const SCENE_COLOURS = ['ff0000', 'ffff00', '00ff00', '0000ff'];
    const checkVideo = async (value, transition) => {
      const file = path.join(sessionDir, value.file);
      const info = await probeFile(file);
      near(info.duration, 12, 0.08, `${transition}: the length of the song`);
      near(info.frames, 12 * 25, 1, `${transition}: the frames`);
      assert.equal(info.hasAudio, true, `${transition}: the song is underneath`);
      near(info.audioDuration, 12, 0.1);
      assert.deepEqual([info.width, info.height], [1280, 720]);
      near(value.duration, 12, 0.08, 'the stored length');
      for (const [index, hex] of SCENE_COLOURS.entries()) assert.equal(await colourAt(file, 3 * index + 1.5), hex, `${transition}: scene ${index} shows its own clip`);
      return file;
    };

    const ctx = makeCtx();
    const cut = await exec('music_video.edit', ctx, editInputs(), { transition: 'cut' });
    const file = await checkVideo(cut.variants[0].video, 'cut');
    // the cuts lie on the scene boundaries (a tenth of a second before and after)
    for (const boundary of [3, 6, 9]) {
      assert.equal(await colourAt(file, boundary - 0.12), SCENE_COLOURS[boundary / 3 - 1], `before ${boundary} s`);
      assert.equal(await colourAt(file, boundary + 0.12), SCENE_COLOURS[boundary / 3], `after ${boundary} s`);
    }
    // four scenes: more than a batch holds, so two batches (the log says so)
    assert.ok(ctx.logs.some((line) => /^4 scenes, 12 s at 25 fps, 1280x720, cut in 2 batches, 1 clips slowed down, 1 clips too short \(last frame held\)$/.test(line)), ctx.logs.join(' | '));
    const entry = (await store.readLedger(sessionId)).find((item) => item.id === cut.variants[0].video.assetId);
    assert.equal(entry.kind, 'video');
    assert.deepEqual(await scratchLeft(), [], 'no scratch folder is left');

    // the transitions do not move the scenes
    for (const transition of ['crossfade', 'flash']) {
      const result = await exec('music_video.edit', makeCtx(), editInputs(), { transition, resolution: '720p', fade_out: 0 });
      await checkVideo(result.variants[0].video, transition);
    }
    // a clip longer than its scene is cut off; the format follows the plan
    const vertical = await exec('music_video.edit', makeCtx(), editInputs({ shots: textValue(JSON.stringify(handShots({ aspect_ratio: '9:16' }))) }), { transition: 'cut' });
    const verticalInfo = await probeFile(path.join(sessionDir, vertical.variants[0].video.file));
    assert.deepEqual([verticalInfo.width, verticalInfo.height], [720, 1280]);

    // a wrong number of clips: a code the page translates, with the numbers, before anything is cut
    const storyMismatch = await errorOf(exec('music_video.edit', makeCtx(), editInputs({ story: listValue('video', [red, green]) })));
    assert.equal(storyMismatch.code, 'MUSICVIDEO_STORY_MISMATCH');
    assert.deepEqual(storyMismatch.data, { expected: 3, got: 2 });
    const performanceMismatch = await errorOf(exec('music_video.edit', makeCtx(), editInputs({ performance: listValue('video', []) })));
    assert.equal(performanceMismatch.code, 'MUSICVIDEO_PERFORMANCE_MISMATCH');
    assert.deepEqual(performanceMismatch.data, { expected: 1, got: 0 });
    const performanceMissing = await errorOf(exec('music_video.edit', makeCtx(), editInputs({ performance: undefined })));
    assert.equal(performanceMissing.code, 'MUSICVIDEO_PERFORMANCE_MISMATCH', 'a port that is not connected counts as no clips');
    const unreadable = await errorOf(exec('music_video.edit', makeCtx(), editInputs({ shots: textValue('{"shots":[]}') })));
    assert.equal(unreadable.code, 'MUSICVIDEO_SHOTS_INVALID');
    // a single clip given as a value (not a list) is read as a list of one
    const onlyPerformance = handShots({ story: 0, performance: 1, shots: [{ ...handShots().shots[1], start: 0, end: 12, duration: 12, clip: 0 }] });
    const single = await exec('music_video.edit', makeCtx(), { song: editSong, shots: textValue(JSON.stringify(onlyPerformance)), story: listValue('video', []), performance: yellow }, { transition: 'cut' });
    near((await probeFile(path.join(sessionDir, single.variants[0].video.file))).duration, 12, 0.08);
    assert.deepEqual(await scratchLeft(), []);
  }

  /* ---------- the cut in batches ---------- */

  // nine scenes of 1.33 s (the boundaries fall on 33, 67, 100, ... frames): more than three, so cut in batches: three of three scenes,
  // and under a crossfade five of two (a batch also opens the clip before it)
  {
    const STORY = ['ff0000', '00ff00', '0000ff', 'ff00ff', '00ffff', 'ff8000', '8000ff'];
    const SINGER = ['ffff00', '808080'];
    const kinds = ['story', 'story', 'story', 'performance', 'story', 'story', 'story', 'performance', 'story'];
    const counters = { story: 0, performance: 0 };
    const scenes = kinds.map((kind, index) => ({ index, kind, clip: counters[kind]++ }));
    const sceneHex = scenes.map((scene) => (scene.kind === 'story' ? STORY : SINGER)[scene.clip]);
    const film = {
      ...handShots(),
      story: STORY.length,
      performance: SINGER.length,
      shots: scenes.map(({ index, kind, clip }) => ({
        index,
        start: (index * 12) / 9,
        end: ((index + 1) * 12) / 9,
        duration: 12 / 9,
        kind,
        clip,
        section: 'A',
        line: null,
        prompt: 'p',
        motion: kind === 'story' ? 'm' : '',
        character: null
      }))
    };
    const storyClips = [];
    for (const hex of STORY) storyClips.push(await videoAsset(hex, hex === 'ff8000' ? 1 : 5)); // one is too short for its scene: slowed down, then held
    const singerClips = [];
    for (const hex of SINGER) singerClips.push(await videoAsset(hex, 5));
    const batchInputs = (extra = {}) => ({ song: editSong, shots: textValue(JSON.stringify(film)), story: listValue('video', storyClips), performance: listValue('video', singerClips), ...extra });
    const bounds = Array.from({ length: 10 }, (_unused, index) => Math.round((index * 12 * 25) / 9));
    const middleOf = (index) => ((bounds[index] + bounds[index + 1]) / 2) / 25;

    // every process the render starts, and a hook to do something to them
    const started = [];
    let hook = null;
    const realRender = renderLib.renderPlan;
    patch(renderLib, 'renderPlan', (plan, options) =>
      realRender(plan, {
        ...options,
        onSpawn: (child, args) => {
          started.push(child);
          if (hook) hook(child, args);
        }
      })
    );
    const ended = async () => {
      for (let wait = 0; wait < 80; wait += 1) {
        if (started.every((child) => child.exitCode !== null || child.signalCode !== null)) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    };

    for (const transition of ['cut', 'crossfade', 'flash']) {
      started.length = 0;
      const ctx = makeCtx();
      const result = await exec('music_video.edit', ctx, batchInputs(), { transition, fade_out: 0 });
      const value = result.variants[0].video;
      const file = path.join(sessionDir, value.file);
      const info = await probeFile(file);
      assert.equal(info.frames, 300, `${transition}: the frames`);
      near(info.duration, 12, 0.08, `${transition}: the length of the song`);
      assert.equal(info.hasAudio, true);
      near(info.audioDuration, 12, 0.1);
      assert.deepEqual([info.width, info.height], [1280, 720]);
      near(value.duration, 12, 0.08, 'the stored length');
      // every scene shows its own clip, also the first one of every batch (scenes 4 and 7, or 3, 5, 7 and 9 under a crossfade); the boundaries lie where the plan put them
      for (let index = 0; index < 9; index += 1) assert.equal(await colourAt(file, middleOf(index)), sceneHex[index], `${transition}: scene ${index + 1}`);
      for (const index of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const boundary = bounds[index] / 25;
        assert.equal(await colourAt(file, boundary - 0.07), sceneHex[index - 1], `${transition}: still scene ${index} 0.07 s before its end`);
        if (transition === 'cut') assert.equal(await colourAt(file, boundary + 0.01), sceneHex[index], `${transition}: scene ${index + 1} at its first frame`);
        else assert.equal(await colourAt(file, boundary + 0.3), sceneHex[index], `${transition}: scene ${index + 1} after the ${transition}`);
      }
      const batchCount = transition === 'crossfade' ? 5 : 3;
      assert.equal(started.length, batchCount + 1, `${transition}: ${batchCount} batches and the encoder`);
      assert.ok(await ended(), `${transition}: no process is left`);
      assert.ok(ctx.logs.some((line) => new RegExp(`^9 scenes, 12 s at 25 fps, 1280x720, cut in ${batchCount} batches, 1 clips slowed down, 1 clips too short \\(last frame held\\)$`).test(line)), ctx.logs.join(' | '));
      assert.deepEqual(await scratchLeft(), [], `${transition}: no scratch folder is left`);
    }
    // three scenes or fewer: one process, no word about batches
    {
      started.length = 0;
      const ctx = makeCtx();
      const [first, second, third] = handShots().shots;
      const three = handShots({ story: 2, shots: [first, second, { ...third, end: 12, duration: 6 }] });
      await exec('music_video.edit', ctx, { song: editSong, shots: textValue(JSON.stringify(three)), story: listValue('video', storyClips.slice(0, 2)), performance: listValue('video', singerClips.slice(0, 1)) }, { transition: 'cut' });
      assert.equal(started.length, 0, 'the single process is not run by the batch code');
      assert.ok(!ctx.logs.some((line) => /batches/.test(line)), ctx.logs.join(' | '));
    }

    const videosInLedger = async () => (await store.readLedger(sessionId)).filter((item) => item.kind === 'video').length;
    // an abort in the middle of the job: the run ends with the abort, every process is killed, nothing is stored, nothing is left
    {
      started.length = 0;
      const before = await videosInLedger();
      const ctx = makeCtx();
      hook = () => {
        if (started.length === 3) ctx.controller.abort(); // the encoder and two batches are running
      };
      const error = await errorOf(exec('music_video.edit', ctx, batchInputs(), { transition: 'crossfade' }));
      hook = null;
      assert.ok(error && error.name === 'AbortError', String(error));
      assert.equal(started.length, 3, 'nothing is started after the abort');
      assert.ok(await ended(), 'abort: every process is killed');
      assert.equal(await videosInLedger(), before, 'abort: no video is stored');
      assert.deepEqual(await scratchLeft(), [], 'abort: no scratch folder is left');
    }
    // a batch that is killed from outside: the run fails with the reason, the encoder and the rest are stopped
    {
      started.length = 0;
      const before = await videosInLedger();
      hook = (child) => {
        if (started.length === 3) child.kill('SIGKILL'); // the second batch
      };
      const error = await errorOf(exec('music_video.edit', makeCtx(), batchInputs(), { transition: 'cut' }));
      hook = null;
      assert.ok(error && /^Scenes 4 to 6: ffmpeg ist fehlgeschlagen/.test(error.message), String(error && error.message));
      assert.equal(started.length, 3, 'the third batch is not started');
      assert.ok(await ended(), 'killed batch: every process is ended');
      assert.equal(await videosInLedger(), before, 'killed batch: no video is stored');
      assert.deepEqual(await scratchLeft(), [], 'killed batch: no scratch folder is left');
    }
    // a signal that has been aborted before the start
    {
      started.length = 0;
      const ctx = makeCtx();
      ctx.controller.abort();
      const error = await errorOf(exec('music_video.edit', ctx, batchInputs(), { transition: 'cut' }));
      assert.ok(error && error.name === 'AbortError', String(error));
      assert.equal(started.length, 0);
      assert.deepEqual(await scratchLeft(), []);
    }
  }

  /* ---------- the template through the engine ---------- */

  // The real nodes everywhere but at the three providers: image, video (the story clips, H3 Max turbo) and lip sync are doubles of the real
  // definitions (same ports and parameters). They make a picture or a clip of the colour their prompt names, so what the cut shows tells
  // where a clip came from.
  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  musicVideoNodes.registerAll(registry);
  // the local editing nodes: the zoom of the variant with moving images is the real one
  editNodes.registerAll(registry);
  // What the doubles saw, by the position in the list (the executions of a node run side by side and finish in any order)
  const seen = { image: { n8: [], n9: [] }, video: [], lipsync: [] };
  const clearSeen = () => {
    seen.image.n8.length = 0;
    seen.image.n9.length = 0;
    seen.video.length = 0;
    seen.lipsync.length = 0;
  };
  const colourOfImage = new Map();
  // `priced` keeps the price table of the real definition (the plan then prices the node)
  const double = (type, execute, { priced = false } = {}) =>
    registry.register({ ...real.get(type), available: () => true, prepare: undefined, validate: undefined, cost: priced ? real.get(type).cost : undefined, execute });
  const scratchFile = async (ctx, name) => path.join(await assets.createScratchDir(ctx.sessionId), name);
  const keepFile = async (ctx, file, options) => {
    const value = await ctx.saveOutputFile({ sourceFile: file, ...options });
    await assets.removeScratchDir(path.dirname(file));
    return value;
  };
  const promptColour = (text) => /colour #([0-9a-f]{6})/.exec(text)[1];
  double('image.edit', async (ctx, inputs) => {
    const prompt = inputs.prompt.value;
    const hex = promptColour(prompt);
    const file = await scratchFile(ctx, 'picture.png');
    await ff(['-f', 'lavfi', '-i', `color=c=0x${hex}:s=64x36:d=1`, '-frames:v', '1', file]);
    const value = await keepFile(ctx, file, { kind: 'image', ext: '.png', prompt, cost: 0 });
    colourOfImage.set(value.assetId, hex);
    const references = inputs.images.type === 'list' ? inputs.images.items.length : 1;
    seen.image[ctx.nodeId][ctx.itemIndex ?? 0] = { prompt, hex, references };
    return { variants: [{ image: value }] };
  });
  double('fal.h3_video', async (ctx, inputs, params) => {
    const hex = colourOfImage.get(inputs.first_frame.assetId);
    const clip = await colourClip(hex, params.duration);
    const file = await scratchFile(ctx, 'clip.mp4');
    await fsp.copyFile(clip, file);
    const value = await keepFile(ctx, file, { kind: 'video', ext: '.mp4', prompt: inputs.prompt.value, cost: 0, duration: params.duration });
    seen.video[ctx.itemIndex ?? 0] = { motion: inputs.prompt.value, hex, duration: params.duration };
    return { variants: [{ video: value }] };
  }, { priced: true });
  double('fal.h3_lipsync', async (ctx, inputs) => {
    const hex = colourOfImage.get(inputs.image.assetId);
    const slice = assets.assetFilePath(inputs.audio);
    const length = (await probeFile(slice)).duration;
    // the double needs the sound of the slice only for its length
    const clip = await colourClip(hex, Math.round(length * 100) / 100, { audioFile: slice });
    const file = await scratchFile(ctx, 'lipsync.mp4');
    await fsp.copyFile(clip, file);
    const value = await keepFile(ctx, file, { kind: 'video', ext: '.mp4', prompt: 'lip sync', cost: 0, duration: length });
    seen.lipsync[ctx.itemIndex ?? 0] = { hex, sliceSeconds: length, sliceDuration: inputs.audio.duration };
    return { variants: [{ video: value }] };
  });

  const bus = createEventBus();
  const flowStore = createWorkflowsStore({ dir: path.join(iso.root, 'data', 'workflows-music-video'), registry, events: bus });
  const engineConfig = { imageModel: 'openai/gpt-image-2', videoModel: 'bytedance/seedance-2.5', defaultBrain: 'vendor/default-brain', brainModels: ['vendor/default-brain'] };
  const engine = createEngine({ store: flowStore, registry, events: bus, getConfig: () => engineConfig, limits: { jobPollMs: 20 } });

  // The template burns the lyrics in as karaoke captions, and libass (the filter "ass") is not in every ffmpeg - not in the one of the machine
  // that runs this test, maybe. The cut therefore runs with a stand-in: the real ffmpeg, which lists the filter as present and takes it out
  // of the graph, after writing the script down. So the wiring (times node -> cut -> one script for the encoder) is tested everywhere; the
  // picture of the captions is tested with libass where there is one (test-captions-ass.js, test-music-video-captions.js).
  const standIn = await createAssStandIn(workDir, { real: bins.ffmpeg });
  const originalFfmpegPath = process.env.FFMPEG_PATH;
  restorers.push(() => {
    if (originalFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = originalFfmpegPath;
    ffmpegLib.resetFilterCache();
  });
  const useFfmpeg = (file) => {
    process.env.FFMPEG_PATH = file;
    ffmpegLib.resetFilterCache();
  };
  useFfmpeg(standIn.file);

  const document = templatesLib.resolveTemplate('music-video', { lang: 'en' });
  // the story clips are H3 Max turbo (Seedance refuses the images of the template: they show the person of the photo)
  assert.equal(document.graph.nodes.find((node) => node.id === 'n10').type, 'fal.h3_video');
  const created = await flowStore.createWorkflow({ document, user: STAFF, owner: null });
  const workflow = created.workflow;
  const flowSession = workflow.sessionId;
  const flowSong = await asset(songBytes, '.wav', flowSession);
  const flowPhoto = await asset(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), '.png', flowSession);
  const refOf = (value) => ({ assetId: value.assetId, sessionId: flowSession });
  {
    const graph = JSON.parse(JSON.stringify(workflow.graph));
    const set = (id, params) => Object.assign(graph.nodes.find((node) => node.id === id).params, params);
    set('n1', { asset: refOf(flowSong) });
    set('n2', { asset: refOf(flowPhoto) });
    set('n4', { lyrics: LYRICS_TEXT });
    set('n5', { brief: 'A drummer crosses a quiet harbour town at dawn.', shots_per_minute: 12, performance_share: 0.3 });
    await flowStore.saveGraph(workflow.id, { baseRev: workflow.rev, graph });
  }
  const resultOf = async (nodeId) => (await flowStore.readResults(workflow.id)).nodes[nodeId].history[0];
  let runNumber = 0;
  const runAll = async (overrides = {}, flowId = workflow.id) => {
    runNumber += 1;
    llmRun.token = ` run${runNumber}`;
    clearSeen();
    resetProviders();
    await standIn.reset();
    const runId = await engine.start(flowId, { mode: 'all', user: STAFF, overrides });
    const record = await engine.whenFinished(flowId, runId);
    assert.equal(record.status, 'completed', JSON.stringify(record.nodes).slice(0, 600));
    return record;
  };
  // the cut shows every scene in the colour of its prompt
  const checkCut = async (shots, finalVideo, session = flowSession) => {
    const file = path.join(store.sessionAssetDir(session), finalVideo.file);
    const info = await probeFile(file);
    near(info.duration, SONG_SECONDS, 0.1, 'as long as the song');
    assert.equal(info.hasAudio, true);
    for (const shot of shots.shots) {
      const expected = PALETTE[shot.index % PALETTE.length];
      assert.equal(await colourAt(file, (shot.start + shot.end) / 2), expected, `scene ${shot.index} (${shot.kind}) shows ${expected}`);
    }
    return file;
  };

  // the price of the times by the length of the song: an uploaded file has none, a file a node made has one (the plan reads it from the
  // values the node receives; while the song node still has to run it knows nothing)
  {
    const mini = (await flowStore.createWorkflow({ name: 'Times', user: STAFF, owner: null })).workflow;
    const scratch = await assets.createScratchDir(mini.sessionId);
    const file = path.join(scratch, 'song.wav');
    await fsp.writeFile(file, songBytes);
    const measured = await assets.saveOutputFile(mini.sessionId, { kind: 'audio', ext: '.wav', sourceFile: file, duration: SONG_SECONDS });
    await assets.removeScratchDir(scratch);
    const uploaded = await asset(songBytes, '.wav', mini.sessionId);
    assert.equal(measured.duration, SONG_SECONDS);
    assert.equal(uploaded.duration, undefined);
    let rev = mini.rev;
    const useSong = async (value) => {
      const graph = {
        nodes: [
          { id: 'a', type: 'input.audio', typeVersion: 1, x: 0, y: 0, params: { asset: { assetId: value.assetId, sessionId: mini.sessionId } } },
          { id: 't', type: 'audio.lyrics_timing', typeVersion: 1, x: 300, y: 0, params: { lyrics: LYRICS_TEXT, method: 'auto' } },
          { id: 'o', type: 'output.result', typeVersion: 1, x: 600, y: 0, params: { label: 'Times' } }
        ],
        edges: [
          { id: 'e1', from: { node: 'a', port: 'audio' }, to: { node: 't', port: 'audio' } },
          { id: 'e2', from: { node: 't', port: 'timing' }, to: { node: 'o', port: 'inputs' } }
        ],
        groups: [],
        notes: [],
        viewport: { x: 0, y: 0, zoom: 1 }
      };
      rev = (await flowStore.saveGraph(mini.id, { baseRev: rev, graph })).rev;
    };
    const planTimes = () => engine.plan(mini.id, { mode: 'all', user: STAFF });
    await useSong(measured);
    let planned = await planTimes();
    assert.equal(planned.nodes.t.estimate, null, 'the song node has not run: its length is not known');
    assert.equal(planned.totals.unknownNodes, 1);
    const upstream = await engine.start(mini.id, { mode: 'node', nodeIds: ['a'], user: STAFF });
    assert.equal((await engine.whenFinished(mini.id, upstream)).status, 'completed');
    planned = await planTimes();
    near(planned.nodes.t.estimate.usd, tools.lyricsTimingUsd(SONG_SECONDS), 1e-9, 'the length of the song node is used');
    assert.equal(planned.totals.unknownNodes, 0);
    near(planned.totals.usd, tools.lyricsTimingUsd(SONG_SECONDS), 1e-9);
    // an uploaded file: still no price after the song node has run
    await useSong(uploaded);
    const second = await engine.start(mini.id, { mode: 'node', nodeIds: ['a'], user: STAFF });
    assert.equal((await engine.whenFinished(mini.id, second)).status, 'completed');
    planned = await planTimes();
    assert.equal(planned.nodes.t.estimate, null, 'an upload carries no length');
    assert.equal(planned.totals.unknownNodes, 1);
    // the run books the measured length, whatever the plan knew
    resetProviders();
    const timed = await engine.start(mini.id, { mode: 'all', user: STAFF });
    assert.equal((await engine.whenFinished(mini.id, timed)).status, 'completed');
    const timedEntry = (await flowStore.readResults(mini.id)).nodes.t.history[0];
    near(timedEntry.cost.usd, tools.lyricsTimingUsd(SONG_SECONDS), 1e-9);
    assert.equal(journal.length, 1);
    near(journal[0].cost, tools.lyricsTimingUsd(SONG_SECONDS), 1e-9);
  }

  // 0. the plan before anything ran: the prices are unknown, the number of clips too, the title of the lip sync is the only thing known
  {
    const plan0 = await engine.plan(workflow.id, { mode: 'all', user: STAFF });
    assert.equal(plan0.valid, true, JSON.stringify(plan0.issues));
    assert.equal(plan0.nodes.n4.estimate, null, 'an uploaded song has no length: no price for the times');
    assert.equal(plan0.nodes.n8.executions, null, 'how many images there are comes from the plan');
    assert.equal(plan0.nodes.n10.executions, null);
    assert.ok(plan0.totals.unknownNodes >= 4);
  }

  // 1. a full run
  {
    await runAll();
    const shots = planLib.parseShots((await resultOf('n5')).variants[0].shots.value);
    const story = shots.shots.filter((shot) => shot.kind === 'story');
    const performance = shots.shots.filter((shot) => shot.kind === 'performance');
    assert.ok(story.length >= 3 && performance.length >= 1);

    // the times: aligned to the lyrics of the node, the length measured
    assert.equal(eleven.align.length, 1);
    assert.equal(eleven.align[0].text, LYRICS_TEXT);
    assert.equal(eleven.stt.length, 0);
    near((await resultOf('n4')).cost.usd, tools.lyricsTimingUsd(SONG_SECONDS), 1e-9, 'the price of the times by the length of the song');
    assert.equal(journal.filter((entry) => entry.type === 'speech').length, 1);
    // the plan: one request, paid by what the model charged
    assert.equal(llmCalls.length, 1);
    assert.equal((await resultOf('n5')).cost.usd, LLM_USD);
    assert.match(llmCalls[0].prompt, /^Brief:\nA drummer crosses a quiet harbour town at dawn\./);

    // the lists keep their order from the plan to the cut: image k of the story is the picture of scene k, the clip is made from it
    assert.equal(seen.image.n8.length, story.length);
    assert.equal(seen.image.n9.length, performance.length);
    assert.equal(seen.video.length, story.length);
    assert.equal(seen.lipsync.length, performance.length);
    story.forEach((shot, position) => {
      assert.match(seen.image.n8[position].prompt, new RegExp(`scene ${shot.index} story colour`), `image ${position} of the story is the picture of its scene`);
      assert.equal(seen.video[position].motion, `motion of scene ${shot.index}`, `clip ${position} gets the motion of its scene`);
      assert.equal(seen.video[position].hex, PALETTE[shot.index % PALETTE.length], `clip ${position} is made from the picture of its scene`);
    });
    performance.forEach((shot, position) => {
      assert.match(seen.image.n9[position].prompt, new RegExp(`scene ${shot.index} performance colour`), `image ${position} of the singer is the picture of its scene`);
      assert.equal(seen.lipsync[position].hex, PALETTE[shot.index % PALETTE.length], `lip sync ${position} is made from the picture of its scene`);
      near(seen.lipsync[position].sliceSeconds, shot.duration, 0.02, `lip sync ${position} gets the song slice of its scene`);
    });
    // the reference photo goes into every image, and the prompt tells to keep the person of the photo
    assert.ok([...seen.image.n8, ...seen.image.n9].every((entry) => entry.references === 1));
    assert.ok(seen.image.n8.every((entry) => entry.prompt.startsWith('If a person appears in this image, it is the person from the reference photo')));
    assert.ok(seen.image.n9.every((entry) => entry.prompt.startsWith('The singer is the person from the reference photo')));
    // the story clips are as long as the clip length of the plan
    const planNode = document.graph.nodes.find((node) => node.id === 'n5');
    assert.ok(seen.video.every((entry) => entry.duration === planNode.params.clip_seconds), 'the clip length of the template is the one of the plan');

    // the cut
    const final = (await resultOf('n12')).variants[0].video;
    const file = await checkCut(shots, final);
    const info = await probeFile(file);
    assert.deepEqual([info.width, info.height], [1280, 720]);
    near(info.frames, SONG_SECONDS * 25, 1);
    // the result node holds the video
    const shown = (await resultOf('n13')).variants[0].result;
    assert.equal((shown.type === 'list' ? shown.items[0] : shown).assetId, final.assetId);
    assert.deepEqual(await scratchLeft(flowSession), []);

    // the captions: the times of the song went from the times node to the cut, which gave ONE script to the encoder (not one per batch);
    // the lines are where the song has them (the film starts with the first scene), 0.4 s ahead of their first word
    const scripts = await standIn.scripts();
    assert.equal(scripts.length, 1, 'the encoder draws the captions once');
    const captions = parseAss(scripts[0].text);
    assert.deepEqual([captions.info.PlayResX, captions.info.PlayResY], ['1280', '720'], 'the script has the size of the film');
    assert.deepEqual(captions.events.map((event) => lex(event.text).visible.replace(/\n/g, ' ')), LYRICS, 'the lines of the song, in order');
    assert.ok(captions.events.every((event) => /\\kf\d+/.test(event.text)), 'karaoke: every line is filled word by word');
    const filmStart = shots.shots[0].start;
    near(captions.events[0].start / 100, Math.max(0, eleven.starts[0] - filmStart - 0.4), 0.02, 'the first line appears just before its first word');
    assert.ok(captions.events.every((event) => event.end / 100 <= SONG_SECONDS - filmStart + 0.01), 'nothing is shown after the end of the film');

    // a second plan: everything is up to date, and the nodes behind the lists know how many times they ran
    const planned = await engine.plan(workflow.id, { mode: 'all', user: STAFF });
    assert.equal(planned.valid, true);
    assert.equal(planned.totals.usd, 0);
    assert.deepEqual(Object.values(planned.nodes).filter((entry) => entry.status !== 'cached').map((entry) => entry.status), [], 'every step is up to date');
    assert.equal(planned.nodes.n8.executions, story.length);
    assert.equal(planned.nodes.n10.executions, story.length);
    assert.equal(planned.nodes.n9.executions, performance.length);
    assert.equal(planned.nodes.n11.executions, performance.length);

    // the price of the story clips once the plan has run: a clip is 5 s of H3 Max turbo at 768P, 0.04 USD a second (here 6 s: 0.24 each, so
    // that the node is stale and has a price); the rest of the chain is cached, and the doubles of the other providers have no price
    const repriced = await engine.plan(workflow.id, { mode: 'all', user: STAFF, overrides: { n10: { duration: 6 } } });
    assert.equal(repriced.nodes.n10.status, 'stale');
    assert.equal(repriced.nodes.n10.executions, story.length);
    assert.equal(repriced.nodes.n10.estimate.usd, 0.24);
    near(repriced.totals.usd, story.length * 0.24, 1e-9, 'every story clip is priced');
    assert.equal(repriced.totals.unknownNodes, 0);
    const hd = await engine.plan(workflow.id, { mode: 'all', user: STAFF, overrides: { n10: { duration: 5, resolution: '1080P' } } });
    assert.equal(hd.nodes.n10.estimate.usd, 0.4, 'turbo at 1080P: 5 s at 0.08 USD');
  }

  // 2. a share of 0: the lists for the singer are empty, the nodes behind them run no time, the video is made of the story clips
  {
    await runAll({ n5: { performance_share: 0 } });
    const shots = planLib.parseShots((await resultOf('n5')).variants[0].shots.value);
    assert.equal(shots.performance, 0);
    assert.equal(seen.lipsync.length, 0, 'no lip sync was made');
    assert.equal(seen.video.length, shots.story);
    const results = (await flowStore.readResults(workflow.id)).nodes;
    assert.deepEqual(results.n11.history[0].variants[0].video.items, [], 'an empty list comes out of the node behind an empty list');
    await checkCut(shots, (await resultOf('n12')).variants[0].video);
    const saved = await flowStore.readWorkflow(workflow.id);
    assert.equal(saved.graph.nodes.find((node) => node.id === 'n5').params.performance_share, 0.3, 'an override never changes the workflow');
  }

  // 3. a small share: one singer scene
  {
    await runAll({ n5: { performance_share: 0.1 } });
    const shots = planLib.parseShots((await resultOf('n5')).variants[0].shots.value);
    assert.equal(shots.performance, 1);
    assert.equal(seen.lipsync.length, 1);
    await checkCut(shots, (await resultOf('n12')).variants[0].video);
  }

  // 4. a song without lyrics: Scribe hears the words, the same plan
  {
    await runAll({ n4: { lyrics: '' } });
    assert.equal(eleven.align.length, 0);
    assert.equal(eleven.stt.length, 1);
    const shots = planLib.parseShots((await resultOf('n5')).variants[0].shots.value);
    assert.ok(shots.performance >= 1);
    await checkCut(shots, (await resultOf('n12')).variants[0].video);
  }

  // 5. an instrumental song: no words at all, no singer scene, cut on the beats, and still a video
  {
    resetProviders();
    eleven.silent = true;
    runNumber += 1;
    llmRun.token = ` run${runNumber}`;
    clearSeen();
    await standIn.reset();
    const runId = await engine.start(workflow.id, { mode: 'all', user: STAFF, overrides: { n4: { lyrics: '', method: 'transcribe' } } });
    const record = await engine.whenFinished(workflow.id, runId);
    assert.equal(record.status, 'completed', JSON.stringify(record.nodes).slice(0, 600));
    assert.equal(eleven.stt.length, 1);
    const shots = planLib.parseShots((await resultOf('n5')).variants[0].shots.value);
    assert.equal(shots.performance, 0);
    assert.equal(shots.cut_on, 'beats');
    assert.equal(seen.lipsync.length, 0);
    await checkCut(shots, (await resultOf('n12')).variants[0].video);
    assert.deepEqual(await standIn.scripts(), [], 'a song without words has nothing to show: the captions are on, but no script is made');
    eleven.silent = false;
  }

  // 6. the idea is missing: the plan says so before anything is paid
  {
    const emptyIdea = await engine.plan(workflow.id, { mode: 'all', user: STAFF, overrides: { n5: { brief: '' } } });
    assert.equal(emptyIdea.valid, false);
    const problem = emptyIdea.issues.find((issue) => issue.nodeId === 'n5' && issue.port === 'brief');
    assert.ok(problem && problem.level === 'error' && problem.code === 'missing_input', JSON.stringify(emptyIdea.issues));
    resetProviders();
    const refusedRun = await errorOf(engine.start(workflow.id, { mode: 'all', user: STAFF, overrides: { n5: { brief: '' } } }));
    assert.ok(refusedRun, 'the run is refused');
    assert.deepEqual([eleven.align.length, eleven.stt.length, llmCalls.length], [0, 0, 0], 'nothing was sent');
  }

  // 7. the captions switched off in the form: no script, the same film (a share that no case before used, so that the plan is made anew and
  //    the engine does not hand back the clips of an older run)
  {
    await runAll({ n5: { performance_share: 0.2 }, n12: { captions: 'off' } });
    const shots = planLib.parseShots((await resultOf('n5')).variants[0].shots.value);
    assert.deepEqual(await standIn.scripts(), []);
    await checkCut(shots, (await resultOf('n12')).variants[0].video);
  }

  // 8. an ffmpeg without libass: with the captions on the run is refused before anything is paid, and the plan says why; with the captions
  //    off the same plan is fine
  {
    const noAss = await createFakeFfmpeg(workDir, { filters: [], name: 'ffmpeg-no-libass' });
    useFfmpeg(noAss.file);
    try {
      resetProviders();
      const blocked = await engine.plan(workflow.id, { mode: 'all', user: STAFF });
      assert.equal(blocked.valid, false);
      const noLibass = blocked.issues.find((issue) => issue.nodeId === 'n12' && issue.code === 'CAPTIONS_NO_LIBASS');
      assert.ok(noLibass && noLibass.level === 'error', JSON.stringify(blocked.issues));
      assert.ok(await errorOf(engine.start(workflow.id, { mode: 'all', user: STAFF })), 'the run is refused');
      assert.deepEqual([eleven.align.length, eleven.stt.length, llmCalls.length, journal.length], [0, 0, 0, 0], 'nothing was sent and nothing was paid');
      const unblocked = await engine.plan(workflow.id, { mode: 'all', user: STAFF, overrides: { n12: { captions: 'off' } } });
      assert.equal(unblocked.valid, true, JSON.stringify(unblocked.issues));
      assert.equal((await noAss.calls()).length, 0, 'no ffmpeg process was started for this');
    } finally {
      useFfmpeg(standIn.file);
    }
  }

  // 9. the variant with moving images: the story scenes are moved by the zoom node of this computer (the real one), only the images and the
  //    lip sync are provider calls, and the cut and the captions are the same
  {
    const stillsDocument = templatesLib.resolveTemplate('music-video-stills', { lang: 'en' });
    const stills = (await flowStore.createWorkflow({ document: stillsDocument, user: STAFF, owner: null })).workflow;
    const stillsSession = stills.sessionId;
    const stillsSong = await asset(songBytes, '.wav', stillsSession);
    const stillsPhoto = await asset(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), '.png', stillsSession);
    const graph = JSON.parse(JSON.stringify(stills.graph));
    const setStills = (id, params) => Object.assign(graph.nodes.find((node) => node.id === id).params, params);
    setStills('n1', { asset: { assetId: stillsSong.assetId, sessionId: stillsSession } });
    setStills('n2', { asset: { assetId: stillsPhoto.assetId, sessionId: stillsSession } });
    setStills('n4', { lyrics: LYRICS_TEXT });
    setStills('n5', { brief: 'A drummer crosses a quiet harbour town at dawn.', shots_per_minute: 12, performance_share: 0.3 });
    await flowStore.saveGraph(stills.id, { baseRev: stills.rev, graph });

    await runAll({}, stills.id);
    const results = (await flowStore.readResults(stills.id)).nodes;
    const shots = planLib.parseShots(results.n5.history[0].variants[0].shots.value);
    assert.ok(shots.story >= 3 && shots.performance >= 1);
    assert.equal(seen.video.length, 0, 'no paid clip is made for the story');
    assert.equal(seen.lipsync.length, shots.performance, 'the singer scenes still get their lip sync');
    // a zoom clip per story scene, as long as the clip length of the plan, in the picture size of the scene's image
    const zooms = results.n10.history[0].variants[0].video;
    assert.equal(zooms.items.length, shots.story);
    for (const clip of zooms.items) {
      const info = await probeFile(path.join(store.sessionAssetDir(stillsSession), clip.file));
      near(info.duration, 5, 0.1, 'the zoom clip is as long as the clip length of the plan');
      assert.equal(info.hasAudio, false);
    }
    const file = await checkCut(shots, results.n12.history[0].variants[0].video, stillsSession);
    near((await probeFile(file)).frames, SONG_SECONDS * 25, 1);
    const stillsScripts = await standIn.scripts();
    assert.equal(stillsScripts.length, 1);
    assert.deepEqual(parseAss(stillsScripts[0].text).events.map((event) => lex(event.text).visible.replace(/\n/g, ' ')), LYRICS);
    assert.deepEqual(await scratchLeft(stillsSession), []);
    // the plan after the run: nothing left to run, and the zoom is no paid step (it costs nothing, a step of the gallery that is free)
    const afterwards = await engine.plan(stills.id, { mode: 'all', user: STAFF });
    assert.equal(afterwards.valid, true);
    assert.equal(afterwards.totals.usd, 0);
    assert.equal(afterwards.nodes.n10.executions, shots.story);
  }

  /* ---------- the Director's way ---------- */

  {
    const chat = await store.createSession({ owner: STAFF });
    const chatSong = await store.saveAsset(chat.id, { kind: 'audio', buffer: songBytes, ext: '.wav', prompt: 'my song' });
    const chatPhoto = await store.saveAsset(chat.id, { kind: 'image', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), ext: '.png', prompt: 'me' });
    const service = runServiceLib.createRunService({ engine, store: flowStore, registry });
    const viewer = access.viewerOf({}, {});
    resetProviders();
    clearSeen();
    const missing = await errorOf(service.prepare(viewer, { templateId: 'music-video', sourceSessionId: chat.id, inputs: { Song: chatSong.id }, lang: 'de' }));
    assert.equal(missing.code, 'MISSING_INPUT');
    assert.deepEqual(missing.missing.map((item) => [item.id, item.label.split(' (')[0]]), [['n2.asset', 'Foto der Hauptperson'], ['n5.brief', 'Idee für das Video']], 'the photo and the idea are asked for');
    const countBefore = (await flowStore.listWorkflows()).length;
    const prepared = await service.prepare(viewer, {
      templateId: 'music-video',
      sourceSessionId: chat.id,
      inputs: { Song: chatSong.id, 'Foto der Hauptperson': chatPhoto.id, 'n5.brief': 'A drummer crosses a quiet harbour town at dawn.', 'n5.performance_share': 0.2, 'n12.transition': 'crossfade', 'n12.captions': 'lines' },
      lang: 'de',
      requireStartable: true
    });
    assert.equal(prepared.created, true);
    assert.equal(prepared.name, 'Musikvideo aus Song');
    assert.equal((await flowStore.listWorkflows()).length, countBefore + 1);
    const made = await flowStore.readWorkflow(prepared.workflowId);
    const param = (id, name) => made.graph.nodes.find((node) => node.id === id).params[name];
    assert.equal(param('n5', 'brief'), 'A drummer crosses a quiet harbour town at dawn.');
    assert.equal(param('n5', 'performance_share'), 0.2);
    assert.equal(param('n12', 'transition'), 'crossfade');
    assert.equal(param('n12', 'captions'), 'lines', 'the captions are one of the things the person can set');
    assert.ok(param('n1', 'asset') && param('n1', 'asset').sessionId === made.sessionId, 'the song is copied into the workflow');
    assert.ok(param('n2', 'asset') && param('n2', 'asset').sessionId === made.sessionId);
    // what the card shows: paid, nothing known in advance but what the song costs once the plan has run
    const plan = prepared.plan;
    assert.equal(plan.paid, true);
    assert.equal(plan.valid, true, JSON.stringify(plan.issues));
    assert.ok(plan.totals.unknownNodes >= 4, 'the prices are not known before the plan has run');
    assert.deepEqual(plan.blockers.filter((blocker) => !['BUDGET_EXHAUSTED', 'BUDGET_INSUFFICIENT', 'RUN_ACTIVE'].includes(blocker.code)), []);
    // a paid run does not start without the amount the person accepted
    const noClick = await errorOf(service.start(viewer, prepared.workflowId, {}));
    assert.equal(noClick.code, 'CONFIRMATION_REQUIRED');
    // the card asks for the unknown steps too
    const tooLittle = await errorOf(service.start(viewer, prepared.workflowId, { maxUsd: 100 }));
    assert.equal(tooLittle.code, 'COST_CHANGED', 'steps without a price need to be accepted');
    assert.deepEqual([eleven.align.length, eleven.stt.length, llmCalls.length, seen.image.n8.length, seen.video.length, journal.length], [0, 0, 0, 0, 0, 0], 'nothing ran before the click');
    assert.equal(await service.discardPrepared(viewer, prepared), true);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
