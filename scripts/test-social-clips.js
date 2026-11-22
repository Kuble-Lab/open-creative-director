'use strict';

// Tests for "Social clips from film" (video.social_clips): the pure part (lib/social-clips.js: the answer of the model, the lengths,
// the edges, the crop, the focus on the face, the ffmpeg arguments) and the node on a real ffmpeg with films made on the spot: a
// film whose left half is red and whose right half is blue, with a tone while a "word" is spoken, and a film longer than one
// transcript takes. ElevenLabs and the language model are stand-ins; nothing is paid.

const assert = require('assert/strict');

const ffmpeg = require('../lib/ffmpeg');
const tools = require('../lib/tools');
const generate = require('../lib/nodes/nodes-generate');
const socialClips = require('../lib/social-clips');
const captions = require('../lib/captions-ass');
const nodesRoughCut = require('../lib/nodes/nodes-rough-cut');
const nodesSocialClips = require('../lib/nodes/nodes-social-clips');
const { createEditHarness } = require('./support/edit-harness');

const W = (text, start, end) => ({ text, start, end });

// A transcript of sentences: every sentence has `n` words of 0.4 s with 0.1 s between them and 1 s of silence after it.
function sentences(counts) {
  const words = [];
  let t = 1;
  counts.forEach((n, s) => {
    for (let i = 0; i < n; i += 1) {
      words.push(W(`s${s}w${i}${i === n - 1 ? '.' : ''}`, Math.round(t * 1000) / 1000, Math.round((t + 0.4) * 1000) / 1000));
      t += 0.5;
    }
    t += 0.9;
  });
  return words;
}

/* ---------- pure ---------- */

function testPrompts() {
  const system = socialClips.systemPrompt();
  assert.match(system, /"clips":\[\{"from"/);
  assert.match(system, /never times|Indices are the numbers/);
  const prompt = socialClips.userPrompt({ transcript: '0:01.0: [0]Hallo', instructions: 'Nur Stellen zu Preisen', language: 'de', count: 3, minSeconds: 20, maxSeconds: 60 });
  assert.match(prompt, /3 best clips, each between 20 and 60 seconds/);
  assert.match(prompt, /Nur Stellen zu Preisen/);
  assert.match(prompt, /never the sharp s/);
  assert.match(prompt, /\[0\]Hallo/);
  assert.match(socialClips.userPrompt({ transcript: 'x', count: 1 }), /the best clip,/);
  assert.match(socialClips.userPrompt({ transcript: 'x', feedback: 'clip 1 is 3 s long.' }), /could not be used: clip 1 is 3 s long\./);
  // limits that make no sense are brought in order
  assert.deepEqual(socialClips.normaliseSettings({ count: 99, minSeconds: 50, maxSeconds: 10 }), { count: 12, minSeconds: 50, maxSeconds: 50 });
  assert.deepEqual(socialClips.normaliseSettings({}), { count: 3, minSeconds: 20, maxSeconds: 60 });
}

function testReadClips() {
  // 8 sentences of 20 words: each lasts 9.9 s, a sentence starts every 10.9 s
  const words = sentences([20, 20, 20, 20, 20, 20, 20, 20]);
  const options = { count: 2, minSeconds: 15, maxSeconds: 25 };
  const answer = JSON.stringify({
    clips: [
      // ends in the middle of sentence 1: carried on to its end (words 0..39)
      { from: 0, to: 30, title: 'Erster', hook: 'Ein Einstieg', post: 'Text  mit   Lücken\n\n\n\n#eins', reason: 'gut', score: 70 },
      // far too long (sentences 3 to 7): ends at the last sentence end that fits (3 and 4: words 60..99)
      { from: 60, to: 159, title: 'Zweiter', score: 90 },
      // overlaps the second one and scores lower: left out
      { from: 80, to: 119, title: 'Dritter', score: 60 },
      // far too short
      { from: 120, to: 125, title: 'Kurz', score: 99 },
      // not in the transcript
      { from: 150, to: 400, title: 'Daneben', score: 99 },
      { from: 'x' }
    ]
  });
  const read = socialClips.readClips(`\`\`\`json\n${answer}\n\`\`\``, words, options);
  assert.equal(read.readable, true);
  assert.deepEqual(read.clips.map((clip) => [clip.title, clip.from, clip.to]), [['Zweiter', 60, 99], ['Erster', 0, 39]], 'best first, the lengths repaired');
  assert.equal(read.clips[1].post, 'Text mit Lücken\n\n#eins');
  assert.ok(read.clips.every((clip) => clip.seconds >= 15 * 0.7 && clip.seconds <= 25 * 1.05), JSON.stringify(read.clips.map((clip) => clip.seconds)));
  assert.equal(read.problems.length, 4, read.problems.join(' | '));
  assert.match(read.problems.join(' | '), /shorter than the 15 s wanted/);
  assert.match(read.problems.join(' | '), /overlaps a better one/);
  // only the best `count`
  assert.equal(socialClips.readClips(answer, words, { ...options, count: 1 }).clips.length, 1);
  assert.equal(socialClips.readClips('Sorry.', words, options).readable, false);
  assert.deepEqual(socialClips.readClips('{"clips":[]}', words, options).clips, []);
  // without a sentence end in reach a clip that is too long ends at a pause, else at the last word that fits
  const flat = Array.from({ length: 100 }, (_unused, i) => W(`w${i}`, i + (i >= 22 ? 2 : 0), i + 0.6 + (i >= 22 ? 2 : 0)));
  assert.equal(socialClips.fitEnd(flat, 0, 99, { minSeconds: 15, maxSeconds: 30 }), 21, 'the pause after word 21');
  assert.equal(socialClips.fitEnd(flat, 30, 99, { minSeconds: 15, maxSeconds: 30 }), 59, 'the last word within 30 s');
}

function testPlanAndWords() {
  const words = sentences([20, 20, 20]);
  const clips = socialClips.planClips({ words, duration: 40, clips: [{ from: 20, to: 39, title: 'Mitte' }, { from: 0, to: 19 }, { from: 40, to: 59 }], fps: 25 });
  const [middle, first, last] = clips;
  // a quarter of a second before the first word, 0.4 s after the last one, on the grid of 25 fps
  assert.ok(Math.abs(middle.start - (words[20].start - 0.25)) <= 0.04 && middle.start <= words[20].start - 0.2, `start ${middle.start}`);
  assert.ok(Math.abs(middle.end - (words[39].end + 0.4)) <= 0.04 && middle.end >= words[39].end + 0.4 - 1e-9, `end ${middle.end}`);
  for (const clip of clips) for (const t of [clip.start, clip.end]) assert.ok(Math.abs(t * 25 - Math.round(t * 25)) < 1e-6, `${t} is on the frame grid`);
  assert.ok(middle.start > words[19].end && middle.end < words[40].start, 'the clip touches no word of its neighbours');
  assert.ok(first.start >= 0 && last.end <= 40);
  assert.equal(middle.duration, Math.round((middle.end - middle.start) * 1000) / 1000);
  // words that follow each other without a pause: the clip starts at its first word, not inside the word before
  const tight = [W('a', 0, 1), W('b', 1, 2), W('c.', 2, 3), W('d', 3, 4)];
  const [inner] = socialClips.planClips({ words: tight, duration: 5, clips: [{ from: 1, to: 2 }], fps: 25 });
  assert.equal(inner.start, 1);
  assert.equal(inner.end, 3);
  // the words of a clip at their times in the clip
  const own = socialClips.clipWords(words, middle);
  assert.equal(own.length, 20);
  assert.ok(Math.abs(own[0].start - (words[20].start - middle.start)) < 1e-6);
  assert.ok(own.every((word) => word.start >= 0 && word.end <= middle.duration && word.end >= word.start));
}

function testPicture() {
  assert.deepEqual(socialClips.outputSize('9:16', { width: 1920, height: 1080 }), { width: 1080, height: 1920 });
  assert.deepEqual(socialClips.outputSize('source', { width: 1279, height: 721 }), { width: 1280, height: 722 });
  // 9:16 out of full HD: 608 x 1080, in the middle, at the face, and held inside the frame
  assert.deepEqual(socialClips.cropFor({ width: 1920, height: 1080, format: '9:16' }), { w: 606, h: 1080, x: 657, y: 0 });
  assert.deepEqual(socialClips.cropFor({ width: 1920, height: 1080, format: '9:16', focusX: 0.25 }), { w: 606, h: 1080, x: 177, y: 0 });
  assert.equal(socialClips.cropFor({ width: 1920, height: 1080, format: '9:16', focusX: 0.98 }).x, 1920 - 606);
  assert.equal(socialClips.cropFor({ width: 1920, height: 1080, format: '9:16', focusX: 0 }).x, 0);
  // 16:9 out of a portrait film: the full width, a band of its height
  assert.deepEqual(socialClips.cropFor({ width: 1080, height: 1920, format: '16:9' }), { w: 1080, h: 606, x: 0, y: 657 });
  assert.deepEqual(socialClips.cropFor({ width: 1920, height: 1080, format: '1:1' }), { w: 1080, h: 1080, x: 420, y: 0 });

  // the focus: the median of the largest face of every frame; a second, smaller face and a stray find do not move it
  const face = (x, s = 300) => ({ x, y: 400, s, q: 10 });
  const frames = [
    { faces: [face(500), face(1500, 120)] },
    { faces: [face(520)] },
    { faces: [] },
    { faces: [face(480)] },
    { faces: [face(1700)] },
    { faces: [face(510)] }
  ];
  const focus = socialClips.focusOf(frames);
  assert.ok(Math.abs(focus.x - 510 / 1920) < 0.01, `focus ${focus.x}`);
  assert.ok(Math.abs(focus.share - 5 / 6) < 0.01);
  assert.equal(socialClips.focusOf([{ faces: [face(500)] }, ...Array.from({ length: 9 }, () => ({ faces: [] }))]), null, 'a face in one frame of ten is no focus');
  assert.equal(socialClips.focusOf([]), null);
}

function testRenderArgs() {
  const base = { input: 'in.mp4', output: 'out.mp4', start: 12.48, end: 40.2, source: { width: 1920, height: 1080 }, fps: 25 };
  const face = socialClips.renderArgs({ ...base, format: '9:16', framing: 'face', focus: { x: 0.25, y: 0.4 } });
  const graph = face[face.indexOf('-filter_complex') + 1];
  assert.match(graph, /crop=606:1080:177:0,scale=1080:1920/);
  assert.match(graph, /afade=t=in:st=0:d=0\.040,afade=t=out:st=27\.680:d=0\.040/);
  assert.deepEqual(face.slice(face.indexOf('-ss'), face.indexOf('-i') + 2), ['-ss', '12.480', '-t', '27.720', '-i', 'in.mp4']);
  // without a face the middle
  assert.match(socialClips.renderArgs({ ...base, format: '9:16', framing: 'face', focus: null }).join(' '), /crop=606:1080:657:0/);
  assert.match(socialClips.renderArgs({ ...base, format: '9:16', framing: 'center', focus: { x: 0.1, y: 0.5 } }).join(' '), /crop=606:1080:657:0/);
  // the whole frame on a blurred copy of itself
  const fit = socialClips.renderArgs({ ...base, format: '9:16', framing: 'fit' }).join(' ');
  assert.match(fit, /boxblur/);
  assert.match(fit, /overlay=\(W-w\)\/2:\(H-h\)\/2/);
  assert.equal(fit.includes('crop=606'), false);
  // a film that already has the shape, or "source": only scaled, never cropped or blurred
  for (const args of [socialClips.renderArgs({ ...base, format: '16:9', framing: 'fit' }), socialClips.renderArgs({ ...base, format: 'source' })]) {
    const text = args.join(' ');
    assert.match(text, /scale=1920:1080/);
    assert.equal(/crop=|boxblur/.test(text), false);
  }
  const silent = socialClips.renderArgs({ ...base, hasAudio: false });
  assert.ok(silent.includes('-an'));
  assert.equal(silent.join(' ').includes('[0:a]'), false);
  // the frames for the face finder: spread over the clip, 640 x 360 grey
  const frames = socialClips.faceFramesArgs({ input: 'in.mp4', output: 'f.raw', start: 10, duration: 20, count: 40 });
  assert.match(frames.join(' '), /-ss 10\.000 -t 20\.000 -i in\.mp4 .*fps=1\/0\.5000,scale=640:360:flags=area,format=gray -frames:v 40/);
}

function testTexts() {
  const clips = [{ title: 'Preise', hook: 'Niemand zahlt gern.', post: 'Warum Preise wirken. #pricing', reason: 'Klare These', score: 91, start: 42, end: 75.5, duration: 33.5 }];
  assert.equal(socialClips.postText(clips[0]), 'Preise\n\nWarum Preise wirken. #pricing');
  const report = socialClips.clipsReport(clips, { language: 'de', duration: 600 });
  assert.match(report, /^1 Clip aus 10:00\.0 Film\./);
  assert.match(report, /1\. Preise \(0:42\.0–1:15\.5, 34 s, Wertung 91\)/);
  assert.match(report, /Einstieg: «Niemand zahlt gern\.»/);
  assert.equal(report.includes('ß'), false);
  assert.match(socialClips.clipsReport(clips, { language: 'en', duration: 600 }), /^1 clip from/);
}

/* ---------- the node on a real ffmpeg ---------- */

// The film: 1280 x 720, 40 s, the left half red and the right half blue, a tone of 440 Hz while a word of the first sentence is spoken.
const WORDS = sentences([20, 20, 20]);

async function makeFilm(h) {
  await h.ff([
    '-f', 'lavfi', '-i', 'color=red:s=640x720:r=25:d=40',
    '-f', 'lavfi', '-i', 'color=blue:s=640x720:r=25:d=40',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=40',
    '-filter_complex', '[0:v][1:v]hstack=inputs=2[v]', '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-shortest', h.src('film.mp4')
  ]);
  return h.upload('film.mp4', '.mp4');
}

const isRed = (r, g, b) => r > 150 && g < 90 && b < 90;
const isBlue = (r, g, b) => b > 150 && r < 90 && g < 90;

async function testNode(h) {
  const film = await makeFilm(h);
  const calls = { timing: 0, model: 0, prompts: [] };
  const originalExecute = tools.executeTool;
  const originalAsk = generate.askModel;
  tools.executeTool = async (_toolCtx, name, args) => {
    assert.equal(name, 'lyrics_timing');
    assert.equal(args.method, 'transcribe');
    calls.timing += 1;
    return { timing: { version: 1, source: 'transcribe', duration: 40, words: WORDS, lines: [] }, durationSeconds: 40, costUsd: 0.0024 };
  };
  const answer = { clips: [{ from: 20, to: 39, title: 'Der zweite Satz', hook: 'Es beginnt.', post: 'Ein Text. #clip', reason: 'steht für sich', score: 80 }, { from: 0, to: 19, title: 'Der erste Satz', score: 95 }] };
  generate.askModel = async (_ctx, _params, request) => {
    calls.model += 1;
    calls.prompts.push(request.prompt);
    return { text: JSON.stringify(answer), usd: 0.01 };
  };
  try {
    const def = h.registry.get('video.social_clips');
    const run = (inputs, raw) => def.execute({ ...h.makeCtx(), toolCtx: {} }, inputs, h.registry.normalizeParams(def, { min_seconds: 8, max_seconds: 12, clip_count: 2, language: 'de', ...raw }));

    // portrait, the middle of the frame: half red, half blue
    const result = await run({ video: film }, { framing: 'center' });
    assert.equal(calls.timing, 1);
    assert.equal(calls.model, 1);
    assert.match(calls.prompts[0], /2 best clips, each between 8 and 12 seconds/);
    assert.match(calls.prompts[0], /\[20\]s1w0/);
    assert.ok(Math.abs(result.cost.usd - 0.0124) < 1e-9, 'transcript and model are booked');
    const out = result.variants[0];
    assert.equal(out.clips.type, 'list');
    assert.equal(out.clips.of, 'video');
    assert.equal(out.clips.items.length, 2);
    assert.equal(out.timing.items.length, 2);
    assert.equal(out.posts.items.length, 2);
    // best first: the first sentence (score 95), then the second
    assert.equal(out.posts.items[0].value, 'Der erste Satz');
    assert.equal(out.posts.items[1].value, 'Der zweite Satz\n\nEin Text. #clip');
    assert.match(out.info.value, /^2 Clips aus 0:40\.0 Film\./);
    assert.match(out.info.value, /1\. Der erste Satz \(0:00\.[78]–0:11\.3, 11 s, Wertung 95\)/);
    for (const [index, clip] of out.clips.items.entries()) {
      const file = await h.fileOf(clip);
      const probe = await h.probe(file);
      assert.deepEqual([probe.width, probe.height], [1080, 1920]);
      assert.ok(probe.hasAudio);
      // a sentence of 9.9 s with 0.25 s before and 0.4 s after it
      assert.ok(Math.abs(probe.duration - 10.55) < 0.12, `clip ${index + 1} is ${probe.duration} s long`);
      assert.ok(Math.abs(probe.videoDuration - probe.audioDuration) < 0.06, `video ${probe.videoDuration} s, audio ${probe.audioDuration} s`);
      const frame = await h.frame(file, 2, 90, 160);
      assert.ok(h.count(frame, 90, { x0: 0, y0: 0, x1: 40, y1: 160 }, isRed) > 40 * 160 * 0.9, 'the left of the clip is red');
      assert.ok(h.count(frame, 90, { x0: 50, y0: 0, x1: 90, y1: 160 }, isBlue) > 40 * 160 * 0.9, 'the right of the clip is blue');
      // the times of the words fit "Burn in captions": the words of the clip, from the start of the clip
      const timing = JSON.parse(out.timing.items[index].value);
      assert.equal(timing.words.length, 20);
      assert.ok(Math.abs(timing.words[0].start - 0.25) < 0.05, `the first word starts at ${timing.words[0].start}`);
      assert.ok(Math.abs(timing.duration - probe.duration) < 0.1);
      assert.ok(timing.lines.every((line) => line.text.length <= 22 || !line.text.includes(' ')), 'short lines for a phone');
      assert.ok(captions.readTiming(out.timing.items[index].value), 'the captions read the timing');
    }

    // "Burn in captions" takes a clip and its timing
    if (ffmpeg.hasFilter('ass')) {
      const burnt = await h.run('video.captions', { video: out.clips.items[0], timing: out.timing.items[0] }, { style: 'karaoke' });
      const probe = await h.probe(await h.fileOf(burnt.video));
      assert.deepEqual([probe.width, probe.height], [1080, 1920]);
    }

    // the face: no face in a film of two colours, so the whole frame on its blurred copy (not a blind crop of the middle)
    const noFace = await run({ video: film }, { framing: 'face', clip_count: 1 });
    const whole = await h.frame(await h.fileOf(noFace.variants[0].clips.items[0]), 2, 90, 160);
    assert.ok(h.count(whole, 90, { x0: 2, y0: 62, x1: 40, y1: 98 }, isRed) > 38 * 36 * 0.9, 'the band shows the left of the film');
    assert.ok(h.count(whole, 90, { x0: 0, y0: 0, x1: 90, y1: 40 }, isRed) < 90 * 40 * 0.5, 'above the band the film is blurred and darker');

    // the whole frame on its blurred copy: red left and blue right in the band in the middle, something else than black above it
    const fit = await run({ video: film }, { framing: 'fit', clip_count: 1 });
    const fitFile = await h.fileOf(fit.variants[0].clips.items[0]);
    assert.deepEqual([(await h.probe(fitFile)).width, (await h.probe(fitFile)).height], [1080, 1920]);
    const fitFrame = await h.frame(fitFile, 2, 90, 160);
    assert.ok(h.count(fitFrame, 90, { x0: 2, y0: 62, x1: 40, y1: 98 }, isRed) > 38 * 36 * 0.9, 'the band shows the left of the film');
    assert.ok(h.count(fitFrame, 90, { x0: 50, y0: 62, x1: 88, y1: 98 }, isBlue) > 38 * 36 * 0.9, 'the band shows the right of the film');
    assert.ok(h.count(fitFrame, 90, { x0: 0, y0: 0, x1: 90, y1: 40 }, (r, g, b) => r + g + b > 40) > 90 * 40 * 0.9, 'the background is the blurred film, not black');

    // the format of the film: nothing cropped
    const same = await run({ video: film }, { format: 'source', clip_count: 1 });
    const sameProbe = await h.probe(await h.fileOf(same.variants[0].clips.items[0]));
    assert.deepEqual([sameProbe.width, sameProbe.height], [1280, 720]);

    // a connected timing: no transcript, only the model is booked
    const before = calls.timing;
    const timed = await run({ video: film, timing: { type: 'text', value: JSON.stringify({ version: 1, source: 'rough_cut', duration: 40, words: WORDS, lines: [], language: 'de' }) } }, { clip_count: 1 });
    assert.equal(calls.timing, before, 'no transcript for a connected timing');
    assert.ok(Math.abs(timed.cost.usd - 0.01) < 1e-9);
    assert.equal(timed.variants[0].clips.items.length, 1);
    await assert.rejects(run({ video: film, timing: { type: 'text', value: 'nonsense' } }), (err) => err.code === 'SOCIALCLIPS_TIMING_INVALID');

    // an answer with clips that are not in the film: asked once more, with what was wrong; twice is the end
    calls.model = 0;
    calls.prompts = [];
    generate.askModel = async (_ctx, _params, request) => {
      calls.model += 1;
      calls.prompts.push(request.prompt);
      return { text: JSON.stringify({ clips: [{ from: 500, to: 600, title: 'daneben' }] }), usd: 0.01 };
    };
    await assert.rejects(run({ video: film }), (err) => err.code === 'SOCIALCLIPS_MODEL_ANSWER');
    assert.equal(calls.model, 2);
    assert.match(calls.prompts[1], /could not be used: clip 1: the words 500\.\.600 are not in the transcript/);

    // the wishes of the person reach the model
    generate.askModel = async (_ctx, _params, request) => {
      calls.prompts.push(request.prompt);
      return { text: JSON.stringify(answer), usd: 0.01 };
    };
    await run({ video: film, instructions: { type: 'text', value: 'Nur die Stelle über Preise' } }, { clip_count: 1, format: 'source' });
    assert.match(calls.prompts[calls.prompts.length - 1], /Nur die Stelle über Preise/);
  } finally {
    tools.executeTool = originalExecute;
    generate.askModel = originalAsk;
  }
}

// A film of 21 minutes is longer than one transcript takes (20 minutes): it is heard in two parts, the words of the second part get
// the times of the whole film, and a word heard twice at the seam counts once.
async function testLongFilm(h) {
  await h.ff([
    '-f', 'lavfi', '-i', 'color=green:s=64x36:r=5:d=1260',
    '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '16k', '-shortest', h.src('long.mp4')
  ]);
  const film = await h.upload('long.mp4', '.mp4');
  const seen = [];
  const originalExecute = tools.executeTool;
  const originalAsk = generate.askModel;
  // twelve words at the end of the first part (from 19:50) and twelve from 1 s into the second part (the seam is at 19:56)
  const tail = Array.from({ length: 12 }, (_unused, i) => W(`a${i}${i === 11 ? '.' : ''}`, 1190 + i * 0.8, 1190.5 + i * 0.8));
  tools.executeTool = async (_toolCtx, _name, args) => {
    seen.push(args.duration_seconds);
    if (args.duration_seconds === 1200) return { timing: { version: 1, words: tail, lines: [] }, costUsd: 0.07 };
    // the second part hears the last word of the first part again (at 3 s of the part = 19:59) and then its own
    return { timing: { version: 1, words: [W('a11.', 2.8, 3.3), ...Array.from({ length: 12 }, (_unused, i) => W(`b${i}${i === 11 ? '.' : ''}`, 10 + i * 0.8, 10.5 + i * 0.8))], lines: [] }, costUsd: 0.004 };
  };
  let prompt = '';
  generate.askModel = async (_ctx, _params, request) => {
    prompt = request.prompt;
    return { text: JSON.stringify({ clips: [{ from: 12, to: 23, title: 'Aus dem zweiten Teil', score: 90 }] }), usd: 0.02 };
  };
  try {
    const heard = await nodesRoughCut.hearRecording({ ...h.makeCtx(), toolCtx: {} }, film, {});
    assert.deepEqual(seen, [1200, 64], 'two parts: 20 minutes and the rest from 19:56');
    seen.length = 0;
    assert.equal(heard.words.length, 24, 'the word at the seam counts once');
    assert.ok(Math.abs(heard.words[12].start - (1196 + 10)) < 1e-6, 'the words of the second part have the times of the film');
    assert.ok(Math.abs(heard.costs.reduce((a, b) => a + b, 0) - 0.074) < 1e-9);

    const def = h.registry.get('video.social_clips');
    const result = await def.execute({ ...h.makeCtx(), toolCtx: {} }, { video: film }, h.registry.normalizeParams(def, { clip_count: 1, min_seconds: 5, max_seconds: 20, format: 'source' }));
    assert.match(prompt, /\[12\]b0/);
    assert.match(result.variants[0].info.value, /\(20:05\.\d–20:15\.\d/);
    const probe = await h.probe(await h.fileOf(result.variants[0].clips.items[0]));
    assert.ok(Math.abs(probe.duration - 10.1) < 0.3, `the clip is ${probe.duration} s long`);
    assert.ok(Math.abs(result.cost.usd - 0.094) < 1e-9);
  } finally {
    tools.executeTool = originalExecute;
    generate.askModel = originalAsk;
  }
}

function testDefinition(h) {
  const def = h.registry.get('video.social_clips');
  assert.equal(def.category, 'edit-video');
  assert.equal(def.paid, true);
  assert.deepEqual(def.inputs.map((port) => port.id), ['video', 'timing', 'instructions']);
  assert.deepEqual(def.outputs.map((port) => [port.id, port.type]), [['clips', 'video[]'], ['timing', 'text[]'], ['posts', 'text[]'], ['info', 'text']]);
  const defaults = h.registry.paramDefaults(def);
  assert.deepEqual([defaults.clip_count, defaults.format, defaults.framing, defaults.min_seconds, defaults.max_seconds], [3, '9:16', 'face', 20, 60]);
  assert.deepEqual(def.validate(h.registry.normalizeParams(def, { min_seconds: 60, max_seconds: 30 }), {}).map((issue) => issue.code), ['SOCIALCLIPS_LENGTHS']);
  assert.deepEqual(def.validate(h.registry.normalizeParams(def, {}), {}), []);
  assert.equal(def.cost.estimate({}, {}), null, 'the price is learnt from an earlier run');
  assert.equal(nodesSocialClips.MAX_FILM_SECONDS, 120 * 60);
}

async function main() {
  testPrompts();
  testReadClips();
  testPlanAndWords();
  testPicture();
  testRenderArgs();
  testTexts();
  if (!ffmpeg.binaries().available) {
    console.log('SKIP ffmpeg is missing (only the pure parts were tested)');
    console.log('test-social-clips.js: ok');
    return;
  }
  const h = await createEditHarness({ prefix: 'ocd-social-clips-', extraRegister: (registry) => nodesSocialClips.registerAll(registry) });
  try {
    testDefinition(h);
    await testNode(h);
    await testLongFilm(h);
  } finally {
    await h.cleanup();
  }
  console.log('test-social-clips.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
