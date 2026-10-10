'use strict';

// The music video in the HUD style (WP44, part 1): the frame model, the layout, the chunks, the page of a chunk, the post-pass and the node
// music_video.hud_render. No network and nothing paid: the render node is replaced by a double that makes a plain video of the right length,
// ffmpeg is the real one (the parts that need it are skipped when it is missing).
//   state      frameState is a pure function (the same frames from the whole film and from every chunk, also at the seams), the karaoke at the
//              borders of the words, the counters, bar and beat, the countdown to a drop, the ticker, the end card
//   graphics   normalizeGraphics survives broken input (never throws, nothing can end a script element), the layout puts no device on another
//              or on the figure (frame by frame, also for plans that are too full), the framing of a cut and the zone of the face that follows from
//              it (and from the punch-in), the new graphic wins (older ones end earlier, new ones come later or are left out with a note), the tilted
//              chart holds its outline, the accent goes to few devices, a device appears on its own word (`key`, WP44 part 2) or else on the key word
//              of its line
//   chunks     boundaries on the cuts, at most 24 s, the end card in the last chunk
//   page       the HTML of a chunk: size, root, timeline, fonts, data, no way out of the script element
//   post-pass  the arguments of ffmpeg: the glitch windows, the colour tags, the audio, grain, the check of the finished film, the contact sheet
//   node       the whole run with the render node replaced: one job per chunk with the footage as an asset and fps 24, a failed chunk is drawn
//              once more, the errors, the files that are left, the finished film
//   i18n       every text of the node and of its errors in de, en and es
//   styles     the style hud stays as it was (a fingerprint of everything it makes: nothing of the second style can change it); the style Kuble: its
//              table, fonts, page, frames, effects, the one amber element, layout, a cut without a figure, post-pass, and the finished film

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const state = require('../lib/music-video-hud/state');
const graphicsLib = require('../lib/music-video-hud/graphics');
const view = require('../lib/music-video-hud/view');
const chunksLib = require('../lib/music-video-hud/chunks');
const composition = require('../lib/music-video-hud/composition');
const post = require('../lib/music-video-hud/postpass');
const themes = require('../lib/music-video-hud/themes');
const metricsLib = require('../lib/music-video-hud/metrics');
const sceneLib = require('../lib/explainer-scene');
const motionHtml = require('../public/nodes/motion-html');

const FPS = 24;
const near = (actual, expected, tolerance, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} !== ${expected} (±${tolerance})`.trim());
const errorOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
};

// every number in a value is finite and no string has a character that could end a script element or a line
function walk(value, visit, trail = '$') {
  visit(value, trail);
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, visit, `${trail}[${index}]`));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) walk(item, visit, `${trail}.${key}`);
}
// strings: false for the state of a frame (the scrambled tiles of the title hold < and >, the view escapes every text it draws)
function assertClean(value, label, { strings = true } = {}) {
  walk(value, (item, trail) => {
    if (typeof item === 'number') assert.ok(Number.isFinite(item), `${label}: ${trail} is ${item}`);
    if (strings && typeof item === 'string') assert.ok(!/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/.test(item), `${label}: ${trail} holds a character that does not belong: ${JSON.stringify(item).slice(0, 60)}`);
  });
}

const demoInput = graphicsLib.demoGraphics({ duration: 128.4 });
const demo = graphicsLib.prepareGraphics(demoInput).graphics;

/* ---------- state: the small functions ---------- */

function testHelpers() {
  assert.equal(state.groupThousands(0), '0');
  assert.equal(state.groupThousands(7684), '7,684');
  assert.equal(state.groupThousands(48615203), '48,615,203');
  assert.equal(state.groupThousands(-1234567), '-1,234,567');
  assert.equal(state.roman(1), 'I');
  assert.equal(state.roman(4), 'IV');
  assert.equal(state.roman(14), 'XIV');
  assert.equal(state.roman(2026), 'MMXXVI');
  assert.equal(state.timecode(0), '00:00:00');
  assert.equal(state.timecode(83.5), '01:23:12');
  assert.equal(state.clockText(((3 * 60 + 52) * 60 + 17) * FPS + 4, 4), '03:52:17:04');
  assert.equal(state.clockText(23 * 60 * 60 * FPS + 59 * 60 * FPS, 2), '1439:00');
  assert.deepEqual(state.parseClock('03:52:17:04'), { frames: ((3 * 60 + 52) * 60 + 17) * FPS + 4, parts: 4 });
  assert.deepEqual(state.parseClock('12:30'), { frames: (12 * 60 + 30) * FPS, parts: 2 });
  assert.deepEqual(state.parseClock('x:y'), { frames: 0, parts: 4 });
  // the typing: 30 characters a second, one text after the other
  assert.deepEqual(state.typedCounts(['abcdef', 'xyz'], 0.1, 30), [3, 0]);
  assert.deepEqual(state.typedCounts(['abcdef', 'xyz'], 0.25, 30), [6, 1]);
  assert.deepEqual(state.typedCounts(['abcdef', 'xyz'], 9, 30), [6, 3]);
  assert.deepEqual(state.typedCounts(['abc'], 0.2, 30, 0.2), [0]);
  // the same hash on every machine
  assert.equal(state.hash(1, 2, 3), state.hash(1, 2, 3));
  assert.notEqual(state.hash(1, 2, 3), state.hash(1, 2, 4));
  for (let i = 0; i < 200; i += 1) assert.ok(state.hash(i, i * 7, 3) >= 0 && state.hash(i, i * 7, 3) < 1);
}

// The counter of the HUD: the value of the last step, rolled up from the one before in 6 frames.
function testCounterValues() {
  const steps = [{ at: 0, value: 1 }, { at: 10, value: 3 }, { at: 20, value: 64 }];
  assert.equal(state.stepValue(steps, 0).value, 1);
  assert.equal(state.stepValue(steps, 9.99).value, 1);
  assert.equal(state.stepValue(steps, 9.99).step, 0);
  assert.equal(state.stepValue(steps, 10).step, 1);
  assert.equal(state.stepValue(steps, 10).value, 1, 'a roll starts at the old value');
  const mid = state.stepValue(steps, 10 + state.ROLL_S / 2);
  assert.ok(mid.value > 1 && mid.value <= 3 && mid.rolling > 0, 'in the middle of a roll');
  const done = state.stepValue(steps, 10 + state.ROLL_S);
  assert.equal(done.value, 3);
  assert.equal(done.rolling, 0);
  assert.equal(state.stepValue(steps, 99).value, 64);
  assert.deepEqual(state.stepValue([], 5), { value: 0, rolling: 0, step: -1 });
  // never backwards inside one roll
  let last = 1;
  for (let t = 20; t <= 20 + state.ROLL_S; t += 0.005) {
    const value = state.stepValue(steps, t).value;
    assert.ok(value >= last, `a roll goes one way (${value} after ${last})`);
    last = value;
  }
}

function tiny(devices, extra = {}) {
  const beats = [];
  for (let t = 0.5; t < 16; t += 0.5) beats.push(Math.round(t * 1000) / 1000);
  const input = {
    version: 1,
    duration: 12,
    cuts: [{ start: 0, end: 12, kind: 'performance', crop: { scale: 1, x: 0.5, y: 0.5 }, subject: 'center' }],
    lines: [],
    music: { bpm: 120, beats, downbeats: beats.filter((_beat, index) => index % 4 === 0), hits: [], energy: [0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6] },
    hud: { title: 'TEST', counter: { label: 'ROUND', pad: 2, steps: [{ at: 0, value: 1 }, { at: 6, value: 12 }] }, drops: [] },
    graphics: devices,
    ...extra
  };
  return graphicsLib.prepareGraphics(input, {}).graphics;
}

function testDeviceCounters() {
  const g = tiny([
    { id: 'p', type: 'counter', format: 'percent', from: 0, to: 73, start: 1, end: 6, label: 'BATTERY' },
    { id: 'm', type: 'counter', format: 'money', from: 0, to: 48615203, start: 1, end: 6, label: 'SOLD' },
    { id: 'c', type: 'counter', format: 'clock', from: '03:52:17:00', to: '03:52:21:04', start: 1, end: 6, label: 'CLOCK' },
    { id: 'f', type: 'counter', format: 'fraction', from: 0, to: 714, total: 1308, start: 1, end: 6, label: 'INSIDE' }
  ]);
  const at = (t) => Object.fromEntries(state.frameState(g, t).devices.map((item) => [item.id, item.sub]));
  assert.equal(at(1.0).p.text, '0%');
  assert.equal(at(1.0).m.text, '$0');
  assert.equal(at(1.0).c.text, '03:52:17:00');
  assert.equal(at(5.9).p.text, '73%', 'the value is where it was said to go');
  assert.equal(at(5.9).m.text, '$48,615,203');
  assert.equal(at(5.9).f.text, '714');
  assert.equal(at(5.9).f.total, '/ 1,308');
  // the clock runs through the span
  assert.equal(at(5.99).c.text.slice(0, 8), '03:52:21');
  let previous = -1;
  for (let t = 1; t < 5.95; t += 1 / FPS) {
    const value = Number(at(t).p.text.replace('%', ''));
    assert.ok(value >= previous, 'a counter only rises');
    previous = value;
  }
  // before it appears and after it left there is nothing
  assert.equal(state.frameState(g, 0.5).devices.length, 0);
  assert.equal(state.frameState(g, 7).devices.length, 0);
  // the counter of the title
  assert.equal(state.frameState(g, 0.5).hud.title.counterValue, 1);
  assert.equal(state.frameState(g, 7).hud.title.counterValue, 12);
  assert.match(state.frameState(g, 7).hud.title.text, /^TEST · ROUND 12$/);
  assert.match(state.frameState(g, 0.5).hud.title.text, /^TEST · ROUND 01$/);
}

/* ---------- state: bar and beat, drops, ticker, karaoke ---------- */

function testBarAndBeat() {
  const first = demo.music.beats[0];
  const period = 60 / 128;
  const bb = (t) => state.frameState(demo, t).hud.barBeat;
  assert.equal(bb(first + 0.01), 'BAR 001 · BEAT 1');
  assert.equal(bb(first + period + 0.01), 'BAR 001 · BEAT 2');
  assert.equal(bb(first + 3 * period + 0.01), 'BAR 001 · BEAT 4');
  assert.equal(bb(first + 4 * period + 0.01), 'BAR 002 · BEAT 1');
  assert.equal(bb(first + 8 * period + 0.01), 'BAR 003 · BEAT 1');
  // before the first beat of the song the bar is 0
  assert.match(bb(first / 2), /^BAR 000 · BEAT \d$/);
  const m = state.frameState(demo, first + 5 * period + 0.001).music;
  assert.equal(m.bar, 2);
  assert.equal(m.beat, 2);
  near(m.phase, 0.001 / period, 0.01);
  // sixteenths count from the start of the song, four to a beat
  const a = state.beatState(demo.music, first + 0.001);
  const b = state.beatState(demo.music, first + period / 4 + 0.001);
  assert.equal(b.sixteenth - a.sixteenth, 1);
  assert.equal(state.beatState(demo.music, first + period + 0.001).sixteenth - a.sixteenth, 4);
  // a song without beats still counts (a regular grid of the tempo)
  const bare = tiny([], { music: { bpm: 120, beats: [], hits: [], energy: [0.5, 0.5, 0.5] } });
  assert.equal(state.frameState(bare, 2.01).hud.barBeat, 'BAR 000 · BEAT 1');
  assert.equal(state.frameState(bare, 2.51).hud.barBeat, 'BAR 000 · BEAT 2');
}

function testDropCountdown() {
  const [first, second] = demo.hud.drops;
  const drop = (t) => state.frameState(demo, t).hud.drop;
  assert.equal(drop(first - state.DROP_WINDOW_S - 0.05), null, 'nothing before the 8 seconds');
  assert.equal(drop(first - state.DROP_WINDOW_S).text, 'DROP IN 8.00 S');
  assert.equal(drop(first - state.DROP_WINDOW_S).accent, false);
  assert.equal(drop(first - 4).text, 'DROP IN 4.00 S');
  assert.equal(drop(first - 0.5).text, 'DROP IN 0.50 S');
  assert.equal(drop(first - 0.5).accent, true, 'the last second is in the accent colour');
  assert.equal(drop(first - 1.5).accent, false);
  assert.equal(drop(first), null, 'at the drop it is gone');
  assert.equal(drop(first + 3), null);
  assert.equal(drop(second - 2).text, 'DROP IN 2.00 S');
  // the countdown takes a place of the layout, no device stands in it
  for (const device of demo.devices) {
    const rects = device.occupies || [device.rect];
    const overlapsWindow = device.appear < first && device.end > first - state.DROP_WINDOW_S;
    if (!overlapsWindow) continue;
    for (const rect of rects) assert.ok(!(rect.x < 1860 && rect.x + rect.w > 1620 && rect.y < 186 && rect.y + rect.h > 136), `${device.id} stands in the countdown`);
  }
}

function testTicker() {
  const at = (t) => state.frameState(demo, t).hud.ticker;
  const t0 = at(0);
  assert.ok(t0.text.length > 20 && t0.width > 0);
  assert.equal(t0.offset, 0);
  near(at(1).offset, state.TICKER_PX_PER_S % t0.width, 1e-6);
  near(at(10).offset, (10 * state.TICKER_PX_PER_S) % t0.width, 1e-6);
  // one frame is 4 pixels, also over the wrap of the loop
  for (const t of [3, 17.5, 63.99, 100]) {
    const delta = (at(t + 1 / FPS).offset - at(t).offset + t0.width) % t0.width;
    near(delta, state.TICKER_PX_PER_S / FPS, 1e-6, `the ticker at ${t}`);
  }
  // without a ticker: no text, no move
  const none = tiny([], { hud: { title: 'X', ticker: [] } });
  assert.equal(state.frameState(none, 5).hud.ticker.offset, 0);
}

function testKaraoke() {
  const line = demo.lines[0];
  const k = (t) => state.frameState(demo, t).karaoke;
  assert.equal(k(line.start - state.KARAOKE_LEAD_S - 0.02), null);
  const lead = k(line.start - state.KARAOKE_LEAD_S);
  assert.ok(lead && lead.line === 0, 'the line comes a little before the first word');
  assert.deepEqual(lead.words.map((word) => word.state), line.words.map(() => 'next'));
  assert.equal(lead.current, -1);
  line.words.forEach((word, index) => {
    // exactly at the start of a word it is the current one, all before it are sung, all after it are next
    const now = k(word.start);
    assert.equal(now.current, index, `word ${index} is current at its start`);
    assert.deepEqual(now.words.map((item) => item.state), line.words.map((_item, i) => (i < index ? 'sung' : i === index ? 'current' : 'next')));
    // just before its start it is still next
    const before = k(word.start - 0.002);
    assert.notEqual(before.words[index].state, 'current');
    // exactly at its end it is sung
    const after = k(word.end);
    assert.equal(after.words[index].state, 'sung', `word ${index} is sung at its end`);
    // the gap between two words: nobody is current
    if (index + 1 < line.words.length && line.words[index + 1].start - word.end > 0.02) assert.equal(k(word.end + 0.01).current, -1);
  });
  const last = line.words[line.words.length - 1];
  assert.deepEqual(k(last.end + 0.01).words.map((word) => word.state), line.words.map(() => 'sung'));
  assert.ok(k(line.end + state.KARAOKE_TAIL_S - 0.02).alpha < 0.2, 'it fades out at the end');
  const afterTail = line.end + state.KARAOKE_TAIL_S + 0.02;
  if (!demo.lines.some((other) => other !== line && other.start - state.KARAOKE_LEAD_S <= afterTail && afterTail < other.end + state.KARAOKE_TAIL_S)) assert.equal(k(afterTail), null, 'after the tail of its line nothing is shown');
  // the key word is named by the line, and the karaoke can be left out
  assert.equal(k(line.start + 0.1).key, line.key);
  assert.equal(state.frameState(demo, line.start + 0.1, { karaoke: false }).karaoke, null);
}

function testEndcard() {
  const start = demo.endFrame / FPS;
  const e = (t, options) => state.frameState(demo, t, options);
  assert.equal(e(start - 1 / FPS).endcard, null);
  assert.ok(e(start - 1 / FPS).hud, 'the HUD is there up to the last frame of the song');
  const first = e(start);
  assert.ok(first.endcard, 'the card begins with the frame after the song');
  assert.equal(first.hud, null, 'no HUD on the card');
  assert.deepEqual(first.devices, []);
  assert.equal(first.karaoke, null);
  assert.equal(first.kick, 0);
  // the title and the lines are typed, and all of it (the credit line too) is complete when 60 % of the card are over
  const later = e(start + 0.6 * demo.endcard.seconds + 0.05).endcard;
  assert.equal(later.title, demo.endcard.title);
  assert.deepEqual(later.lines, demo.endcard.lines);
  assert.deepEqual(e(start + demo.endcard.seconds - 1 / FPS).endcard.lines, demo.endcard.lines, 'and stays so to the last frame');
  assert.ok(e(start + 0.5).endcard.title.length < demo.endcard.title.length || e(start + 0.5).endcard.title === demo.endcard.title, 'typing begins slowly');
  assert.equal(e(start + 0.1).endcard.title, '', 'nothing yet in the first moment');
  for (const seconds of [2, 3, 5]) {
    const card = graphicsLib.prepareGraphics({ duration: 12, cuts: [{ start: 0, end: 12 }], endcard: { seconds, title: 'A TITLE OF SOME LENGTH', lines: ['The first line of the card goes here', 'Claudia by anabology · claudia.gallery'] } }).graphics;
    const done = state.frameState(card, card.endFrame / FPS + seconds - 1 / FPS).endcard;
    assert.equal(done.title, 'A TITLE OF SOME LENGTH', `${seconds} s card: title`);
    assert.deepEqual(done.lines, ['The first line of the card goes here', 'Claudia by anabology · claudia.gallery'], `${seconds} s card: lines`);
  }
  // without the card the HUD goes on
  assert.equal(e(start + 1, { endcard: false }).endcard, null);
  assert.ok(e(start + 1, { endcard: false }).hud);
}

/* ---------- state: pure, and the same from every chunk ---------- */

function checkPurity(film) {
  const times = [];
  for (let frame = 0; frame < film.endFrame + 72; frame += 13) times.push(frame / FPS);
  const options = { karaoke: true, endcard: true };
  const once = times.map((t) => JSON.stringify(state.frameState(film, t, options)));
  const twice = times.map((t) => JSON.stringify(state.frameState(film, t, options)));
  assert.deepEqual(once, twice, 'the same data and the same time give the same frame');
  // in another order and after other frames (no memory between frames)
  const shuffled = [...times.keys()].sort((a, b) => ((a * 7919) % 101) - ((b * 7919) % 101));
  for (const index of shuffled) assert.equal(JSON.stringify(state.frameState(film, times[index], options)), once[index]);
  // the data is not touched
  const copy = JSON.stringify(film);
  state.frameState(film, 12.34, options);
  assert.equal(JSON.stringify(film), copy);
  // no frame has anything that is not a finite number
  for (const t of times) assertClean(state.frameState(film, t, options), `t=${t}`, { strings: false });
  // the kick, the camera and the accent stay inside their limits on every frame of the film
  for (let frame = 0; frame < film.endFrame; frame += 3) {
    const s = state.frameState(film, frame / FPS);
    assert.ok(s.kick >= 0 && s.kick <= 0.05 + 1e-9, `the kick at ${frame}`);
    assert.ok(s.camera.scale >= 1 && s.camera.scale <= 1.6);
    const accented = s.devices.filter((item) => item.accent && item.leave < 1).length + (s.karaoke ? 1 : 0);
    assert.ok(accented <= 2, `at most two accents at frame ${frame}, got ${accented}`);
  }
}

function testPurity() {
  checkPurity(demo);
}

function checkChunkIdentity(film) {
  const chunks = chunksLib.planChunks(film, { endcardSeconds: film.endcard.seconds });
  assert.ok(chunks.length >= 5);
  const options = { karaoke: true, endcard: true };
  let compared = 0;
  chunks.forEach((chunk, index) => {
    const slice = graphicsLib.sliceGraphics(film, chunk.start, chunk.start + chunk.duration);
    const frames = chunk.pageFrames;
    const wanted = new Set([0, 1, 2, frames - 3, frames - 2, frames - 1, Math.floor(frames / 2)]);
    for (let i = 3; i < frames; i += 11) wanted.add(i);
    for (const frame of wanted) {
      const t = chunk.start + frame / FPS;
      assert.equal(JSON.stringify(state.frameState(slice, t, options)), JSON.stringify(state.frameState(film, t, options)), `chunk ${index + 1}, frame ${frame} (t=${t.toFixed(3)}) differs from the film`);
      compared += 1;
    }
    // the seam: the last frame of this chunk and the first of the next one lie one frame apart, and the HUD runs on
    if (index + 1 < chunks.length) {
      const next = graphicsLib.sliceGraphics(film, chunks[index + 1].start, chunks[index + 1].start + chunks[index + 1].duration);
      const lastOfThis = state.frameState(slice, chunk.start + (frames - 1) / FPS, options);
      const firstOfNext = state.frameState(next, chunks[index + 1].start, options);
      assert.equal(firstOfNext.frame - lastOfThis.frame, 1, 'the chunks join without a gap');
      const width = lastOfThis.hud.ticker.width;
      near((firstOfNext.hud.ticker.offset - lastOfThis.hud.ticker.offset + width) % width, state.TICKER_PX_PER_S / FPS, 1e-6, 'the ticker runs through the seam');
      assert.ok(firstOfNext.music.beatIndex - lastOfThis.music.beatIndex >= 0 && firstOfNext.music.beatIndex - lastOfThis.music.beatIndex <= 1, 'the beats are counted through the seam');
      assert.ok(firstOfNext.music.bar - lastOfThis.music.bar >= 0 && firstOfNext.music.bar - lastOfThis.music.bar <= 1, 'the bars are counted through the seam');
      assert.ok(firstOfNext.hud.title.counterValue >= lastOfThis.hud.title.counterValue, 'the number of the title never goes back');
    }
    // a slice carries less than the whole film
    assert.ok(slice.music.beats.length < film.music.beats.length || chunks.length === 1);
  });
  assert.ok(compared > 200);
}

function testChunkIdentity() {
  checkChunkIdentity(demo);
}

/* ---------- graphics: broken input, the layout ---------- */

function testNormalizeBroken() {
  const hostile = '</script><script>alert(1)</script><img src=x onerror=alert(1)>';
  const cases = [
    '',
    '{',
    'null',
    '[]',
    '42',
    '"text"',
    '{}',
    { cuts: 'x', lines: 5, graphics: {}, music: 'loud', hud: [] },
    { duration: 'NaN', cuts: [{ start: 'a', end: null }], lines: [{ words: 'no' }], graphics: [null, 5, 'x', []] },
    { duration: 1e12, cuts: [{ start: -50, end: 1e9 }] },
    { duration: 20, cuts: [{ start: 0, end: 10 }, { start: 5, end: 8 }, { start: 5, end: 8 }, { start: 30, end: 40 }], lines: [], graphics: [] },
    { duration: 20, cuts: [{ start: 0, end: 20 }], lines: [{ start: 5, end: 2, words: [{ text: hostile, start: 9, end: 1 }, { text: '', start: 1 }, { start: 2 }] }] },
    { duration: 20, cuts: [{ start: 0, end: 20, subject: 'up', kind: 'dream', transition: 'explode', crop: { scale: 99, x: -5, y: 'a' } }] },
    { duration: 20, cuts: [{ start: 0, end: 10, framing: hostile }, { start: 10, end: 20, framing: { toString: 'x' } }, { start: 20, end: 30, framing: ['CU'] }] },
    { duration: 20, cuts: [{ start: 0, end: 20 }], graphics: [{ type: 'virus', start: 1, end: 3 }, { type: 'counter', format: 'bitcoin', start: 1, end: 3, from: 'a', to: {} }, { type: 'display', start: 3, end: 1, rows: 'no' }, { type: 'terminal', lines: [hostile, 5, null], start: 1, end: 6 }, { type: 'tag', text: hostile, start: 0, end: 5 }] },
    { duration: 20, cuts: [{ start: 0, end: 20 }], hud: { title: hostile, console: hostile, ticker: [hostile, ...Array(40).fill('x')], chapters: [{ start: 'a' }, { start: 5, end: 3, name: hostile }], drops: [-1, 'x', 1e9, 5] }, endcard: { seconds: 1e9, title: hostile, lines: [hostile, hostile, hostile, hostile, hostile] } },
    { duration: 20, accent: 'red; background:url(//evil)', cuts: [{ start: 0, end: 20 }], music: { bpm: -3, beats: ['a', 1, 1, 0.5, 1e9], hits: [{ t: 'x' }, { t: 1, strength: 99 }], energy: [-4, 'a', 9, ...Array(5000).fill(0.3)] } },
    JSON.parse('{"__proto__": {"polluted": true}, "duration": 12, "cuts": [{"start": 0, "end": 12}]}'),
    { duration: 30, cuts: [{ start: 0, end: 30 }], graphics: Array.from({ length: 900 }, (_item, index) => ({ type: 'tag', text: `T${index}`, start: index % 25, end: (index % 25) + 3 })) }
  ];
  cases.forEach((input, index) => {
    const { graphics, warnings } = graphicsLib.normalizeGraphics(input);
    const label = `case ${index}`;
    assert.ok(Array.isArray(warnings) && warnings.length <= 100, label);
    assertClean(graphics, label);
    assert.ok(graphics.cuts.length >= 1, `${label}: there is always a cut`);
    assert.equal(graphics.cuts[0].start * FPS, Math.round(graphics.cuts[0].start * FPS), `${label}: cuts sit on the frame grid`);
    graphics.cuts.forEach((cut, i) => {
      near(cut.start * FPS, Math.round(cut.start * FPS), 1e-6, `${label}: start ${i}`);
      near(cut.end * FPS, Math.round(cut.end * FPS), 1e-6, `${label}: end ${i}`);
      assert.ok(cut.end > cut.start, `${label}: a cut has a length`);
      if (i > 0) near(cut.start, graphics.cuts[i - 1].end, 1e-9, `${label}: cuts have no gap`);
    });
    near(graphics.cuts[graphics.cuts.length - 1].end, graphics.endFrame / FPS, 1e-9, `${label}: the cuts cover the film`);
    assert.ok(graphics.duration >= 1 && graphics.duration <= 7200, label);
    assert.equal(new Set(graphics.graphics.map((device) => device.id)).size, graphics.graphics.length, `${label}: ids are unique`);
    assert.ok(graphics.graphics.length <= graphicsLib.MAX.devices, label);
    assert.match(graphics.accent, /^#[0-9A-F]{6}$/, `${label}: the accent is a colour`);
    assert.equal(({}).polluted, undefined, 'nothing was added to Object.prototype');
    // and everything that follows works on it
    const resolved = graphicsLib.resolveGraphics(graphics, {});
    for (const t of [0, graphics.duration / 2, graphics.duration - 0.01, graphics.duration + 1]) assertClean(state.frameState(resolved, t), `${label} t=${t}`, { strings: false });
  });
  // what was asked for survives
  const kept = graphicsLib.normalizeGraphics({ duration: 20, cuts: [{ start: 0, end: 20 }], graphics: [{ type: 'virus', start: 1, end: 3 }, { type: 'tag', text: 'KEPT', start: 1, end: 3 }] });
  assert.equal(kept.graphics.graphics.length, 1);
  assert.equal(kept.graphics.graphics[0].text, 'KEPT');
  assert.ok(kept.warnings.some((warning) => /virus/.test(warning)), 'the unknown type is named');
  // a text with markup keeps no markup
  const hostileText = graphicsLib.normalizeGraphics({ duration: 20, cuts: [{ start: 0, end: 20 }], graphics: [{ type: 'tag', text: '<b>BOLD</b> & more', start: 1, end: 3 }] });
  assert.ok(!/[<>]/.test(hostileText.graphics.graphics[0].text));
  assert.equal(graphicsLib.normalizeGraphics({ duration: 20, cuts: [{ start: 0, end: 20 }], accent: '#abc' }).graphics.accent, '#AABBCC');
  assert.equal(graphicsLib.normalizeGraphics({ duration: 20, cuts: [{ start: 0, end: 20 }], accent: '#3B82F6' }).graphics.accent, '#3B82F6');
  assert.equal(graphicsLib.normalizeColor('nonsense'), graphicsLib.DEFAULT_ACCENT);
  assert.equal(graphicsLib.normalizeColor('nonsense', '#112233'), '#112233');
  // the demo is clean and the same every time
  const clean = graphicsLib.normalizeGraphics(demoInput);
  assert.deepEqual(clean.warnings, [], 'the example has no notes');
  assert.equal(JSON.stringify(graphicsLib.demoGraphics({ duration: 128.4 })), JSON.stringify(demoInput));
  assert.deepEqual(new Set(demoInput.graphics.map((device) => device.type)), new Set(graphicsLib.DEVICE_TYPES), 'the example has every kind of device');
}

function testLayout() {
  const FACE = graphicsLib.FACE;
  for (const duration of [40, 72, 128.4]) {
    const g = graphicsLib.prepareGraphics(graphicsLib.demoGraphics({ duration })).graphics;
    const placed = g.devices.filter((device) => device.rect);
    assert.equal(placed.length, g.devices.length, 'every device has a place');
    // no device on another
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i];
        const b = placed[j];
        if (!(a.appear < b.end && b.appear < a.end)) continue;
        for (const x of a.occupies || [a.rect]) {
          for (const y of b.occupies || [b.rect]) {
            assert.ok(!(x.x < y.x + y.w && x.x + x.w > y.x && x.y < y.y + y.h && x.y + x.h > y.y), `${a.id} (${a.type}) lies on ${b.id} (${b.type})`);
          }
        }
      }
    }
    // no device on the figure for 0.4 s or more
    for (const device of placed) {
      for (const cut of g.cuts) {
        const overlap = Math.min(cut.end, device.end) - Math.max(cut.start, device.appear);
        if (overlap < 0.4) continue;
        const zone = FACE[cut.subject];
        for (const rect of device.occupies || [device.rect]) {
          assert.ok(!(rect.x < zone.x1 && rect.x + rect.w > zone.x0 && rect.y < FACE.y1 && rect.y + rect.h > FACE.y0), `${device.id} (${device.type}) stands on the ${cut.subject} figure at ${cut.start}`);
        }
      }
    }
    // inside the frame of the HUD (the pin and the full-width pieces aside)
    for (const device of placed) {
      if (device.type === 'pin') continue;
      assert.ok(device.rect.x >= graphicsLib.SAFE.left - 24 && device.rect.x + device.rect.w <= graphicsLib.SAFE.right + 24, `${device.id} is inside the side margins`);
      assert.ok(device.rect.y >= graphicsLib.SAFE.top - 8 && device.rect.y + device.rect.h <= graphicsLib.SAFE.bottom + 8, `${device.id} is inside the top and bottom margins`);
    }
    // the accent: one device at a time (two without the karaoke line), the same layout every time
    for (const budget of [1, 2]) {
      const withBudget = graphicsLib.prepareGraphics(graphicsLib.demoGraphics({ duration }), { karaoke: budget === 1 }).graphics;
      const holders = withBudget.devices.filter((device) => device.accent);
      for (const holder of holders) {
        const same = holders.filter((other) => other.appear < holder.end && other.end > holder.appear && other.appear <= holder.appear);
        assert.ok(same.length <= budget, `${same.map((item) => item.id).join(', ')} hold the accent at the same time (budget ${budget})`);
      }
    }
    assert.equal(JSON.stringify(g), JSON.stringify(graphicsLib.prepareGraphics(graphicsLib.demoGraphics({ duration })).graphics), 'the layout is a function of the data');
  }
  // a pin that would cover the figure slides to the side, in its row
  const pinned = graphicsLib.prepareGraphics({ duration: 12, cuts: [{ start: 0, end: 12, subject: 'center' }], graphics: [{ type: 'pin', label: 'HERE', x: 0.5, y: 0.4, start: 1, end: 8 }] }).graphics;
  const pin = pinned.devices[0];
  assert.ok(pin.rect.x >= FACE.center.x1 || pin.rect.x + pin.rect.w <= FACE.center.x0, 'the pin is off the figure');
  near(pin.rect.y, 0.4 * 1080 - 80, 1);
  // measured brightness changes the ink: dark writing on a bright picture
  const bright = graphicsLib.prepareGraphics(
    { duration: 12, cuts: [{ start: 0, end: 12, subject: 'center' }], graphics: [{ type: 'tag', text: 'ON LIGHT', start: 1, end: 8 }] },
    { luma: [[0.9, 0.9]] }
  ).graphics;
  assert.equal(state.frameState(bright, 3).ink, 'dark');
  assert.equal(state.frameState(bright, 3).devices[0].ink, 'dark');
  const darkPicture = graphicsLib.prepareGraphics({ duration: 12, cuts: [{ start: 0, end: 12, subject: 'center' }], graphics: [{ type: 'tag', text: 'ON DARK', start: 1, end: 8 }] }, { luma: [[0.1, 0.2]] }).graphics;
  assert.equal(state.frameState(darkPicture, 3).ink, 'light');
}

/* ---------- graphics: the framing, the zone of the face, never one graphic on another ---------- */

// One device of every kind (with what it needs to have a size), for plans that are too full
const SAMPLES = {
  tag: { text: 'DJ BOOTH · ROOM 2 · 128 BPM' },
  counter: { format: 'percent', from: 0, to: 88, label: 'CHARGING' },
  list: { title: 'TIMETABLE', rows: ['22:48 BERN ..... GONE', '23:05 CHUR ..... GONE', '23:17 BIEL ..... GONE', '23:34 ZUG ...... GONE'] },
  chart: { title: 'FLOOR · LOUDNESS', values: [23, 27, 26, 34, 41, 49, 47, 58], marker: 'PEAK AT 58%' },
  terminal: { lines: ['ride request --to home', 'ticket 03 accepted', 'queue: 12 left'] },
  stopwatch: { from: '03:52:17:04', label: 'SINCE THE LAST TRAIN' },
  clock: { time: '00:07', label: 'LOCAL TIME', arc: 0.9 },
  blueprint: { title: 'FIG. 1 · TICKET GATE', labels: { a: 'A · SENSOR', b: 'B · HINGE' }, dims: [1.1, 0.9] },
  voice: { label: 'VOICE · ECHO', db: -32 },
  stamp: { text: 'CANCELLED', count: 2 },
  toggle: { label: 'DANCE MODE', states: ['ON', 'OFF?'] },
  progress: { label: 'FILLING', from: 4, to: 92 },
  notification: { app: 'MESSAGES', title: 'Friends · 4 new', text: 'are you alive?', time: 'now' },
  chat: { messages: [{ from: 'them', text: 'where did you run off?' }, { from: 'her', text: 'last train gone, I am dancing' }] },
  spec: { title: 'FACT SHEET', rows: [['TYPE', 'LATCH'], ['RATING', '240'], ['OWNER', 'UNKNOWN']] },
  strike: { text: 'THE BIG RUSH', mode: 'strike' },
  display: { style: 'condensed', rows: [{ text: 'MERIDIAN', size: 'xl' }] },
  pin: { label: 'PIER 11 · HANGAR', x: 0.62, y: 0.4 }
};

// A plan that cannot be laid out as it is: 90 devices of every kind in 36 s (seven at a time on average), over cuts of every kind, framing, subject and
// punch-in. The numbers come from a fixed generator, so every run is the same plan.
function crowded(seed) {
  // mulberry32: a small generator with exact integer arithmetic, the same numbers on every machine
  let x = seed >>> 0;
  const random = () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = Math.imul(x ^ (x >>> 15), x | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const seconds = 36;
  const cuts = [];
  for (let t = 0; t < seconds; ) {
    const length = pick([0.75, 1.25, 1.5, 2, 2.5, 3.5]);
    cuts.push({
      start: t,
      end: Math.min(seconds, t + length),
      kind: pick(['performance', 'performance', 'story', 'still']),
      subject: pick(['left', 'center', 'right']),
      framing: pick([...graphicsLib.FRAMINGS, undefined]),
      crop: { scale: pick([1, 1, 1.35, 1.6]), x: pick([0.5, 0.4, 0.6]), y: pick([0.5, 0.42]) }
    });
    t += length;
  }
  const types = Object.keys(SAMPLES);
  const graphics = [];
  for (let i = 0; i < 90; i += 1) {
    const type = types[i % types.length];
    const start = Math.round(random() * (seconds - 4) * 100) / 100;
    graphics.push({ id: `x${i}`, type, start, end: Math.round((start + pick([1.5, 2, 2.5, 3, 4])) * 100) / 100, ...SAMPLES[type] });
  }
  return { version: 1, duration: seconds, cuts, lines: [], graphics, hud: { title: 'TEST' }, endcard: { seconds: 3, title: 'THE END', lines: ['MADE FOR A TEST'] } };
}

const rectsOf = (item) => item.d.occupies || [item.rect];
const touch = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// Every frame of the film: no two graphics that are on the screen at the same time touch (one counts from its first frame to the end of its exit), none
// stands on the zone of the face of a lip-sync cut, and on another cut none crosses it for 0.4 s or more (that is 10 frames).
function assertNoCover(g, label) {
  const zones = g.cuts.map((cut) => {
    const zone = graphicsLib.faceZone(cut);
    return zone ? { x: zone.x0, y: zone.y0, w: zone.x1 - zone.x0, h: zone.y1 - zone.y0 } : null;
  });
  const crossing = new Map();
  for (let frame = 0; frame < g.endFrame; frame += 1) {
    const t = frame / FPS;
    const items = state.frameState(g, t).devices;
    const cut = g.cuts.findIndex((candidate) => t >= candidate.start - 1e-9 && t < candidate.end - 1e-9);
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        for (const a of rectsOf(items[i])) for (const b of rectsOf(items[j])) assert.ok(!touch(a, b), `${label}: ${items[i].id} (${items[i].type}) lies on ${items[j].id} (${items[j].type}) at ${t.toFixed(3)} s`);
      }
      if (cut < 0 || !zones[cut] || !rectsOf(items[i]).some((rect) => touch(rect, zones[cut]))) continue;
      assert.notEqual(g.cuts[cut].kind, 'performance', `${label}: ${items[i].id} (${items[i].type}) stands on the face of the lip-sync cut at ${t.toFixed(3)} s`);
      const key = `${items[i].id} on cut ${cut}`;
      crossing.set(key, (crossing.get(key) || 0) + 1);
    }
  }
  for (const [key, frames] of crossing) assert.ok(frames <= Math.ceil(0.4 * FPS), `${label}: ${key} stands on the face for ${frames} frames`);
}

// What the layout does to a plan, and what it must keep to: a graphic is left out (and named in a note), comes later (1 s of life left at least) or ends
// earlier (1.2 s fully on the screen at least), and never lives longer than planned. Returns how often each happened. (For plans without lyric lines:
// a graphic that is tied to a line appears at the key word, not at its start.)
function assertKept(plan, prepared, label) {
  const planned = new Map(graphicsLib.normalizeGraphics(plan).graphics.graphics.map((device) => [device.id, device]));
  const kept = new Map(prepared.graphics.devices.map((device) => [device.id, device]));
  const counts = { dropped: 0, shortened: 0, late: 0 };
  for (const [id, wanted] of planned) {
    const device = kept.get(id);
    if (!device) {
      counts.dropped += 1;
      assert.ok(prepared.warnings.some((note) => note.includes(`"${id}"`) && /left out/.test(note)), `${label}: ${id} was left out without a note`);
      continue;
    }
    assert.ok(device.end <= wanted.end + 1e-6, `${label}: ${id} lives longer than planned`);
    if (device.end < wanted.end - 1e-6) {
      counts.shortened += 1;
      assert.ok(device.end - (device.appear + state.ENTER_S) >= graphicsLib.MIN_SHOWN_S - 1e-6, `${label}: ${id} was cut short to ${device.appear}..${device.end}`);
    }
    if (device.appear > wanted.start + 1e-6) {
      counts.late += 1;
      assert.ok(device.end - device.appear >= graphicsLib.MIN_LATE_S - 1e-6, `${label}: ${id} comes at ${device.appear} and ends at ${device.end}`);
    }
  }
  assert.equal(kept.size + counts.dropped, planned.size, `${label}: every graphic is kept or named`);
  return counts;
}

// The chunks of a film show what the whole film shows (the layout is made once for the whole film)
function assertSameInChunks(g, label) {
  const options = { karaoke: true, endcard: true };
  const chunks = chunksLib.planChunks(g, { endcardSeconds: g.endcard.seconds });
  assert.ok(chunks.length >= 2, `${label}: more than one chunk`);
  let compared = 0;
  for (const chunk of chunks) {
    const slice = graphicsLib.sliceGraphics(g, chunk.start, chunk.start + chunk.duration);
    for (let frame = 0; frame < chunk.pageFrames; frame += 1) {
      const t = chunk.start + frame / FPS;
      assert.equal(JSON.stringify(state.frameState(slice, t, options)), JSON.stringify(state.frameState(g, t, options)), `${label}: frame ${frame} of the chunk at ${chunk.start} differs from the film`);
      compared += 1;
    }
  }
  assert.ok(compared > 800, label);
}

function testFraming() {
  const cuts = (framings) => framings.map((framing, index) => ({ start: index * 2, end: index * 2 + 2, subject: 'center', ...(framing === undefined ? {} : { framing }) }));
  const read = graphicsLib.normalizeGraphics({ duration: 20, cuts: cuts(['CU', ' mcu ', 'ots', undefined, 'close-up', 5, null, {}, 'WS', 'ECU']) });
  assert.deepEqual(read.graphics.cuts.map((cut) => cut.framing), ['CU', 'MCU', 'OTS', null, null, null, null, null, 'WS', 'ECU'], 'a framing is read (case and spaces do not matter), anything else is dropped');
  const notes = read.warnings.filter((note) => /framing/.test(note));
  assert.equal(notes.length, 1, 'the dropped framings are named once');
  assert.match(notes[0], /^3 cuts have a framing/, 'and counted');
  assert.deepEqual(graphicsLib.FRAMINGS, ['ECU', 'CU', 'MCU', 'MS', 'MWS', 'WS', 'FS', 'EWS', 'OTS']);
  for (const framing of graphicsLib.FRAMINGS) assert.equal(graphicsLib.normalizeGraphics({ duration: 6, cuts: cuts([framing]) }).graphics.cuts[0].framing, framing);
  // nothing said, nothing noted: a film without framings is as it was
  const none = graphicsLib.normalizeGraphics({ duration: 6, cuts: cuts([undefined, null, '']) });
  assert.ok(none.graphics.cuts.every((cut) => cut.framing === null));
  assert.ok(!none.warnings.some((note) => /framing/.test(note)));
  // a film without cuts gets one, without a framing
  assert.equal(graphicsLib.normalizeGraphics({ duration: 6 }).graphics.cuts[0].framing, null);
  // it survives the layout and the slices of the chunks
  const g = graphicsLib.prepareGraphics({ duration: 12, cuts: cuts(['CU', 'MS', 'WS', 'ECU', 'bad', 'OTS']) }).graphics;
  assert.deepEqual(g.cuts.map((cut) => cut.framing), ['CU', 'MS', 'WS', 'ECU', null, 'OTS']);
  const slice = graphicsLib.sliceGraphics(g, 4, 10);
  assert.ok(slice.cuts.length >= 3);
  for (const cut of slice.cuts) assert.equal(cut.framing, g.cuts.find((original) => original.start === cut.start).framing);
}

function testFaceZone() {
  const zone = (cut) => graphicsLib.faceZone({ kind: 'story', subject: 'center', crop: { scale: 1, x: 0.5, y: 0.5 }, ...cut });
  const centre = (z) => (z.x0 + z.x1) / 2;
  // the wider the shot, the smaller the head: the zone gets narrower and does not reach as far down
  const framed = graphicsLib.FRAMINGS.map((framing) => zone({ framing }));
  assert.deepEqual(framed.map((z) => z.x1 - z.x0), [1120, 840, 640, 480, 360, 360, 360, 360, 360]);
  assert.deepEqual(framed.map((z) => z.y1), [1010, 980, 860, 640, 520, 520, 520, 520, 520]);
  for (let i = 1; i < framed.length; i += 1) assert.ok(framed[i].x1 - framed[i].x0 <= framed[i - 1].x1 - framed[i - 1].x0 && framed[i].y1 <= framed[i - 1].y1, `${graphicsLib.FRAMINGS[i]} is not bigger than ${graphicsLib.FRAMINGS[i - 1]}`);
  // the zone is round the figure: left, in the middle, right
  for (const framing of ['CU', 'MS', 'WS']) {
    assert.equal(centre(zone({ framing, subject: 'left' })), 520);
    assert.equal(centre(zone({ framing, subject: 'center' })), 960);
    assert.equal(centre(zone({ framing, subject: 'right' })), 1400);
  }
  // without a framing it is the old zone, and with lip-sync it reaches down to the mouth and the chin
  assert.deepEqual(zone({}), { x0: 660, y0: 70, x1: 1260, y1: 800 });
  assert.deepEqual(zone({ subject: 'left' }), { x0: graphicsLib.FACE.left.x0, y0: graphicsLib.FACE.y0, x1: graphicsLib.FACE.left.x1, y1: graphicsLib.FACE.y1 });
  assert.equal(zone({ kind: 'performance' }).y1, 860);
  assert.equal(zone({ kind: 'performance', framing: 'MS' }).y1, 640, 'a framing says where the mouth is');
  assert.equal(zone({ kind: 'performance', framing: 'xx' }).y1, 860, 'what is not a framing is not read');
  assert.deepEqual(zone({ subject: 'nobody', framing: 'CU' }), zone({ subject: 'center', framing: 'CU' }));
  assert.deepEqual(graphicsLib.faceZone({}), { x0: 660, y0: 70, x1: 1260, y1: 800 }, 'a cut without anything gets the old zone');
  // a punch-in makes the picture bigger and the zone with it, round the middle of the picture, and the zone stays on the screen
  const punched = zone({ framing: 'CU', crop: { scale: 1.35, x: 0.5, y: 0.5 } });
  assert.deepEqual(punched, { x0: 393, y0: 0, x1: 1527, y1: 1080 });
  const wide = zone({ framing: 'WS', crop: { scale: 1.6, x: 0.5, y: 0.5 } });
  near(wide.x1 - wide.x0, 360 * 1.6, 1);
  // a punch-in on a point other than the middle moves it the way the camera moves the picture
  for (const crop of [{ scale: 1.35, x: 0.4, y: 0.42 }, { scale: 1.6, x: 0.6, y: 0.5 }]) {
    const camera = state.camera(crop, 0);
    const moved = zone({ framing: 'MS', crop });
    const plain = zone({ framing: 'MS' });
    near(moved.x0, Math.max(0, plain.x0 * camera.scale + camera.tx), 1, `x0 of ${JSON.stringify(crop)}`);
    near(moved.x1, Math.min(1920, plain.x1 * camera.scale + camera.tx), 1, `x1 of ${JSON.stringify(crop)}`);
    near(moved.y1, Math.min(1080, plain.y1 * camera.scale + camera.ty), 1, `y1 of ${JSON.stringify(crop)}`);
  }
  // a zone is never outside the screen or empty
  for (const framing of [...graphicsLib.FRAMINGS, null]) {
    for (const subject of ['left', 'center', 'right']) {
      for (const scale of [1, 1.35, 1.6]) {
        const z = zone({ framing, subject, crop: { scale, x: 0.5, y: 0.5 } });
        assert.ok(z.x0 >= 0 && z.y0 >= 0 && z.x1 <= 1920 && z.y1 <= 1080 && z.x1 > z.x0 && z.y1 > z.y0, `${framing} ${subject} ${scale}`);
      }
    }
  }
}

function testNoCover() {
  for (const duration of [40, 72, 128.4]) assertNoCover(graphicsLib.prepareGraphics(graphicsLib.demoGraphics({ duration })).graphics, `the example of ${duration} s`);
  assert.equal(Object.keys(SAMPLES).sort().join(), [...graphicsLib.DEVICE_TYPES].sort().join(), 'the crowded plans have every kind of device');
  const total = { dropped: 0, shortened: 0, late: 0 };
  for (const seed of [3, 8, 17]) {
    const plan = crowded(seed);
    const prepared = graphicsLib.prepareGraphics(plan);
    const label = `the crowded plan ${seed}`;
    assertNoCover(prepared.graphics, label);
    const counts = assertKept(plan, prepared, label);
    for (const key of Object.keys(total)) total[key] += counts[key];
    assertSameInChunks(prepared.graphics, label);
    assert.equal(JSON.stringify(graphicsLib.prepareGraphics(plan).graphics), JSON.stringify(prepared.graphics), `${label}: the layout is a function of the data`);
    // the node asks the layout directly, and gets the same notes
    const notes = [];
    graphicsLib.resolveGraphics(graphicsLib.normalizeGraphics(plan).graphics, { warn: (note) => notes.push(note) });
    assert.ok(notes.length > 0, `${label}: something was left out`);
    assert.deepEqual(prepared.warnings.slice(prepared.warnings.length - notes.length), notes, `${label}: resolveGraphics tells what it left out`);
  }
  assert.ok(total.dropped > 0 && total.shortened > 0 && total.late > 0, `the crowded plans make the layout leave out (${total.dropped}), shorten (${total.shortened}) and delay (${total.late})`);
}

function testNewWins() {
  const chart = (id, start, end) => ({ id, type: 'chart', ...SAMPLES.chart, start, end });
  const story = { duration: 20, cuts: [{ start: 0, end: 20, kind: 'story', subject: 'center' }] };
  const run = (plan) => {
    const prepared = graphicsLib.prepareGraphics(plan);
    assertNoCover(prepared.graphics, 'new wins');
    assertKept(plan, prepared, 'new wins');
    return { ...prepared, by: Object.fromEntries(prepared.graphics.devices.map((device) => [device.id, device])) };
  };
  // two charts fit beside the figure. The third one is new: the oldest chart ends so that its exit is over when the new one appears, in the same place
  const apart = run({ ...story, graphics: [1, 3, 5, 7, 9].map((start, index) => chart(`c${index}`, start, 13)) });
  assert.equal(apart.graphics.devices.length, 5, 'all five are shown');
  assert.equal(apart.by.c1.end, 13, 'the one that is not in the way is not touched');
  assert.equal(apart.by.c4.end, 13);
  for (const [old, next] of [['c0', 'c2'], ['c2', 'c3'], ['c3', 'c4']]) {
    near(apart.by[old].end + state.EXIT_S, apart.by[next].appear, 1e-9, `${old} is gone when ${next} comes`);
    assert.deepEqual(apart.by[old].rect, apart.by[next].rect, `${next} takes the place of ${old}`);
    assert.equal(apart.by[next].appear, [1, 3, 5, 7, 9][Number(next.slice(1))], `${next} comes when it was planned`);
  }
  // too soon after each other: nobody is cut shorter than its entrance and 1.2 s, the new ones come later
  const soon = run({ ...story, graphics: [1, 1.2, 1.4, 1.6, 1.8, 2].map((start, index) => chart(`c${index}`, start, 9)) });
  near(soon.by.c0.end, 1 + state.ENTER_S + graphicsLib.MIN_SHOWN_S, 1e-9, 'the oldest stays as short as it may');
  near(soon.by.c2.appear, soon.by.c0.end + state.EXIT_S, 1e-9, 'and the third comes when the oldest is gone');
  assert.ok(soon.by.c2.appear > 1.4, 'it comes later than it was planned');
  assert.ok(soon.by.c2.appear <= 9 - graphicsLib.MIN_LATE_S, 'but with a second left at least');
  // a graphic that would come after its last second is left out, and the note names it
  const none = run({ ...story, graphics: [chart('a', 1, 8), chart('b', 1.1, 8), chart('c', 1.2, 2.9)] });
  assert.equal(none.by.c, undefined, 'there is no place and no time for the third');
  assert.equal(none.by.a.end, 8);
  assert.equal(none.by.b.end, 8);
  assert.equal(none.warnings.filter((note) => /"c"/.test(note) && /left out/.test(note)).length, 1);
  assert.ok(!none.warnings.some((note) => /"[ab]"/.test(note)), 'and nothing else is');
  // the picture changes to a lip-sync close-up in which there is no room at the sides: what does not fit there ends at the cut, with its exit,
  // and what fits stays
  const cut = run({
    duration: 20,
    cuts: [{ start: 0, end: 6, kind: 'story', subject: 'center' }, { start: 6, end: 20, kind: 'performance', subject: 'center', framing: 'CU' }],
    graphics: [chart('big', 2, 12), { id: 'small', type: 'tag', text: 'STAYS', start: 2, end: 12 }]
  });
  near(cut.by.big.end, 6 - state.EXIT_S, 1e-9, 'the chart ends at the cut');
  assert.equal(cut.by.big.appear, 2);
  assert.ok(cut.by.big.end - (cut.by.big.appear + state.ENTER_S) >= graphicsLib.MIN_SHOWN_S);
  assert.equal(cut.by.small.end, 12, 'a tag fits beside the face and stays');
  const face = graphicsLib.faceZone(cut.graphics.cuts[1]);
  assert.ok(cut.by.small.rect.x + cut.by.small.rect.w <= face.x0 || cut.by.small.rect.x >= face.x1, 'and stays beside it');
  // nothing fits on the lip-sync close-up for the whole life of a chart: it is left out
  const inside = run({
    duration: 20,
    cuts: [{ start: 0, end: 6, kind: 'story', subject: 'center' }, { start: 6, end: 20, kind: 'performance', subject: 'center', framing: 'CU' }],
    graphics: [chart('late', 8, 12)]
  });
  assert.equal(inside.graphics.devices.length, 0);
  assert.equal(inside.warnings.filter((note) => /"late"/.test(note)).length, 1);
  // a big word that has not been sung yet is not on the screen, and its place is free until then
  const waiting = (second, key) => graphicsLib.prepareGraphics({
    duration: 14,
    cuts: [{ start: 0, end: 4, kind: 'performance', subject: 'center', framing: 'CU' }, { start: 4, end: 14, kind: 'story', subject: 'left' }],
    lines: [{ start: 1, end: second + 0.5, key, words: [{ text: 'say', start: 1, end: 1.4 }, { text: 'yes', start: second, end: second + 0.5 }] }],
    graphics: [{ id: 'yes', type: 'display', line: 0, style: 'condensed', rows: [{ text: 'YES', size: 'xl' }], start: 1, end: 12 }]
  }).graphics;
  const later = waiting(6, 0);
  assert.equal(later.devices[0].first, 6, 'the word comes at 6 s');
  assert.equal(state.frameState(later, 3).devices.length, 0, 'before it nothing of the display is on the screen');
  assert.equal(state.frameState(later, 7).devices.length, 1);
  assertNoCover(later, 'a word that waits');
  const now = waiting(1.5, 1);
  assert.equal(now.devices[0].first, undefined, 'a word that comes at once needs no waiting');
  assert.equal(now.devices[0].appear, 1.5);
}

// The key of a device (WP44, the planner): the index of a word in its line; the device appears on that word. Without it the key word of the line
// holds, as it always did (the fingerprint of the style hud keeps that for whole films).
function testDeviceKey() {
  // one line of five words at 10.0, 10.6, 11.2, 11.8 and 12.4 s; the key word of the line is the second one
  const words = ['Every', 'night', 'they', 'count', 'forty'].map((text, index) => ({ text, start: 10 + index * 0.6, end: 10.45 + index * 0.6 }));
  const story = { duration: 30, cuts: [{ start: 0, end: 30, kind: 'story', subject: 'left' }], lines: [{ start: 10, end: 12.85, key: 1, words }, { start: 15, end: 16, key: 0, words: [{ text: 'Done', start: 15, end: 15.5 }] }] };
  const tag = (extra) => ({ id: 'k', type: 'tag', text: 'THE TAG', start: 9, end: 20, line: 0, ...extra });
  const planned = (graphics, extra = {}) => graphicsLib.prepareGraphics({ ...story, ...extra, graphics });
  const one = (extra) => planned([tag(extra)]).graphics.devices[0];
  const normalised = (extra) => graphicsLib.normalizeGraphics({ ...story, graphics: [tag(extra)] }).graphics.graphics[0];

  // normalisation: a whole number from 0, rounded, limited; anything else is left out (and so is a key without a line)
  assert.equal(normalised({ key: 3 }).key, 3);
  assert.equal(normalised({ key: 0 }).key, 0);
  assert.equal(normalised({ key: 2.6 }).key, 3, 'rounded');
  assert.equal(normalised({ key: '2' }).key, 2, 'a number as text');
  assert.equal(normalised({ key: -4 }).key, 0, 'not below the first word');
  assert.equal(normalised({ key: 1e9 }).key, graphicsLib.MAX.words - 1, 'not beyond what a line may hold');
  for (const nothing of [undefined, null, '', 'x', true, false, {}, [], [3], { index: 3 }, NaN, Infinity]) assert.equal('key' in normalised({ key: nothing }), false, `key ${JSON.stringify(nothing)}`);
  assert.equal(normalised({ key: 3, line: null }).key, undefined, 'a device without a line has no word to point at');
  assert.equal(normalised({ key: 3, line: 7 }).key, undefined, 'and neither has one whose line does not exist');
  assert.equal(normalised({ key: 3, line: 7 }).line, null);
  assert.equal('key' in normalised({}), false, 'a device without a key does not get one');
  assert.deepEqual(Object.keys(normalised({})), ['id', 'line', 'start', 'end', 'type', 'position', 'text'], 'and is as it was');

  // when it appears: on its own word, not before its start
  assert.equal(one({}).appear, 10.6, 'without a key: the key word of the line');
  assert.equal(one({ key: undefined }).appear, 10.6);
  assert.equal(one({ key: 1 }).appear, 10.6, 'the same word as the line names, the same time');
  const at = [0, 1, 2, 3, 4].map((key) => one({ key }).appear);
  assert.deepEqual(at, [10, 10.6, 11.2, 11.8, 12.4], 'every word of the line');
  assert.equal(one({ key: 9 }).appear, 12.4, 'beyond the last word means the last word');
  assert.equal(one({ key: 0, start: 11 }).appear, 11, 'not before the start of the device');
  assert.equal(one({ key: 2, start: 10.2 }).appear, 11.2);
  assert.equal(one({ key: 4, end: 12.6 }).appear, 9, 'a word so late that the device would be there for less than half a second: it appears at its start');
  assert.equal(one({ key: 4, end: 12.95 }).appear, 12.4, 'and with half a second left it waits for the word');
  assert.equal(one({ key: 3, line: null }).appear, 9, 'without a line it appears at its start whatever its key');
  assert.equal(one({ line: 1, key: 0 }).appear, 15, 'a line of one word');
  assert.equal(one({ line: 1, key: 4, end: 16.5 }).appear, 15, 'a key beyond the words of a short line: its last word');

  // three devices on one line, each on its word: they come in the order of their words
  const three = planned([
    tag({ id: 'a', key: 4, position: 'bottom-right' }),
    tag({ id: 'b', key: 0, position: 'top-right' }),
    tag({ id: 'c', key: 2, position: 'right' })
  ]);
  assert.deepEqual(three.graphics.devices.map((device) => [device.id, device.appear]), [['b', 10], ['c', 11.2], ['a', 12.4]]);
  assert.deepEqual(three.warnings.filter((note) => !/^the HUD has no/.test(note)), [], 'and nothing is left out or moved');

  // a big word: the block comes on the word of the device when the words of its rows are not in the line, a word of the line comes when it is sung
  const display = (extra) => one({ type: 'display', style: 'condensed', rows: [{ text: 'NOBODY', size: 'xl' }], text: undefined, position: 'top-right', ...extra });
  const block = display({ key: 2 });
  assert.equal(block.appear, 11.2);
  assert.deepEqual(block.wordTimes, [[11.2]], 'a word that is not in the line comes with the device');
  assert.equal(display({}).appear, 10.6, 'and on the key word of the line without a key');
  const sung = display({ key: 0, rows: [{ text: 'FORTY', size: 'xl' }] });
  assert.equal(sung.appear, 10);
  assert.deepEqual(sung.wordTimes, [[12.4]], 'a word of the line comes when it is sung');
  assert.equal(sung.first, 12.4, 'and until then nothing of the display is on the screen');

  // a film with a key on every device: the layout takes nothing from anyone, the data is a function of the input, and the same frames come from
  // every chunk (the key is only read when the time of appearing is worked out)
  const plan = graphicsLib.demoGraphics({ duration: 128.4 });
  const wordCount = (device) => plan.lines[device.line].words.length;
  const keyedPlan = { ...plan, graphics: plan.graphics.map((device, index) => (device.line === null ? device : { ...device, key: (index * 2 + 1) % wordCount(device) })) };
  const plain = graphicsLib.prepareGraphics(plan);
  const keyed = graphicsLib.prepareGraphics(keyedPlan);
  const appearOf = (prepared) => Object.fromEntries(prepared.graphics.devices.map((device) => [device.id, device.appear]));
  const moved = Object.keys(appearOf(plain)).filter((id) => appearOf(keyed)[id] !== undefined && appearOf(keyed)[id] !== appearOf(plain)[id]);
  assert.ok(moved.length >= 8, `${moved.length} devices of the demo appear on another word`);
  assert.equal(JSON.stringify(graphicsLib.prepareGraphics(keyedPlan).graphics), JSON.stringify(keyed.graphics), 'the layout is a function of the data');
  assertNoCover(keyed.graphics, 'the example with keys');
  assertSameInChunks(keyed.graphics, 'the example with keys');
  checkPurity(keyed.graphics);
  checkChunkIdentity(keyed.graphics);
  // the plan without keys is the plan that was: the resolved devices carry no key
  assert.ok(plain.graphics.devices.every((device) => !('key' in device)));
  assert.ok(keyed.graphics.devices.some((device) => 'key' in device));
}

function testChartOutline() {
  const T = view.SIZES.chart;
  // the outline of the panel on the screen, with matrices as the browser does it: perspective(P) rotateY(a) rotateZ(b), round the middle of the panel
  const times = (a, b) => a.map((row) => b[0].map((_cell, j) => row.reduce((sum, value, k) => sum + value * b[k][j], 0)));
  const rad = (degrees) => (degrees * Math.PI) / 180;
  const matrix = times(
    [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, -1 / T.perspective, 1]],
    times(
      [[Math.cos(rad(T.rotateY)), 0, Math.sin(rad(T.rotateY)), 0], [0, 1, 0, 0], [-Math.sin(rad(T.rotateY)), 0, Math.cos(rad(T.rotateY)), 0], [0, 0, 0, 1]],
      [[Math.cos(rad(T.rotateZ)), -Math.sin(rad(T.rotateZ)), 0, 0], [Math.sin(rad(T.rotateZ)), Math.cos(rad(T.rotateZ)), 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
    )
  );
  const project = (x, y) => {
    const [px, py, , pw] = matrix.map((row) => row[0] * x + row[1] * y + row[3]);
    return [px / pw, py / pw];
  };
  const [tl, tr, br, bl] = [project(-T.w / 2, -T.h / 2), project(T.w / 2, -T.h / 2), project(T.w / 2, T.h / 2), project(-T.w / 2, T.h / 2)];
  // the tilt is clearly there, as on the reference: the right edge (nearer) is much higher than the left one and the top edge climbs to the right
  const ratio = (br[1] - tr[1]) / (bl[1] - tl[1]);
  assert.ok(ratio >= 1.3 && ratio <= 1.6, `the right edge is ${ratio.toFixed(2)} times as high as the left one`);
  assert.ok((tr[1] - tl[1]) / (tr[0] - tl[0]) < -0.15, 'the top edge climbs');
  assert.ok((br[1] - bl[1]) / (br[0] - bl[0]) > 0 && (br[1] - bl[1]) / (br[0] - bl[0]) < 0.1, 'the bottom edge falls a little');
  // what the layout holds is that outline, not the panel before the tilt
  const g = graphicsLib.prepareGraphics({ duration: 12, cuts: [{ start: 0, end: 12, kind: 'story', subject: 'left' }], graphics: [{ id: 'chart', type: 'chart', ...SAMPLES.chart, start: 1, end: 9 }] }).graphics;
  const device = g.devices[0];
  const scale = device.scale || 1;
  const centreX = device.box.x + device.box.w / 2;
  const centreY = device.box.y + device.box.h / 2;
  assert.equal(device.box.w, T.w);
  assert.equal(device.box.h, T.h);
  const xs = [tl, tr, br, bl].map((corner) => centreX + corner[0] * scale);
  const ys = [tl, tr, br, bl].map((corner) => centreY + corner[1] * scale);
  near(device.rect.x, Math.min(...xs), 2, 'the left edge of the outline');
  near(device.rect.x + device.rect.w, Math.max(...xs), 2, 'the right edge of the outline');
  near(device.rect.y, Math.min(...ys), 2, 'the top of the outline');
  near(device.rect.y + device.rect.h, Math.max(...ys), 2, 'the bottom of the outline');
  assert.ok(device.rect.w > T.w * scale * 0.85 && device.rect.h > T.h * scale, 'the outline is higher than the panel and a little narrower');
  // it stands inside the frame of the HUD and not on the figure
  assert.ok(device.rect.x >= graphicsLib.SAFE.left - 24 && device.rect.x + device.rect.w <= graphicsLib.SAFE.right + 24);
  assert.ok(device.rect.y >= graphicsLib.SAFE.top - 8 && device.rect.y + device.rect.h <= graphicsLib.SAFE.bottom + 8);
  assertNoCover(g, 'the chart');
  // the view draws the panel at its natural size and tilts it
  const html = view.devicesHtml(state.frameState(g, 5).devices, 'left');
  assert.ok(html.includes(`perspective(${T.perspective}px) rotateY(${T.rotateY}deg) rotateZ(${T.rotateZ}deg)`), 'the chart is tilted');
  assert.ok(html.includes(`width:${T.w}px;height:${T.h}px`), 'at its natural size');
}

/* ---------- chunks ---------- */

function testChunks() {
  const check = (g, endcardSeconds) => {
    const chunks = chunksLib.planChunks(g, { endcardSeconds });
    const firstFrame = Math.round(g.cuts[0].start * FPS);
    assert.equal(chunks[0].startFrame, firstFrame);
    assert.equal(chunks[chunks.length - 1].endFrame, g.endFrame);
    const cutFrames = new Set(g.cuts.map((cut) => Math.round(cut.start * FPS)).concat([g.endFrame]));
    chunks.forEach((chunk, index) => {
      assert.equal(chunk.index, index);
      assert.ok(chunk.pageFrames / FPS <= 24 + 1e-9, `chunk ${index + 1} is ${chunk.pageFrames / FPS} s`);
      assert.equal(chunk.frames, chunk.endFrame - chunk.startFrame);
      near(chunk.seconds, chunk.frames / FPS, 1e-9);
      assert.equal(chunk.last, index === chunks.length - 1);
      assert.equal(chunk.pageFrames, chunk.frames + (chunk.last ? Math.round(endcardSeconds * FPS) : 0), 'only the last chunk holds the end card');
      near(chunk.duration, chunk.pageFrames / FPS, 1e-9);
      assert.equal(chunk.clipSeconds, chunk.seconds, 'the footage is as long as the film of the chunk, without the card');
      if (index > 0) assert.equal(chunk.startFrame, chunks[index - 1].endFrame, 'chunks follow each other without a gap');
      if (chunk.onCut) {
        assert.ok(cutFrames.has(chunk.startFrame) && cutFrames.has(chunk.endFrame), `chunk ${index + 1} begins and ends on a cut`);
      }
    });
    return chunks;
  };
  const long = check(demo, demo.endcard.seconds);
  assert.ok(long.every((chunk) => chunk.onCut), 'the example is cut on cuts only');
  assert.ok(long.length >= 6 && long.length <= 8);
  // the pieces are about the same length (the target is 20 s)
  for (const chunk of long.slice(0, -1)) assert.ok(chunk.seconds >= 14 && chunk.seconds <= 24, `a chunk of ${chunk.seconds} s`);
  // without the card the last chunk is plain
  const plain = check(demo, 0);
  assert.equal(plain[plain.length - 1].duration, plain[plain.length - 1].seconds);
  // a film that is shorter than the limit is one chunk
  const short = check(graphicsLib.prepareGraphics(graphicsLib.demoGraphics({ duration: 12 })).graphics, 3);
  assert.equal(short.length, 1);
  assert.equal(short[0].last, true);
  // a card that makes the last chunk too long moves a cut: the card never goes over 24 s
  const edge = graphicsLib.prepareGraphics({ duration: 22, cuts: [{ start: 0, end: 11 }, { start: 11, end: 22 }] }).graphics;
  const edgeChunks = check(edge, 5);
  assert.equal(edgeChunks.length, 2, '22 s and a card of 5 s do not fit in one chunk');
  // one cut that is much longer than the limit is cut in the middle
  const single = graphicsLib.prepareGraphics({ duration: 70, cuts: [{ start: 0, end: 70 }] }).graphics;
  const singleChunks = check(single, 0);
  assert.ok(singleChunks.length >= 3);
  assert.equal(singleChunks[0].onCut, false);
  // all frames of the film are in exactly one chunk
  assert.equal(long.reduce((sum, chunk) => sum + chunk.frames, 0), demo.endFrame - Math.round(demo.cuts[0].start * FPS));
}

/* ---------- the page of a chunk ---------- */

function testPage() {
  const chunks = chunksLib.planChunks(demo, { endcardSeconds: demo.endcard.seconds });
  const chunk = chunks[1];
  const html = composition.buildChunkHtml({ graphics: demo, chunk, clipFile: 'video-0007.mp4', options: { karaoke: true, endcard: true } });
  const bytes = Buffer.byteLength(html, 'utf8');
  assert.ok(bytes < 1.8 * 1024 * 1024, `the page is ${bytes} bytes`);
  assert.ok(bytes < 2 * 1024 * 1024, 'and so inside the limit of the render node');
  assert.match(html, /<div id="main-composition" data-composition-id="main" data-width="1920" data-height="1080" data-start="0" data-duration="[\d.]+" data-fps="24"/);
  assert.ok(html.includes(`data-duration="${composition.durationAttr(chunk.duration)}"`), 'the length of the page is the length of the chunk (a hundredth of a frame short of the whole frames)');
  assert.ok(Number(composition.durationAttr(chunk.duration)) * FPS > chunk.pageFrames - 1 && Number(composition.durationAttr(chunk.duration)) * FPS < chunk.pageFrames);
  assert.ok(html.includes('<video id="v1" class="clip" src="video-0007.mp4" muted playsinline data-start="0" data-duration="'), 'the footage is a file beside the page');
  assert.ok(html.includes(sceneLib.CSP_META), 'the policy of the render node');
  assert.ok(html.includes(`<script src="${sceneLib.GSAP_URL}"></script>`), 'GSAP from jsDelivr');
  assert.ok(html.includes('window.__timelines'), 'the timeline is registered');
  assert.ok(html.includes("window.__timelines['main']") || html.includes('window.__timelines["main"]'));
  assert.equal(motionHtml.checkComposition(html, 'landscape'), null, 'the check of the chat tool takes it');
  // the fonts are in the page, as data
  for (const font of composition.FONTS) assert.ok(html.includes(`font-family:'${font.family}';src:url(data:${font.mime};base64,`), `${font.family} is embedded`);
  assert.equal((html.match(/@font-face/g) || []).length, composition.FONTS.length);
  assert.ok(!/url\((?!data:)/.test(html.replace(/url\(#[^)]*\)/g, '')), 'no address in the style');
  // the data of the chunk
  const match = /window\.__HUD_DATA=(.*?);<\/script>/s.exec(html);
  const data = JSON.parse(match[1]);
  assert.equal(data.t0, chunk.start);
  near(data.duration, chunk.pageFrames / FPS, 1e-9);
  assert.deepEqual(data.options, { karaoke: true, endcard: true });
  assert.equal(data.graphics.resolved, true);
  assert.ok(data.graphics.cuts.length >= 1 && data.graphics.cuts.length < demo.cuts.length);
  assert.ok(data.graphics.cuts.every((cut) => cut.end > chunk.start && cut.start < chunk.start + chunk.duration), 'only the cuts of the chunk');
  assert.ok(html.includes('--acc:#3B82F6'), 'the accent colour');
  // the options travel
  const noKaraoke = composition.buildChunkHtml({ graphics: demo, chunk, clipFile: 'a.mp4', options: { karaoke: false, endcard: false } });
  assert.deepEqual(JSON.parse(/window\.__HUD_DATA=(.*?);<\/script>/s.exec(noKaraoke)[1]).options, { karaoke: false, endcard: false });
  // the last chunk carries the card
  const last = chunks[chunks.length - 1];
  const lastData = JSON.parse(/window\.__HUD_DATA=(.*?);<\/script>/s.exec(composition.buildChunkHtml({ graphics: demo, chunk: last, clipFile: 'a.mp4' }))[1]);
  assert.deepEqual(lastData.graphics.endcard, demo.endcard);
  near(lastData.duration, last.seconds + demo.endcard.seconds, 1e-9);
  // nothing in the data can end the script element or the line
  const encoded = composition.jsonForScript({ a: '</script><b>&x\u2028\u2029"</b>' });
  assert.ok(!/[<>&\u2028\u2029]/.test(encoded), encoded);
  assert.deepEqual(JSON.parse(encoded), { a: '</script><b>&x\u2028\u2029"</b>' });
  // the name of the footage is a plain file name
  for (const bad of ['../x.mp4', 'a b.mp4', 'x"onerror="y', '', 'a/b.mp4']) assert.throws(() => composition.buildChunkHtml({ graphics: demo, chunk, clipFile: bad }), /plain file name/, JSON.stringify(bad));
  // too much data is refused with a code that the node knows
  const fat = { ...demo, hud: { ...demo.hud, ticker: ['x'.repeat(2 * 1024 * 1024)] } };
  const failure = (() => {
    try {
      composition.buildChunkHtml({ graphics: fat, chunk, clipFile: 'a.mp4' });
    } catch (err) {
      return err;
    }
    return null;
  })();
  assert.equal(failure && failure.code, 'HUD_CHUNK_TOO_LARGE');
  assert.ok(failure.data.kb > failure.data.limit);
  // the runtime and the scripts do not carry a closing script tag (the check is in the builder)
  for (const file of ['state.js', 'view.js', 'runtime.browser.js']) assert.ok(!/<\/script/i.test(fs.readFileSync(path.join(root, 'lib', 'music-video-hud', file), 'utf8')), file);
}

// The page runs: state.js, view.js and the runtime in a made-up browser draw frames (the render of a chunk calls the same function for every frame).
function testRuntime() {
  const chunk = chunksLib.planChunks(demo, { endcardSeconds: 3 })[1];
  const html = composition.buildChunkHtml({ graphics: demo, chunk, clipFile: 'a.mp4' });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((entry) => entry[1]);
  assert.equal(scripts.length, 5, 'data, themes, state, view and runtime');
  const layers = {};
  const element = (id) => {
    const el = { id, innerHTML: '', className: '', style: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, getAttribute(name) { return this.attributes[name] || null; } };
    layers[id] = el;
    return el;
  };
  const ticks = [];
  const timeline = { to(target, options) { ticks.push({ target, options }); return timeline; } };
  const sandbox = {
    document: { getElementById: (id) => layers[id] || element(id) },
    gsap: { timeline: (options) => { assert.equal(options.paused, true, 'the timeline is only a clock'); return timeline; } },
    console
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const script of scripts) vm.runInContext(script, sandbox, { filename: 'page-script.js' });
  assert.ok(sandbox.__timelines && sandbox.__timelines.main === timeline, 'the timeline of the page is registered as main');
  assert.equal(ticks.length, 1);
  near(ticks[0].options.duration, chunk.pageFrames / FPS, 1e-9, 'its length is the length of the chunk');
  assert.equal(ticks[0].options.ease, 'none');
  assert.equal(typeof sandbox.__hudRenderAt, 'function');
  assert.ok(layers['l-hud'].innerHTML.length > 500, 'the first frame is drawn at once');
  // the clock: every frame is drawn from the time it is told
  const drawAt = (local) => {
    ticks[0].target.t = local;
    ticks[0].options.onUpdate();
    return { hud: layers['l-hud'].innerHTML, dev: layers['l-dev'].innerHTML, kar: layers['l-kar'].innerHTML, stage: layers.stage.attributes.style, cam: layers.cam.attributes.style };
  };
  const a = drawAt(3.5);
  assert.ok(a.hud.includes('BAR '), 'bar and beat are in the HUD');
  const again = drawAt(3.5);
  assert.deepEqual(again, a, 'the same time, the same frame');
  drawAt(9);
  assert.deepEqual(drawAt(3.5), a, 'also after other frames');
  assert.notEqual(drawAt(3.5 + 1 / FPS).hud, a.hud, 'the next frame is another one');
  for (const local of [0, 1.7, 5, 11.1, chunk.pageFrames / FPS - 1 / FPS]) {
    const frame = drawAt(local);
    assert.ok(!/<script|\son[a-z]+=|javascript:/i.test(frame.hud + frame.dev + frame.kar), 'the drawing makes no script and no handler');
    assert.ok(!/NaN|undefined|Infinity/.test(frame.hud + frame.dev + frame.kar + frame.stage + frame.cam), `no NaN in the frame at ${local}`);
  }
  // the last chunk draws the card
  const last = chunksLib.planChunks(demo, { endcardSeconds: 3 }).pop();
  const lastHtml = composition.buildChunkHtml({ graphics: demo, chunk: last, clipFile: 'a.mp4' });
  const lastLayers = {};
  const box = {
    document: { getElementById: (id) => lastLayers[id] || (lastLayers[id] = { id, innerHTML: '', className: '', style: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }) },
    gsap: { timeline: () => ({ to(target, options) { box.tick = { target, options }; return this; } }) },
    console
  };
  box.window = box;
  box.self = box;
  vm.createContext(box);
  for (const script of [...lastHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((entry) => entry[1])) vm.runInContext(script, box, { filename: 'last-page-script.js' });
  box.tick.target.t = last.seconds + 2.5;
  box.tick.options.onUpdate();
  assert.ok(lastLayers['l-end'].innerHTML.includes(demo.endcard.title), 'the end card shows its title');
  assert.equal(lastLayers['l-hud'].innerHTML, '', 'and no HUD');
}

/* ---------- the post-pass ---------- */

const flag = (args, name) => args[args.indexOf(name) + 1];

function testPostArgs() {
  // the glitch windows: the cuts that ask for it and the strong hits, 3 to 5 frames, on the time line of the film
  const g = graphicsLib.prepareGraphics({
    duration: 40,
    cuts: [
      { start: 2, end: 10, transition: 'cut' },
      { start: 10, end: 20, transition: 'glitch' },
      { start: 20, end: 30, transition: 'wipe' },
      { start: 30, end: 40, transition: 'glitch' }
    ],
    music: { bpm: 120, beats: [2, 2.5, 3], hits: [{ t: 5, strength: 0.9 }, { t: 6, strength: 0.79 }, { t: 7, strength: 1 }, { t: 7.1, strength: 0.85 }, { t: 33, strength: 0.3 }, { t: 1, strength: 1 }], energy: [] }
  }).graphics;
  assert.equal(g.start, 2);
  const windows = post.glitchWindows(g, { glitch: 0.6 });
  const starts = windows.map((item) => item.start);
  // film time = song time - the start of the first cut
  near(starts[0], 3, 1e-9, 'the hit at 5 s is at 3 s of the film');
  assert.ok(starts.some((time) => Math.abs(time - 8) < 1e-9), 'the glitch cut at 10 s');
  assert.ok(starts.some((time) => Math.abs(time - 28) < 1e-9), 'the glitch cut at 30 s');
  assert.ok(starts.some((time) => Math.abs(time - 5) < 1e-9), 'the hit of strength 1');
  assert.ok(!starts.some((time) => Math.abs(time - 4) < 1e-9), 'a hit of 0.79 gives none');
  assert.ok(!starts.some((time) => Math.abs(time - 31) < 1e-9), 'a weak hit gives none');
  assert.ok(!starts.some((time) => time < 0), 'a hit before the first cut gives none');
  assert.ok(!starts.some((time) => Math.abs(time - 18) < 1e-9), 'a wipe is no glitch');
  for (const item of windows) {
    const frames = Math.round((item.end - item.start) * FPS);
    assert.ok(frames >= 3 && frames <= 8, `a window of ${frames} frames`);
    near(item.start * FPS, Math.round(item.start * FPS), 1e-9);
    assert.ok(item.strength > 0 && item.strength <= 0.6 + 1e-9);
  }
  // the hits at 7 s and 7.1 s touch: one window
  assert.equal(windows.filter((item) => item.start >= 4.9 && item.start < 5.5).length, 1);
  for (let i = 1; i < windows.length; i += 1) assert.ok(windows[i].start >= windows[i - 1].end, 'windows do not overlap');
  // a stronger hit lasts longer; 0.9 is 4 frames, 1 is 5
  const hit = (strength) => {
    const one = graphicsLib.prepareGraphics({ duration: 20, cuts: [{ start: 0, end: 20 }], music: { bpm: 120, beats: [1], hits: [{ t: 4, strength }], energy: [] } }).graphics;
    const [window] = post.glitchWindows(one, { glitch: 1 });
    return Math.round((window.end - window.start) * FPS);
  };
  assert.equal(hit(0.8), 3);
  assert.equal(hit(1), 5);
  assert.ok(hit(0.9) >= 3 && hit(0.9) <= 5);
  // the strength of the node is the strength of the glitch, and 0 means none
  assert.deepEqual(post.glitchWindows(g, { glitch: 0 }), []);
  assert.ok(post.glitchWindows(g, { glitch: 1 })[0].strength > post.glitchWindows(g, { glitch: 0.3 })[0].strength);
  assert.ok(post.glitchWindows(g, { glitch: 7 }).every((item) => item.strength <= 1), 'clamped');
  // a hundred glitch cuts do not make an endless command
  const many = graphicsLib.prepareGraphics({ duration: 600, cuts: Array.from({ length: 500 }, (_item, i) => ({ start: i * 1.2, end: i * 1.2 + 1.2, transition: 'glitch' })) }).graphics;
  assert.ok(post.glitchWindows(many, { glitch: 1 }).length <= post.MAX_WINDOWS);

  // the command
  const built = post.buildPostArgs({ listFile: '/s/chunks.txt', songFile: '/s/song.mp3', outFile: '/s/film.mp4', graphics: g, params: { grain: 0.35, glitch: 0.6 }, endcardSeconds: 3 });
  const { args } = built;
  assert.equal(built.frames, (g.endFrame - 2 * FPS) + 3 * FPS, 'the film and the card');
  near(built.seconds, 38 + 3, 1e-9);
  assert.deepEqual(args.slice(args.indexOf('-f'), args.indexOf('-f') + 6), ['-f', 'concat', '-safe', '0', '-i', '/s/chunks.txt']);
  assert.equal(args[args.indexOf('/s/song.mp3') - 1], '-i');
  assert.equal(args[args.length - 1], '/s/film.mp4');
  // the video: H.264 CRF 17, yuv420p, BT.709 and tagged
  assert.equal(flag(args, '-c:v'), 'libx264');
  assert.equal(flag(args, '-crf'), '17');
  assert.equal(flag(args, '-pix_fmt'), 'yuv420p');
  assert.equal(flag(args, '-colorspace'), 'bt709');
  assert.equal(flag(args, '-color_primaries'), 'bt709');
  assert.equal(flag(args, '-color_trc'), 'bt709');
  assert.equal(flag(args, '-color_range'), 'tv');
  assert.equal(flag(args, '-r'), '24');
  assert.equal(flag(args, '-movflags'), '+faststart');
  assert.equal(flag(args, '-frames:v'), String(built.frames));
  assert.ok(built.filter.includes('scale=in_color_matrix=bt709:in_range=tv:out_color_matrix=bt709:out_range=tv'), 'the colours are converted to BT.709 (a chunk that is BT.709 is left as it is)');
  assert.ok(built.filter.includes('setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv'), 'every frame carries the tags (the encoder takes the primaries and the transfer from the frames)');
  // other tags are converted from what they say; untagged is BT.709 (swscale would guess BT.601)
  const tagged = (inputColor) => post.buildPostArgs({ listFile: 'l', songFile: 's', outFile: 'o', graphics: g, params: {}, inputColor }).filter;
  assert.ok(tagged({ color_space: 'smpte170m', color_range: 'pc' }).includes('in_color_matrix=smpte170m:in_range=pc:out_color_matrix=bt709:out_range=tv'));
  assert.ok(tagged({ color_space: 'bt470bg' }).includes('in_color_matrix=bt470:in_range=tv'));
  assert.ok(tagged({ color_space: 'unknown', color_range: 'unknown' }).includes('in_color_matrix=bt709:in_range=tv'));
  assert.ok(tagged({}).includes('in_color_matrix=bt709:in_range=tv'));
  assert.deepEqual(post.inputColour({ space: 'bt2020nc', range: 'tv' }), { matrix: 'bt2020', range: 'tv' });
  assert.ok(built.filter.includes('scale=1920:1080'), 'and the size is the size');
  // the audio: the song from the start of the first cut for the length of the film, AAC 256k, silence up to the end of the card
  assert.equal(flag(args, '-c:a'), 'aac');
  assert.equal(flag(args, '-b:a'), '256k');
  assert.equal(flag(args, '-ar'), '48000');
  assert.ok(built.filter.includes('atrim=start=2:end=40'), built.filter);
  assert.ok(built.filter.includes('apad=whole_dur=41'), 'the sound is as long as the film and the card');
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4), ['-map', '[v]', '-map', '[a]']);
  // the glitch is in the graph, each group with its own windows; the grain and the vignette are there
  assert.ok(built.filter.includes('rgbashift='), 'RGB shift');
  assert.ok(built.filter.includes('overlay='), 'the displaced strip');
  assert.ok(built.filter.includes("enable='gte(t,"), 'only in the windows');
  assert.ok(built.filter.includes('noise='), 'grain');
  assert.ok(built.filter.includes('vignette='), 'vignette');
  for (const item of built.windows) assert.ok(built.filter.includes(`gte(t,${Math.round(item.start * 10000) / 10000})*lt(t,${Math.round(item.end * 10000) / 10000})`), `window ${item.start} is in the graph`);
  // no grain without grain, no glitch without glitch, no card without a card
  const quiet = post.buildPostArgs({ listFile: 'l', songFile: 's', outFile: 'o', graphics: g, params: { grain: 0, glitch: 0 }, endcardSeconds: 0 });
  assert.ok(!quiet.filter.includes('noise='));
  assert.ok(!quiet.filter.includes('rgbashift='));
  assert.ok(quiet.filter.includes('apad=whole_dur=38'));
  assert.equal(quiet.frames, g.endFrame - 2 * FPS);
  // stronger grain is more noise
  const noiseOf = (grain) => Number(/noise=c0s=(\d+)/.exec(post.buildPostArgs({ listFile: 'l', songFile: 's', outFile: 'o', graphics: g, params: { grain, glitch: 0 } }).filter)[1]);
  assert.ok(noiseOf(1) > noiseOf(0.35) && noiseOf(0.35) > 0 && noiseOf(0.05) >= 0);
  // a path with a quote in a list file
  assert.equal(post.concatListText(["/a/b'c.mp4", '/a/d.mp4']), "file '/a/b'\\''c.mp4'\nfile '/a/d.mp4'\n");
}

function testVerify() {
  const good = {
    streams: [
      { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1920, height: 1080, r_frame_rate: '24/1', nb_frames: '984', color_space: 'bt709', color_primaries: 'bt709', color_transfer: 'bt709', color_range: 'tv' },
      { codec_type: 'audio', codec_name: 'aac' }
    ],
    format: { duration: '41.000000' }
  };
  assert.deepEqual(post.verifyOutput(good, { frames: 984, seconds: 41 }), []);
  const broken = (change) => post.verifyOutput(JSON.parse(JSON.stringify({ ...good, streams: [{ ...good.streams[0], ...change }, good.streams[1]] })), { frames: 984, seconds: 41 });
  assert.match(broken({ color_space: undefined }).join(), /color_space is not set/);
  assert.match(broken({ color_space: 'bt601' }).join(), /color_space is bt601/);
  assert.match(broken({ color_transfer: 'smpte170m' }).join(), /color_transfer/);
  assert.match(broken({ color_primaries: 'bt470bg' }).join(), /color_primaries/);
  assert.match(broken({ color_range: 'pc' }).join(), /color_range is pc/);
  assert.match(broken({ r_frame_rate: '30/1' }).join(), /frame rate 30\/1/);
  assert.match(broken({ width: 1280, height: 720 }).join(), /size 1280x720/);
  assert.match(broken({ pix_fmt: 'yuv444p' }).join(), /pixel format/);
  assert.match(broken({ codec_name: 'hevc' }).join(), /video codec hevc/);
  assert.match(broken({ nb_frames: '900' }).join(), /900 frames, not 984/);
  assert.deepEqual(broken({ nb_frames: '985' }), [], 'one frame of tolerance');
  assert.match(post.verifyOutput({ ...good, format: { duration: '43.5' } }, { frames: 984, seconds: 41 }).join(), /length 43\.500 s/);
  assert.match(post.verifyOutput({ streams: [good.streams[0]], format: good.format }, { seconds: 41 }).join(), /no audio stream/);
  assert.match(post.verifyOutput({ streams: [good.streams[0], { codec_type: 'audio', codec_name: 'mp3' }], format: good.format }, {}).join(), /audio codec mp3/);
  assert.deepEqual(post.verifyOutput({ streams: [], format: {} }, {}), ['no video stream']);
  assert.deepEqual(post.verifyOutput(null, {}), ['no video stream']);
}

function testSheetAndClipArgs() {
  const sheet = post.contactSheetArgs({ inputFile: '/s/film.mp4', outFile: '/s/sheet.png', frames: 984 });
  assert.equal(sheet.picks.length, 12);
  assert.ok(sheet.picks.every((pick, index) => pick >= 0 && pick < 984 && (index === 0 || pick > sheet.picks[index - 1])), 'twelve frames spread over the film');
  assert.ok(sheet.picks[0] < 984 / 12 && sheet.picks[11] > 984 - 984 / 12);
  assert.ok(sheet.args.join(' ').includes('tile=4x3'));
  assert.equal(sheet.args[sheet.args.length - 1], '/s/sheet.png');
  // a film of 5 frames has no twelve different ones: the same frame is not asked twice
  const few = post.contactSheetArgs({ inputFile: 'a', outFile: 'b', frames: 5 });
  assert.ok(new Set(few.picks).size <= 5 && few.picks.every((pick) => pick >= 0 && pick < 5));
  assert.ok(few.args.join(' ').includes("select='eq(n,"));
  const clip = post.cutClipArgs({ inputFile: '/s/base.mp4', outFile: '/s/c1.mp4', start: 17.8333333, frames: 461 });
  assert.equal(flag(clip, '-ss'), '17.8333');
  assert.equal(flag(clip, '-frames:v'), '461');
  assert.ok(clip.includes('-an'), 'no sound');
  assert.equal(flag(clip, '-crf'), '16');
  assert.ok(flag(clip, '-vf').includes('scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080'));
  assert.ok(flag(clip, '-vf').includes('fps=24'));
  assert.ok(flag(clip, '-vf').includes('tpad=stop_mode=clone'), 'a base cut that ends early holds its last frame');
  assert.equal(flag(post.cutClipArgs({ inputFile: 'a', outFile: 'b', start: -3, frames: 0 }), '-ss'), '0');
  // the brightness: the mean of the samples inside a cut, without its first and last tenth of a second
  const samples = Buffer.alloc(2 * 4 * 20); // 20 s at 4 a second
  for (let i = 0; i < 80; i += 1) {
    samples[i * 2] = i < 40 ? 255 : 0; // left: bright for the first 10 s
    samples[i * 2 + 1] = 51; // right: 0.2 all the time
  }
  const luma = post.lumaPerCut(samples, [{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 9.9, end: 10.1 }], 0);
  assert.deepEqual(luma[0], [1, 0.2]);
  assert.deepEqual(luma[1], [0, 0.2]);
  assert.equal(luma[2].length, 2, 'a cut that is too short takes the nearest sample');
  // an offset of the first frame
  assert.deepEqual(post.lumaPerCut(samples, [{ start: 7, end: 9 }], 2)[0], [1, 0.2], 'the song time of the cut minus the song time of the first frame');
  assert.deepEqual(post.lumaPerCut(samples, [{ start: 12, end: 14 }], 2)[0], [0, 0.2]);
  assert.deepEqual(post.lumaPerCut(Buffer.alloc(0), [{ start: 0, end: 1 }], 0), [null]);
  assert.ok(post.lumaArgs({ inputFile: 'a', outFile: 'b' }).join(' ').includes('scale=2:1:flags=area'));
}

/* ---------- ffmpeg itself (when it is there) ---------- */

async function testFfmpegPostPass(binaries) {
  const { execFile } = require('child_process');
  const raw = (args) => new Promise((resolve, reject) => execFile(binaries.ffmpeg, args, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())));
  const run = (args) => raw(['-nostdin', '-v', 'error', '-y', ...args]);
  const probeOf = async (file) => JSON.parse(await new Promise((resolve, reject) => execFile(binaries.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], (err, stdout) => (err ? reject(err) : resolve(stdout)))));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hud-post-'));
  try {
    // two chunks as the render node returns them (24 fps, 1920x1080, tagged BT.709), a song of one tone, a plan with a glitch cut and a hit
    const chunkFiles = [];
    for (const [index, frames] of [[1, 36], [2, 48]]) {
      const file = path.join(dir, `chunk-${index}.mp4`);
      await run(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24', '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', file]);
      chunkFiles.push(file);
    }
    const song = path.join(dir, 'song.wav');
    await run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-ar', '44100', song]);
    const planInput = { duration: 3, cuts: [{ start: 0, end: 1.5 }, { start: 1.5, end: 3, transition: 'glitch' }], music: { bpm: 120, beats: [0.5, 1], hits: [{ t: 1, strength: 0.9 }], energy: [] } };
    const g = graphicsLib.prepareGraphics(planInput).graphics;
    fs.writeFileSync(path.join(dir, 'chunks.txt'), post.concatListText(chunkFiles));
    const out = path.join(dir, 'film.mp4');
    const built = post.buildPostArgs({ listFile: path.join(dir, 'chunks.txt'), songFile: song, outFile: out, graphics: g, params: { grain: 0.35, glitch: 0.6 }, endcardSeconds: 0.5 });
    assert.equal(built.windows.length, 2, 'the hit and the glitch cut');
    assert.equal(built.frames, 72 + 12, 'the film is 3 s, the card 0.5 s');
    await raw(built.args);
    const info = await probeOf(out);
    assert.deepEqual(post.verifyOutput(info, { frames: built.frames, seconds: built.seconds }), [], 'the real film passes the check');
    assert.equal(info.streams.find((stream) => stream.codec_type === 'video').color_transfer, 'bt709');
    assert.equal(info.streams.find((stream) => stream.codec_type === 'video').color_primaries, 'bt709');
    // chunks without any tag come out tagged all the same
    const untagged = [];
    for (const [index, frames] of [[1, 36], [2, 48]]) {
      const file = path.join(dir, `plain-${index}.mp4`);
      await run(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24', '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
      untagged.push(file);
    }
    fs.writeFileSync(path.join(dir, 'plain.txt'), post.concatListText(untagged));
    const plainOut = path.join(dir, 'plain-film.mp4');
    const plain = post.buildPostArgs({ listFile: path.join(dir, 'plain.txt'), songFile: song, outFile: plainOut, graphics: g, params: { grain: 0, glitch: 0 }, endcardSeconds: 0.5 });
    await raw(plain.args);
    assert.deepEqual(post.verifyOutput(await probeOf(plainOut), { frames: plain.frames, seconds: plain.seconds }), [], 'an untagged chunk is tagged BT.709 by the post-pass');
    const video = info.streams.find((stream) => stream.codec_type === 'video');
    assert.equal(video.nb_frames, '84');
    assert.equal(video.color_space, 'bt709');
    assert.equal(video.color_range, 'tv');
    assert.equal(info.streams.find((stream) => stream.codec_type === 'audio').codec_name, 'aac');
    near(Number(info.format.duration), 3.5, 0.06);
    // the second style: the same chunks, the prism and the splinters in the windows, the bloom, the grain of its own and a stronger vignette
    {
      const gk = graphicsLib.prepareGraphics(planInput, { theme: 'kuble' }).graphics;
      const kubleFile = path.join(dir, 'film-kuble.mp4');
      const builtK = post.buildPostArgs({ listFile: path.join(dir, 'chunks.txt'), songFile: song, outFile: kubleFile, graphics: gk, params: { grain: 0.35, glitch: 0.6 }, endcardSeconds: 0.5 });
      assert.deepEqual(builtK.windows, built.windows, 'the same windows');
      await raw(builtK.args);
      const infoK = await probeOf(kubleFile);
      assert.deepEqual(post.verifyOutput(infoK, { frames: builtK.frames, seconds: builtK.seconds }), [], 'the film of the second style passes the same check');
      assert.equal(infoK.streams.find((stream) => stream.codec_type === 'video').nb_frames, '84');
      // no glitch and no grain: the bloom and the vignette only (the graph has two sinks for the unused branches)
      const quietFile = path.join(dir, 'film-kuble-quiet.mp4');
      const quietK = post.buildPostArgs({ listFile: path.join(dir, 'chunks.txt'), songFile: song, outFile: quietFile, graphics: gk, params: { grain: 0, glitch: 0 }, endcardSeconds: 0 });
      await raw(quietK.args);
      assert.deepEqual(post.verifyOutput(await probeOf(quietFile), { frames: quietK.frames, seconds: quietK.seconds }), []);
      // the mean colour of a frame (a mean of the whole frame, in RGB): frame 60 is outside every window
      const meanOf = async (file, frame) => {
        const out = await new Promise((resolve, reject) => execFile(binaries.ffmpeg, ['-nostdin', '-v', 'error', '-i', file, '-vf', `select='eq(n,${frame})',scale=1:1:flags=area`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer' }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
        return [...out.subarray(0, 3)];
      };
      const [hudMean, kubleMean, quietMean] = [await meanOf(out, 60), await meanOf(kubleFile, 60), await meanOf(quietFile, 60)];
      // the plates keep their colours: the bloom is grey, the vignette darkens a little more than in the first style. Nothing is tinted or swapped.
      for (let channel = 0; channel < 3; channel += 1) {
        assert.ok(Math.abs(kubleMean[channel] - hudMean[channel]) <= 8, `channel ${channel}: ${kubleMean[channel]} against ${hudMean[channel]}`);
        assert.ok(Math.abs(quietMean[channel] - kubleMean[channel]) <= 6, `channel ${channel} without grain and glitch: ${quietMean[channel]} against ${kubleMean[channel]}`);
      }
    }
    // the contact sheet: 4 across, 3 down
    const sheetPath = path.join(dir, 'sheet.png');
    await raw(post.contactSheetArgs({ inputFile: out, outFile: sheetPath, frames: built.frames }).args);
    const png = fs.readFileSync(sheetPath);
    assert.equal(png.toString('latin1', 1, 4), 'PNG');
    assert.equal(png.readUInt32BE(16), 4 * 640 + 3 * 4);
    assert.equal(png.readUInt32BE(20), 3 * 360 + 2 * 4);
    // the brightness of a white picture and of a black one
    const bw = path.join(dir, 'bw.mp4');
    await run(['-f', 'lavfi', '-i', 'color=c=white:s=320x180:r=24', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24', '-filter_complex', '[0:v]trim=duration=2[a];[1:v]trim=duration=2[b];[a][b]concat=n=2:v=1[v]', '-map', '[v]', '-pix_fmt', 'yuv420p', bw]);
    const lumaFile = path.join(dir, 'luma.raw');
    await raw(post.lumaArgs({ inputFile: bw, outFile: lumaFile }));
    const values = post.lumaPerCut(fs.readFileSync(lumaFile), [{ start: 0, end: 2 }, { start: 2, end: 4 }], 0);
    assert.ok(values[0][0] > 0.9 && values[0][1] > 0.9, `white is bright: ${values[0]}`);
    assert.ok(values[1][0] < 0.1 && values[1][1] < 0.1, `black is dark: ${values[1]}`);
    // the footage of a chunk: exactly its frames, also when the base cut ends early (the last frame is held)
    const clipFile = path.join(dir, 'clip.mp4');
    await raw(post.cutClipArgs({ inputFile: bw, outFile: clipFile, start: 3, frames: 48 }));
    const clip = (await probeOf(clipFile)).streams[0];
    assert.equal(clip.nb_frames, '48');
    assert.equal(clip.width, 1920);
    assert.equal(clip.height, 1080);
    assert.equal(clip.r_frame_rate, '24/1');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ---------- the node ---------- */

async function testNode(binaries) {
  const store = require('../lib/store');
  const assets = require('../lib/nodes/assets');
  const registryModule = require('../lib/nodes/registry');
  const tools = require('../lib/tools');
  const rendernode = require('../lib/rendernode');
  const costs = require('../lib/costs');
  const { toneWav } = require('./support/explainer-media');
  const { execFile } = require('child_process');
  const real = registryModule.registry;
  const def = real.get('music_video.hud_render');

  /* the definition */
  assert.ok(def, 'the node is registered');
  assert.equal(def.category, 'edit-video');
  assert.equal(def.paid, false);
  assert.equal(def.cost.unit, 'local');
  assert.equal(def.async, true);
  assert.ok(def.timeoutMs >= 60 * 60 * 1000, 'a film of minutes with chunks in a line may take its time');
  const portsOf = (list) => list.map((port) => [port.id, port.type, Boolean(port.required)]);
  assert.deepEqual(portsOf(def.inputs), [['video', 'video', true], ['audio', 'audio', true], ['graphics', 'text', true]]);
  assert.deepEqual(portsOf(def.outputs), [['video', 'video', false], ['sheet', 'image', false]]);
  assert.deepEqual(real.normalizeParams(def, {}), { theme: 'auto', accent: '#3B82F6', karaoke: false, effects: 'strong', grain: 0.35, glitch: 0.6, endcard: true, quality: 'standard' });
  // WP45, WP49: the beat effects, strong by default; off makes the film of before (scripts/test-music-video-hud-effects.js)
  assert.deepEqual(def.params.find((param) => param.id === 'effects').options, ['off', 'subtle', 'strong', 'wild']);
  assert.deepEqual(real.checkParams(def, real.normalizeParams(def, { effects: 'wild' })), []);
  assert.deepEqual(real.checkParams(def, real.normalizeParams(def, { effects: 'loud' })), ['param effects: "loud" is not a valid option']);
  // WP49: a film with the effects on has a stamp, so a film drawn with the effects of WP45 is drawn once more (free); off keeps the key of before
  assert.equal(def.cacheStamp(real.normalizeParams(def, { effects: 'off' })), undefined);
  for (const level of ['subtle', 'strong', 'wild']) assert.deepEqual(def.cacheStamp(real.normalizeParams(def, { effects: level })), { effects: 'wp49' }, level);
  assert.equal(def.cacheStampAdopts, undefined, 'an entry from before the stamp is not taken');
  assert.deepEqual(def.params.find((param) => param.id === 'quality').options, ['draft', 'standard', 'high']);
  assert.deepEqual(def.params.find((param) => param.id === 'theme').options, ['auto', 'hud', 'kuble'], 'the styles: the one of the plan (auto) is the default, HUD Blue and Kuble force one');
  assert.equal(def.params.find((param) => param.id === 'theme').default, 'auto');
  assert.equal(real.normalizeParams(def, { theme: 'kuble' }).theme, 'kuble');
  assert.equal(real.normalizeParams(def, { theme: 'hud' }).theme, 'hud');
  assert.deepEqual(real.checkParams(def, real.normalizeParams(def, { theme: 'neon' })), ['param theme: "neon" is not a valid option']);
  assert.equal(def.params.find((param) => param.id === 'accent').kind, 'color');
  assert.equal(real.normalizeParams(def, { grain: 7 }).grain, 1);
  assert.equal(real.normalizeParams(def, { glitch: -2 }).glitch, 0);
  assert.equal(def.params.find((param) => param.id === 'karaoke').default, false, 'no burnt-in lyrics unless the person switches them on');
  assert.equal(real.normalizeParams(def, { karaoke: 'true' }).karaoke, true);
  assert.equal(registryModule.providerOf(def), null, 'it costs nothing: the render nodes are ours');
  assert.deepEqual(real.checkParams(def, real.normalizeParams(def, { quality: 'ultra' })), ['param quality: "ultra" is not a valid option']);
  // the render node and ffmpeg are needed
  const originals = { enabled: rendernode.enabled, listConfiguredNodes: rendernode.listConfiguredNodes, submit: rendernode.submit, recordCost: costs.recordCost };
  rendernode.enabled = () => false;
  assert.match(String(real.availability(def)), /No render node configured/);
  rendernode.enabled = () => true;
  assert.equal(real.availability(def), true);

  /* the render node, replaced: a plain video of the length the page says */
  const session = await store.createSession();
  const sessionId = session.id;
  const sessionDir = store.sessionAssetDir(sessionId);
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'hud-node-'));
  const ff = (args) => new Promise((resolve, reject) => execFile(binaries.ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args], (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())));
  const probe = async (file) =>
    JSON.parse(await new Promise((resolve, reject) => execFile(binaries.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], (err, stdout) => (err ? reject(err) : resolve(stdout)))));
  const submits = [];
  const plan = { fail: new Set(), short: new Set(), gone: new Set() }; // by the number of the job (from 1)
  let videoCounter = 0;
  rendernode.listConfiguredNodes = () => [{ id: 'rn1', name: 'Render 1', enabled: true }];
  rendernode.submit = async function submitDouble(html, quality, files, format, fps) {
    submits.push({ html, quality, files, format, fps, argumentCount: arguments.length, jobId: `job-${submits.length + 1}`, number: submits.length + 1 });
    return { jobId: `job-${submits.length}`, nodeId: 'rn1' };
  };
  costs.recordCost = async (entry) => entry;
  const durationOf = (html) => Number(/data-duration="([\d.]+)"/.exec(html)[1]);

  function makeCtx() {
    const controller = new AbortController();
    const logs = [];
    const waits = [];
    return {
      workflowId: 'wf-test',
      runId: 'r-test',
      nodeId: 'n1',
      sessionId,
      itemIndex: 0,
      user: 'tester',
      config: {},
      signal: controller.signal,
      controller,
      toolCtx: { nodeView: true, sessionId, config: {}, user: 'tester', emit() {}, signal: controller.signal },
      log: (line) => logs.push(line),
      saveOutputFile: (options) => assets.saveOutputFile(sessionId, options),
      withLocalSlot: (fn) => fn(),
      watchJob() {},
      waitForJob: async (job, options) => {
        waits.push({ job, options });
        const entry = submits.find((item) => item.jobId === job.jobId);
        assert.ok(entry, `a render was sent for ${job.jobId}`);
        if (plan.gone.has(entry.number)) throw new Error(`Timed out waiting for job ${job.jobId}`);
        if (plan.fail.has(entry.number)) throw new Error('Render-Exit 1: the browser of the render node crashed');
        const frames = Math.ceil(durationOf(entry.html) * FPS - 1e-9) - (plan.short.has(entry.number) ? 30 : 0);
        videoCounter += 1;
        const file = path.join(sessionDir, `fake-render-${videoCounter}.mp4`);
        await ff(['-f', 'lavfi', '-i', 'color=c=0x336699:s=320x180:r=24', '-frames:v', String(frames), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', file]);
        await store.completeAssetFile(sessionId, job.assetId, file, { cost: 0, duration: frames / FPS, ext: '.mp4', kind: 'video' });
        return [job.assetId];
      },
      logs,
      waits
    };
  }
  const exec = (ctx, inputs, raw = {}) => def.execute(ctx, inputs, real.normalizeParams(def, raw));
  const seed = async (file, ext, name) => {
    const saved = await store.saveAsset(sessionId, { kind: 'upload', buffer: await fsp.readFile(file), ext, prompt: name });
    return assets.valueFromAsset(sessionId, saved.id);
  };
  const textValue = (value) => ({ type: 'text', value });
  const baseVideo = async (seconds, colours = ['white', 'black']) => {
    const file = path.join(work, `base-${seconds}.mp4`);
    await ff(['-f', 'lavfi', '-i', `color=c=${colours[0]}:s=320x180:r=24`, '-f', 'lavfi', '-i', `color=c=${colours[1]}:s=320x180:r=24`, '-filter_complex', `[0:v]trim=duration=${seconds / 2}[a];[1:v]trim=duration=${seconds / 2}[b];[a][b]concat=n=2:v=1[v]`, '-map', '[v]', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', file]);
    return seed(file, '.mp4', `base ${seconds}`);
  };
  const songFile = path.join(work, 'song.wav');
  await fsp.writeFile(songFile, toneWav(40, 330));
  const song = await seed(songFile, '.wav', 'song');
  const silent = await (async () => {
    const file = path.join(work, 'silent.mp4');
    await ff(['-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24', '-frames:v', '24', '-pix_fmt', 'yuv420p', file]);
    return seed(file, '.mp4', 'no sound');
  })();
  const ledgerNow = async () => (await store.readLedger(sessionId)).filter((entry) => !entry.pending);
  const reset = () => {
    submits.length = 0;
    plan.fail.clear();
    plan.short.clear();
    plan.gone.clear();
  };
  const planFor = (seconds) => JSON.stringify(graphicsLib.demoGraphics({ duration: seconds }));

  try {
    /* the inputs are checked before anything is sent */
    {
      const video = await baseVideo(12);
      const before = (await ledgerNow()).length;
      for (const [text, code] of [['', 'HUD_GRAPHICS_INVALID'], ['{"cuts": []}', 'HUD_GRAPHICS_INVALID'], ['[1,2]', 'HUD_GRAPHICS_INVALID'], ['no json', 'HUD_GRAPHICS_INVALID']]) {
        reset();
        const err = await errorOf(exec(makeCtx(), { video, audio: song, graphics: textValue(text) }));
        assert.equal(err && err.code, code, JSON.stringify(text));
        assert.equal(submits.length, 0, 'nothing was sent');
      }
      reset();
      let err = await errorOf(exec(makeCtx(), { video, audio: song, graphics: textValue(planFor(30)) }));
      assert.equal(err && err.code, 'HUD_VIDEO_TOO_SHORT', 'a base cut of 12 s for a plan of 30 s');
      assert.equal(err.data.have, '12');
      assert.equal(err.data.need, '30');
      err = await errorOf(exec(makeCtx(), { video, audio: silent, graphics: textValue(planFor(12)) }));
      assert.equal(err && err.code, 'HUD_AUDIO_INVALID');
      assert.equal(submits.length, 0);
      assert.equal((await ledgerNow()).length, before, 'nothing is left behind');
    }

    /* no render node online: the dispatcher says so, the node says it in a code */
    {
      reset();
      const video = await baseVideo(12);
      const before = (await ledgerNow()).length;
      rendernode.submit = async () => {
        throw new rendernode.RenderNodeError('Kein Render-Node online.');
      };
      const err = await errorOf(exec(makeCtx(), { video, audio: song, graphics: textValue(planFor(12)) }));
      assert.equal(err && err.code, 'HUD_NO_RENDER_NODE');
      assert.equal((await ledgerNow()).length, before, 'the footage that was cut is removed again');
      // a render node whose service cannot take large files: its own code, no second try
      rendernode.submit = async () => {
        throw new rendernode.RenderNodeError('Render-Node Alpha unterstuetzt noch keine grossen Uploads - Node-Service aktualisieren.');
      };
      const old = await errorOf(exec(makeCtx(), { video, audio: song, graphics: textValue(planFor(12)) }));
      assert.equal(old && old.code, 'HUD_NODE_NO_UPLOADS');
      assert.equal((await ledgerNow()).length, before);
      rendernode.submit = async function submitDouble(html, quality, files, format, fps) {
        submits.push({ html, quality, files, format, fps, argumentCount: arguments.length, jobId: `job-${submits.length + 1}`, number: submits.length + 1 });
        return { jobId: `job-${submits.length}`, nodeId: 'rn1' };
      };
    }

    /* a chunk that fails twice ends the node; a render node that is gone is not asked again */
    {
      reset();
      const video = await baseVideo(12);
      const before = (await ledgerNow()).length;
      plan.fail.add(1).add(2);
      const ctx = makeCtx();
      const err = await errorOf(exec(ctx, { video, audio: song, graphics: textValue(planFor(12)) }));
      assert.equal(err && err.code, 'HUD_RENDER_FAILED');
      assert.deepEqual(err.data, { chunk: 1, count: 1 });
      assert.equal(submits.length, 2, 'one try and one more');
      assert.ok(ctx.logs.some((line) => /chunk 1 of 1: .*crashed.* once more/.test(line)), ctx.logs.join(' | '));
      assert.equal((await ledgerNow()).length, before, 'no footage and no chunk is left');
      reset();
      plan.gone.add(1);
      const gone = await errorOf(exec(makeCtx(), { video, audio: song, graphics: textValue(planFor(12)) }));
      assert.equal(gone && gone.code, 'HUD_RENDER_FAILED');
      assert.equal(submits.length, 1, 'a stuck render node is not asked a second time');
      // the end of the run: nothing is sent
      reset();
      const stopped = makeCtx();
      stopped.controller.abort();
      const aborted = await errorOf(exec(stopped, { video, audio: song, graphics: textValue(planFor(12)) }));
      assert.ok(aborted && (aborted.name === 'AbortError' || aborted.code === 'ABORT_ERR'), 'aborted');
      assert.equal(submits.length, 0);
      assert.equal((await ledgerNow()).length, before);
    }

    /* the whole run: two chunks, the first of them is returned too short and drawn again, the second one fails once */
    {
      reset();
      const seconds = 26;
      const video = await baseVideo(seconds + 2);
      const before = (await ledgerNow()).length;
      const g = graphicsLib.prepareGraphics(planFor(seconds)).graphics;
      const expected = chunksLib.planChunks(g, { endcardSeconds: g.endcard.seconds });
      assert.ok(expected.length >= 2, 'the film is cut into chunks');
      plan.short.add(1);
      plan.fail.add(2);
      const ctx = makeCtx();
      const started = Date.now();
      const result = await exec(ctx, { video, audio: song, graphics: textValue(planFor(seconds)) }, { quality: 'draft', accent: '#ff3366', grain: 0.4, glitch: 0.7 });
      const elapsed = (Date.now() - started) / 1000;
      assert.equal(submits.length, expected.length + 2, 'every chunk once, the two that went wrong once more');
      // the jobs: footage as an asset, 24 fps, the quality and the format of the node
      for (const entry of submits) {
        assert.equal(entry.fps, 24, 'fps 24 goes to the render node');
        assert.equal(entry.argumentCount, 6, 'fps and the owner (WP46: the person of the run decides whether an own computer may render it)');
        assert.equal(entry.quality, 'draft');
        assert.equal(entry.format, 'landscape');
        assert.equal(entry.files.files.length, 1, 'one asset: the footage');
        const clip = entry.files.files[0];
        assert.match(clip.filename, /\.mp4$/);
        assert.ok(entry.html.includes(`src="${clip.filename}"`), 'the page names the file the render node puts beside it');
        assert.equal(motionHtml.checkComposition(entry.html, 'landscape'), null);
        assert.ok(entry.html.includes('--acc:#FF3366'), 'the colour of the node replaces the colour of the plan');
        assert.ok(!entry.html.includes('data-theme') && !entry.html.includes("@font-face{font-family:'Montserrat'"), 'the first style: the page it always had');
        assert.ok(Buffer.byteLength(entry.html) < 1.8 * 1024 * 1024);
      }
      // the two chunks that went wrong are sent again with the same page and the same footage (in the order they failed)
      const again = submits.slice(expected.length);
      assert.deepEqual(again.map((entry) => entry.html).sort(), [submits[0].html, submits[1].html].sort());
      assert.deepEqual(again.map((entry) => entry.files.files[0].filename).sort(), [submits[0].files.files[0].filename, submits[1].files.files[0].filename].sort());
      // the footage was measured: the first half of the base cut is white, the second black (the data of the page carries it)
      const dataOf = (html) => JSON.parse(/window\.__HUD_DATA=(.*?);<\/script>/s.exec(html)[1]);
      const first = dataOf(submits[0].html);
      const lastData = dataOf(submits[expected.length - 1].html);
      assert.ok(first.graphics.cuts[0].luma && first.graphics.cuts[0].luma[0] > 0.9, `the white start is measured: ${JSON.stringify(first.graphics.cuts[0].luma)}`);
      assert.ok(lastData.graphics.cuts[lastData.graphics.cuts.length - 1].luma[0] < 0.1, 'and the black end');
      assert.equal(first.t0, expected[0].start);
      // the waits: with a time limit that grows with the place in the line, and the node is told how it goes
      assert.ok(ctx.waits.every((wait) => wait.options.timeoutMs >= 20 * 60 * 1000));
      assert.ok(ctx.waits[expected.length - 1].options.timeoutMs >= ctx.waits[0].options.timeoutMs);
      assert.ok(ctx.logs.some((line) => /once more/.test(line)));
      assert.ok(ctx.logs.some((line) => new RegExp(`${expected.length} chunks`).test(line)));
      // the result: a video and a contact sheet
      assert.deepEqual(Object.keys(result.variants[0]).sort(), ['sheet', 'video']);
      assert.equal(result.variants[0].video.type, 'video');
      assert.equal(result.variants[0].sheet.type, 'image');
      assert.equal(result.cost, undefined, 'free of charge');
      const film = assets.assetFilePath(result.variants[0].video);
      const info = await probe(film);
      const video0 = info.streams.find((stream) => stream.codec_type === 'video');
      const audio0 = info.streams.find((stream) => stream.codec_type === 'audio');
      const filmFrames = g.endFrame - Math.round(g.start * FPS) + Math.round(g.endcard.seconds * FPS);
      assert.deepEqual(post.verifyOutput(info, { frames: filmFrames, seconds: filmFrames / FPS }), []);
      assert.equal(video0.width, 1920);
      assert.equal(video0.height, 1080);
      assert.equal(video0.r_frame_rate, '24/1');
      assert.equal(Number(video0.nb_frames), filmFrames, 'the film and the card, to the frame');
      assert.equal(video0.color_space, 'bt709');
      assert.equal(video0.color_range, 'tv');
      assert.equal(audio0.codec_name, 'aac');
      near(Number(info.format.duration), filmFrames / FPS, 0.06);
      const sheetFile = assets.assetFilePath(result.variants[0].sheet);
      const png = await fsp.readFile(sheetFile);
      assert.equal(png.toString('latin1', 1, 4), 'PNG');
      assert.equal(png.readUInt32BE(16), 4 * 640 + 3 * 4);
      assert.equal(png.readUInt32BE(20), 3 * 360 + 2 * 4);
      // the ledger: the two results and nothing else (not the footage, not the chunks), and no scratch folder
      const after = await ledgerNow();
      assert.equal(after.length, before + 2, `two new assets, got ${after.length - before}`);
      assert.deepEqual((await fsp.readdir(sessionDir)).filter((name) => name.startsWith('.nodes-')), [], 'no scratch folder is left');
      assert.ok(elapsed < 150, `the run took ${elapsed} s`);
      console.log(`   node run: ${expected.length} chunks, ${filmFrames} frames, ${elapsed.toFixed(1)} s with ffmpeg`);
    }

    /* the style: the parameter reaches the page, the post-pass and the log; it wins over the field of the plan (as the accent does) */
    {
      reset();
      const video = await baseVideo(10);
      const ctx = makeCtx();
      const seconds = 8;
      const result = await exec(ctx, { video, audio: song, graphics: textValue(planFor(seconds)) }, { theme: 'kuble', quality: 'draft', glitch: 0.8 });
      assert.equal(submits.length, 1);
      const html = submits[0].html;
      assert.ok(html.includes('data-theme="kuble"') && html.includes("@font-face{font-family:'Montserrat'") && !html.includes("@font-face{font-family:'Anton'"), 'the faces and the style of Kuble');
      assert.ok(html.includes('--acc:#2E5CFF'), 'the accent that was left at its default is the blue of the style');
      assert.ok(Buffer.byteLength(html) < 1.8 * 1024 * 1024);
      assert.equal(motionHtml.checkComposition(html, 'landscape'), null);
      assert.equal(JSON.parse(/window\.__HUD_DATA=(.*?);<\/script>/s.exec(html)[1]).graphics.theme, 'kuble');
      assert.ok(ctx.logs.some((line) => /style kuble/.test(line)), ctx.logs.join(' | '));
      const g = graphicsLib.prepareGraphics(planFor(seconds), { theme: 'kuble' }).graphics;
      const frames = g.endFrame - Math.round(g.start * FPS) + Math.round(g.endcard.seconds * FPS);
      const info = await probe(assets.assetFilePath(result.variants[0].video));
      assert.deepEqual(post.verifyOutput(info, { frames, seconds: frames / FPS }), [], 'the film of Kuble passes the same check');
      // a colour that was chosen stays
      reset();
      await exec(makeCtx(), { video, audio: song, graphics: textValue(planFor(seconds)) }, { theme: 'kuble', accent: '#FF3366', quality: 'draft', grain: 0, glitch: 0 });
      assert.ok(submits[0].html.includes('--acc:#FF3366'));
      // the parameter is "auto" by default: the style of the plan is used, HUD Blue where the plan names none
      reset();
      const planned = JSON.parse(planFor(seconds));
      planned.theme = 'kuble';
      await exec(makeCtx(), { video, audio: song, graphics: textValue(JSON.stringify(planned)) }, { quality: 'draft', glitch: 0 });
      assert.ok(submits[0].html.includes('data-theme="kuble"'), 'auto takes the style of the plan');
      reset();
      await exec(makeCtx(), { video, audio: song, graphics: textValue(planFor(seconds)) }, { theme: 'auto', quality: 'draft', glitch: 0 });
      assert.ok(!submits[0].html.includes('data-theme'), 'auto without a style in the plan is HUD Blue');
      // a style that was chosen wins over the plan
      reset();
      await exec(makeCtx(), { video, audio: song, graphics: textValue(JSON.stringify(planned)) }, { theme: 'hud', quality: 'draft', glitch: 0 });
      assert.ok(!submits[0].html.includes('data-theme'), 'the chosen style wins over the plan');
    }

    /* the karaoke switch and the end card switch reach the page */
    {
      reset();
      const video = await baseVideo(14);
      const ctx = makeCtx();
      // 12 s of film: one chunk; the card is off and the karaoke line is off
      const plain = JSON.parse(planFor(12));
      const result = await exec(ctx, { video, audio: song, graphics: textValue(JSON.stringify(plain)) }, { karaoke: false, endcard: false, quality: 'draft', grain: 0, glitch: 0 });
      assert.equal(submits.length, 1);
      const page = JSON.parse(/window\.__HUD_DATA=(.*?);<\/script>/s.exec(submits[0].html)[1]);
      assert.deepEqual(page.options, { karaoke: false, endcard: false });
      assert.equal(page.graphics.endcard, null);
      const info = await probe(assets.assetFilePath(result.variants[0].video));
      near(Number(info.format.duration), 12, 0.06, 'no card: the film ends with the last cut');
      assert.equal(post.verifyOutput(info, { frames: 288, seconds: 12 }).length, 0);
      // a plan without an end card says so
      reset();
      delete plain.endcard;
      const noCard = makeCtx();
      await exec(noCard, { video, audio: song, graphics: textValue(JSON.stringify(plain)) }, { quality: 'draft' });
      assert.ok(noCard.logs.some((line) => /no end card/.test(line)), noCard.logs.join(' | '));
    }
  } finally {
    rendernode.enabled = originals.enabled;
    rendernode.listConfiguredNodes = originals.listConfiguredNodes;
    rendernode.submit = originals.submit;
    costs.recordCost = originals.recordCost;
    await fsp.rm(work, { recursive: true, force: true });
    await store.deleteSession(sessionId).catch(() => {});
  }
}

/* ---------- the texts ---------- */

function testI18n() {
  const storage = new Map([['vcd-lang', 'de']]);
  const window = {
    document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
    navigator: { language: 'de-CH' },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'i18n.js'), 'utf8'), { window }, { filename: 'public/i18n.js' });
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'nodes', 'i18n-nodes.js'), 'utf8'), { window }, { filename: 'public/nodes/i18n-nodes.js' });
  const registryModule = require('../lib/nodes/registry');
  const def = registryModule.get('music_video.hud_render');
  const keys = [
    'nodes.type.music_video.hud_render.label',
    'nodes.type.music_video.hud_render.keywords',
    'nodes.type.music_video.hud_render.help',
    'nodes.type.music_video.hud_render.example',
    'nodes.type.music_video.hud_render.tip.1',
    'nodes.type.music_video.hud_render.tip.2',
    'nodes.type.music_video.hud_render.tip.3',
    ...[...def.inputs, ...def.outputs].map((port) => `nodes.port.${port.id}`),
    ...def.params.map((param) => `nodes.param.${param.id}`),
    'nodes.portdesc.music_video.hud_render.video.in',
    'nodes.portdesc.music_video.hud_render.video.out',
    'nodes.portdesc.music_video.hud_render.audio',
    'nodes.portdesc.music_video.hud_render.graphics',
    'nodes.portdesc.music_video.hud_render.sheet',
    'nodes.portdesc.graphics',
    'nodes.portdesc.sheet'
  ];
  for (const lang of ['de', 'en', 'es']) {
    for (const key of keys) {
      const value = window.I18N[lang][key];
      assert.ok(typeof value === 'string' && value.trim(), `${lang}: ${key} is missing`);
      assert.ok(!value.includes('ß'), `${lang}: ${key} has a sharp s`);
    }
    for (const param of def.params.filter((item) => item.kind === 'select')) for (const option of param.options) assert.ok(window.I18N[lang][`nodes.option.${option}`], `${lang}: option ${option}`);
  }
  // the style: the label of the parameter (not the "Style" of the planner, which has a text field of that name) and its options, in the three languages
  for (const [lang, label] of [['de', 'HUD-Stil'], ['en', 'HUD style'], ['es', 'Estilo del HUD']]) {
    assert.equal(window.I18N[lang]['nodes.param.theme'], label, lang);
    assert.notEqual(window.I18N[lang]['nodes.param.theme'], window.I18N[lang]['nodes.param.style'], `${lang}: the two parameters of the planner need two labels`);
    assert.equal(window.I18N[lang]['nodes.option.hud'], 'HUD Blue', lang);
    assert.equal(window.I18N[lang]['nodes.option.kuble'], 'Kuble', lang);
    assert.ok(window.I18N[lang]['nodes.option.auto'], `${lang}: the option "auto" of the style`);
  }
  // the codes of the errors: every code the node and the page builder can throw has a text, and the figures it names are placeholders
  const source = fs.readFileSync(path.join(root, 'lib', 'nodes', 'nodes-music-video-hud.js'), 'utf8') + fs.readFileSync(path.join(root, 'lib', 'music-video-hud', 'composition.js'), 'utf8');
  const codes = new Set([...source.matchAll(/'(HUD_[A-Z_]+)'/g)].map((match) => match[1]));
  for (const expected of ['HUD_GRAPHICS_INVALID', 'HUD_VIDEO_INVALID', 'HUD_VIDEO_TOO_SHORT', 'HUD_AUDIO_INVALID', 'HUD_RENDER_FAILED', 'HUD_NO_RENDER_NODE', 'HUD_NODE_NO_UPLOADS', 'HUD_CHUNK_TOO_LARGE', 'HUD_OUTPUT_CHECK']) assert.ok(codes.has(expected), `${expected} is thrown`);
  for (const code of codes) {
    for (const lang of ['de', 'en', 'es']) assert.ok(window.I18N[lang][`nodes.issue.${code}`], `${lang}: no text for ${code}`);
  }
  const placeholders = { HUD_VIDEO_TOO_SHORT: ['have', 'need'], HUD_RENDER_FAILED: ['chunk', 'count'], HUD_CHUNK_TOO_LARGE: ['kb', 'limit'], HUD_OUTPUT_CHECK: ['problems'] };
  for (const [code, names] of Object.entries(placeholders)) {
    for (const lang of ['de', 'en', 'es']) for (const name of names) assert.ok(window.I18N[lang][`nodes.issue.${code}`].includes(`{${name}}`), `${lang}: ${code} names {${name}}`);
  }
  // the help texts keep the limits of the help test
  for (const lang of ['de', 'en', 'es']) {
    assert.ok(window.I18N[lang]['nodes.type.music_video.hud_render.help'].length <= 320);
    assert.ok(window.I18N[lang]['nodes.type.music_video.hud_render.example'].length <= 260);
    for (const n of [1, 2, 3]) assert.ok(window.I18N[lang][`nodes.type.music_video.hud_render.tip.${n}`].length <= 240);
  }
}

/* ---------- the style "hud" stays as it is ---------- */

// WP44b: the second style (Kuble) was built on the same engine. This part was written first, with the code as it was before the style: it holds a
// fingerprint of everything the style "hud" (the default, no `theme`) makes, so that nothing of the second style can change the first one.
//   layout    the resolved data (places, times, accents) of the example and of the crowded plans
//   frames    the state of every fifth frame of the example (also on bright footage and without the karaoke line) and the HTML strings that the view
//             draws from it: the picture is a function of these strings and of the style sheet
//   page      the HTML of three chunks with the code scripts left out (their text holds the code of both styles; what they draw is in "frames"):
//             the style sheet, the faces, the data and the frame of the page (the scripts are one block in this value: the page of the code before
//             the second style had three of them, the page now has four, because themes.js is a script of its own)
//   post      the arguments of the post-pass and the other ffmpeg commands of the node
// To make the values again after a change that is meant to change the style hud: PRINT_HUD_GOLDEN=1 node scripts/test-music-video-hud.js
const sha = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

function hudFingerprint() {
  const out = { layout: {}, frames: {}, page: {}, post: {} };
  for (const duration of [40, 72, 128.4]) out.layout[`demo ${duration}`] = sha(graphicsLib.prepareGraphics(graphicsLib.demoGraphics({ duration })));
  for (const seed of [3, 8, 17]) out.layout[`crowded ${seed}`] = sha(graphicsLib.prepareGraphics(crowded(seed)));

  const bright = graphicsLib.prepareGraphics(demoInput, { luma: demo.cuts.map((_cut, index) => (index % 3 === 0 ? [0.9, 0.85] : index % 3 === 1 ? [0.2, 0.7] : [0.1, 0.2])) }).graphics;
  const run = (g, options, from, to, step) => {
    const states = [];
    const views = [];
    for (let frame = from; frame < to; frame += step) {
      const current = state.frameState(g, frame / FPS, options);
      states.push(JSON.stringify(current));
      views.push(JSON.stringify(view.render(current)));
    }
    return { states: sha(states.join('\n')), views: sha(views.join('\n')), count: states.length };
  };
  out.frames.demo = run(demo, { karaoke: true, endcard: true }, 0, demo.endFrame + 72, 5);
  out.frames.bright = run(bright, { karaoke: true, endcard: true }, 0, bright.endFrame + 72, 7);
  out.frames.plain = run(demo, { karaoke: false, endcard: false }, 0, demo.endFrame, 11);

  const chunks = chunksLib.planChunks(demo, { endcardSeconds: demo.endcard.seconds });
  const page = (chunk, options) => composition.buildChunkHtml({ graphics: demo, chunk, clipFile: 'video-0007.mp4', options });
  const masked = (html) => html.replace(/(<script>(?!window\.__HUD_DATA=)[\s\S]*?<\/script>\n)+/g, '<script>/* code */</script>\n');
  out.page.second = sha(masked(page(chunks[1], { karaoke: true, endcard: true })));
  out.page.last = sha(masked(page(chunks[chunks.length - 1], { karaoke: true, endcard: true })));
  out.page.plain = sha(masked(page(chunks[1], { karaoke: false, endcard: false })));
  out.page.style = sha(fs.readFileSync(path.join(root, 'lib', 'music-video-hud', 'styles.css'), 'utf8'));

  const plan = graphicsLib.prepareGraphics({
    duration: 40,
    cuts: [{ start: 2, end: 10, transition: 'cut' }, { start: 10, end: 20, transition: 'glitch' }, { start: 20, end: 30, transition: 'wipe' }, { start: 30, end: 40, transition: 'glitch' }],
    music: { bpm: 120, beats: [2, 2.5, 3], hits: [{ t: 5, strength: 0.9 }, { t: 6, strength: 0.79 }, { t: 7, strength: 1 }, { t: 7.1, strength: 0.85 }, { t: 33, strength: 0.3 }], energy: [] }
  }).graphics;
  const files = { listFile: '/s/chunks.txt', songFile: '/s/song.mp3', outFile: '/s/film.mp4' };
  out.post.args = sha([
    post.buildPostArgs({ ...files, graphics: plan, params: { grain: 0.35, glitch: 0.6 }, endcardSeconds: 3 }),
    post.buildPostArgs({ ...files, graphics: plan, params: { grain: 0, glitch: 0 }, endcardSeconds: 0 }),
    post.buildPostArgs({ ...files, graphics: demo, params: { grain: 0.8, glitch: 1 }, endcardSeconds: 3, inputColor: { color_space: 'smpte170m', color_range: 'pc' } }),
    post.buildPostArgs({ ...files, graphics: demo, params: {}, endcardSeconds: 2 })
  ]);
  out.post.others = sha([
    post.glitchWindows(demo, { glitch: 0.6 }),
    post.contactSheetArgs({ inputFile: '/s/film.mp4', outFile: '/s/sheet.png', frames: 3084 }),
    post.cutClipArgs({ inputFile: '/s/base.mp4', outFile: '/s/c1.mp4', start: 17.8333333, frames: 461 }),
    post.lumaArgs({ inputFile: 'a', outFile: 'b' }),
    post.concatListText(['/a/b.mp4', '/a/c.mp4'])
  ]);
  return out;
}

// (made again with PRINT_HUD_GOLDEN=1 when the example song, the device examples and the end card of the crowded test were replaced by texts of our own: what holds text changed - the layout, the
// frames and the pages of the example and the crowded plans; the style sheet, the post-pass and the number of frames are still the ones of the code before the second style)
const HUD_GOLDEN = {
  layout: {
    'demo 40': '2a7eb69991684e95308e22f6f6e02a69aee2c2304f18614741e8cc7147e16ef9',
    'demo 72': '7af8caa99efb9d5b9ab8e83eb786f7dafa69200a6f5afeb7cd8106a4a51b8cad',
    'demo 128.4': '09312088812ac6a23aaff47fa761036507cfaac1cc32eff0906a8a27f82ceeb6',
    'crowded 3': '2d2cbcfa4c0e69900d089b2226babe65482d204a35c72ea2e733160c494a2a1f',
    'crowded 8': '920d23ee0df1dc4aebc5a6eecece82ddea5d1a3a2e35bf3b2a305e4b1221db9c',
    'crowded 17': 'b1cea0c09ec76654200d91c44208ff2b10c2dc86620e1fb3130fbf61dbdbb362'
  },
  frames: {
    demo: {
      states: '15b3b01076a23da549857d3652a8679ca886cc1ded406a656f350eaf5b85f713',
      views: '76cdcc3e963b2cecc5f6330e4e37f6a9fb60615e4e5c83ee1263e4b9eb7e7bfc',
      count: 631
    },
    bright: {
      states: '2878b6a7a7d6f33b7e602a74cb3ff4cf483787e684f8913a4ff54108a19eddcb',
      views: 'c90a658c7151578e991698abf4c78f45f8b14b866f79490b46a33b62ee7026de',
      count: 451
    },
    plain: {
      states: '7f92c3a9dfb500c0d76022a9318f95ca43e3bc570927d6ca766784d0ab667010',
      views: '4945b3031fb1118517fd79b6d434c6a58142d4bb7a8d5c3c0e580cf52db5a31b',
      count: 281
    }
  },
  page: {
    second: '383c687930991075a6842a83e37cfafd49e965d7eddf148ec5c1d6bb828824c4',
    last: 'c4a2b878f43a2574c9f58d684184f062167aa81eab8f9ca34b7ec1e1918fd364',
    plain: '9d408f689ad1379b8c8fe2deb844df15c1a7820b21c7366da4ae32b73a35bcef',
    style: 'f9f10ce017878a08df9b051ba0d87d35d2a568d5620e2ac57fce5cb07dbbd186'
  },
  post: {
    args: 'a472d472f97af8797487d882a469a0ca738deee2a0bce3c26ce0f22ee84a1f4f',
    others: '55b9132b58a9d772649bdbf1df15740fba8d04ec2261fadd77bc2cab7270fa0e'
  }
};

function testHudStyleUnchanged() {
  const found = hudFingerprint();
  assert.ok(HUD_GOLDEN, 'the fingerprint of the style hud is not recorded yet');
  for (const group of Object.keys(HUD_GOLDEN)) assert.deepEqual(found[group], HUD_GOLDEN[group], `the style hud changed: ${group}`);
}

/* ---------- the style "kuble" ---------- */

// WP44b: the second style on the same engine (lib/music-video-hud/themes.js). What the first style must keep doing is tested above (the fingerprint).
// What the second one must be is tested here:
//   table      its colours, faces and effects, how the name of a style is read (the parameter wins over the field of the plan), the accent
//   fonts      Montserrat with its licence, the faces of a page (only the ones of the style), the size of the page, the colours of the table
//   frames     a pure function of the song time, the same from every chunk; the pulse, the sparks, the sweep and the words on the sixteenths
//   amber      at most one amber element in a picture, and the places that draw amber are the five that are meant to
//   layout     no device on another or on the figure, also with the padding of the cards; a cut without a figure (subject none)
//   post-pass  the prism and the splinters instead of the RGB shift, the bloom, the grain of its own and a stronger vignette, in the windows of the hits
const kuble = themes.get('kuble');
// (the film as the node makes it: the parameters theme and accent, the accent with its default, which Kuble turns into its own blue)
const kubleOf = (input, options) => graphicsLib.prepareGraphics(input, { theme: 'kuble', accent: graphicsLib.DEFAULT_ACCENT, ...options }).graphics;
const kubleDemo = kubleOf(demoInput);

function testKubleTable() {
  assert.deepEqual(themes.NAMES, ['hud', 'kuble']);
  assert.equal(themes.DEFAULT, 'hud');
  // the colours of Kuble v2 (dark first): Night Ink, Ink and its two greys, Kuble Blue (and its light form for writing and glow), the one amber
  const expected = { night: '#05070C', ink: '#F2F4F8', ink2: '#B4BCCC', ink3: '#8892A6', blue: '#2E5CFF', blueText: '#4E7BFF', amber: '#F7901F' };
  for (const [name, value] of Object.entries(expected)) assert.equal(kuble.colors[name], value, name);
  for (const [name, value] of Object.entries(kuble.colors)) {
    assert.match(value, /^#[0-9A-F]{6}$/, name);
    // no red, no green, no violet: everything is a blue, a grey or white, apart from the amber
    const [r, g, b] = themes.rgb(value).split(',').map(Number);
    if (name !== 'amber') assert.ok(b >= r && b >= g, `${name} is a blue or a grey`);
  }
  assert.equal(kuble.accent, kuble.colors.blue);
  assert.equal(themes.get('hud').accent, graphicsLib.DEFAULT_ACCENT);
  assert.equal(themes.lighten('#000000', 1), '#FFFFFF');
  assert.equal(themes.lighten('#2E5CFF', 0), '#2E5CFF');
  assert.equal(themes.rgb('#2E5CFF'), '46,92,255');
  // the faces: Montserrat Black for the words and the numbers, SemiBold for the sentences; the first style keeps Anton
  assert.deepEqual(kuble.faces, { display: 'mont9', number: 'mont9', sans: 'mont6' });
  assert.deepEqual(themes.get('hud').faces, { display: 'anton', number: 'anton', sans: 'sans' });
  assert.deepEqual(themes.get('hud').sizes, {}, 'the first style changes no size');
  assert.deepEqual(themes.get('hud').cards, []);
  assert.equal(themes.get('hud').fx, null);
  // the effects of the table are the ones that were asked for: a pulse of 2 or 3 frames at 0.15 to 0.35, 20 to 40 sparks for 0.6 s, a sweep
  assert.ok(kuble.fx.pulse.frames >= 2 && kuble.fx.pulse.frames <= 3);
  assert.equal(kuble.fx.pulse.min, 0.15);
  assert.equal(kuble.fx.pulse.max, 0.35);
  assert.ok(kuble.fx.sparks.min >= 20 && kuble.fx.sparks.max <= 40 && kuble.fx.sparks.min <= kuble.fx.sparks.max);
  assert.equal(kuble.fx.sparks.seconds, 0.6);
  assert.ok(kuble.fx.sweep.frames >= 4);
  assert.equal(kuble.post.glitch, 'prism');
  assert.equal(themes.get('hud').post.glitch, 'rgb');
  // the grain of Kuble is 0.2 where the slider of the node stands at its default of 0.35; the vignette is stronger (a larger lens angle darkens more)
  near(0.35 * kuble.post.grain, 0.2, 1e-9);
  assert.equal(themes.get('hud').post.grain, 1);
  const angle = (theme) => Math.PI / Number(/PI\/(\d+)/.exec(theme.post.vignette)[1]);
  assert.ok(angle(kuble) > angle(themes.get('hud')));
  assert.ok(kuble.post.bloom && kuble.post.bloom.opacity > 0 && kuble.post.bloom.opacity <= 0.4, 'a light bloom');
  assert.equal(themes.get('hud').post.bloom, null);

  // the name of a style: only the two that exist (not what every object has)
  assert.equal(themes.resolve('kuble'), 'kuble');
  assert.equal(themes.resolve(' Kuble '), 'kuble');
  assert.equal(themes.resolve('neon'), 'hud');
  assert.equal(themes.resolve('neon', 'kuble'), 'kuble');
  assert.equal(themes.resolve(undefined, 'KUBLE'), 'kuble');
  for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', '', 7, null, undefined, {}, ['kuble']]) {
    assert.equal(themes.resolve(bad), 'hud', JSON.stringify(bad));
    assert.equal(themes.get(bad).id, 'hud', JSON.stringify(bad));
    assert.equal(themes.resolve(bad, bad), 'hud', JSON.stringify(bad));
  }

  // the plan: the field `theme` is the fallback, the parameter of the node wins (as the accent colour does); the first style is not written down
  const plan = { duration: 20, cuts: [{ start: 0, end: 20 }] };
  const themeOf = (raw, options) => graphicsLib.normalizeGraphics(raw, options).graphics.theme;
  assert.equal('theme' in graphicsLib.normalizeGraphics(plan).graphics, false, 'the first style is not in the data');
  assert.equal(themeOf({ ...plan, theme: 'hud' }), undefined);
  assert.equal(themeOf({ ...plan, theme: 'kuble' }), 'kuble');
  assert.equal(themeOf({ ...plan, theme: ' Kuble ' }), 'kuble');
  for (const bad of ['neon', '__proto__', 'constructor', 7, null, {}, ['kuble']]) assert.equal(themeOf({ ...plan, theme: bad }), undefined, JSON.stringify(bad));
  assert.equal(themeOf({ ...plan, theme: 'kuble' }, { theme: 'hud' }), undefined, 'the parameter wins over the plan');
  assert.equal(themeOf({ ...plan, theme: 'hud' }, { theme: 'kuble' }), 'kuble');
  assert.equal(themeOf(plan, { theme: 'kuble' }), 'kuble');
  assert.equal(themeOf({ ...plan, theme: 'kuble' }, { theme: 'neon' }), 'kuble', 'a parameter that is no style leaves the plan its own');
  assert.equal(themeOf(JSON.parse(JSON.stringify(graphicsLib.normalizeGraphics({ ...plan, theme: 'kuble' }).graphics))), 'kuble', 'the data of a film can be read again');
  // the accent: the blue of the first style is the default of the node, so Kuble takes its own blue then; a colour that was chosen stays
  assert.equal(graphicsLib.accentFor('hud', '#3B82F6'), '#3B82F6');
  assert.equal(graphicsLib.accentFor(undefined, '#3B82F6'), '#3B82F6');
  assert.equal(graphicsLib.accentFor('kuble', '#3B82F6'), '#2E5CFF');
  assert.equal(graphicsLib.accentFor('kuble', '#ff3366'), '#FF3366');
  assert.equal(graphicsLib.accentFor('hud', '#2E5CFF'), '#2E5CFF');
  assert.equal(graphicsLib.accentFor('kuble', 'nonsense', '#112233'), '#112233');
  assert.equal(kubleOf(plan, { accent: '#3B82F6' }).accent, '#2E5CFF');
  assert.equal(kubleOf(plan, { accent: '#FF3366' }).accent, '#FF3366');
  assert.equal(graphicsLib.prepareGraphics(plan, { accent: '#3B82F6' }).graphics.accent, '#3B82F6');
  assert.equal(graphicsLib.prepareGraphics({ ...plan, accent: '#112233' }, { theme: 'kuble' }).graphics.accent, '#112233', 'without the parameter the plan keeps its colour');
  assert.equal(kubleDemo.theme, 'kuble');
  assert.equal(kubleDemo.accent, '#2E5CFF');
}

// The font of the style: one variable file with its licence beside it, a subset that keeps the weights and drops the layout tables.
function testKubleFonts() {
  const dir = path.join(root, 'lib', 'fonts', 'montserrat');
  assert.match(fs.readFileSync(path.join(dir, 'OFL.txt'), 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/i, 'the licence is beside the font');
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  for (const word of ['OFL', 'google/fonts', 'subset', '600', '800', '900']) assert.ok(readme.includes(word), `the README names ${word}`);
  const file = fs.readFileSync(path.join(dir, 'Montserrat-Variable.ttf'));
  assert.ok(file.length < 150 * 1024, `the font is small (${file.length} bytes)`);
  const ttf = require('../lib/music-video-hud/ttf');
  const tables = ttf.readTables(file);
  for (const tag of ['cmap', 'glyf', 'hmtx', 'fvar', 'avar', 'HVAR', 'gvar']) assert.ok(tables.has(tag), `${tag} is in the font`);
  assert.ok(!tables.has('GPOS') && !tables.has('GSUB'), 'no layout tables (no kerning: the layout measures what the browser draws)');
  const weight = ttf.readAxes(tables.get('fvar')).find((axis) => axis.tag === 'wght');
  assert.ok(weight && weight.min <= 600 && weight.max >= 900, 'the weights 600 to 900 are in the file');
  // the three faces are measured at their weights: the heavier, the wider; every printable ASCII character is in the subset
  const faces = metricsLib.load();
  for (const name of ['mont6', 'mont8', 'mont9']) {
    for (let code = 33; code <= 126; code += 1) assert.ok(faces[name].advances[String.fromCharCode(code)] > 0, `${name} has ${String.fromCharCode(code)}`);
    assert.ok(faces[name].cell > 0.5 && faces[name].cell < 0.9, `${name} has a cell for the digits`);
    assert.ok(faces[name].capHeight > 0.6 && faces[name].capHeight < 0.8, `${name} has a cap height`);
  }
  const wide = (face) => metricsLib.textWidth(face, 'MERIDIAN', 100, 0, false);
  assert.ok(wide('mont9') > wide('mont8') && wide('mont8') > wide('mont6'), 'Black is wider than ExtraBold, which is wider than SemiBold');
  near(metricsLib.textWidth('mont9', 'MERIDIAN', 200, 0, false), 2 * wide('mont9'), 1e-9, 'the width grows with the size');
  near(metricsLib.textWidth('mont9', 'MERIDIAN', 100, -0.02, false), wide('mont9') - 8 * 2, 1e-9, 'the letter spacing is added after every character');
  // the digits stand in cells of one width (the numbers do not change their width while they roll)
  assert.equal(metricsLib.textWidth('mont9', '1111', 100), metricsLib.textWidth('mont9', '8888', 100));
  assert.notEqual(metricsLib.textWidth('mont9', '1111', 100, 0, false), metricsLib.textWidth('mont9', '8888', 100, 0, false), 'the digits of a word are the digits of the face');
  // a text in Anton is narrower than the same one in Montserrat Black (it is why the sizes of the style are smaller)
  assert.ok(metricsLib.textWidth('anton', 'MERIDIAN', 100, 0, false) < wide('mont9'));
}

// The page of a chunk: the faces and the style sheet of the style only, the colours of the table, a size the render node takes.
function testKublePage() {
  const families = (html) => [...html.matchAll(/@font-face\{font-family:'([^']+)'/g)].map((match) => match[1]);
  const chunks = chunksLib.planChunks(kubleDemo, { endcardSeconds: kubleDemo.endcard.seconds });
  let biggest = 0;
  chunks.forEach((chunk, index) => {
    const html = composition.buildChunkHtml({ graphics: kubleDemo, chunk, clipFile: 'video-0007.mp4' });
    biggest = Math.max(biggest, Buffer.byteLength(html));
    assert.equal(motionHtml.checkComposition(html, 'landscape'), null, `chunk ${index + 1} passes the check of the render node`);
    const found = families(html);
    for (const family of ['Montserrat', 'Instrument Serif', 'JetBrains Mono']) assert.ok(found.includes(family), `${family} is embedded`);
    for (const family of ['Anton', 'Inter Tight']) assert.ok(!found.includes(family), `${family} is not in the page of the style Kuble`);
    assert.equal(found.filter((family) => family === 'Montserrat').length, 1, 'one file for every weight');
    assert.ok(html.includes('data-theme="kuble"'));
    assert.ok(html.includes('--acc:#2E5CFF') && html.includes('--blue-t:#4E7BFF'), 'the accent is Kuble Blue, its light form is the table\'s');
    // the colours of the table are the custom properties of the page
    for (const [name, value] of [['--night', kuble.colors.night], ['--ink-c', kuble.colors.ink], ['--ink-2', kuble.colors.ink2], ['--ink-3', kuble.colors.ink3], ['--amber', kuble.colors.amber]]) assert.ok(html.includes(`${name}:${value}`), `${name} is ${value}`);
    assert.ok(html.includes('--cell:'), 'the width of the cell of a digit');
    assert.ok(html.includes('.k-title{'), 'the style sheet of the style is in');
    const data = JSON.parse(/window\.__HUD_DATA=(.*?);<\/script>/s.exec(html)[1]);
    assert.equal(data.graphics.theme, 'kuble');
  });
  assert.ok(biggest < 1.8 * 1024 * 1024, `the biggest page is ${biggest} bytes`);
  assert.ok(biggest < 700 * 1024, `and far below the limit (${biggest} bytes)`);
  // the first style: its faces, no style sheet of the second one, nothing of its colours
  const hudChunk = chunksLib.planChunks(demo, { endcardSeconds: demo.endcard.seconds })[1];
  const hudHtml = composition.buildChunkHtml({ graphics: demo, chunk: hudChunk, clipFile: 'video-0007.mp4' });
  assert.ok(families(hudHtml).includes('Anton') && families(hudHtml).includes('Inter Tight'));
  assert.ok(!families(hudHtml).includes('Montserrat'), 'the page of the first style is as small as it was');
  assert.ok(!hudHtml.includes('data-theme') && !hudHtml.includes('.k-title{') && !hudHtml.includes('--night:'));
  // a plan that names a style by a name that is none gets the first one (nothing breaks, no key of Object.prototype is read)
  const other = composition.buildChunkHtml({ graphics: { ...demo, theme: 'constructor' }, chunk: hudChunk, clipFile: 'a.mp4' });
  assert.ok(families(other).includes('Anton') && !families(other).includes('Montserrat') && !other.includes('data-theme'), 'a name that is no style is the first style');

  // the style sheet: no colour of its own (the table holds them), amber in the places that are meant to have it, Montserrat in the weights that are in use
  const css = fs.readFileSync(path.join(root, 'lib', 'music-video-hud', 'styles.kuble.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(css.match(/#[0-9a-fA-F]{3,8}\b/g), null, 'no hex colour in the style sheet');
  assert.equal(css.match(/rgba?\(\s*\d/g), null, 'no rgb() with numbers in the style sheet');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1].trim(), body: match[2] }));
  assert.ok(rules.length > 100);
  const amberAt = rules.filter((rule) => /amber/.test(rule.body)).map((rule) => rule.selector);
  assert.equal(amberAt.length, 5, `amber is drawn by ${amberAt.join(' | ')}`);
  for (const pattern of [/\.k-beats i\.on\.dn/, /\.stampbox\.amb/, /\.strikeline\.amb/, /\.k-sparks i/, /\.k-edot/]) assert.ok(amberAt.some((selector) => pattern.test(selector)), `${pattern} is amber`);
  const weights = new Set();
  for (const rule of rules) {
    if (!/Montserrat/.test(rule.body)) continue;
    const weight = /(?:font:|font-weight:)\s*(\d{3})/.exec(rule.body);
    if (weight) weights.add(Number(weight[1]));
  }
  assert.ok(weights.size >= 2 && [...weights].every((weight) => [600, 800, 900].includes(weight)), `Montserrat is used at ${[...weights].join(', ')}`);
  // the view draws amber in one place of its own (the marker of the chart)
  assert.equal((fs.readFileSync(path.join(root, 'lib', 'music-video-hud', 'view.js'), 'utf8').match(/--amber/g) || []).length, 1);
}

// Kuble is pure and the same from every chunk, like the first style.
function testKubleFrames() {
  checkPurity(kubleDemo);
  checkChunkIdentity(kubleDemo);
  // the same with the measured brightness on every cut (the gradients and the ink of the words follow it): the chunks still draw what the film draws
  const measured = [[0.1, 0.2], [0.8, 0.7], [0.45, 0.55], [0.2, 0.9]];
  checkChunkIdentity({ ...kubleDemo, cuts: kubleDemo.cuts.map((cut, index) => ({ ...cut, luma: measured[index % measured.length] })) });
  // the spring that the big words use: 0 to 1 with an overshoot of 20 %
  assert.equal(state.ease.spring(0), 0);
  assert.equal(state.ease.spring(1), 1);
  let top = 0;
  for (let x = 0; x <= 1; x += 0.005) top = Math.max(top, state.ease.spring(x));
  near(top, 1.2, 0.005, 'the overshoot');
  // the grid of the sixteenths: the nearest one on the grid of the beat that the time is in, never before the floor
  const music = { bpm: 120, beats: [1, 1.5, 2, 2.5] };
  near(state.sixteenthGrid(music, 1.31, 0), 1.25, 1e-9);
  near(state.sixteenthGrid(music, 1.33, 0), 1.375, 1e-9);
  near(state.sixteenthGrid(music, 1.31, 1.3), 1.3 > 1.25 ? 1.3 : 1.25, 1e-9, 'not before the floor');
  near(state.sixteenthGrid(music, 0.9, 0), 0.875, 1e-9, 'before the first beat the grid goes on backwards');
  near(state.sixteenthGrid({ bpm: 120, beats: [] }, 0.3, 0), 0.25, 1e-9, 'without beats the grid is the one of the tempo');
}

// The page of a Kuble chunk runs in a made-up browser (themes.js, state.js, view.js and the runtime) and draws what the film draws from the same time.
function testKubleRuntime() {
  const chunk = chunksLib.planChunks(kubleDemo, { endcardSeconds: 3 })[1];
  const html = composition.buildChunkHtml({ graphics: kubleDemo, chunk, clipFile: 'a.mp4' });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((entry) => entry[1]);
  assert.equal(scripts.length, 5, 'data, themes, state, view and runtime');
  const layers = {};
  const element = (id) => (layers[id] = { id, innerHTML: '', className: '', style: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } });
  const ticks = [];
  const sandbox = {
    document: { getElementById: (id) => layers[id] || element(id) },
    gsap: { timeline: () => ({ to(target, options) { ticks.push({ target, options }); return this; } }) },
    console
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const script of scripts) vm.runInContext(script, sandbox, { filename: 'kuble-page-script.js' });
  assert.equal(ticks.length, 1);
  assert.ok(sandbox.HudThemes && sandbox.HudThemes.get('kuble').id === 'kuble', 'the table of the styles is in the page');
  const options = { karaoke: true, endcard: true };
  const drawAt = (local) => {
    ticks[0].target.t = local;
    ticks[0].options.onUpdate();
    return { dev: layers['l-dev'].innerHTML, hud: layers['l-hud'].innerHTML, kar: layers['l-kar'].innerHTML, over: layers['l-over'].innerHTML, end: layers['l-end'].innerHTML };
  };
  const hit = kubleDemo.music.hits.find((item) => item.t > chunk.start + 1 && item.strength >= 0.9 && item.t < chunk.start + chunk.seconds - 2);
  const hitFrame = Math.ceil((hit.t - chunk.start) * FPS - 1e-6);
  for (const local of [0, 2.1, hitFrame / FPS, hitFrame / FPS + 3 / FPS, 8.3, chunk.pageFrames / FPS - 1 / FPS]) {
    const drawn = drawAt(local);
    const film = view.render(state.frameState(kubleDemo, chunk.start + local, options));
    for (const layer of ['dev', 'hud', 'kar', 'over', 'end']) assert.ok(drawn[layer] === film[layer], `the layer ${layer} of the page at ${local} s is the one of the film`);
    assert.ok(!/NaN|undefined|Infinity/.test(Object.values(drawn).join('')));
  }
  assert.ok(drawAt(hitFrame / FPS).over.includes('class="k-pulse"'), 'the pulse on the hit');
  assert.ok(!drawAt(hitFrame / FPS + 4 / FPS).over.includes('k-pulse'), 'and it is over after three frames');
  assert.ok(drawAt(2.1).hud.includes('class="k-title"'));
}

// The effects over the picture: the pulse on the hits, the sparks, the sweep, the words on the sixteenths. All of them from the song time.
function testKubleEffects() {
  const g = kubleDemo;
  const options = { karaoke: true, endcard: true };
  const states = [];
  for (let frame = 0; frame < g.endFrame + 72; frame += 1) states.push(state.frameState(g, frame / FPS, options));
  // runs of frames in which `pick` gives something
  const runs = (pick) => {
    const found = [];
    let current = null;
    states.forEach((s, frame) => {
      const value = pick(s);
      if (value) {
        if (!current) {
          current = { from: frame, items: [] };
          found.push(current);
        }
        current.items.push(value);
      } else current = null;
    });
    return found;
  };
  assert.ok(states.every((s) => s.theme === 'kuble' && s.fx && 'amber' in s));

  // the pulse: over the whole picture, 2 or 3 frames on a hit of 0.5 or more, the first frame the strongest (0.15 to 0.35), a small push of the picture
  const pulses = runs((s) => s.fx.pulse);
  const strong = g.music.hits.filter((hit) => hit.strength >= kuble.fx.pulse.from && hit.t < g.endFrame / FPS - 0.2);
  assert.ok(pulses.length >= 10 && pulses.length >= strong.length * 0.9, `${pulses.length} pulses for ${strong.length} strong hits`);
  for (const run of pulses) {
    assert.ok(run.items.length >= 2 && run.items.length <= 3, `a pulse of ${run.items.length} frames`);
    const first = run.items[0];
    assert.ok(first.alpha >= 0.15 - 1e-9 && first.alpha <= 0.35 + 1e-9, `the pulse starts with ${first.alpha}`);
    for (let i = 1; i < run.items.length; i += 1) assert.ok(run.items[i].alpha < run.items[i - 1].alpha && run.items[i].alpha > 0, 'and fades');
    for (const item of run.items) assert.ok(item.zoom > 0 && item.zoom <= 0.02 + 1e-9);
    const at = run.from / FPS;
    assert.ok(g.music.hits.some((hit) => hit.strength >= kuble.fx.pulse.from && at - hit.t >= -1e-9 && at - hit.t < 1 / FPS + 1e-9), `the pulse at ${at} follows a hit`);
  }
  // a stronger hit is a stronger pulse
  const one = (strength) => state.frameState(kubleOf({ duration: 20, cuts: [{ start: 0, end: 20 }], music: { bpm: 120, beats: [1], hits: [{ t: 5, strength }], energy: [] } }), 5 + 1 / 48, options).fx.pulse;
  assert.equal(one(0.4), null, 'a weak hit gives none');
  assert.ok(one(1).alpha > one(0.7).alpha && one(0.7).alpha > one(0.5).alpha);
  near(one(1).alpha, 0.35, 1e-9);
  near(one(0.5).alpha, 0.15, 1e-9);
  // the first style has no pulse, no sweep and no sparks
  assert.ok(Array.from({ length: 200 }, (_item, frame) => state.frameState(demo, frame / FPS, options)).every((s) => !('fx' in s) && !('theme' in s) && !('amber' in s)));

  // the sparks: 20 to 40 amber dots for 0.6 s on the strongest hits and on a drop
  const sparks = runs((s) => s.fx.sparks);
  assert.ok(sparks.length >= 5, `${sparks.length} sparks`);
  for (const run of sparks) {
    const count = run.items[0].length;
    assert.ok(count >= 20 && count <= 40, `${count} dots`);
    assert.ok(run.items.length <= 16, `the sparks live ${run.items.length} frames`);
    for (const dots of run.items) {
      for (const dot of dots) {
        assert.ok(dot.a >= 0 && dot.a <= 1 && dot.r > 0 && dot.r <= 7, JSON.stringify(dot));
        assert.ok(dot.x > -60 && dot.x < 1980 && dot.y > -60 && dot.y < 1140, `a dot at ${dot.x}, ${dot.y} is on the screen`);
      }
    }
    // the dots only get fewer, they never come back
    for (let i = 1; i < run.items.length; i += 1) assert.ok(run.items[i].length <= run.items[i - 1].length);
  }
  const lengths = sparks.map((run) => run.items.length / FPS);
  assert.ok(Math.max(...lengths) >= 0.55 && Math.max(...lengths) <= 0.7, `the longest sparks live ${Math.max(...lengths)} s`);
  for (const drop of g.hud.drops) {
    const frame = Math.ceil(drop * FPS - 1e-6);
    assert.ok(states[frame].fx.sparks || (states[frame].amber && states[frame].amber.kind !== 'sparks'), `the drop at ${drop} s has sparks (or another amber element holds the place)`);
  }
  // the same sparks every time, from the time of the trigger (also from a chunk: see the chunk identity); they fly away from the figure
  const centroid = (s) => s.fx.sparks.reduce((sum, dot) => sum + dot.x, 0) / s.fx.sparks.length;
  const plan = (subject, graphics = []) => kubleOf({ duration: 12, cuts: [{ start: 0, end: 12, kind: 'story', subject }], music: { bpm: 120, beats: [1], hits: [{ t: 5, strength: 1 }], energy: [] }, graphics });
  const at = (film) => state.frameState(film, 5.2, options);
  assert.ok(centroid(at(plan('left'))) > 960, 'a figure on the left: the sparks come from the right');
  assert.ok(centroid(at(plan('right'))) < 960, 'a figure on the right: from the left');
  // a card on the place the sparks fly through moves their start point inward, but never to the side of the figure
  const spec = { id: 'c', type: 'spec', ...SAMPLES.spec, start: 3, end: 9, position: 'right' };
  const blocked = plan('left', [spec]);
  assert.ok(blocked.devices[0].rect.x + blocked.devices[0].rect.w > 1180 && blocked.devices[0].rect.y + blocked.devices[0].rect.h > 520, 'the spec stands on the right side');
  assert.ok(centroid(at(blocked)) > 960 && centroid(at(blocked)) < centroid(at(plan('left'))) - 100, 'the sparks start further in, on the same side');
  const counter = { id: 'n', type: 'counter', ...SAMPLES.counter, start: 3, end: 9, position: 'bottom-left' };
  const crowdedLeft = plan('right', [counter]);
  assert.ok(centroid(at(crowdedLeft)) < 960 && centroid(at(crowdedLeft)) > centroid(at(plan('right'))) + 100, 'a card at the bottom left: the sparks start right of it, still left of the figure');
  // with the figure in the middle (or none) the dots do not touch the zone of the face, whichever side they come from
  for (const subject of ['center', 'none']) {
    for (const seedTime of [4, 5, 6.3, 7.7]) {
      const film = kubleOf({ duration: 12, cuts: [{ start: 0, end: 12, kind: 'story', subject }], music: { bpm: 120, beats: [1], hits: [{ t: seedTime, strength: 1 }], energy: [] } });
      for (let frame = 0; frame < 15; frame += 1) {
        const s = state.frameState(film, seedTime + frame / FPS, options);
        for (const dot of s.fx.sparks || []) assert.ok(!(subject === 'center' && dot.a > 0.15 && dot.x > graphicsLib.FACE.center.x0 && dot.x < graphicsLib.FACE.center.x1 && dot.y < graphicsLib.FACE.y1), `a dot at ${dot.x}, ${dot.y} on the face (${subject}, ${seedTime})`);
      }
    }
  }

  // the sweep: a band of light at the start of every chapter after the first, and during a wipe
  const sweeps = runs((s) => s.fx.sweep);
  const wipes = g.cuts.filter((cut) => cut.transition === 'wipe' && cut.start > g.start);
  const starts = [...g.hud.chapters.slice(1).map((chapter) => chapter.start), ...wipes.map((cut) => cut.start)];
  assert.ok(wipes.length >= 1 && sweeps.length >= g.hud.chapters.length - 1);
  for (const run of sweeps) {
    const at = run.from / FPS;
    assert.ok(starts.some((start) => at - start >= -1e-6 && at - start < 1 / FPS + 1e-6), `the sweep at ${at} s starts with a chapter or a wipe`);
    for (let i = 0; i < run.items.length; i += 1) {
      assert.ok(run.items[i].p >= 0 && run.items[i].p <= 1 && (run.items[i].kind === 'chapter' || run.items[i].kind === 'wipe'));
      if (i > 0) assert.ok(run.items[i].p >= run.items[i - 1].p, 'the band moves on');
    }
  }
  for (const start of starts) assert.ok(sweeps.some((run) => Math.abs(run.from / FPS - start) < 1 / FPS + 1e-6), `a sweep at ${start} s`);
  assert.ok(!sweeps.some((run) => run.from / FPS < g.hud.chapters[1].start - 1e-6 && !wipes.some((cut) => Math.abs(cut.start - run.from / FPS) < 0.1)), 'none at the first chapter');

  // the big words: every word springs in on a sixteenth (the one nearest to the time it is sung), with an overshoot and a blue glow that fades
  const display = g.devices.find((d) => d.id === 'g2d');
  assert.ok(display && display.wordTimes[1].length === 2, 'the example has a block of words');
  const tokens = [];
  display.wordTimes.forEach((row, rowIndex) => row.forEach((at, tokenIndex) => tokens.push({ rowIndex, tokenIndex, start: state.sixteenthGrid(g.music, at, display.appear) })));
  assert.equal(tokens.length, 3);
  for (const token of tokens) {
    let first = null;
    let top = 0;
    let glowAt = null;
    for (let frame = Math.floor(display.appear * FPS); frame < Math.ceil((display.end + 0.2) * FPS); frame += 1) {
      const item = states[frame].devices.find((entry) => entry.id === display.id);
      if (!item) continue;
      const word = item.sub.rows[token.rowIndex].tokens[token.tokenIndex];
      if (word.shown && first === null) first = frame / FPS;
      if (first !== null && frame / FPS - first < 0.4) top = Math.max(top, word.p);
      assert.ok(word.glow >= 0 && word.glow <= 1);
      if (word.shown && frame / FPS - token.start > kuble.fx.kinetic.glowSeconds + 1e-6) assert.equal(word.glow, 0, 'the glow is gone after 0.35 s');
      if (word.shown && glowAt === null) glowAt = word.glow;
      if (!word.shown) assert.equal(word.glow, 0);
    }
    assert.ok(first !== null && first - token.start >= -1e-6 && first - token.start < 1 / FPS + 1e-6, `the word ${token.tokenIndex} of row ${token.rowIndex} shows on its sixteenth (${token.start}), not at ${first}`);
    assert.ok(top > 1.1 && top <= 1.21, `the word overshoots (${top})`);
    assert.ok(glowAt > 0.5, 'and glows when it comes');
  }
}

// The one amber element of a picture: the arbiter of the state decides, the view draws exactly that.
function testKubleAmber() {
  const kinds = (v) => {
    const html = `${v.dev}${v.hud}${v.kar}${v.over}${v.end}`;
    const found = [];
    if (/class="stampbox[^"]*\bamb\b/.test(html)) found.push('stamp');
    if (/class="strikeline[^"]*\bamb\b/.test(html)) found.push('strike');
    if (html.includes('fill="var(--amber)"')) found.push('marker');
    if (html.includes('class="k-sparks"')) found.push('sparks');
    if (/class="on dn"/.test(html)) found.push('beat');
    if (html.includes('class="k-edot"')) found.push('end');
    return found;
  };
  const options = { karaoke: true, endcard: true };
  const seen = new Set();
  const area = [];
  for (const [label, film] of [['the example', kubleDemo], ['a crowded plan', kubleOf(crowded(3))], ['another one', kubleOf(crowded(17))]]) {
    for (let frame = 0; frame < film.endFrame + 72; frame += 1) {
      const s = state.frameState(film, frame / FPS, options);
      const found = kinds(view.render(s));
      assert.ok(found.length <= 1, `${label}: ${found.join(' and ')} are amber at frame ${frame}`);
      if (found.length) {
        assert.ok(s.amber && s.amber.kind === found[0], `${label}: the view draws ${found[0]} where the state says ${s.amber && s.amber.kind}`);
        seen.add(found[0]);
      }
      if (s.amber && (s.amber.kind === 'stamp' || s.amber.kind === 'strike')) {
        const item = s.devices.find((entry) => entry.id === s.amber.id);
        for (const rect of rectsOf(item)) area.push((rect.w * rect.h) / (1920 * 1080));
      }
    }
  }
  assert.deepEqual([...seen].sort(), ['beat', 'end', 'marker', 'sparks', 'stamp', 'strike'], 'every place that draws amber was seen');
  assert.ok(area.length > 50 && Math.max(...area) < 0.15, `the biggest amber device covers ${Math.max(...area)} of the picture`);
  // the first style has no amber and draws nothing of this
  for (let frame = 0; frame < 300; frame += 7) assert.deepEqual(kinds(view.render(state.frameState(demo, frame / FPS, options))), []);
}

// What the view draws for Kuble: the colours are the ones of the table, the effects are in the layer over the picture, the cards are cards.
function testKubleView() {
  const options = { karaoke: true, endcard: true };
  const allowed = new Set(Object.values(kuble.colors).map((value) => themes.rgb(value)));
  const hexes = new Set(Object.values(kuble.colors));
  const found = { pulse: 0, sweep: 0, sparks: 0, card: 0, spring: 0 };
  for (let frame = 0; frame < kubleDemo.endFrame + 72; frame += 2) {
    const s = state.frameState(kubleDemo, frame / FPS, options);
    const v = view.render(s);
    const html = `${v.dev}${v.hud}${v.kar}${v.over}${v.end}`;
    for (const match of html.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) assert.ok(hexes.has(match[0].toUpperCase()), `${match[0]} is no colour of the table`);
    for (const match of html.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g)) assert.ok(allowed.has(`${match[1]},${match[2]},${match[3]}`), `rgb(${match[1]},${match[2]},${match[3]}) is no colour of the table`);
    assert.ok(!/NaN|undefined|Infinity|<script|\son[a-z]+=/i.test(html), `frame ${frame}`);
    // the effects: lit by the state, drawn in the layer over the picture (never in another layer)
    assert.equal(v.over.includes('class="k-pulse"'), Boolean(s.fx.pulse && s.fx.pulse.alpha > 0.004), 'the pulse');
    assert.equal(v.over.includes('class="k-sweep'), Boolean(s.fx.sweep), 'the sweep');
    assert.equal(v.over.includes('class="k-sparks"'), Boolean(s.fx.sparks && s.fx.sparks.length), 'the sparks');
    if (s.fx.sparks && s.fx.sparks.length) assert.equal(v.over.split('<i ').length - 1, s.fx.sparks.length, 'one element for every dot');
    assert.ok(!/k-pulse|k-sweep|k-sparks/.test(v.dev + v.hud + v.kar + v.end));
    if (s.fx.pulse) found.pulse += 1;
    if (s.fx.sweep) found.sweep += 1;
    if (s.fx.sparks) found.sparks += 1;
    if (/class="dv [^"]*\bcard\b/.test(v.dev)) found.card += 1;
    if (/text-shadow:0 0 [\d.]+px rgba\(var\(--blue-t-rgb\)/.test(v.dev)) found.spring += 1;
    // the frame of the HUD: the title, the chapter, the progress line, the counter, the beat bar of sixteen squares and the status line
    if (s.hud) {
      assert.ok(v.hud.includes('class="k-title"') && v.hud.includes('class="k-prog"') && v.hud.includes('class="k-beats"') && v.hud.includes('class="k-status"'), 'the frame of Kuble');
      assert.equal(/<div class="k-beats">(.*?)<\/div>/.exec(v.hud)[1].split('<i').length - 1, 16, 'a beat bar of sixteen squares');
      assert.ok(!v.hud.includes('class="tile') && !v.hud.includes('class="console"') && !v.hud.includes('class="ticker"'), 'no drop-down title, no console, no ticker');
    }
  }
  for (const [name, count] of Object.entries(found)) assert.ok(count > 0, `${name} was drawn`);
  // the end card: Night Ink, one blue line, one amber dot
  const card = view.render(state.frameState(kubleDemo, kubleDemo.endFrame / FPS + 2.5, options)).end;
  assert.ok(card.includes('class="end k"') && card.includes('class="k-eline"') && card.includes('class="k-edot"'));
  assert.ok(card.includes(kubleDemo.endcard.title) && card.includes('anabology'), 'the title and the credit');
  // a card is a card: the devices on the table of the style have a card, a multiplier has none, the other devices (displays, tags) have none
  const cardOf = (type, extra) => {
    const film = kubleOf({ duration: 12, cuts: [{ start: 0, end: 12, kind: 'story', subject: 'center' }], graphics: [{ id: 'x', type, ...SAMPLES[type], ...extra, start: 1, end: 10 }] });
    return /class="dv[^"]*\bcard\b/.test(view.render(state.frameState(film, 4, options)).dev);
  };
  for (const type of kuble.cards) assert.ok(cardOf(type), `${type} stands on a card`);
  assert.ok(!cardOf('counter', { format: 'multiplier', from: 1, to: 40 }), 'a multiplier is a chip of its own');
  assert.ok(!cardOf('tag') && !cardOf('display'));
  // the dark gradients under the writing at the top and the bottom: their strength follows the brightness of the cut and reaches the page as a
  // variable of the stage (the first style has no such variable)
  const scrimOf = (luma, make) => {
    const film = make({ duration: 12, cuts: [{ start: 0, end: 12, kind: 'story', subject: 'center', ...(luma ? { luma } : {}) }] });
    const s = state.frameState(film, 5, options);
    return { strength: s.fx && s.fx.scrim, stage: view.render(s).stage };
  };
  const ofKuble = (luma) => scrimOf(luma, kubleOf);
  assert.equal(ofKuble([0.8, 0.9]).strength, 1, 'a bright cut: full');
  assert.equal(ofKuble([0.05, 0.1]).strength, 0.25, 'a dark cut: light');
  assert.ok(ofKuble(null).strength > 0.25 && ofKuble(null).strength < 1, 'a cut of unknown brightness: in between');
  assert.ok(ofKuble([0.3, 0.3]).strength < ofKuble([0.45, 0.45]).strength, 'the brighter the cut, the stronger the gradients');
  assert.ok(/;--sk:1$/.test(ofKuble([0.8, 0.9]).stage), `the strength is a variable of the stage: ${ofKuble([0.8, 0.9]).stage}`);
  const ofHud = scrimOf([0.8, 0.9], (input) => graphicsLib.prepareGraphics(input).graphics);
  assert.ok(ofHud.strength === undefined && !ofHud.stage.includes('--sk'), 'the first style has none');
}

// The layout with the padding of the cards and the faces of Montserrat: nothing on another, nothing on the figure, the same from every chunk.
function testKubleLayout() {
  assertNoCover(kubleOf(graphicsLib.demoGraphics({ duration: 72 })), 'Kuble, the example of 72 s');
  let dropped = 0;
  for (const seed of [3, 17]) {
    const plan = crowded(seed);
    const prepared = graphicsLib.prepareGraphics(plan, { theme: 'kuble' });
    const label = `Kuble, the crowded plan ${seed}`;
    assertNoCover(prepared.graphics, label);
    dropped += assertKept(plan, prepared, label).dropped;
    assertSameInChunks(prepared.graphics, label);
    assert.equal(JSON.stringify(graphicsLib.prepareGraphics(plan, { theme: 'kuble' }).graphics), JSON.stringify(prepared.graphics), `${label}: the layout is a function of the data`);
    for (const device of prepared.graphics.devices) {
      if (device.type === 'pin') continue;
      assert.ok(device.rect.x >= graphicsLib.SAFE.left - 24 && device.rect.x + device.rect.w <= graphicsLib.SAFE.right + 24, `${device.id} is inside the side margins`);
    }
  }
  assert.ok(dropped > 0, 'a plan that is too full is thinned out here too, with notes');
  // a card is as much bigger than what is on it as its padding; a multiplier is a chip of its own and has none
  const pad = view.sizesOf('kuble').card.pad;
  const noCards = { ...kuble, cards: [] };
  const seen = new Set();
  const multiplier = kubleOf({ duration: 12, cuts: [{ start: 0, end: 12, kind: 'story', subject: 'center' }], graphics: [{ id: 'm', type: 'counter', format: 'multiplier', from: 1, to: 40, label: 'TAXIS', start: 1, end: 8 }] }).devices[0];
  for (const d of [...kubleOf(crowded(17)).devices, multiplier]) {
    if (d.type === 'display' || d.type === 'pin') continue;
    const extra = view.isCard(kuble, d) ? 2 * pad : 0;
    near(graphicsLib.measure(d, kuble).w - graphicsLib.measure(d, noCards).w, extra, 1e-9, `${d.id} (${d.type}): width`);
    near(graphicsLib.measure(d, kuble).h - graphicsLib.measure(d, noCards).h, extra, 1e-9, `${d.id} (${d.type}): height`);
    seen.add(`${d.type}${extra ? ' card' : ''}`);
  }
  assert.ok(seen.has('multiplier') || seen.has('counter'), 'the multiplier was measured');
  assert.ok([...seen].filter((name) => /card/.test(name)).length >= 6 && seen.size >= 10, `${[...seen].join(', ')}`);
}

// A cut without a figure (subject none): no zone of the face, so the layout may use the middle; the first style does it the same way.
function testSubjectNone() {
  assert.ok(graphicsLib.SUBJECTS.includes('none'));
  assert.equal(graphicsLib.faceZone({ kind: 'story', subject: 'none', crop: { scale: 1, x: 0.5, y: 0.5 } }), null);
  assert.equal(graphicsLib.faceZone({ kind: 'performance', subject: 'none', framing: 'CU', crop: { scale: 1.6, x: 0.5, y: 0.5 } }), null);
  assert.notEqual(graphicsLib.faceZone({ kind: 'story', subject: 'center', crop: { scale: 1, x: 0.5, y: 0.5 } }), null);
  const read = graphicsLib.normalizeGraphics({ duration: 12, cuts: [{ start: 0, end: 6, subject: 'none' }, { start: 6, end: 12, subject: 'nobody' }] });
  assert.deepEqual(read.graphics.cuts.map((cut) => cut.subject), ['none', 'center'], 'none is a subject, anything else is the centre');
  const plan = (subject) => ({
    version: 1,
    duration: 12,
    cuts: [{ start: 0, end: 12, kind: 'story', subject }],
    hud: { title: 'TEST' },
    graphics: [
      { id: 'a', type: 'display', style: 'condensed', rows: [{ text: 'MERIDIAN', size: 'xl' }], start: 1, end: 6 },
      { id: 'b', type: 'pin', label: 'HERE', x: 0.5, y: 0.4, start: 1, end: 8 }
    ]
  });
  for (const theme of ['hud', 'kuble']) {
    const through = (subject) => graphicsLib.prepareGraphics(plan(subject), { theme });
    const centre = through('center');
    const none = through('none');
    assert.deepEqual(none.warnings, [], `${theme}: nothing is left out`);
    const rect = (prepared, id) => prepared.graphics.devices.find((device) => device.id === id).rect;
    const zone = graphicsLib.FACE.center;
    const onFace = (r) => r.x < zone.x1 && r.x + r.w > zone.x0 && r.y < graphicsLib.FACE.y1 && r.y + r.h > graphicsLib.FACE.y0;
    assert.ok(!onFace(rect(centre, 'a')) && !onFace(rect(centre, 'b')), `${theme}: a figure in the centre keeps both away`);
    // without a figure the word is as big as the room, and the pin stays nearer to the place it was put at
    assert.ok(rect(none, 'a').w > rect(centre, 'a').w, `${theme}: the word is as big as the room`);
    const away = (r) => Math.abs(r.x + r.w / 2 - 0.5 * graphicsLib.WIDTH);
    assert.ok(away(rect(none, 'b')) < away(rect(centre, 'b')), `${theme}: the pin is nearer to its place`);
    assert.deepEqual(through('none').graphics, none.graphics, `${theme}: the same every time`);
    // every frame is drawn: the camera, the karaoke, the sparks and the HUD take a cut without a figure
    for (let frame = 0; frame < 12 * FPS; frame += 5) {
      const s = state.frameState(none.graphics, frame / FPS, { karaoke: true });
      assertClean(s, `${theme} none ${frame}`, { strings: false });
      assert.equal(s.cut.subject, 'none');
      const v = view.render(s);
      assert.ok(!/NaN|undefined|Infinity/.test(`${v.dev}${v.hud}${v.kar}${v.over}`));
    }
    assertNoCover(none.graphics, `${theme}: a cut without a figure`);
  }
  // a pin that would stand on the figure slides aside on the cut of a figure, and stays on a cut without one (a plan of several cuts)
  const two = graphicsLib.prepareGraphics({ duration: 12, cuts: [{ start: 0, end: 6, kind: 'story', subject: 'center' }, { start: 6, end: 12, kind: 'story', subject: 'none' }], hud: { title: 'T' }, graphics: [{ id: 'p', type: 'pin', label: 'HERE', x: 0.5, y: 0.4, start: 1, end: 11 }] }, { theme: 'kuble' });
  assert.equal(two.graphics.devices.length, 1);
  assertNoCover(two.graphics, 'a figure and then none');
}

// The post-pass of the style: the same windows as the first style (the cuts and the hits decide, not the style), the prism and the splinters instead of
// the RGB shift, the bloom, the grain of its own and a stronger vignette.
function testKublePostArgs() {
  const input = {
    duration: 40,
    cuts: [{ start: 2, end: 10, transition: 'cut' }, { start: 10, end: 20, transition: 'glitch' }, { start: 20, end: 30, transition: 'wipe' }, { start: 30, end: 40, transition: 'glitch' }],
    music: { bpm: 120, beats: [2, 2.5, 3], hits: [{ t: 5, strength: 0.9 }, { t: 6, strength: 0.79 }, { t: 7, strength: 1 }, { t: 7.1, strength: 0.85 }, { t: 33, strength: 0.3 }], energy: [] }
  };
  const files = { listFile: '/s/chunks.txt', songFile: '/s/song.mp3', outFile: '/s/film.mp4' };
  const gHud = graphicsLib.prepareGraphics(input).graphics;
  const gKuble = graphicsLib.prepareGraphics(input, { theme: 'kuble' }).graphics;
  const hud = post.buildPostArgs({ ...files, graphics: gHud, params: { grain: 0.35, glitch: 0.6 }, endcardSeconds: 3 });
  const built = post.buildPostArgs({ ...files, graphics: gKuble, params: { grain: 0.35, glitch: 0.6 }, endcardSeconds: 3 });
  assert.deepEqual(built.windows, hud.windows, 'the same windows');
  assert.equal(built.frames, hud.frames);
  assert.equal(built.seconds, hud.seconds);
  assert.ok(built.windows.length >= 3);
  const f = built.filter;
  // everything that is not the picture is the same: the colour conversion, the tags, the audio, the encoder
  assert.deepEqual(built.args.filter((arg) => arg !== f), hud.args.filter((arg) => arg !== hud.filter));
  assert.ok(f.includes('[1:a]atrim=start=2:end=40') && f.includes('apad=whole_dur=41'));
  assert.ok(f.includes('setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv'));
  // no RGB shift (red, green, blue) and no displaced strip of the first style
  assert.ok(!f.includes('rgbashift=') && !f.includes('overlay='));
  // the splinters: strips cut out of the picture and moved sideways for a few frames; 2, 3 and 4 strips, every kind in its own windows
  assert.ok(f.includes('maskedmerge=enable='), 'the splinters');
  const strips = [...f.matchAll(/geq=lum='([^']*)'/g)].map((match) => (match[1].match(/\*between\(X,/g) || []).length);
  assert.deepEqual(strips, [2, 3, 4], 'three kinds of splinters with two, three and four strips');
  const merges = [...f.matchAll(/maskedmerge=enable='([^']*)'/g)].map((match) => match[1]);
  assert.equal(merges.length, 3);
  const windowsText = (items) => items.map((item) => `gte(t,${Math.round(item.start * 10000) / 10000})*lt(t,${Math.round(item.end * 10000) / 10000})`);
  assert.deepEqual(merges.join('+').split('+').sort(), windowsText(built.windows).sort(), 'every window has its splinters, and only there');
  // the prism: blue to the left and amber to the right of the edges, in the windows only; the colours are the table's (the weights of the two mixers)
  assert.ok(f.includes('colorchannelmixer='), 'the fringes are made with a mixer');
  const prism = /blend=all_mode=addition:enable='([^']*)'/.exec(f);
  assert.ok(prism, 'the fringes are added');
  assert.deepEqual(prism[1].split('+').sort(), windowsText(built.windows).sort(), 'the fringes are in the windows only');
  const mixers = [...f.matchAll(/colorchannelmixer=([^,\[]*)/g)].map((match) => Object.fromEntries(match[1].split(':').map((pair) => pair.split('=')))).map((mixer) => Object.fromEntries(Object.entries(mixer).map(([key, value]) => [key, Number(value)])));
  assert.equal(mixers.length, 2);
  const [blueMix, amberMix] = mixers;
  assert.ok(blueMix.br > blueMix.rr && blueMix.bg > blueMix.gg && blueMix.bb > blueMix.rb, 'the left fringe is made of the blue channel');
  assert.ok(amberMix.rr > amberMix.br && amberMix.gg > amberMix.bg && amberMix.rg > amberMix.bg, 'the right fringe is made of red and green');
  // the bloom: the same on the three channels (no new colour), small and scaled up, for the whole film; a threshold under white
  const bloom = /lutrgb=r='([^']*)':g='([^']*)':b='([^']*)',gblur=sigma=(\d+)/.exec(f);
  assert.ok(bloom && bloom[1] === bloom[2] && bloom[2] === bloom[3], 'the bloom does not recolour the picture');
  assert.equal(Number(bloom[4]), kuble.post.bloom.sigma);
  assert.ok(f.includes('scale=480:270:flags=area') && f.includes('blend=all_mode=screen'), 'drawn small, screened on');
  // the grain is lighter than the first style's at the same slider, the vignette is stronger
  const noise = (filter) => Number(/noise=c0s=(\d+)/.exec(filter)[1]);
  assert.ok(noise(f) > 0 && noise(f) < noise(hud.filter), `${noise(f)} against ${noise(hud.filter)}`);
  assert.equal(noise(f), Math.round(0.35 * 12 * kuble.post.grain));
  assert.ok(f.includes(`vignette=angle=${kuble.post.vignette}`) && !f.includes('vignette=angle=PI/7'));
  assert.ok(hud.filter.includes('vignette=angle=PI/7') && !hud.filter.includes('maskedmerge') && !hud.filter.includes('gblur'));
  // a stronger slider is more grain, here too
  const noiseOf = (grain) => noise(post.buildPostArgs({ ...files, graphics: gKuble, params: { grain, glitch: 0 } }).filter);
  assert.ok(noiseOf(1) > noiseOf(0.35) && noiseOf(0.35) > 0);
  // no glitch: no splinters and no fringes, but the bloom and the vignette stay (they are the look of the style); no grain: no noise
  const quiet = post.buildPostArgs({ ...files, graphics: gKuble, params: { grain: 0, glitch: 0 }, endcardSeconds: 0 });
  assert.ok(!quiet.filter.includes('maskedmerge') && !quiet.filter.includes('noise=') && !quiet.filter.includes('colorchannelmixer') && !quiet.filter.includes('geq='));
  assert.ok(quiet.filter.includes('gblur=') && quiet.filter.includes('vignette='));
  assert.equal(quiet.frames, gKuble.endFrame - 2 * FPS);
  // the colour of the chunks goes through the style as it goes through the first one
  const tagged = post.buildPostArgs({ ...files, graphics: gKuble, params: {}, inputColor: { color_space: 'smpte170m', color_range: 'pc' } }).filter;
  assert.ok(tagged.includes('in_color_matrix=smpte170m:in_range=pc'), tagged.slice(0, 200));
  // no more than the limit of windows (the graph stays short)
  const many = graphicsLib.prepareGraphics({ duration: 600, cuts: Array.from({ length: 500 }, (_item, i) => ({ start: i * 1.2, end: i * 1.2 + 1.2, transition: 'glitch' })) }, { theme: 'kuble' }).graphics;
  const long = post.buildPostArgs({ ...files, graphics: many, params: { glitch: 1 } });
  assert.ok(long.windows.length <= post.MAX_WINDOWS && long.filter.length < 60000, `the graph of a long film is ${long.filter.length} characters`);
}

// What the files of this part must never hold: a name, an address or a key of the maker (the repository is public).
function testHygiene() {
  const files = [
    'lib/nodes/nodes-music-video-hud.js',
    'lib/music-video-hud/state.js',
    'lib/music-video-hud/view.js',
    'lib/music-video-hud/graphics.js',
    'lib/music-video-hud/plan.js',
    'lib/music-video-hud/composition.js',
    'lib/music-video-hud/chunks.js',
    'lib/music-video-hud/postpass.js',
    'lib/music-video-hud/runtime.browser.js',
    'lib/music-video-hud/styles.css',
    'lib/music-video-hud/styles.kuble.css',
    'lib/music-video-hud/themes.js',
    'lib/music-video-hud/ttf.js',
    'lib/music-video-hud/metrics.js',
    'lib/fonts/montserrat/README.md',
    'lib/fonts/montserrat/OFL.txt',
    'scripts/subset-font.js',
    'scripts/hud-preview.js',
    'scripts/test-music-video-hud.js',
    'scripts/test-music-video-hud-plan.js',
    'scripts/support/hud-plan-fixtures.js'
  ];
  // (written in pieces, so that this file does not hold what it looks for)
  const forbidden = new RegExp(['mani' + 'ak', 'gust' + 'avo', '46' + '\\.225', '192' + '\\.168', 'hf' + 'r_', 'sk-' + 'or-'].join('|'), 'i');
  for (const file of files) assert.ok(!forbidden.test(fs.readFileSync(path.join(root, file), 'utf8')), `${file} holds a name, an address or a key that does not belong in a public repository`);
  // the font files have their licence beside them
  for (const dir of ['anton', 'instrument-serif', 'jetbrains-mono', 'montserrat']) assert.ok(fs.existsSync(path.join(root, 'lib', 'fonts', dir, 'OFL.txt')), `${dir} has its licence`);
}

async function main() {
  if (process.env.PRINT_HUD_GOLDEN) {
    console.log(JSON.stringify(hudFingerprint(), null, 2));
    return;
  }
  const tests = [
    testHelpers,
    testCounterValues,
    testDeviceCounters,
    testBarAndBeat,
    testDropCountdown,
    testTicker,
    testKaraoke,
    testEndcard,
    testPurity,
    testChunkIdentity,
    testNormalizeBroken,
    testLayout,
    testFraming,
    testFaceZone,
    testNoCover,
    testNewWins,
    testDeviceKey,
    testChartOutline,
    testChunks,
    testPage,
    testRuntime,
    testPostArgs,
    testVerify,
    testSheetAndClipArgs,
    testI18n,
    testHudStyleUnchanged,
    testKubleTable,
    testKubleFonts,
    testKublePage,
    testKubleRuntime,
    testKubleFrames,
    testKubleEffects,
    testKubleAmber,
    testKubleView,
    testKubleLayout,
    testSubjectNone,
    testKublePostArgs,
    testHygiene
  ];
  let passed = 0;
  for (const test of tests) {
    test();
    passed += 1;
    console.log(`ok ${test.name}`);
  }
  const binaries = require('../lib/ffmpeg').binaries();
  if (binaries.available) {
    await testFfmpegPostPass(binaries);
    console.log('ok testFfmpegPostPass');
    passed += 1;
    await testNode(binaries);
    console.log('ok testNode');
    passed += 1;
  } else {
    console.log('skipped testFfmpegPostPass and testNode: ffmpeg is not installed');
  }
  console.log(`${passed} tests passed`);
  console.log('test-music-video-hud.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
