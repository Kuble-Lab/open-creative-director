'use strict';

// Tests for "Rough cut from recording" (video.rough_cut) and "Subtitles" (video.subtitles): the pure planning of the cut
// (lib/rough-cut.js), the cues (lib/subtitles.js), and both nodes on a real ffmpeg with a recording made on the spot: a white square
// and a tone that are on exactly while a "word" is spoken. ElevenLabs and the language model are stand-ins; nothing is paid.
// After the cut the square and the tone must still come and go together (picture and sound in sync).

const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');

const ffmpeg = require('../lib/ffmpeg');
const tools = require('../lib/tools');
const generate = require('../lib/nodes/nodes-generate');
const roughCut = require('../lib/rough-cut');
const subtitles = require('../lib/subtitles');
const captions = require('../lib/captions-ass');
const nodesRoughCut = require('../lib/nodes/nodes-rough-cut');
const { createEditHarness, execFileAsync } = require('./support/edit-harness');

const W = (text, start, end) => ({ text, start, end });

/* ---------- pure: the cut ---------- */

function testFillers() {
  const words = [W('Also', 0.5, 0.8), W('ähm', 1.0, 1.3), W('wir', 1.5, 1.7), W('Um,', 2.0, 2.2), W('este', 2.5, 2.7), W('es', 3.0, 3.1), W('este', 3.1, 3.3), W('libro.', 3.3, 3.8)];
  const cuts = roughCut.fillerCuts(words);
  // "ähm" and "Um," by the list; "este" alone between pauses is a filler, "este libro" is not
  assert.deepEqual(cuts.map((cut) => cut.from), [1, 3, 4]);
  assert.ok(cuts.every((cut) => cut.kind === 'filler' && cut.from === cut.to));
  assert.equal(roughCut.isFiller([W('er', 0, 0.2)], 0), false, 'German "er" (he) is no filler');
}

function testReadCuts() {
  const answer = '```json\n{"cuts":[{"from":4,"to":6,"kind":"retake","reason":"zweiter Anlauf besser"},{"from":2,"to":3,"kind":"false_start"},{"from":5,"to":5},{"from":9,"to":20},{"from":"x"},{"from":7,"kind":"filler"}],"summary":"Zwei Anläufe gekürzt."}\n```';
  const read = roughCut.readCuts(answer, 12);
  assert.equal(read.readable, true);
  assert.deepEqual(read.cuts.map((cut) => [cut.from, cut.to, cut.kind]), [[2, 3, 'false_start'], [4, 6, 'retake'], [7, 7, 'filler']]);
  assert.equal(read.summary, 'Zwei Anläufe gekürzt.');
  assert.equal(read.problems.length, 3, 'out of range, not a number, and the overlap are reported');
  assert.deepEqual(roughCut.readCuts(answer, 12, { removeFillers: false }).cuts.map((cut) => cut.kind), ['false_start', 'retake']);
  assert.equal(roughCut.readCuts('no json here', 5).readable, false);
  assert.deepEqual(roughCut.readCuts('{"cuts":[]}', 5).cuts, []);
  // the model's cut wins over a filler inside it; separate ones stay
  const merged = roughCut.mergeCuts([{ from: 3, to: 3, kind: 'filler' }, { from: 9, to: 9, kind: 'filler' }], [{ from: 2, to: 5, kind: 'retake' }]);
  assert.deepEqual(merged.map((cut) => [cut.from, cut.to]), [[2, 5], [9, 9]]);
}

// A long transcript is read in parts that end at a long pause.
function testWordParts() {
  const words = [];
  for (let i = 0; i < 250; i += 1) words.push(W(`w${i}`, i + (i > 95 ? 3 : 0), i + 0.5 + (i > 95 ? 3 : 0)));
  assert.deepEqual(roughCut.wordParts(words.slice(0, 80), 100), [{ from: 0, to: 79 }]);
  const parts = roughCut.wordParts(words, 100);
  assert.deepEqual(parts[0], { from: 0, to: 95 }, 'the first part ends at the pause of 3.5 s');
  assert.equal(parts[parts.length - 1].to, 249);
  parts.forEach((part, index) => {
    assert.ok(part.to - part.from + 1 <= 100);
    if (index) assert.equal(part.from, parts[index - 1].to + 1);
  });
}

function testPlan() {
  const words = [W('Also', 0.5, 0.8), W('ähm', 1.0, 1.3), W('wir', 1.5, 1.7), W('wollten,', 1.7, 2.0), W('wir', 2.4, 2.6), W('haben', 2.6, 2.9), W('entschieden.', 2.9, 3.5), W('Das', 6.0, 6.2), W('ist', 6.2, 6.4), W('gut.', 6.4, 6.8)];
  const cuts = roughCut.mergeCuts(roughCut.fillerCuts(words), [{ from: 2, to: 3, kind: 'false_start', reason: 'Fehlstart' }]);
  const plan = roughCut.planCut({ words, duration: 9, cuts, fps: 25 });
  // every edge on the 25 fps grid
  for (const piece of plan.keep) for (const t of [piece.start, piece.end]) assert.ok(Math.abs(t * 25 - Math.round(t * 25)) < 1e-6 || t === 9, `${t} is on the frame grid`);
  // no kept piece cuts into a kept word; every kept word lies inside one piece
  const keptWords = words.filter((_w, index) => ![1, 2, 3].includes(index));
  for (const word of keptWords) assert.ok(plan.keep.some((piece) => word.start >= piece.start && word.end <= piece.end), `${word.text} is kept whole`);
  // removed words are gone, with the padding of 0.08 s kept on both sides of the neighbours
  for (const word of words.slice(1, 4)) assert.ok(!plan.keep.some((piece) => word.start >= piece.start && word.end <= piece.end), `${word.text} is cut`);
  assert.ok(plan.keep[0].end >= 0.8 + 0.08 - 0.02 && plan.keep[1].start <= 2.4 - 0.08 + 0.02);
  // the pause of 2.5 s is shortened to about 0.7 s, the silence at the ends trimmed to 0.3 s and 0.6 s
  const pauseLeft = plan.keep[2].start - plan.keep[1].end;
  assert.ok(pauseLeft > 0, 'a cut between the two sentences');
  const remapped = roughCut.remapWords(words, plan.keep);
  assert.deepEqual(remapped.map((word) => word.text), ['Also', 'wir', 'haben', 'entschieden.', 'Das', 'ist', 'gut.']);
  const gap = remapped[4].start - remapped[3].end;
  assert.ok(gap > 0.6 && gap < 0.8, `the long pause became ${gap} s`);
  assert.ok(Math.abs(remapped[0].start - 0.3) < 0.03, 'the first word starts 0.3 s into the cut');
  assert.ok(Math.abs(plan.newDuration - (remapped[remapped.length - 1].end + 0.6)) < 0.05, 'the cut ends 0.6 s after the last word');
  assert.equal(plan.newDuration, Math.round(plan.keep.reduce((sum, piece) => sum + piece.end - piece.start, 0) * 1000) / 1000);
  // the report names the cuts
  const report = roughCut.cutReport(plan, { language: 'de', summary: 'Ein Fehlstart.' });
  assert.match(report, /^Vorher 0:09\.0, nachher 0:0\d\.\d, 4 Schnitte\./);
  assert.match(report, /Fehlstart: «ähm wir wollten,»/);
  assert.match(report, /Pause/);
  assert.equal(report.includes('ß'), false);

  // switched off: no pause shortening, no trimming of the ends, nothing cut at all
  const untouched = roughCut.planCut({ words, duration: 9, cuts: [], fps: 25, shortenPauses: false, trimEnds: false });
  assert.deepEqual(untouched.keep, [{ start: 0, end: 9 }]);
  assert.deepEqual(untouched.removed, []);
  // everything cut is refused
  assert.throws(() => roughCut.planCut({ words, duration: 9, cuts: [{ from: 0, to: words.length - 1, kind: 'retake' }], fps: 25 }), (err) => err.code === 'ROUGHCUT_NOTHING_LEFT');
  // 29.97 fps: grid of 1001/30000 s and fine sound blocks
  const ntsc = roughCut.planCut({ words, duration: 9, cuts, fps: 30000 / 1001 });
  for (const piece of ntsc.keep.slice(0, -1)) assert.ok(Math.abs(piece.end / (1001 / 30000) - Math.round(piece.end / (1001 / 30000))) < 1e-3);
  assert.equal(roughCut.audioBlockSamples(25), 1920);
  assert.equal(roughCut.audioBlockSamples(30), 1600);
  assert.equal(roughCut.audioBlockSamples(30000 / 1001), 80);
}

function testModelText() {
  const words = [W('Hallo', 0.2, 0.5), W('zusammen.', 0.5, 1.0), W('Heute', 2.0, 2.3), W('zeige', 2.3, 2.6)];
  const transcript = roughCut.transcriptForModel(words);
  assert.equal(transcript, '0:00.2: [0]Hallo [1]zusammen.\n0:02.0 (pause 1.0 s): [2]Heute [3]zeige');
  const prompt = roughCut.userPrompt({ transcript, instructions: 'Lacher stehen lassen', language: 'de', removeFillers: false });
  assert.match(prompt, /Swiss High German/);
  assert.match(prompt, /Keep filler words/);
  assert.match(prompt, /Lacher stehen lassen/);
  assert.match(roughCut.systemPrompt(), /JSON only/);
  assert.match(roughCut.systemPrompt(), /never cut content/i);
}

function testRenderArgs() {
  const args = roughCut.renderArgs({ input: '/in.mp4', output: '/out.mp4', keep: [{ start: 0, end: 1 }, { start: 2.04, end: 3 }], fps: 25 });
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /fps=25,select='between\(t,-0\.020000,0\.980000\)\+between\(t,2\.020000,2\.980000\)',setpts=N\/FRAME_RATE\/TB\[v\]/);
  assert.match(graph, /aselect='between\(t,-0\.000010,0\.999990\)\+between\(t,2\.039990,2\.999990\)'/);
  assert.match(roughCut.renderArgs({ input: '/i', output: '/o', keep: [{ start: 0, end: 1 }], fps: 30000 / 1001 }).join(' '), /fps=30000\/1001,/);
  assert.match(graph, /aresample=48000,asetnsamples=n=1920:p=0,aselect=/);
  assert.ok(args.includes('[a]') && args.includes('libx264'));
  const mute = roughCut.renderArgs({ input: '/in.mp4', output: '/out.mp4', keep: [{ start: 0, end: 1 }], fps: 25, hasAudio: false });
  assert.ok(mute.includes('-an') && !mute.includes('[a]'));
}

/* ---------- pure: subtitles ---------- */

function testSubtitles() {
  const sentence = 'Wir haben uns entschieden, die neue Version erst im Frühling zu veröffentlichen, weil der Winter zu kurz ist. Danach geht es weiter.';
  let t = 0.3;
  const words = sentence.split(' ').map((text) => {
    const word = W(text, t, t + 0.3);
    t += text.endsWith('.') ? 1.4 : 0.35;
    return word;
  });
  const { cues, srt, vtt, timing } = subtitles.subtitlesFromWords(words, { maxChars: 42, maxLines: 2 });
  assert.ok(cues.length >= 2);
  for (const cue of cues) {
    assert.ok(cue.lines.length <= 2, 'at most two lines');
    for (const line of cue.lines) assert.ok(line.length <= 42 || !line.includes(' '), `line "${line}" fits 42 characters`);
    assert.ok(cue.end - cue.start <= subtitles.MAX_SECONDS_DEFAULT + 0.31);
    assert.ok(cue.end > cue.start);
  }
  // the sentence end with its long pause starts a new cue
  assert.ok(cues.some((cue) => cue.words[0].text === 'Danach'));
  // a line is not broken after a weak word where a better break exists
  for (const cue of cues) if (cue.lines.length === 2) assert.ok(!/ (die|der|im|zu)$/.test(cue.lines[0]), `no break after a weak word: ${cue.lines[0]}`);
  assert.match(srt, /^1\n00:00:00,300 --> 00:00:0\d,\d{3}\n/);
  assert.ok(srt.includes('\n\n2\n'));
  assert.match(vtt, /^WEBVTT\n\n00:00:00\.300 --> /);
  // the timing fits "Burn in captions": a line per cue, the words with their line
  const read = captions.readTiming(JSON.stringify(timing));
  assert.equal(read.lines.length, cues.length);
  assert.equal(read.words.length, words.length);
  assert.ok(timing.words.every((word) => Number.isInteger(word.line)));
  // one line of 28 characters for portrait
  const portrait = subtitles.buildCues(words, { maxChars: 28, maxLines: 1 });
  assert.ok(portrait.every((cue) => cue.lines.length === 1 && (cue.lines[0].length <= 28 || !cue.lines[0].includes(' '))));
  // a short cue stays at least 0.8 s, never into the next one
  const short = subtitles.buildCues([W('Ja.', 1, 1.2), W('Nein.', 1.6, 1.9)], { maxChars: 42 });
  assert.equal(short.length, 1, 'two short words of one breath are one cue');
  const apart = subtitles.buildCues([W('Ja.', 1, 1.2), W('Nein.', 3, 3.2)]);
  assert.equal(apart[0].end, 1.8);
  assert.equal(subtitles.stamp(3723.4567, ','), '01:02:03,457');
  assert.equal(subtitles.toVtt([{ start: 0, end: 1, lines: ['a --> b'] }]).includes('-->  b'), false);
}

/* ---------- the nodes on a real ffmpeg ---------- */

// Word spans of the recording: the square is white and the tone sounds exactly then.
const SPANS = [[1.0, 1.6], [2.0, 2.6], [3.0, 3.4], [6.0, 6.6], [7.0, 7.6]];
const TEXTS = ['Hallo', 'ähm', 'zusammen.', 'Heute', 'zeige'];
const between = (variable) => SPANS.map(([a, b]) => `between(${variable},${a},${b})`).join('+');

async function makeRecording(h) {
  await h.ff([
    '-f', 'lavfi', '-i', `color=black:s=64x64:r=25:d=9,drawbox=x=0:y=0:w=64:h=64:color=white:t=fill:enable='${between('t')}'`,
    '-f', 'lavfi', '-i', `aevalsrc='if(${between('t')},0.6*sin(2*PI*440*t),0)':s=48000:d=9`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', h.src('recording.mp4')
  ]);
  return h.upload('recording.mp4', '.mp4');
}

// When the picture is white and when the tone sounds in a file, in steps of 10 ms: [[start, end]] of each.
async function onSpans(file) {
  const bin = ffmpeg.binaries().ffmpeg;
  const { stdout: frames } = await execFileAsync(bin, ['-nostdin', '-v', 'error', '-i', file, '-vf', 'scale=4:4', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const { stdout: pcm } = await execFileAsync(bin, ['-nostdin', '-v', 'error', '-i', file, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const picture = [];
  for (let i = 0; i < frames.length / 16; i += 1) picture.push(frames[i * 16 + 5] > 128);
  const sound = [];
  for (let i = 0; i + 80 <= pcm.length / 2; i += 80) {
    let energy = 0;
    for (let k = 0; k < 80; k += 1) energy += Math.abs(pcm.readInt16LE((i + k) * 2));
    sound.push(energy / 80 > 2000);
  }
  const spans = (flags, step) => {
    const out = [];
    flags.forEach((on, index) => {
      if (on && !flags[index - 1]) out.push([index * step, null]);
      if (!on && flags[index - 1]) out[out.length - 1][1] = index * step;
    });
    if (out.length && out[out.length - 1][1] === null) out[out.length - 1][1] = flags.length * step;
    return out;
  };
  return { picture: spans(picture, 1 / 25), sound: spans(sound, 0.01) };
}

async function testNodes(h) {
  const recording = await makeRecording(h);
  const words = SPANS.map(([start, end], index) => W(TEXTS[index], start, end));
  const calls = { timing: 0, model: 0 };
  const originalExecute = tools.executeTool;
  const originalAsk = generate.askModel;
  tools.executeTool = async (_toolCtx, name, args) => {
    assert.equal(name, 'lyrics_timing');
    assert.equal(args.method, 'transcribe');
    calls.timing += 1;
    return { timing: { version: 1, source: 'transcribe', duration: 9, words, lines: [] }, durationSeconds: 9, costUsd: 0.00055 };
  };
  generate.askModel = async (_ctx, _params, request) => {
    calls.model += 1;
    assert.match(request.prompt, /\[1\]ähm/);
    return { text: JSON.stringify({ cuts: [{ from: 1, to: 1, kind: 'filler', reason: 'Füllwort' }], summary: 'Ein Füllwort.' }), usd: 0.002 };
  };
  try {
    const def = h.registry.get('video.rough_cut');
    const ctx = { ...h.makeCtx(), toolCtx: {} };
    const result = await def.execute(ctx, { video: recording }, h.registry.normalizeParams(def, {}));
    assert.equal(calls.timing, 1);
    assert.equal(calls.model, 1);
    assert.ok(Math.abs(result.cost.usd - 0.00255) < 1e-9, 'transcript and model are booked');
    const out = result.variants[0];
    const probe = await h.probe(await h.fileOf(out.video));
    assert.equal(probe.width, 64);
    assert.ok(probe.hasAudio);
    // picture and sound as long as each other (within a frame) and as long as the plan
    assert.ok(Math.abs(probe.videoDuration - probe.audioDuration) < 0.05, `video ${probe.videoDuration} s, audio ${probe.audioDuration} s`);
    const timing = JSON.parse(out.timing.value);
    assert.deepEqual(timing.words.map((word) => word.text), ['Hallo', 'zusammen.', 'Heute', 'zeige']);
    assert.ok(Math.abs(probe.duration - timing.duration) < 0.1, `the file is ${probe.duration} s, the plan ${timing.duration} s`);
    // the filler "ähm" and the pause of 2.6 s are gone: from 9 s to about 4 s
    assert.ok(timing.duration > 3 && timing.duration < 5, `the cut is ${timing.duration} s long`);
    assert.match(out.cuts.value, /Füllwort: «ähm»/);
    // in sync: four spans of square and tone, each where its word now is
    const on = await onSpans(await h.fileOf(out.video));
    assert.equal(on.picture.length, 4, `four white spans: ${JSON.stringify(on.picture)}`);
    assert.equal(on.sound.length, 4, `four tones: ${JSON.stringify(on.sound)}`);
    on.picture.forEach(([start, end], index) => {
      const [soundStart, soundEnd] = on.sound[index];
      assert.ok(Math.abs(start - soundStart) <= 0.05 && Math.abs(end - soundEnd) <= 0.05, `span ${index}: picture ${start}-${end}, sound ${soundStart}-${soundEnd}`);
      const word = timing.words[index];
      assert.ok(Math.abs(start - word.start) <= 0.05, `span ${index} starts where its word starts (${start} / ${word.start})`);
    });

    // Subtitles from that timing: free, no transcript
    const subs = h.registry.get('video.subtitles');
    const before = calls.timing;
    const made = await subs.execute({ ...h.makeCtx(), toolCtx: {} }, { timing: out.timing }, h.registry.normalizeParams(subs, {}));
    assert.equal(calls.timing, before, 'no transcript for a connected timing');
    assert.equal(made.cost?.usd || 0, 0);
    assert.match(made.variants[0].srt.value, /^1\n00:00:00,\d{3} --> /);
    assert.match(made.variants[0].vtt.value, /^WEBVTT/);
    assert.match(made.variants[0].srt.value, /Hallo zusammen\./);
    // Subtitles from the recording: one transcript, booked (the key is only looked at, the call is the stand-in)
    const savedKey = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = 'test-key';
    const heard = await subs.execute({ ...h.makeCtx(), toolCtx: {} }, { video: recording }, h.registry.normalizeParams(subs, { max_chars: 20, max_lines: 1 }));
    assert.equal(calls.timing, before + 1);
    assert.ok(Math.abs(heard.cost.usd - 0.00055) < 1e-9);
    if (savedKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = savedKey;
    assert.ok(heard.variants[0].srt.value.split('\n').every((line) => line.length <= 30));
    await assert.rejects(subs.execute({ ...h.makeCtx(), toolCtx: {} }, { timing: { type: 'text', value: 'nonsense' } }, h.registry.normalizeParams(subs, {})), (err) => err.code === 'SUBTITLES_TIMING_INVALID');

    // a model answer that cannot be read twice stops the run
    generate.askModel = async () => ({ text: 'Sorry, I cannot.', usd: 0.001 });
    await assert.rejects(def.execute({ ...h.makeCtx(), toolCtx: {} }, { video: recording }, h.registry.normalizeParams(def, {})), (err) => err.code === 'ROUGHCUT_MODEL_ANSWER');
    // without the model (only fillers and pauses) the model is not asked
    calls.model = 0;
    const plain = await def.execute({ ...h.makeCtx(), toolCtx: {} }, { video: recording }, h.registry.normalizeParams(def, { remove_retakes: false }));
    assert.equal(calls.model, 0);
    assert.match(plain.variants[0].cuts.value, /Füllwort/);
  } finally {
    tools.executeTool = originalExecute;
    generate.askModel = originalAsk;
  }
}

function testDefinitions(h) {
  const cut = h.registry.get('video.rough_cut');
  assert.equal(cut.category, 'edit-video');
  assert.equal(cut.paid, true);
  assert.deepEqual(cut.inputs.map((port) => port.id), ['video', 'instructions']);
  assert.deepEqual(cut.outputs.map((port) => [port.id, port.type]), [['video', 'video'], ['timing', 'text'], ['cuts', 'text']]);
  const defaults = h.registry.paramDefaults(cut);
  assert.equal(defaults.remove_retakes, true);
  assert.equal(defaults.max_pause, 0.7);
  assert.deepEqual(cut.validate(h.registry.normalizeParams(cut, { remove_retakes: false, remove_fillers: false, shorten_pauses: false, trim_ends: false }), {}).map((issue) => issue.code), ['ROUGHCUT_NOTHING_TO_DO']);
  // the price: the transcript by the length; with the model it is learnt from an earlier run
  assert.equal(cut.cost.estimate({ remove_retakes: false }, { inputs: { video: { type: 'video', duration: 600 } } }), tools.lyricsTimingUsd(600));
  assert.equal(cut.cost.estimate({ remove_retakes: true }, { inputs: { video: { type: 'video', duration: 600 } } }), null);
  const subs = h.registry.get('video.subtitles');
  assert.equal(subs.cost.estimate({}, { connected: new Set(['timing']) }), 0);
  // a recording longer than one transcript takes is heard in parts that overlap by 4 s, and each part is priced
  const windows = nodesRoughCut.hearingWindows(3600);
  assert.deepEqual(windows.map((window) => [window.start, window.seconds]), [[0, 1200], [1196, 1200], [2392, 1200], [3588, 12]]);
  assert.deepEqual(nodesRoughCut.hearingWindows(600), [null]);
  const priced = windows.reduce((sum, window) => sum + tools.lyricsTimingUsd(window.seconds), 0);
  assert.ok(Math.abs(subs.cost.estimate({}, { connected: new Set(['video']), inputs: { video: { type: 'video', duration: 3600 } } }) - priced) < 1e-5);
  assert.equal(nodesRoughCut.MAX_RECORDING_SECONDS, 7200);
  assert.deepEqual(subs.validate({}, {}).map((issue) => issue.code), ['SUBTITLES_NO_INPUT']);
  assert.deepEqual(subs.validate({}, { timing: { connected: true } }), []);
}

async function main() {
  testFillers();
  testReadCuts();
  testWordParts();
  testPlan();
  testModelText();
  testRenderArgs();
  testSubtitles();
  if (!ffmpeg.binaries().available) {
    console.log('SKIP ffmpeg is missing (only the pure parts were tested)');
    console.log('test-rough-cut.js: ok');
    return;
  }
  const h = await createEditHarness({ prefix: 'ocd-rough-cut-', extraRegister: (registry) => nodesRoughCut.registerAll(registry) });
  try {
    testDefinitions(h);
    await testNodes(h);
  } finally {
    await h.cleanup();
  }
  console.log('test-rough-cut.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
