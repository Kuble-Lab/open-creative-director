'use strict';

// The render of the event video (WP53, package C): lib/event-video/composition.js, view.js, mix.js, lib/render-chunks.js and the nodes of
// lib/nodes/nodes-event-video-render.js. No network, nothing paid: the render node is replaced, the sound is made by ffmpeg (sines and noise).
//   pages      the chunks of graphics-60.json (D3: no end card added), one page per chunk in each format: under 2 MB, the policy of the render node,
//              GSAP from jsDelivr once, the size of the format, the faces it draws, the logo only where the end card is, nothing names the maker
//   layout     the title on two lines in 9:16, the sizes of spec §5c, a lower third with its accent
//   view       the frames: title, lower third, intertitle, subtitles, end card, dip and flash, the light spot only in hook, peak and close; pure
//   mix        the ducking of the music (-12 dB, 0.3 s ramp) under the soundbites and the voice, the stem under the soundbites, the voice at its time,
//              the last pass (grain, vignette of spec §5c, BT.709); with ffmpeg: the loudness of the plan (-16 LUFS +-1), a silent stem left out
//   finish     a film of 1080 x 1920 passes verifyOutput; the contact sheet of an upright film; the SRT
//   chunks     lib/render-chunks.js sends the format of the event video and its codes; the HUD keeps its own

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const contract = require('../lib/event-video/contract');
const composition = require('../lib/event-video/composition');
const view = require('../lib/event-video/view');
const mixLib = require('../lib/event-video/mix');
const chunkRenderer = require('../lib/render-chunks');
const postLib = require('../lib/music-video-hud/postpass');
const metrics = require('../lib/music-video-hud/metrics');
const sceneLib = require('../lib/explainer-scene');
const motionHtml = require('../public/nodes/motion-html');
const ffmpeg = require('../lib/ffmpeg');
const nodes = require('../lib/nodes/nodes-event-video-render');

const SUPPORT = path.join(__dirname, 'support', 'event-video');
const graphics = JSON.parse(fs.readFileSync(path.join(SUPPORT, 'graphics-60.json'), 'utf8'));

/* ---------- the pages ---------- */

function testPages() {
  const chunks = composition.eventChunks(graphics);
  assert.ok(chunks.length >= 3 && chunks.every((chunk) => chunk.seconds <= 24), 'chunks of at most 24 s');
  assert.equal(chunks[chunks.length - 1].endFrame, 1440, 'the last chunk ends with the film (no end card added, D3)');
  assert.ok(chunks.every((chunk) => chunk.pageFrames === chunk.frames));
  assert.ok(chunks.every((chunk) => graphics.cuts.some((cut) => Math.round(cut * 24) === chunk.startFrame)), 'chunks start on the frame of a cut');
  for (const format of contract.FORMATS) {
    const size = contract.FORMAT_SIZES[format];
    const pages = composition.buildPages(graphics, format, { clipFiles: chunks.map((_c, i) => `clip-${i}.mp4`), logoFile: 'logo-1.png' });
    assert.equal(pages.length, chunks.length);
    pages.forEach((page, index) => {
      const bytes = Buffer.byteLength(page.html);
      assert.ok(bytes < 2 * 1024 * 1024, `${format} page ${index}: ${bytes} bytes`);
      assert.ok(page.html.includes(sceneLib.CSP_META), 'the policy of the render node');
      assert.equal(page.html.split(`<script src="${sceneLib.GSAP_URL}"></script>`).length, 2, 'GSAP from jsDelivr, once');
      assert.equal((page.html.match(/<script src=/g) || []).length, 1, 'no other external script');
      assert.equal(motionHtml.checkComposition(page.html, size.renderFormat), null, `${format}: the size the render node checks`);
      assert.ok(page.html.includes(`data-width="${size.width}" data-height="${size.height}"`));
      assert.ok(page.html.includes(`src="clip-${index}.mp4"`));
      assert.doesNotMatch(page.html.replace(/base64,[A-Za-z0-9+/=]+/g, ''), /kuble/i, 'nothing names the maker');
      assert.equal(page.logo, index === pages.length - 1, 'the logo only where the end card is');
      assert.equal(page.html.includes('logo-1.png'), page.logo);
    });
    // the faces of the plan (Montserrat and Inter Tight), each once
    assert.equal((pages[0].html.match(/@font-face/g) || []).length, 2);
    assert.match(pages[0].html, /font-family:'Montserrat'/);
  }
  assert.throws(() => composition.buildChunkPage({ graphics, format: '16:9', chunk: chunks[0], clipFile: '../x.mp4' }), /plain file name/);
  // DM Sans, Space Grotesk and Playfair Display (WP53 package D) are in lib/fonts: each family is drawn in its own face, none needs its stand-in
  const styled = structuredClone(graphics);
  styled.look.type = { title: 'Playfair Display:600:italic', body: 'DM Sans:400' };
  for (const family of ['DM Sans', 'Space Grotesk', 'Playfair Display']) {
    assert.equal(metrics.drawnFamily(family), family);
    assert.ok(fs.existsSync(path.join(metrics.FONT_DIR, metrics.EVENT_FAMILIES[family].file)), `${family}: the file is there`);
  }
  assert.deepEqual(composition.faceOf('Playfair Display:600:italic'), { family: 'Playfair Display', weight: 600, italic: true, asked: 'Playfair Display' });
  assert.deepEqual(composition.faceOf('Space Grotesk:700'), { family: 'Space Grotesk', weight: 700, italic: false, asked: 'Space Grotesk' });
  // the widths are read at the weight, DM Sans also at the optical size the browser takes (the size in px, 9 to 40): a title is narrower than a caption
  const word = 'Innovation Day 2026';
  assert.ok(metrics.familyWidth('Playfair Display:700:italic', word, 100) > metrics.familyWidth('Playfair Display:400:italic', word, 100));
  assert.ok(metrics.familyWidth('DM Sans:700', word, 80) / 80 < (metrics.familyWidth('DM Sans:700', word, 12) / 12) * 0.95, 'DM Sans at opsz 40 is narrower than at 12');
  assert.equal(metrics.familyWidth('DM Sans:700', word, 60), (metrics.familyWidth('DM Sans:700', word, 120) / 120) * 60, 'above 40 px the optical size stays at 40');
  const styledPage = composition.buildChunkPage({ graphics: styled, format: '9:16', chunk: chunks[0] });
  assert.ok(Buffer.byteLength(styledPage) < 2 * 1024 * 1024);
  assert.match(styledPage, /@font-face\{font-family:'Playfair Display';src:url\(data:font\/ttf;base64,[^)]+\) format\('truetype'\);font-weight:400 900;font-style:italic\}/);
  assert.match(styledPage, /@font-face\{font-family:'DM Sans';src:url\(data:font\/ttf;base64,[^)]+\) format\('truetype'\);font-weight:100 1000;font-style:normal\}/);
}

/* ---------- the layout ---------- */

function testLayout() {
  const chunks = composition.eventChunks(graphics);
  const wide = composition.pageData({ graphics, format: '16:9', chunk: chunks[0] });
  const tall = composition.pageData({ graphics, format: '9:16', chunk: chunks[0] });
  // spec §5c: the title 7 % of the height in 16:9, 5 % of 1920 in 9:16; it fits 84 % of the width, on two lines where it must
  assert.equal(wide.title.size, 75.6);
  assert.deepEqual(wide.title.lines, ['Innovation Day 2026']);
  assert.equal(tall.title.size, 96);
  assert.deepEqual(tall.title.lines, ['Innovation', 'Day 2026']);
  for (const data of [wide, tall]) {
    for (const line of data.title.lines) assert.ok(metrics.familyWidth('Montserrat:700', line, data.title.size) <= data.width * 0.84 + 0.5, line);
  }
  // a title that does not fit even on two lines is made smaller
  const long = composition.fitText('Kickoff Supercalifragilistic Innovationsforum', { family: 'Montserrat', weight: 700 }, 96, 907);
  assert.ok(long.size < 96 && long.lines.length === 2);
  // the lower thirds: name 2.8 %, role 2.0 % of the height, the accent of the plan and a text that can be read on it
  const second = composition.pageData({ graphics, format: '16:9', chunk: chunks[1] });
  const lower = [...wide.lowerThirds, ...second.lowerThirds];
  assert.ok(lower.length >= 1);
  assert.equal(wide.lowerThirds[0].nameSize, 30.2);
  assert.equal(wide.lowerThirds[0].roleSize, 21.6);
  assert.equal(wide.look.accent, '#3B6CFF');
  assert.equal(wide.look.onAccent, '#FFFFFF');
  assert.equal(composition.onColour('#FFFFFF'), '#111214', 'a white accent (no branding) takes dark text');
  // the end card on the last 3 s (D3), 4 % of the height
  const last = composition.pageData({ graphics, format: '9:16', chunk: chunks[chunks.length - 1], logoFile: 'logo.png' });
  assert.equal(last.endcard.start, 57);
  assert.equal(last.endcard.lineSize, 76.8);
  assert.equal(last.endcard.logo, 'logo.png');
  // the tint of the look (spec §5c): warm or cool in soft light
  assert.equal(composition.tintStyle(-0.015), 'background:#4A7BFF;opacity:0.033');
  assert.equal(composition.tintStyle(0.12), 'background:#FF9F45;opacity:0.264');
  assert.equal(composition.tintStyle(0), 'display:none');
}

/* ---------- the frames ---------- */

function testView() {
  const chunks = composition.eventChunks(graphics);
  const data = (index, format = '16:9', extra = {}) => composition.pageData({ graphics: { ...graphics, ...extra }, format, chunk: chunks[index], logoFile: 'logo.png' });
  const first = data(0);
  const at = (d, t) => view.render(d, t);
  assert.equal(at(first, 1.0).title, '', 'the title stands from 1.5 s');
  assert.match(at(first, 3).title, /Innovation/);
  assert.match(at(first, 3).title, /Zürich, 12. März 2026/);
  assert.equal(at(first, 5.3).title, '');
  assert.match(at(first, 9).inter, /320 Gäste/);
  assert.match(at(first, 18).lower, /Anna Muster/);
  assert.match(at(first, 18).lower, /CEO/);
  assert.match(at(first, 18).lower, /background:#3B6CFF;transform:scaleX\(1\)/);
  assert.match(at(first, 16.75).lower, /scaleX\(0\.\d+\)/, 'the bar grows');
  assert.match(at(first, 16.9).sub, /Willkommen zum Innovation Day 2026\./);
  assert.equal(at(first, 13).sub, '');
  // the dip at 14.362 (6 frames): black at the cut, nothing 4 frames away
  assert.match(at(first, 14.362).flash, /^background:#000;opacity:1$/);
  assert.equal(at(first, 14.362 + 4 / 24).flash, 'display:none');
  // a flash at a cut: white that fades
  const flashed = composition.pageData({ graphics: { ...graphics, transitions: [{ at: 4.192, type: 'flash', frames: 4 }] }, format: '16:9', chunk: chunks[0] });
  assert.match(at(flashed, 4.2).flash, /^background:#fff;opacity:0\.\d+/);
  // the end card: the veil, the logo, the line
  const last = data(chunks.length - 1);
  assert.equal(at(last, 56).end, '');
  assert.equal(at(last, 56).endVeil, 'display:none');
  assert.match(at(last, 59.5).end, /Danke\. Bis 2027\./);
  assert.match(at(last, 59.5).end, /innovation-day\.example/);
  assert.equal(at(last, 59.5).endVeil, 'opacity:0.82');
  assert.match(at(last, 59.5).endLogo, /^max-width:\d+px;max-height:\d+px;opacity:1/);
  // the light spot (glow above 0.5): only in hook, peak and close
  const glowing = data(1, '16:9', { look: { ...graphics.look, glow: 0.2 } });
  assert.equal(at(glowing, 25).glow, 'display:none', 'programme');
  assert.match(at(glowing, 47).glow, /^opacity:0\.2;background:radial-gradient/, 'peak');
  assert.equal(at(first, 3).glow, 'display:none', 'no glow in the plan');
  // pure: the same time gives the same frame, in any order
  const times = [3, 9, 18, 16.9, 59.5, 2.1, 14.362];
  const once = times.map((t) => JSON.stringify(at(t > 40 ? last : first, t)));
  const again = times.slice().reverse().map((t) => JSON.stringify(at(t > 40 ? last : first, t))).reverse();
  assert.deepEqual(once, again);
  // every animation of the title draws
  for (const anim of Object.keys(contract.TITLE_ANIMS)) {
    const d = composition.pageData({ graphics: { ...graphics, title: { ...graphics.title, anim } }, format: '1:1', chunk: chunks[0] });
    assert.match(at(d, 2).title.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' '), /Innovation/, anim);
    assert.match(at(d, 4.5).title, /opacity:1|opacity:0\.9/, anim);
  }
  // the eases end where they should
  for (const name of ['power2.out', 'power3.out', 'power4.out', 'expo.out', 'sine.out', 'power2.inOut', 'back.out(1.4)']) {
    assert.ok(Math.abs(view.ease(name)(0)) < 1e-9 && Math.abs(view.ease(name)(1) - 1) < 1e-9, name);
  }
  assert.ok(view.ease('back.out(1.4)')(0.6) > 1, 'back overshoots');
  // the subtitles: lines of at most the characters of the format, inside the soundbite, a new line after a sentence
  for (const bite of graphics.soundbites) {
    const lines = view.subtitleLines(bite, 26);
    assert.ok(lines.every((line) => [...line.text].length <= 26 || !line.text.includes(' ')));
    assert.ok(lines.every((line) => line.start >= bite.start - 1e-9 && line.end <= bite.end + 1e-9 && line.end > line.start));
    lines.forEach((line, index) => index && assert.ok(line.start >= lines[index - 1].end));
  }
  assert.equal(view.subtitleLines(graphics.soundbites[0], 42)[0].text, 'Willkommen zum Innovation Day 2026.');
}

/* ---------- the mix ---------- */

// the value of an expression of ffmpeg (clip, min, max, t) at time t
const evaluate = (expr, t) => new Function('t', 'clip', 'max', 'min', `return ${expr};`)(t, (v, a, b) => Math.min(b, Math.max(a, v)), Math.max, Math.min);

function testMix() {
  const voiceSeconds = [2.5, 3];
  const windows = mixLib.duckWindows(graphics, voiceSeconds);
  assert.deepEqual(windows.map(({ start, end }) => [start, Math.round(end * 1000) / 1000]), [[6.624, 9.124], [16.395, 22.905], [32.662, 37.202], [53.401, 56.401]]);
  const mix = mixLib.mixOf(graphics);
  assert.deepEqual(mix, { duck_db: -12, ramp: 0.3, nat_level: 0.12, lufs: -16 });
  const music = mixLib.musicVolume(windows, mix);
  const low = 10 ** (-12 / 20);
  assert.ok(Math.abs(evaluate(music, 2) - 1) < 1e-6, 'full outside');
  assert.ok(Math.abs(evaluate(music, 19) - low) < 1e-3, '-12 dB under a soundbite');
  assert.ok(Math.abs(evaluate(music, 16.395) - low) < 1e-3, 'down when the soundbite starts');
  assert.ok(Math.abs(evaluate(music, 16.245) - (1 + low) / 2) < 1e-3, 'half way on the ramp of 0.3 s');
  assert.ok(Math.abs(evaluate(music, 23.3) - 1) < 1e-6, 'up again 0.3 s after');
  assert.ok(Math.abs(evaluate(music, 7) - low) < 1e-3, 'under the voice');
  const nat = mixLib.natVolume(graphics, mix.nat_level);
  assert.ok(Math.abs(evaluate(nat, 12) - 0.12) < 1e-6, 'the stem under the B-roll');
  assert.ok(Math.abs(evaluate(nat, 19) - 1) < 1e-6, 'full under a soundbite');

  const built = mixLib.mixArgs(graphics, { music: 'm.wav', nat: 'n.wav', voices: [{ file: 'v0.mp3', seconds: 2.5 }, { file: 'v1.mp3', seconds: 3 }], out: 'mix.wav' });
  const graph = built.args[built.args.indexOf('-filter_complex') + 1];
  assert.deepEqual(built.args.filter((arg, index) => built.args[index - 1] === '-i'), ['m.wav', 'n.wav', 'v0.mp3', 'v1.mp3']);
  assert.match(graph, /\[0:a\].*volume='1-0\.7488\*max\(/);
  assert.match(graph, /afade=t=out:st=58\.5:d=1\.5\[m\]/);
  assert.match(graph, /adelay=delays=6624:all=1\[v0\]/);
  assert.match(graph, /adelay=delays=53401:all=1\[v1\]/);
  assert.match(graph, /amix=inputs=4:normalize=0:dropout_transition=0,atrim=0:60,apad=whole_dur=60\[mix\]$/);
  // WP53 review: a line of the voice is placed by its measured length, before the end of the film and the next soundbite; one that fits nowhere is left
  // out, never cut
  const place = (voiceover, seconds) => mixLib.placeVoices({ ...graphics, voiceover }, seconds);
  assert.deepEqual(place(graphics.voiceover, [2.5, 3]), { lines: graphics.voiceover, dropped: [] }, 'the lines of the fixture fit where they are');
  assert.deepEqual(place(graphics.voiceover, [2.5, 6.5]).lines[1], { index: 1, start: 53.2 }, 'close: moved back so that it ends 0.3 s before the end');
  assert.deepEqual(place(graphics.voiceover, [2.5, 8]), { lines: [graphics.voiceover[0]], dropped: [{ index: 1, start: 53.401, seconds: 8 }] }, 'close: 8 s fit nowhere');
  assert.deepEqual(place(graphics.voiceover, [9.5, 3]).lines[0], { index: 0, start: 6.595 }, 'arrival: ends 0.3 s before the soundbite at 16.395');
  assert.deepEqual(place(graphics.voiceover, [10, 3]).dropped.map((line) => line.index), [0], 'arrival: 10 s fit nowhere before the soundbite');
  assert.deepEqual(place([{ index: 0, start: 6.624 }, { index: 1, start: 6.624 }], [2, 2]).lines, [{ index: 0, start: 6.624 }, { index: 1, start: 8.924 }], 'two lines of one act one after the other');
  assert.deepEqual(place([{ index: 0, start: 16.5 }], [2]).lines, [{ index: 0, start: 23.205 }], 'a line inside a soundbite waits for its end');
  assert.deepEqual(place(graphics.voiceover, []).lines, graphics.voiceover, 'without a length the lines stay');
  const cutOff = mixLib.mixArgs(graphics, { music: 'm.wav', nat: 'n.wav', voices: [{ file: 'v0.mp3', seconds: 2.5 }, { file: 'v1.mp3', seconds: 8 }], out: 'mix.wav' });
  assert.deepEqual(cutOff.args.filter((arg, index) => cutOff.args[index - 1] === '-i'), ['m.wav', 'n.wav', 'v0.mp3'], 'the line that does not fit is not mixed');
  assert.deepEqual(cutOff.dropped.map((line) => line.index), [1]);
  assert.deepEqual(cutOff.windows.map(({ start, end }) => [start, Math.round(end * 1000) / 1000]), [[6.624, 9.124], [16.395, 22.905], [32.662, 37.202]]);
  const moved = mixLib.mixArgs(graphics, { music: 'm.wav', nat: null, voices: [{ file: 'v0.mp3', seconds: 2.5 }, { file: 'v1.mp3', seconds: 6.5 }], out: 'mix.wav' });
  assert.match(moved.args[moved.args.indexOf('-filter_complex') + 1], /adelay=delays=53200:all=1\[v1\]/);
  // a photo-only event: music and voice
  const photoOnly = mixLib.mixArgs({ ...graphics, soundbites: [], lower_thirds: [] }, { music: 'm.wav', nat: null, voices: [{ file: 'v0.mp3', seconds: 2.5 }], out: 'mix.wav' });
  assert.equal(photoOnly.args.filter((arg) => arg === '-i').length, 2);
  assert.doesNotMatch(photoOnly.args.join(' '), /n\.wav/);
  assert.equal(mixLib.gainOf(-28.2, -16), 12.2);
  assert.equal(mixLib.gainOf(null), null);
  assert.equal(mixLib.isSilent(null), true);
  assert.equal(mixLib.isSilent(-70), true);
  assert.equal(mixLib.isSilent(-30), false);

  // the last pass: the grain and the vignette of the look, BT.709, the size of the format
  const finish = mixLib.finishArgs({ listFile: 'l.txt', audioFile: 's.wav', outFile: 'f.mp4', format: '9:16', graphics, inputColor: {} });
  assert.match(finish.filter, /scale=1080:1920:flags=bicubic/);
  assert.match(finish.filter, /noise=c0s=1:c0f=t\+u:c0_seed=17/, 'round(12 x 0.1)');
  assert.match(finish.filter, /vignette=angle=PI\/6\.35:eval=init/, 'PI / (5 + 3 (1 - 0.55))');
  assert.match(finish.filter, /setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv/);
  assert.equal(finish.frames, 1440);
  assert.deepEqual(finish.args.slice(finish.args.indexOf('-frames:v'), finish.args.indexOf('-frames:v') + 2), ['-frames:v', '1440']);
  // the subtitles as SRT
  const srt = mixLib.subtitlesSrt(graphics, '16:9');
  assert.match(srt, /^1\n00:00:16,545 --> 00:00:18,\d{3}\nWillkommen zum Innovation Day 2026\.\n/);
  assert.equal(mixLib.subtitlesSrt({ ...graphics, soundbites: [] }), '');

  // the contact sheet of an upright film: frames of 640 px in height; the HUD keeps its 640 px in width
  assert.match(postLib.contactSheetArgs({ inputFile: 'f.mp4', outFile: 's.png', frames: 1440, width: 1080, height: 1920 }).args.join(' '), /scale=360:-2/);
  assert.match(postLib.contactSheetArgs({ inputFile: 'f.mp4', outFile: 's.png', frames: 1440 }).args.join(' '), /scale=640:-2/);
  assert.deepEqual(postLib.cutClipArgs({ inputFile: 'a', outFile: 'b', start: 1, frames: 24 }), postLib.cutClipArgs({ inputFile: 'a', outFile: 'b', start: 1, frames: 24, width: 1920, height: 1080 }));
  assert.match(postLib.cutClipArgs({ inputFile: 'a', outFile: 'b', start: 1, frames: 24, width: 1080, height: 1920 }).join(' '), /scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,/);
}

/* ---------- with ffmpeg: the loudness and the finished film ---------- */

async function testReal() {
  const binaries = ffmpeg.binaries();
  assert.ok(binaries.available, 'ffmpeg is needed');
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'event-render-'));
  const ff = (args) => new Promise((resolve, reject) => execFile(binaries.ffmpeg, args, { maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stderr))));
  const capture = (args) => new Promise((resolve) => execFile(binaries.ffmpeg, args, { maxBuffer: 16 * 1024 * 1024 }, (_err, _out, stderr) => resolve(stderr)));
  try {
    const short = { ...graphics, duration: 20, endFrame: 480, cuts: [0, 6, 12], acts: [], soundbites: [{ start: 6, end: 10, words: [{ w: 'Hallo', s: 0.2, e: 0.6 }] }], voiceover: [{ index: 0, start: 13 }], lower_thirds: [], intertitles: [], title: null, transitions: [] };
    const music = path.join(work, 'music.wav');
    await ff(['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=220:d=22', '-f', 'lavfi', '-i', 'anoisesrc=c=pink:a=0.05:d=22', '-filter_complex', '[0][1]amix=inputs=2,volume=0.3', '-ac', '2', '-ar', '48000', music]);
    const nat = path.join(work, 'nat.wav');
    await ff(['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=660:d=20', '-af', 'volume=0.5', '-ac', '2', '-ar', '48000', nat]);
    const silent = path.join(work, 'silent.wav');
    await ff(['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '20', silent]);
    const voice = path.join(work, 'voice.wav');
    await ff(['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=180:d=3', '-af', 'tremolo=f=5:d=0.8', '-ar', '48000', voice]);
    const run = (args) => ff(args);
    const logs = [];
    const sound = await nodes.mixSound({ graphics: short, files: { music, nat, voices: [{ file: voice, seconds: 3 }] }, scratch: work, run, runCapture: capture, log: (line) => logs.push(line) });
    assert.equal(sound.natUsed, true);
    const measured = mixLib.readLoudness(await capture(mixLib.loudnessProbeArgs(sound.file)));
    assert.ok(Math.abs(measured - -16) <= 1, `the mix is ${measured} LUFS, the plan -16 +-1`);
    // the music is ducked under the soundbite: quieter there than before it (the stem alone at 0.12 before, at 1 inside: so only the music part is
    // compared, with a mix without the stem)
    const onlyMusic = await nodes.mixSound({ graphics: short, files: { music, nat: silent, voices: [] }, scratch: await fsp.mkdtemp(path.join(work, 'm-')), run, runCapture: capture, log: (line) => logs.push(line) });
    assert.equal(onlyMusic.natUsed, false, 'a silent stem is left out');
    assert.match(logs.join('\n'), /silent/);
    const level = async (from, to) => Number(/mean_volume: (-?[\d.]+) dB/.exec(await capture(['-nostdin', '-ss', String(from), '-t', String(to - from), '-i', onlyMusic.file, '-af', 'volumedetect', '-f', 'null', '-']))[1]);
    const before = await level(2, 5);
    const under = await level(6.5, 9.5);
    assert.ok(Math.abs(before - under - 12) < 1, `ducked by ${before - under} dB`);

    // a finished upright film: two chunks as the render node draws them, the sound, the last pass, verifyOutput
    const chunks = [];
    for (const [index, seconds] of [[0, 12], [1, 8]]) {
      const file = path.join(work, `chunk-${index}.mp4`);
      await ff(['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=1080x1920:r=24:d=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
      chunks.push(file);
    }
    const listFile = path.join(work, 'chunks.txt');
    await fsp.writeFile(listFile, postLib.concatListText(chunks));
    const film = path.join(work, 'film.mp4');
    const built = mixLib.finishArgs({ listFile, audioFile: sound.file, outFile: film, format: '9:16', graphics: short, inputColor: {} });
    await ff(built.args);
    const probe = JSON.parse(await new Promise((resolve, reject) => execFile(binaries.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', film], (err, out) => (err ? reject(err) : resolve(out)))));
    assert.deepEqual(postLib.verifyOutput(probe, { frames: built.frames, seconds: built.seconds, width: 1080, height: 1920 }), []);
    assert.deepEqual(postLib.verifyOutput(probe, { frames: built.frames, seconds: built.seconds }), ['size 1080x1920, not 1920x1080'], 'the size is checked');
    const sheet = postLib.contactSheetArgs({ inputFile: film, outFile: path.join(work, 'sheet.png'), frames: built.frames, width: 1080, height: 1920 });
    await ff(sheet.args);
    assert.ok(fs.statSync(path.join(work, 'sheet.png')).size > 1000);
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

/* ---------- the render nodes ---------- */

async function testChunks() {
  const tools = require('../lib/tools');
  const rendernode = require('../lib/rendernode');
  const original = tools.executeTool;
  const calls = [];
  try {
    tools.executeTool = async (_ctx, name, args) => {
      calls.push({ name, args });
      if (args.label === 'gone') throw new rendernode.RenderNodeError('Kein Render-Node online.');
      if (args.label === 'old') throw new rendernode.RenderNodeError('Render-Node Alpha unterstuetzt noch keine grossen Uploads - Node-Service aktualisieren.');
      return { job: { jobId: 'job-1', assetId: 'a1' } };
    };
    const ctx = { toolCtx: {}, signal: null };
    const job = await chunkRenderer.submitChunk(ctx, { html: '<html>', label: 'Event 1/3', quality: 'standard', clipId: 'c1', assetIds: ['c1', 'logo'], format: 'portrait', codes: nodes.RENDER_CODES });
    assert.equal(job.jobId, 'job-1');
    assert.deepEqual(calls[0], { name: 'render_motion_graphics', args: { html: '<html>', label: 'Event 1/3', quality: 'standard', format: 'portrait', fps: 24, asset_ids: ['c1', 'logo'] } });
    // the HUD sends what it sent before
    await chunkRenderer.submitChunk(ctx, { html: '<html>', label: 'HUD 1/2', quality: 'draft', clipId: 'c2' });
    assert.deepEqual(calls[1].args, { html: '<html>', label: 'HUD 1/2', quality: 'draft', format: 'landscape', fps: 24, asset_ids: ['c2'] });
    await assert.rejects(chunkRenderer.submitChunk(ctx, { html: '', label: 'gone', clipId: 'c', codes: nodes.RENDER_CODES }), (err) => err.code === 'EVENTRENDER_NO_NODE');
    await assert.rejects(chunkRenderer.submitChunk(ctx, { html: '', label: 'old', clipId: 'c', codes: nodes.RENDER_CODES }), (err) => err.code === 'EVENTRENDER_NO_NODE');
    await assert.rejects(chunkRenderer.submitChunk(ctx, { html: '', label: 'gone', clipId: 'c' }), (err) => err.code === 'HUD_NO_RENDER_NODE');
    await assert.rejects(chunkRenderer.submitChunk(ctx, { html: '', label: 'x', clipId: 'c', format: 'cinema' }), /Unknown format/);
  } finally {
    tools.executeTool = original;
  }
  // the nodes: their ports and parameters
  const [cut, render] = nodes.definitions;
  assert.equal(cut.type, 'event_video.cut');
  assert.deepEqual(cut.inputs.map((port) => [port.id, port.type, Boolean(port.required), Boolean(port.multiple)]), [
    ['shots', 'text', true, false], ['format', 'text', true, false], ['videos', 'video', false, true], ['photos', 'image', false, true], ['ai_clips', 'video', false, true], ['parallax_clips', 'video', false, true]
  ]);
  assert.deepEqual(cut.outputs.map((port) => port.id), ['video', 'nat']);
  assert.deepEqual(cut.params, [{ id: 'quality', kind: 'select', options: ['standard', 'high'], default: 'standard' }]);
  assert.equal(render.type, 'event_video.render');
  assert.deepEqual(render.inputs.map((port) => port.id), ['video', 'nat', 'graphics', 'format', 'music', 'voice', 'logo', 'brand']);
  assert.deepEqual(render.outputs.map((port) => port.id), ['video', 'sheet', 'subtitles']);
  assert.equal(render.async, true);
  const registered = [];
  nodes.registerAll({ register: (definition) => registered.push(definition.type) });
  assert.deepEqual(registered, ['event_video.cut', 'event_video.render']);
  // what the nodes read
  assert.throws(() => nodes.readShots('{'), (err) => err.code === 'EVENTCUT_FAILED');
  assert.throws(() => nodes.readShots('{"version":1}'), (err) => err.code === 'EVENTCUT_FAILED' && /shots:/.test(err.message));
  assert.equal(nodes.readGraphics(JSON.stringify(graphics)).duration, 60);
  assert.throws(() => nodes.readGraphics('[]'), (err) => err.code === 'EVENTRENDER_GRAPHICS_INVALID' && /graphics:/.test(err.message));
  assert.throws(() => nodes.readGraphics('{"version":'), (err) => err.code === 'EVENTRENDER_GRAPHICS_INVALID');
  assert.equal(nodes.readFormat(' 9:16 '), '9:16');
  assert.throws(() => nodes.readFormat('4:3', 'EVENTCUT_FAILED'), (err) => err.code === 'EVENTCUT_FAILED');
  // every fault of the render has its code: a wrong format, a cut without picture or too short, music without sound
  const fakeCtx = { log: () => {}, sessionId: 'test', signal: null };
  const text = (value) => ({ type: 'text', value });
  await assert.rejects(
    render.execute(fakeCtx, { graphics: text(JSON.stringify(graphics)), format: text('4:3') }, { quality: 'draft' }),
    (err) => err.code === 'EVENTRENDER_GRAPHICS_INVALID' && /format: "4:3"/.test(err.data.problems)
  );
  const film = { video: { width: 1920, height: 1080 }, audio: null, duration: 60 };
  const song = { video: null, audio: { codec: 'aac' }, duration: 62 };
  assert.doesNotThrow(() => nodes.checkRenderInputs({ video: film, music: song, graphics }));
  for (const [label, video, music, problem] of [
    ['a cut without picture', { ...film, video: null }, song, /video: the file has no picture/],
    ['a cut too short', { ...film, duration: 41.2 }, song, /video: 41\.2 s, the plan needs 60 s/],
    ['music without sound', film, { ...song, audio: null }, /music: the file has no sound/]
  ]) {
    assert.throws(() => nodes.checkRenderInputs({ video, music, graphics }), (err) => err.code === 'EVENTRENDER_VERIFY_FAILED' && problem.test(err.data.problems), label);
  }
}

async function main() {
  testPages();
  testLayout();
  testView();
  testMix();
  await testChunks();
  await testReal();
  console.log('test-event-video-render.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
