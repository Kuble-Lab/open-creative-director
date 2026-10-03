'use strict';

// The song analysis (lib/music-analysis.js, WP34, node "Analyze song"): tempo, beats, sections and loudness, computed from the
// audio with no provider. The audio is made here: clicks and kick drums at a known tempo (so the right answer is known), and a
// made-up song of five parts that differ in loudness and sound. What is covered: the BPM (within 1), the beats (within 30 ms of
// the real ones; the measured error is a few ms), the BPM hint of a song plan, sections from a plan (also when its lengths are
// off by a second) and by listening (3 to 10 parts named "Teil 1" ...), the loudness per second, silence and very short audio,
// the way through ffmpeg (a WAV and an MP3 file; skipped without ffmpeg), abort, and that the event loop gets its turns.

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const analysis = require('../lib/music-analysis');
const ffmpeg = require('../lib/ffmpeg');

const execFileAsync = promisify(execFile);
const SR = analysis.SAMPLE_RATE;

/* ---------- the audio ---------- */

// small deterministic noise
function noise(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 4294967296) * 2 - 1;
  };
}

// A train of clicks (short 1 kHz bursts), the first at `offset` seconds. Returns the samples and the real time of every click.
function clickTrain(bpm, seconds, { offset = 0.3 } = {}) {
  const samples = new Float32Array(Math.floor(SR * seconds));
  const truth = [];
  for (let time = offset; time < seconds - 0.05; time += 60 / bpm) {
    truth.push(time);
    const from = Math.round(time * SR);
    for (let index = 0; index < 220 && from + index < samples.length; index += 1) {
      samples[from + index] += 0.8 * Math.sin((2 * Math.PI * 1000 * index) / SR) * Math.exp(-index / 40);
    }
  }
  return { samples, truth };
}

// A made-up song: parts of { seconds, pad, chord, kick, snare, hat, hatLevel }. Kick and snare on the beats, hats in `hat`
// parts per beat, a chord underneath. Returns the samples and the real boundaries between the parts.
function makeSong(bpm, parts) {
  const total = parts.reduce((sum, part) => sum + part.seconds, 0);
  const samples = new Float32Array(Math.floor(SR * total));
  const random = noise(7);
  const period = 60 / bpm;
  let at = 0;
  const boundaries = [];
  for (const part of parts) {
    const from = Math.round(at * SR);
    const to = Math.min(samples.length, Math.round((at + part.seconds) * SR));
    const chord = part.chord || [220, 277.2, 329.6];
    for (let index = from; index < to; index += 1) {
      let value = 0;
      for (const frequency of chord) value += Math.sin((2 * Math.PI * frequency * index) / SR);
      samples[index] += ((part.pad || 0) * value) / chord.length;
    }
    for (let beat = Math.ceil(at / period - 1e-9); beat * period < at + part.seconds - 0.01; beat += 1) {
      const time = beat * period;
      const start = Math.round(time * SR);
      if (part.kick) {
        for (let index = 0; index < SR * 0.25 && start + index < to; index += 1) {
          samples[start + index] += part.kick * Math.sin((2 * Math.PI * (55 + 90 * Math.exp(-index / 500)) * index) / SR) * Math.exp(-index / 2200);
        }
      }
      if (part.snare && beat % 2 === 1) {
        for (let index = 0; index < SR * 0.15 && start + index < to; index += 1) samples[start + index] += part.snare * random() * Math.exp(-index / 900);
      }
      for (let k = 0; k < (part.hat || 0); k += 1) {
        const hit = Math.round((time + (k * period) / part.hat) * SR);
        for (let index = 0; index < 700 && hit + index < to && hit + index >= from; index += 1) samples[hit + index] += (part.hatLevel || 0.12) * random() * Math.exp(-index / 150);
      }
    }
    at += part.seconds;
    boundaries.push(at);
  }
  return { samples, boundaries: boundaries.slice(0, -1), total };
}

const PARTS = [
  { seconds: 15, pad: 0.1, kick: 0, hat: 0 },
  { seconds: 30, pad: 0.1, kick: 0.5, snare: 0.15, hat: 2, hatLevel: 0.08 },
  { seconds: 35, pad: 0.16, chord: [262, 330, 392, 523], kick: 0.6, snare: 0.35, hat: 4, hatLevel: 0.15 },
  { seconds: 25, pad: 0.1, kick: 0.5, snare: 0.15, hat: 2, hatLevel: 0.08 },
  { seconds: 15, pad: 0.07, kick: 0, hat: 0 }
];
const PLAN = '[Intro | 15 s]\n+ 82 BPM, soft piano\n(ahhh)\n[Verse 1 | 30 s]\nla la\n[Chorus | 35 s]\nla la\n[Verse 2 | 25 s]\nla la\n[Outro | 15 s]\nla';
// the same plan, a second off at two boundaries (as the real ones are)
const PLAN_OFF = '[Intro | 15 s]\n+ 82 BPM, soft piano\n[Verse 1 | 29 s]\nla\n[Chorus | 36 s]\nla\n[Verse 2 | 25 s]\nla\n[Outro | 15 s]\nla';

function wavFile(samples) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + samples.length * 2, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SR, 24);
  bytes.writeUInt32LE(SR * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let index = 0; index < samples.length; index += 1) bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[index])) * 32767), 44 + index * 2);
  return bytes;
}

// How far the beats are from the real ones: for every real beat (not the first and last two) the nearest found one.
function beatErrors(found, truth) {
  return truth.slice(2, -2).map((time) => {
    let best = Infinity;
    let nearest = null;
    for (const beat of found) {
      if (Math.abs(beat - time) < best) {
        best = Math.abs(beat - time);
        nearest = beat;
      }
    }
    return nearest - time;
  });
}

/* ---------- tempo and beats ---------- */

async function testClicks() {
  for (const bpm of [96, 120, 75]) {
    const { samples, truth } = clickTrain(bpm, 60);
    const result = await analysis.analyse(samples, {});
    assert.ok(Math.abs(result.bpm - bpm) <= 1, `${bpm} BPM found as ${result.bpm}`);
    const errors = beatErrors(result.beats, truth);
    const worst = Math.max(...errors.map(Math.abs));
    assert.ok(worst <= 0.03, `${bpm} BPM: the beats are at most 30 ms off (worst ${Math.round(worst * 1000)} ms)`);
    assert.ok(Math.abs(result.beats.length - truth.length) <= 2, `${bpm} BPM: ${result.beats.length} beats for ${truth.length} clicks`);
    // beats are in order, in the song, apart by about a beat
    result.beats.forEach((time, index) => {
      assert.ok(time >= 0 && time <= result.duration + 1e-9);
      if (index > 0) assert.ok(Math.abs(time - result.beats[index - 1] - 60 / bpm) < 0.03, `${bpm} BPM: beat ${index} follows the one before`);
    });
    assert.equal(result.warnings.length, 0);
    assert.ok(result.tempoConfidence > 0.5);
    assert.equal(result.version, 1);
    assert.equal(result.duration, 60);
  }
}

async function testOctave() {
  // equal clicks at 150 BPM can as well be felt as 75: the answer is one of the two, and the beats are on clicks either way
  const { samples, truth } = clickTrain(150, 50);
  const result = await analysis.analyse(samples, {});
  assert.ok(Math.abs(result.bpm - 150) <= 1 || Math.abs(result.bpm - 75) <= 1, `${result.bpm}`);
  const onClicks = result.beats.slice(2, -2).filter((time) => truth.some((click) => Math.abs(click - time) <= 0.03));
  assert.ok(onClicks.length >= result.beats.length - 6, 'every beat is on a click');
}

async function testMusicalPatterns() {
  // kick drum on the beats with hats between them: the kind of pulse a song has
  for (const bpm of [82, 140]) {
    const song = makeSong(bpm, [{ seconds: 50, pad: 0.1, kick: 0.6, snare: 0.2, hat: 2, hatLevel: 0.1 }]);
    const result = await analysis.analyse(song.samples, {});
    assert.ok(Math.abs(result.bpm - bpm) <= 1, `kick pattern ${bpm}: ${result.bpm}`);
    const truth = [];
    for (let time = 0; time < 50 - 0.05; time += 60 / bpm) truth.push(time);
    assert.ok(Math.max(...beatErrors(result.beats, truth).map(Math.abs)) <= 0.03, `kick pattern ${bpm}: beats within 30 ms`);
  }
  // the beats reach back to the start of the song and on to its end, also where the song starts with a long quiet part
  const quiet = makeSong(100, [{ seconds: 12, pad: 0.1 }, { seconds: 30, pad: 0.1, kick: 0.6, snare: 0.2, hat: 2 }, { seconds: 10, pad: 0.05 }]);
  const result = await analysis.analyse(quiet.samples, {});
  assert.ok(Math.abs(result.bpm - 100) <= 1, `${result.bpm}`);
  assert.ok(result.beats[0] < 0.7, `the first beat is near the start (${result.beats[0]})`);
  assert.ok(result.beats[result.beats.length - 1] > result.duration - 0.7, 'the last beat is near the end');
  // the quiet start has no pulse to follow (a steady chord): its beats stay near the grid of the later ones
  const middle = result.beats.filter((time) => time > 14 && time < 40);
  const period = (middle[middle.length - 1] - middle[0]) / (middle.length - 1);
  const gridError = (time) => {
    const steps = (time - middle[0]) / period;
    return Math.abs(steps - Math.round(steps)) * period;
  };
  assert.ok(result.beats.filter((time) => time > 14 && time < 40).every((time) => gridError(time) < 0.03), 'the beats of the loud part are on the grid');
  assert.ok(result.beats.every((time) => gridError(time) < 0.1), 'and the others within 100 ms of it');
}

async function testHint() {
  // the plan names its tempo: 82 BPM
  assert.equal(analysis.bpmHint('+ 82 BPM, soft piano'), 82);
  assert.equal(analysis.bpmHint('[Intro | 15 s]\n+ 90 bpm, warm\n[Verse | 10 s]\n+ 92 Bpm, calm\n+ 94 BPM'), 92, 'the middle one');
  assert.equal(analysis.bpmHint('+ 120,5 BPM'), 120.5);
  assert.equal(analysis.bpmHint('+ 300 BPM'), null, 'out of reach');
  assert.equal(analysis.bpmHint('+ 12 BPM'), null);
  assert.equal(analysis.bpmHint('no tempo'), null);
  assert.equal(analysis.bpmHint(''), null);
  assert.equal(analysis.bpmHint(null), null);
  // equal clicks at 164 BPM can be felt as 164 or as 82: with the hint it is 82, beats at every second click
  const { samples, truth } = clickTrain(164, 50);
  const hinted = await analysis.analyse(samples, { planText: '[Verse | 50 s]\n+ 82 BPM, slow\nla' });
  assert.ok(Math.abs(hinted.bpm - 82) <= 1, `hinted: ${hinted.bpm}`);
  assert.ok(Math.abs(hinted.beats[10] - hinted.beats[9] - 60 / 82) < 0.03);
  const every = truth.filter((_unused, index) => index % 2 === 0);
  const nearOnTruth = hinted.beats.slice(2, -2).filter((time) => truth.some((click) => Math.abs(click - time) < 0.03));
  assert.ok(nearOnTruth.length >= hinted.beats.length - 6, 'every beat is on a click');
  assert.ok(every.length > 10);
  const free = await analysis.analyse(samples, {});
  assert.ok(Math.abs(free.bpm - 164) <= 1.5 || Math.abs(free.bpm - 82) <= 1, `without the hint either octave: ${free.bpm}`);
}

/* ---------- sections ---------- */

async function testSectionsFromPlan() {
  const song = makeSong(82, PARTS);
  assert.equal(song.total, 120);
  const result = await analysis.analyse(song.samples, { planText: PLAN });
  assert.equal(result.sectionSource, 'plan');
  assert.deepEqual(result.sections.map((section) => section.name), ['Intro', 'Verse 1', 'Chorus', 'Verse 2', 'Outro']);
  assert.equal(result.sections[0].start, 0);
  assert.equal(result.sections[result.sections.length - 1].end, 120);
  result.sections.forEach((section, index) => {
    assert.ok(section.end > section.start);
    if (index > 0) assert.equal(section.start, result.sections[index - 1].end, 'no gap, no overlap');
  });
  song.boundaries.forEach((boundary, index) => assert.ok(Math.abs(result.sections[index].end - boundary) <= 0.5, `boundary ${index + 1}: ${result.sections[index].end} for ${boundary}`));
  // loudness of the parts: the chorus is the loudest, the intro and outro are quieter
  const energy = result.sections.map((section) => section.energy);
  assert.ok(energy[2] === Math.max(...energy), JSON.stringify(energy));
  assert.ok(energy[0] < energy[1] && energy[4] < energy[1]);
  assert.ok(energy.every((value) => value >= 0 && value <= 1));
  // the plan is off by a second at two boundaries: they move to the change in the sound
  const off = await analysis.analyse(song.samples, { planText: PLAN_OFF });
  assert.equal(off.sectionSource, 'plan');
  song.boundaries.forEach((boundary, index) => assert.ok(Math.abs(off.sections[index].end - boundary) <= 0.5, `moved boundary ${index + 1}: ${off.sections[index].end} for ${boundary}`));
  // a plan that is a little shorter or longer than the audio: the last part takes up the difference
  const shorter = await analysis.analyse(song.samples, { planText: PLAN.replace('[Outro | 15 s]', '[Outro | 12 s]') });
  assert.equal(shorter.sectionSource, 'plan');
  assert.equal(shorter.sections.length, 5);
  assert.equal(shorter.sections[4].end, 120);
  const longer = await analysis.analyse(song.samples, { planText: PLAN.replace('[Outro | 15 s]', '[Outro | 15 s]\nla\n[Coda | 10 s]\nla') });
  assert.equal(longer.sectionSource, 'plan');
  assert.equal(longer.sections[longer.sections.length - 1].end, 120);
  assert.ok(longer.sections.every((section) => section.end > section.start));
  // a plan that does not fit the audio at all (twice as long) is not used
  const wrong = await analysis.analyse(song.samples, { planText: PLAN.replace(/\| (\d+) s\]/g, (_all, seconds) => `| ${seconds * 2} s]`) });
  assert.equal(wrong.sectionSource, 'detected');
  assert.ok(wrong.warnings.includes('PLAN_LENGTH_MISMATCH'));
  assert.ok(wrong.sections.every((section) => /^Teil \d+$/.test(section.name)));
  // a plan without lengths, or without sections: sections by listening
  for (const planText of ['just words', '[Verse]\nla', '', '[Verse | x]\nla']) {
    const none = await analysis.analyse(song.samples.subarray(0, SR * 40), { planText });
    assert.equal(none.sectionSource, 'detected', JSON.stringify(planText));
  }
  // the parts of a plan
  assert.deepEqual(analysis.planSections(PLAN).map((section) => [section.name, section.start, section.end]), [['Intro', 0, 15], ['Verse 1', 15, 45], ['Chorus', 45, 80], ['Verse 2', 80, 105], ['Outro', 105, 120]]);
  assert.equal(analysis.planSections('[ | 10 s]\nla\n[Chorus | 5 s]\nla')[0].name, 'Teil 1', 'a section without a name');
  assert.equal(analysis.planSections('[Verse | 10 s]\nla\n[Chorus]\nla'), null, 'one section without a length spoils the plan');
  assert.equal(analysis.planSections(''), null);
  assert.equal(analysis.planSections(null), null);
}

async function testSectionsByListening() {
  const song = makeSong(82, PARTS);
  const result = await analysis.analyse(song.samples, {});
  assert.equal(result.sectionSource, 'detected');
  assert.ok(result.sections.length >= 3 && result.sections.length <= 10, `${result.sections.length} parts`);
  assert.equal(result.sections.length, 5, 'a song of two minutes with five parts');
  result.sections.forEach((section, index) => {
    assert.equal(section.name, `Teil ${index + 1}`);
    assert.ok(section.end > section.start);
    if (index > 0) assert.equal(section.start, result.sections[index - 1].end);
  });
  assert.equal(result.sections[0].start, 0);
  assert.equal(result.sections[result.sections.length - 1].end, 120);
  song.boundaries.forEach((boundary, index) => assert.ok(Math.abs(result.sections[index].end - boundary) <= 1.5, `boundary ${index + 1}: ${result.sections[index].end} for ${boundary}`));
  // never more than ten parts, however long the song
  const long = makeSong(100, Array.from({ length: 24 }, (_unused, index) => ({ seconds: 15, pad: 0.05 + (index % 2) * 0.1, kick: index % 2 ? 0.6 : 0, hat: index % 2 ? 2 : 0 })));
  const many = await analysis.analyse(long.samples, {});
  assert.ok(many.sections.length >= 3 && many.sections.length <= 10, `${many.sections.length} parts for six minutes`);
  // a song with no change at all still has its three parts, of a sensible length
  const flat = await analysis.analyse(clickTrain(110, 60).samples, {});
  assert.ok(flat.sections.length >= 3 && flat.sections.length <= 10);
  assert.ok(flat.sections.every((section) => section.end - section.start >= 5), JSON.stringify(flat.sections));
  // a short song gets fewer parts, but at least one
  const short = await analysis.analyse(clickTrain(110, 8).samples, {});
  assert.ok(short.sections.length >= 1 && short.sections.length <= 2, `${short.sections.length}`);
}

/* ---------- loudness, silence, short audio ---------- */

async function testEnergyAndEdges() {
  const song = makeSong(82, PARTS);
  const result = await analysis.analyse(song.samples, {});
  assert.equal(result.energy.length, 120, 'one value per second');
  assert.ok(result.energy.every((value) => value >= 0 && value <= 1));
  assert.equal(Math.max(...result.energy), 1);
  assert.ok(result.energy[60] > result.energy[5], 'the chorus is louder than the intro');
  assert.ok(result.energy[112] < result.energy[60]);
  // the length is rounded up to whole seconds
  const odd = await analysis.analyse(clickTrain(100, 10.4).samples, {});
  assert.equal(odd.energy.length, 11);
  // silence: no pulse, a regular grid at 120 BPM (or the hint), one part, a warning, no error
  const silence = await analysis.analyse(new Float32Array(SR * 20), {});
  assert.equal(silence.bpm, 120);
  assert.ok(silence.warnings.includes('NO_PULSE'));
  assert.equal(silence.tempoConfidence, 0);
  assert.ok(silence.beats.length >= 39 && silence.beats.length <= 41);
  assert.ok(silence.sections.length >= 1);
  assert.ok(silence.energy.every((value) => value === 0));
  const hinted = await analysis.analyse(new Float32Array(SR * 20), { planText: '+ 90 BPM, calm' });
  assert.equal(hinted.bpm, 90);
  // very short audio and an empty file
  const brief = await analysis.analyse(clickTrain(120, 2).samples, {});
  assert.equal(brief.duration, 2);
  assert.equal(brief.sections.length, 1);
  assert.ok(Number.isFinite(brief.bpm));
  const empty = await analysis.analyse(new Float32Array(0), {});
  assert.equal(empty.duration, 0);
  assert.equal(empty.sections.length, 1);
  assert.deepEqual(empty.energy, [0]);
  // the result is plain data
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
}

async function testPerformance() {
  // five minutes: a few seconds at most, and the event loop gets turns in between
  const song = makeSong(120, Array.from({ length: 10 }, (_unused, index) => ({ seconds: 30, pad: 0.08, kick: index % 2 ? 0.6 : 0.3, snare: 0.2, hat: 2 })));
  const original = global.setImmediate;
  let turns = 0;
  global.setImmediate = (...args) => {
    turns += 1;
    return original(...args);
  };
  const started = Date.now();
  let result;
  try {
    result = await analysis.analyse(song.samples, {});
  } finally {
    global.setImmediate = original;
  }
  assert.ok(Date.now() - started < 20000, `${Date.now() - started} ms for five minutes`);
  assert.ok(turns >= 4, `the event loop was given ${turns} turns`);
  assert.ok(Math.abs(result.bpm - 120) <= 1);
  assert.equal(result.duration, 300);
}

async function testAbort() {
  const song = makeSong(120, [{ seconds: 200, pad: 0.08, kick: 0.5, snare: 0.2, hat: 2 }]);
  const controller = new AbortController();
  const pending = analysis.analyse(song.samples, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (err) => err.name === 'AbortError');
  const done = new AbortController();
  done.abort();
  await assert.rejects(analysis.decodeMono('/nonexistent.wav', { signal: done.signal }), (err) => err.name === 'AbortError');
}

/* ---------- through ffmpeg ---------- */

async function testThroughFfmpeg() {
  const binaries = ffmpeg.binaries();
  if (!binaries.available) {
    console.log('(ffmpeg not found: the files are not tested)');
    return;
  }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-music-analysis-'));
  try {
    const { samples, truth } = clickTrain(96, 40);
    const wav = path.join(dir, 'clicks.wav');
    await fsp.writeFile(wav, wavFile(samples));
    // a WAV: the same answer as the samples gave
    const fromWav = await analysis.analyseFile(wav, {});
    assert.ok(Math.abs(fromWav.bpm - 96) <= 1, `${fromWav.bpm}`);
    assert.ok(Math.max(...beatErrors(fromWav.beats, truth).map(Math.abs)) <= 0.03);
    assert.equal(Math.round(fromWav.duration), 40);
    // an MP3 (lossy, with the delay of its encoder): the tempo stays, the beats within 30 ms of the clicks plus the delay
    const mp3 = path.join(dir, 'clicks.mp3');
    await execFileAsync(binaries.ffmpeg, ['-nostdin', '-v', 'error', '-y', '-i', wav, '-ar', '44100', '-ac', '2', '-b:a', '128k', mp3]);
    const fromMp3 = await analysis.analyseFile(mp3, {});
    assert.ok(Math.abs(fromMp3.bpm - 96) <= 1, `mp3 ${fromMp3.bpm}`);
    const errors = beatErrors(fromMp3.beats, truth);
    const mean = errors.reduce((sum, value) => sum + value, 0) / errors.length;
    assert.ok(Math.max(...errors.map((value) => Math.abs(value - mean))) <= 0.03, 'mp3: the beats keep their spacing');
    assert.ok(Math.abs(mean) <= 0.06, `mp3: the encoder's delay is ${Math.round(mean * 1000)} ms`);
    // a video file with sound works the same
    const video = path.join(dir, 'clip.mp4');
    await execFileAsync(binaries.ffmpeg, ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=40', '-i', wav, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video]);
    const fromVideo = await analysis.analyseFile(video, {});
    assert.ok(Math.abs(fromVideo.bpm - 96) <= 1, `video ${fromVideo.bpm}`);
    // a file that is not audio, a missing file, and audio of a tenth of a second
    await fsp.writeFile(path.join(dir, 'text.wav'), 'this is not audio');
    await assert.rejects(analysis.analyseFile(path.join(dir, 'text.wav'), {}), /could not read the audio/);
    await assert.rejects(analysis.analyseFile(path.join(dir, 'missing.wav'), {}), /could not read the audio/);
    await fsp.writeFile(path.join(dir, 'tiny.wav'), wavFile(new Float32Array(SR / 10)));
    await assert.rejects(analysis.analyseFile(path.join(dir, 'tiny.wav'), {}), (err) => err.code === 'BEATS_AUDIO_TOO_SHORT');
    // the decoded audio: mono, 22.05 kHz
    const decoded = await analysis.decodeMono(wav, {});
    assert.equal(decoded.length, 40 * SR);
    assert.ok(decoded instanceof Float32Array);
    const peak = Math.max(...decoded.subarray(6000, 8000));
    assert.ok(peak > 0.55 && peak < 0.85, `the first click (at 0.3 s) has its level: ${peak}`);
    // nothing is left behind: the decoding needs no file
    assert.deepEqual((await fsp.readdir(dir)).sort(), ['clicks.mp3', 'clicks.wav', 'clip.mp4', 'text.wav', 'tiny.wav']);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

(async () => {
  await testClicks();
  await testOctave();
  await testMusicalPatterns();
  await testHint();
  await testSectionsFromPlan();
  await testSectionsByListening();
  await testEnergyAndEdges();
  await testPerformance();
  await testAbort();
  await testThroughFfmpeg();
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'lib', 'music-analysis.js')));
  console.log('test-music-analysis.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
