'use strict';

// The beat effects of the music video in the HUD style (WP45, WP49): the plan of the effects (lib/music-video-hud/effects.js), the page of a chunk with
// the effects (composition.js, runtime.fx.browser.js, fxsvg.js), the post-pass with the effects on (postpass.js), the parameter of the node and its
// texts. No network and nothing paid; ffmpeg and the HyperFrames of the render node are the real ones (those parts are skipped when they are missing).
//   parts      a song with parts: break, verse, chorus, bridge, drop from its lyrics (what comes back is a chorus) and its loudness; a song without
//              lyrics; a long part in phrases
//   palettes   3 to 5 kinds for every part, its own for every kind of part, the second chorus varies the first, from the seed of the song
//   variety    never a kind of the accent before, at most CAPS of a kind in any minute, every kind somewhere in a busy film and none takes over; zoom
//              punch and exposure pulse only on a loud downbeat, a strong hit or the start of a part; bursts of 6 to 12 frames on the strongest hits,
//              2 to 4 frames on the others; the stretches over bars
//   rules      at most 3 flashes in any second (with those of the HUD), no red flash, nothing on the end card or before the film, the face in a lip-sync
//              cut, a new graphic readable in its first half second, the copies of the footage inside one chunk
//   frames     frameEffects is a pure function of the song time: the part of the plan in the page of a chunk gives the frames of the whole plan, also
//              at the seams of the chunks; the zoom always covers the screen
//   visible    every kind sets its filter or layer as strong as the measure of WP49 found visible; with HyperFrames (render-node/node_modules, not with
//              HUD_FX_RENDER=0): every kind changes the frames it is drawn in and only those, the freeze and the stutter show exactly their frames
//   page       off is the page of before (byte for byte); on: the wrappers, the layers, the copies as clips of HyperFrames, the filters, the scripts,
//              the size; the runtime draws in the page what frameEffects says and leaves the layers of the HUD as they are
//   post-pass  off is the command of before; on: no glitch windows, the graph without glitch (grain, vignette, colour, encoding); with ffmpeg
//   node       the parameter (off, subtle, strong, wild; strong by default), its texts in de, en and es, the field of the three templates

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const effects = require('../lib/music-video-hud/effects');
const fxsvg = require('../lib/music-video-hud/fxsvg');
const graphicsLib = require('../lib/music-video-hud/graphics');
const chunksLib = require('../lib/music-video-hud/chunks');
const composition = require('../lib/music-video-hud/composition');
const post = require('../lib/music-video-hud/postpass');
const state = require('../lib/music-video-hud/state');
const view = require('../lib/music-video-hud/view');
const themes = require('../lib/music-video-hud/themes');

const FPS = 24;
const BAR_FRAMES = Math.round(((4 * 60) / 128) * FPS);
const prepare = (input, options = {}) => graphicsLib.prepareGraphics(input, { accent: '#3B82F6', ...options }).graphics;
const json = (value) => JSON.parse(JSON.stringify(value));

// The example song of graphics.js made into a song with parts (128 BPM, the bars of graphics.js): an intro without words, a verse, a chorus whose lines
// come back three times, a verse, the chorus, a bridge, the chorus, a loud drop without words and a quiet end; the loudness and the hits follow the
// parts, the plan marks the drop. The lines keep the times (and the graphics) of the example; a line in a part without words is left out.
const PARTS = [['intro', 5, 0.3], ['verse', 10, 0.45], ['chorus', 8, 0.75], ['verse', 8, 0.5], ['chorus', 8, 0.8], ['bridge', 8, 0.6], ['chorus', 8, 0.82], ['drop', 10, 0.97], ['outro', 7, 0.22]];
const CHORUS = ['We run all night', 'Under neon rain tonight', 'Hold the signal high', 'Never coming down again'];
function songWithParts() {
  const bar = (4 * 60) / 128;
  const first = 0.47;
  let at = 0;
  const parts = PARTS.map(([kind, bars, loud]) => {
    const part = { kind, from: at === 0 ? 0 : first + at * bar, to: first + (at + bars) * bar, loud };
    at += bars;
    return part;
  });
  const duration = Math.round(parts[parts.length - 1].to * 10) / 10;
  const demo = graphicsLib.demoGraphics({ duration });
  const partAt = (t) => parts.find((part) => t >= part.from && t < part.to) || parts[parts.length - 1];
  const keep = [];
  const counts = new Map();
  demo.lines.forEach((line, index) => {
    const part = partAt(line.start);
    if (!['verse', 'chorus', 'bridge'].includes(part.kind) || line.start + 3 > part.to + 0.5) return;
    const n = counts.get(part) || 0;
    counts.set(part, n + 1);
    const text = part.kind === 'chorus' ? CHORUS[n % CHORUS.length] : `Lyric${index} only${index} here${index} once${index}`;
    let t = line.start;
    const words = text.split(' ').map((word) => {
      const length = 0.26 + 0.045 * word.length;
      const item = { text: word, start: Math.round(t * 1000) / 1000, end: Math.round((t + length) * 1000) / 1000 };
      t += length + 0.04;
      return item;
    });
    keep.push({ index, line: { start: words[0].start, end: words[words.length - 1].end, key: Math.min(line.key, words.length - 1), words } });
  });
  const lineOf = new Map(keep.map((entry, i) => [entry.index, i]));
  const graphics = demo.graphics
    .filter((device) => lineOf.has(device.line))
    .map((device) => {
      const line = keep[lineOf.get(device.line)].line;
      return { ...device, line: lineOf.get(device.line), start: line.start, end: Math.min(duration, Math.max(device.end, line.end + 0.3)) };
    });
  const energy = demo.music.energy.map((_value, i) => Math.round((partAt(i).loud + 0.04 * Math.sin(i * 1.3)) * 1000) / 1000);
  const hits = demo.music.beats
    .filter((t) => t < duration)
    .map((t, i) => ({ t, part: partAt(t), i }))
    .filter(({ part, i }) => (part.kind === 'drop' ? i % 2 === 0 : i % 8 === 0))
    .map(({ t, part, i }) => ({ t, strength: Math.round(Math.min(1, part.loud + (i % 16 === 0 ? 0.1 : 0)) * 1000) / 1000 }));
  const drop = parts.find((part) => part.kind === 'drop');
  return { input: { ...demo, lines: keep.map((entry) => entry.line), graphics, music: { ...demo.music, energy, hits }, hud: { ...demo.hud, drops: [Math.round(drop.from * 1000) / 1000] } }, parts };
}

const { input: songInput, parts: songParts } = songWithParts();
const song = prepare(songInput);
const kubleSong = prepare(songInput, { theme: 'kuble' });
// the example of graphics.js: its lines come round again after a minute, so nearly all of it is a chorus
const film = prepare(graphicsLib.demoGraphics({ duration: 128.4 }));
const short = prepare(graphicsLib.demoGraphics({ duration: 12 }));
// a hit on every third beat: more accents of every sort
const crowded = (g) => ({ ...g, music: { ...g.music, hits: g.music.beats.filter((t, i) => i % 3 === 0 && t < g.duration).map((t, i) => ({ t, strength: 0.5 + ((i * 37) % 50) / 100 })) } });
const busy = crowded(song);
const plans = new Map();
const planOf = (g, level, glitch) => {
  const key = `${level} ${glitch}`;
  if (!plans.has(g)) plans.set(g, new Map());
  if (!plans.get(g).has(key)) plans.get(g).set(key, effects.planEffects(g, { level, glitch }));
  return plans.get(g).get(key);
};
const strong = planOf(song, 'strong');
const subtle = planOf(song, 'subtle');
const wild = planOf(song, 'wild');

const partAt = (plan, f) => plan.parts.find((part) => f >= part.f0 && f < part.f1);
// the chunk of a film that holds the frame f
const chunkAt = (g, f) => chunksLib.planChunks(g, { endcardSeconds: 3 }).find((chunk) => f >= chunk.startFrame && f < chunk.endFrame);
// a frame in the drop of the song with parts
const DROP_FRAME = Math.round(songParts[7].from * FPS) + 2 * BAR_FRAMES;
const inside = (spans, f) => spans.some(([a, b]) => f >= a && f < b);
const touches = (spans, f, n) => spans.some(([a, b]) => a < f + n && b > f);
// the most of the frames (sorted) in any `size` frames
function mostWithin(frames, size) {
  let most = 0;
  for (let i = 0; i < frames.length; i += 1) {
    let count = 0;
    for (let j = i; j < frames.length && frames[j] < frames[i] + size; j += 1) count += 1;
    most = Math.max(most, count);
  }
  return most;
}

/* ---------- the plan ---------- */

function testLevels() {
  assert.deepEqual(effects.LEVELS, ['off', 'subtle', 'strong', 'wild']);
  assert.equal(effects.DEFAULT_LEVEL, 'strong');
  for (const [value, level] of [['strong', 'strong'], [' Subtle ', 'subtle'], ['WILD', 'wild'], ['off', 'off'], [undefined, 'off'], ['', 'off'], ['loud', 'off'], [3, 'off'], [null, 'off']]) {
    assert.equal(effects.normalizeLevel(value), level, JSON.stringify(value));
  }
  assert.equal(effects.planEffects(song, { level: 'off' }), null);
  assert.equal(effects.planEffects(song, {}), null, 'no level is off');
  for (const plan of [strong, subtle, wild]) {
    assert.equal(plan.version, 2);
    assert.deepEqual([plan.fromF, plan.toF], [0, song.endFrame]);
    for (let i = 1; i < plan.events.length; i += 1) assert.ok(plan.events[i].f >= plan.events[i - 1].f, 'the events in the order of their frames');
    for (const event of plan.events) assert.ok((effects.KINDS[event.k] || event.k === 'negative') && Number.isInteger(event.f), JSON.stringify(event));
    for (const span of plan.spans) assert.ok(['split', 'noise', 'scan'].includes(span.k) && span.n >= 12, JSON.stringify(span));
    assert.ok(JSON.stringify(plan).length < 60000, 'small enough for the pages');
  }
  // more on the beat from subtle to wild; subtle leaves out its wildest kinds
  const count = (plan) => effects.accentsOf(plan).length;
  assert.ok(count(subtle) < count(strong) * 0.75 && count(wild) > count(strong) * 1.2, `accents: subtle ${count(subtle)}, strong ${count(strong)}, wild ${count(wild)}`);
  for (const event of subtle.events) assert.ok(!effects.LEVEL.subtle.never.includes(event.k), event.k);
  const amplitude = (plan, kind) => Math.max(...plan.events.filter((event) => event.k === kind).map((event) => event.a));
  assert.ok(amplitude(wild, 'rgb') > amplitude(strong, 'rgb') && amplitude(strong, 'rgb') > amplitude(subtle, 'rgb'));
  // the slider: 0 leaves out every glitch, more makes it stronger
  const none = planOf(song, 'strong', 0);
  assert.ok(none.events.every((event) => !(effects.KINDS[event.k] && effects.KINDS[event.k].glitch)) && none.spans.length === 0, 'no glitch at 0');
  assert.ok(none.parts.every((part) => part.palette.every((kind) => !effects.KINDS[kind].glitch)));
  assert.ok(amplitude(planOf(song, 'strong', 1), 'rgb') > amplitude(strong, 'rgb'));
}

// The parts of the song with parts, where it has them (a chorus is known from the bar on whose words come back with its neighbours': at most a bar late)
function testParts() {
  assert.deepEqual(strong.parts.map((part) => part.k), ['break', 'verse', 'chorus', 'verse', 'chorus', 'bridge', 'chorus', 'drop', 'break']);
  strong.parts.forEach((part, i) => {
    const expected = Math.round(songParts[i].from * FPS);
    assert.ok(part.f0 >= expected - 1 && part.f0 <= expected + BAR_FRAMES + 1, `${part.k} at ${part.f0}, the song has it at ${expected}`);
    if (i) assert.equal(part.f0, strong.parts[i - 1].f1, 'no gap between the parts');
  });
  assert.ok(strong.parts[0].f0 <= 0 && strong.parts[strong.parts.length - 1].f1 >= song.endFrame);
  assert.deepEqual(strong.parts.filter((part) => part.k === 'chorus').map((part) => part.n), [1, 2, 3]);
  // the colour: the chorus brighter and more colourful than the verse, the drop more than the chorus, a break greyer; a later chorus a little more
  const gradeOf = (kind, n = 1) => strong.parts.find((part) => part.k === kind && part.n === n).g;
  assert.ok(gradeOf('chorus')[0] > gradeOf('verse')[0] && gradeOf('chorus')[2] > gradeOf('verse')[2] && gradeOf('drop')[2] > gradeOf('chorus')[2] && gradeOf('break')[2] < 1);
  assert.ok(gradeOf('chorus', 2)[2] > gradeOf('chorus', 1)[2]);
  assert.ok(gradeOf('bridge')[2] < gradeOf('verse')[2], 'the bridge cooler');
  // the same parts from a copy of the data and in the style Kuble
  assert.deepEqual(effects.planEffects(json(song), { level: 'strong' }).parts, strong.parts);
  assert.deepEqual(planOf(kubleSong, 'strong').parts, strong.parts);
  // without lyrics: by the loudness (the quiet start a break, the loud stretch a drop)
  const plain = effects.planEffects(prepare({ ...songInput, lines: [], graphics: [] }), { level: 'strong' });
  assert.equal(plain.parts[0].k, 'break');
  const dropFrame = Math.round(songParts[7].from * FPS) + 3 * BAR_FRAMES;
  assert.equal(partAt(plain, dropFrame).k, 'drop');
  // lyrics that never come back: no chorus from them; the loud verse is a chorus
  const once = songInput.lines.map((line, i) => ({ ...line, words: line.words.map((word, k) => ({ ...word, text: `w${i}x${k}` })) }));
  const unique = effects.planEffects(prepare({ ...songInput, lines: once }), { level: 'strong' });
  assert.ok(unique.parts.some((part) => part.k === 'chorus') && unique.parts.some((part) => part.k === 'verse'), unique.parts.map((part) => part.k).join(' '));
  // a long part is cut into phrases of at most 12 bars (a later phrase varies the palette of the first)
  const bars = Array.from({ length: 40 }, (_x, i) => ({ start: i * 2, end: i * 2 + 2 }));
  const long = effects.partsOf({ lines: [], music: {}, hud: {} }, bars, bars.map(() => 0.9));
  assert.deepEqual(long.map((part) => [part.kind, part.b1 - part.b0, part.n]), [['drop', 10, 1], ['drop', 10, 2], ['drop', 10, 3], ['drop', 10, 4]]);
}

function testPalettes() {
  for (const [plan, level] of [[strong, 'strong'], [subtle, 'subtle'], [wild, 'wild'], [planOf(busy, 'strong'), 'strong']]) {
    for (const part of plan.parts) {
      assert.ok(part.palette.length >= 3 && part.palette.length <= 5, `${level} ${part.k}: ${part.palette}`);
      assert.equal(new Set(part.palette).size, part.palette.length);
      for (const kind of part.palette) assert.ok(effects.PALETTES[part.k].pool.includes(kind) && !effects.LEVEL[level].never.includes(kind), `${level} ${part.k}: ${kind}`);
    }
  }
  // every kind of part its own palette; the first part of a kind leads with a kind of its own sort and takes at most two of the part before it
  const firstOf = (kind) => strong.parts.find((part) => part.k === kind);
  const sorted = (list) => list.slice().sort().join(' ');
  for (const a of effects.PART_KINDS) for (const b of effects.PART_KINDS) if (a < b) assert.notEqual(sorted(firstOf(a).palette), sorted(firstOf(b).palette), `${a} and ${b}`);
  for (const kind of effects.PART_KINDS) assert.ok(effects.PALETTES[kind].first.includes(firstOf(kind).palette[0]), `${kind} leads with ${firstOf(kind).palette[0]}`);
  strong.parts.forEach((part, i) => {
    if (i === 0 || firstOf(part.k) !== part) return;
    const shared = part.palette.filter((kind) => strong.parts[i - 1].palette.includes(kind));
    assert.ok(shared.length <= 2, `${part.k} shares ${shared} with the part before it`);
  });
  // the second chorus varies the first: the same lead, not the same palette, most of it kept
  const choruses = strong.parts.filter((part) => part.k === 'chorus');
  assert.equal(choruses[1].palette[0], choruses[0].palette[0]);
  assert.notDeepEqual(choruses[1].palette, choruses[0].palette);
  assert.ok(choruses[1].palette.filter((kind) => choruses[0].palette.includes(kind)).length >= 2);
  // from the seed of the song: the same song gives the same palettes, other songs (another tempo) mostly others
  assert.deepEqual(effects.planEffects(song, { level: 'strong' }).parts.map((part) => part.palette), strong.parts.map((part) => part.palette));
  const palettes = (g) => JSON.stringify(effects.planEffects(g, { level: 'strong' }).parts.map((part) => part.palette));
  const others = [126, 127, 129, 130].filter((bpm) => palettes({ ...song, music: { ...song.music, bpm } }) !== palettes(song));
  assert.ok(others.length >= 3, `other palettes for ${others.length} of 4 other songs`);
}

// Variety: never a kind of the accent before; at most CAPS of a kind in any minute; in a busy film every kind somewhere and none takes over; zoom punch
// and exposure pulse only on a loud downbeat, a strong hit or the start of a part.
function testVariety() {
  for (const [name, g, level] of [['song', song, 'strong'], ['song', song, 'subtle'], ['song', song, 'wild'], ['kuble', kubleSong, 'strong'], ['busy', busy, 'strong'], ['busy', busy, 'wild'], ['example', film, 'strong'], ['short', short, 'strong']]) {
    const plan = planOf(g, level);
    const accents = effects.accentsOf(plan);
    assert.ok(accents.length >= 3, `${name} ${level}: ${accents.length} accents`);
    for (let i = 1; i < accents.length; i += 1) {
      assert.ok(!accents[i].kinds.some((kind) => accents[i - 1].kinds.includes(kind)), `${name} ${level}: ${accents[i - 1].kinds} and then ${accents[i].kinds} at frame ${accents[i].f}`);
    }
    for (const kind of Object.keys(effects.KINDS)) {
      const frames = accents.filter((accent) => accent.kinds.includes(kind)).map((accent) => accent.f);
      const cap = Math.max(1, Math.round(effects.CAPS[kind] * effects.LEVEL[level].caps));
      assert.ok(mostWithin(frames, 60 * FPS) <= cap, `${name} ${level}: ${mostWithin(frames, 60 * FPS)} of ${kind} in a minute, at most ${cap}`);
    }
    // punch and pulse
    const beats = effects.beatsOf(g);
    const bars = effects.barsOf(g, beats);
    const rank = effects.barRanks(g, bars);
    const loudDowns = new Set(bars.filter((_bar, b) => rank[b] >= 0.5).map((bar) => Math.round(bar.start * FPS)));
    const hitFrames = (g.music.hits || []).map((hit) => Math.round(hit.t * FPS));
    const starts = new Set(plan.parts.map((part) => part.f0));
    for (const event of plan.events.filter((item) => item.k === 'punch' || item.k === 'pulse')) {
      assert.ok(event.x > 0, 'on an accent');
      const near = hitFrames.some((f) => Math.abs(f - event.f) < effects.LEVEL[level].gap);
      assert.ok(near || starts.has(event.f) || loudDowns.has(event.f), `${name} ${level}: ${event.k} at ${event.f} is not on a loud downbeat, a hit or a start`);
    }
  }
  // the busy film: every kind (and the stretch of the RGB split), none more than a fifth of the accents
  const plan = planOf(busy, 'strong');
  const accents = effects.accentsOf(plan);
  const counts = {};
  for (const accent of accents) for (const kind of accent.kinds) counts[kind] = (counts[kind] || 0) + 1;
  for (const kind of Object.keys(effects.KINDS)) assert.ok(counts[kind] > 0, `the busy film has no ${kind}`);
  assert.ok(plan.spans.some((span) => span.k === 'split'));
  const most = Math.max(...Object.values(counts));
  assert.ok(most <= accents.length * 0.2, `one kind on ${most} of ${accents.length} accents`);
  // the parts differ: the kinds of the drop are not those of the verse
  const kindsIn = (kind) => new Set(accents.filter((accent) => partAt(plan, accent.f).k === kind).map((accent) => accent.kind));
  const [verse, drop] = [kindsIn('verse'), kindsIn('drop')];
  assert.ok([...drop].filter((kind) => verse.has(kind)).length <= 2, `verse ${[...verse]}, drop ${[...drop]}`);
}

// The glitch on the strongest hits bursts for 6 to 12 frames, on the other accents it lasts 2 to 4 frames; the long kinds 6 to 12; the stretches.
function testLengths() {
  const glitchKinds = ['rgb', 'blocks', 'slices', 'noise', 'snow', 'pixel'];
  for (const [g, level] of [[song, 'strong'], [busy, 'strong'], [song, 'wild'], [song, 'subtle']]) {
    const plan = planOf(g, level);
    const rules = effects.LEVEL[level];
    const glitch = plan.events.filter((event) => glitchKinds.includes(event.k) && event.x);
    for (const event of glitch) assert.ok((event.n >= 2 && event.n <= 4) || (event.n >= 6 && event.n <= 12), `${level}: ${event.k} of ${event.n} frames`);
    for (const event of plan.events.filter((item) => ['scan', 'vhs', 'roll', 'smear', 'stutter', 'echo', 'mirror'].includes(item.k))) assert.ok(event.n >= 6 && event.n <= 12, `${level}: ${event.k} of ${event.n} frames`);
    const burst = glitch.filter((event) => event.n >= 6).length;
    const shortOnes = glitch.filter((event) => event.n <= 4).length;
    assert.ok(burst >= 4 && shortOnes >= 10, `${level}: ${burst} bursts, ${shortOnes} short`);
    // the strongest hits of the song (their percentile from burstFrom on) burst
    const hits = g.music.hits;
    const hitRank = effects.ranks(hits.map((hit) => hit.strength));
    for (let i = 0; i < hits.length; i += 1) {
      if (hitRank[i] < rules.burstFrom) continue;
      const f = Math.round(hits[i].t * FPS);
      for (const event of glitch.filter((item) => Math.abs(item.f - f) < rules.gap)) assert.ok(event.n >= 6, `${level}: the ${event.k} on the strong hit at ${f} lasts ${event.n} frames`);
    }
  }
  // the stretches: the RGB split over the first bars of the drop (and again every 8 bars), noise into the bridge, scanlines in a break
  const drop = strong.parts.find((part) => part.k === 'drop');
  const bridge = strong.parts.find((part) => part.k === 'bridge');
  const splits = strong.spans.filter((span) => span.k === 'split');
  assert.ok(splits.length >= 2 && splits[0].f === drop.f0 && splits.every((span) => span.n >= BAR_FRAMES * 2 - 2 && span.f >= drop.f0 && span.f + span.n <= drop.f1 && span.a >= 9));
  const into = strong.spans.find((span) => span.k === 'noise');
  assert.ok(into.f < bridge.f0 && into.f + into.n > bridge.f0 && into.top === bridge.f0 - into.f);
  assert.ok(strong.spans.some((span) => span.k === 'scan' && partAt(strong, span.f).k === 'break'));
  assert.equal(subtle.spans.filter((span) => span.k === 'split').length, 2, 'subtle: one bar of split in each of the two drops of 8 bars');
}

function testDeterminism() {
  assert.deepEqual(effects.planEffects(song, { level: 'strong' }), strong);
  assert.deepEqual(effects.planEffects(json(song), { level: 'strong' }), strong, 'the same from a copy of the data');
  assert.deepEqual(json(strong), strong, 'the plan is plain data');
  for (const t of [0, 3.3, 47.125, 100, 110]) assert.deepEqual(effects.frameEffects(strong, t), effects.frameEffects(json(strong), t));
  // the Kuble plan has the same accents except the flashes (the pulse of the HUD of Kuble counts for the limit) and other colours
  const kuble = planOf(kubleSong, 'strong');
  const noFlash = (plan) => effects.accentsOf(plan).filter((accent) => !accent.kinds.includes('flash') && !accent.kinds.includes('snow')).map((accent) => accent.f);
  assert.ok(noFlash(kuble).filter((f) => noFlash(strong).includes(f)).length >= noFlash(strong).length * 0.8);
  assert.notDeepEqual(kuble.look, strong.look);
  // the strength of a hit and the loudness count as percentiles of the song: a quieter song has the same plan
  const quieter = { ...song, music: { ...song.music, hits: song.music.hits.map((hit) => ({ ...hit, strength: hit.strength * 0.5 })), energy: song.music.energy.map((value) => value * 0.7) } };
  assert.deepEqual(effects.planEffects(quieter, { level: 'strong' }).events, strong.events);
  assert.deepEqual(effects.ranks([3, 1, 2]), [1, 0, 0.5]);
  assert.deepEqual(effects.ranks([5, 5, 1]), [0.75, 0.75, 0]);
}

// At most 3 flashes in any second: the planned ones (light, strobe, negative, snow) and those the HUD draws (a cut with the transition flash, the pulse
// of Kuble). When the plan of the HUD alone has more, the effects add none there.
function testFlashLimit() {
  for (const [g, level] of [[song, 'strong'], [song, 'wild'], [song, 'subtle'], [kubleSong, 'strong'], [busy, 'wild'], [short, 'strong'], [film, 'strong']]) {
    const frames = effects.flashFrames(planOf(g, level), g);
    assert.ok(mostWithin(frames, FPS) <= effects.FLASH_LIMIT, `${g.theme} ${level}: ${mostWithin(frames, FPS)} flashes in a second`);
  }
  const full = {
    ...kubleSong,
    cuts: kubleSong.cuts.map((cut, index) => ({ ...cut, transition: index % 2 ? 'flash' : cut.transition })),
    music: { ...kubleSong.music, hits: kubleSong.music.beats.map((t) => ({ t, strength: 0.95 })) }
  };
  const plan = effects.planEffects(full, { level: 'wild' });
  const own = effects.fixedFlashFrames(full);
  const all = effects.flashFrames(plan, full);
  for (let f = 0; f < full.endFrame; f += 6) {
    const count = (list) => list.filter((x) => x >= f && x < f + FPS).length;
    assert.ok(count(all) <= Math.max(effects.FLASH_LIMIT, count(own)), `frame ${f}: ${count(all)} flashes, ${count(own)} of the HUD`);
    if (count(own) >= effects.FLASH_LIMIT) assert.equal(count(all), count(own), `frame ${f}: no flash of the effects where the HUD has 3`);
  }
  // the white of a cut with the flash of the HUD (its first two frames and the frame before) takes no accent and no flash of the effects: the effect
  // starts after it, a cut takes none
  for (const [g, level] of [[full, 'wild'], [{ ...song, cuts: song.cuts.map((cut, index) => ({ ...cut, transition: index % 3 ? cut.transition : 'flash' })) }, 'strong']]) {
    const whites = g.cuts.filter((cut, index) => index > 0 && cut.transition === 'flash').map((cut) => Math.round(cut.start * FPS));
    const onWhite = (f) => whites.some((white) => f >= white - 1 && f <= white + 1);
    const flashPlan = effects.planEffects(g, { level });
    const accents = effects.accentsOf(flashPlan);
    assert.ok(accents.length > 20 && whites.length > 5);
    for (const accent of accents) assert.ok(!onWhite(accent.f), `${level}: an accent at ${accent.f} on the white of a flash cut`);
    for (const event of flashPlan.events.filter((item) => item.k === 'flash' || item.k === 'negative')) assert.ok(!onWhite(event.f), `${level}: a flash at ${event.f} on the white`);
    assert.ok(accents.some((accent) => whites.includes(accent.f - 2)), `${level}: an accent after the white`);
  }
  assert.equal(effects.flashFits([0, 10], 20), true);
  assert.equal(effects.flashFits([0, 10, 20], 23), false);
  assert.equal(effects.flashFits([0, 10, 20], 24), true);
}

// No red flash: a red accent flashes white (HUD Blue) or ink (Kuble); the negative flash is grey (HUD Blue) or night blue (Kuble).
function testNoRed() {
  for (const hex of ['#FF0000', '#E11D48', '#C81E1E', '#FF3B30', '#D9145A', '#5A2020']) assert.equal(effects.isRed(hex), true, hex);
  for (const hex of ['#3B82F6', '#2E5CFF', '#FFFFFF', '#F2F4F8', '#22C55E', '#F7901F', '#3D3535', '#777777', '#000000']) assert.equal(effects.isRed(hex), false, hex);
  assert.equal(effects.safeFlashColor('#ff0000'), '#FFFFFF');
  assert.equal(effects.safeFlashColor('#3b82f6'), '#3B82F6');
  assert.equal(effects.safeFlashColor('not a colour'), '#FFFFFF');
  for (const [theme, accent] of [['hud', '#FF0000'], ['hud', '#E11D48'], ['hud', '#22C55E'], ['kuble', '#FF0000'], ['kuble', '#F7901F']]) {
    const g = prepare(songInput, { theme, accent });
    const plan = effects.planEffects(g, { level: 'wild' });
    for (const color of plan.look.colors) assert.ok(!effects.isRed(color), `${theme} ${accent}: ${color}`);
    if (theme === 'kuble') assert.deepEqual(plan.look.colors, ['#F2F4F8', '#2E5CFF'], 'Kuble: ink and Kuble Blue, never amber');
    else assert.equal(plan.look.colors[1], effects.isRed(accent) ? '#FFFFFF' : accent);
    assert.match(plan.look.invert, /grayscale\(1\)/, 'the negative has no colour of the picture');
    assert.ok(plan.events.some((event) => event.k === 'flash'));
    for (let f = 0; f < g.endFrame; f += 1) {
      const flash = effects.frameEffects(plan, f / FPS).flash;
      if (flash) assert.ok(!effects.isRed(flash.color) && flash.alpha > 0 && flash.alpha <= 1);
    }
  }
}

// Nothing on the end card and nothing before the first frame of the film; the events, stretches and copies lie in the film.
function testEndcardFree() {
  const excerpt = { ...song, start: 40, endFrame: Math.round(70 * FPS), cuts: song.cuts.filter((cut) => cut.end > 40 && cut.start < 70) };
  const neutral = effects.frameEffects(null, 0);
  for (const g of [song, short, excerpt]) {
    for (const level of ['subtle', 'strong', 'wild']) {
      const plan = effects.planEffects(g, { level });
      const first = Math.round(g.start * FPS);
      assert.ok(plan.events.every((event) => event.f >= first && event.f + (event.n || 1) <= g.endFrame), `${level}: every event in the film`);
      assert.ok(plan.spans.every((span) => span.f >= first && span.f + span.n <= g.endFrame), `${level}: every stretch in the film`);
      assert.ok(plan.copies.every((copy) => copy.f >= first && copy.m >= first && copy.f + copy.n <= g.endFrame), `${level}: every copy in the film`);
      for (let f = g.endFrame; f < g.endFrame + 4 * FPS; f += 1) assert.deepEqual(effects.frameEffects(plan, f / FPS), neutral, `the end card, frame ${f}`);
      for (let f = Math.max(0, first - 30); f < first; f += 1) assert.deepEqual(effects.frameEffects(plan, f / FPS), neutral, `before the film, frame ${f}`);
    }
  }
}

// The face in a lip-sync cut: no bulge and no wave in the whole cut; while a word is sung (one frame before and after it) nothing that pulls it out of
// shape and no glitch over the whole picture: zoom, pulse, turn, light and colour as they are, a smaller shake, noise and scanlines light and without
// line offset, colour edges and RGB split of at most SUNG_SPLIT_PX (3 px: the eyes and the mouth stay sharp); no copy of the footage (the mouth would
// not fit the song).
function testSungWords() {
  const lip = effects.lipOf(song);
  const quiet = effects.quietOf(song);
  assert.ok(lip.length >= 5 && quiet.length >= 10, 'the song sings in lip-sync cuts');
  for (const level of ['strong', 'wild', 'subtle']) {
    const plan = planOf(song, level);
    for (let f = 0; f < song.endFrame; f += 1) {
      const fx = effects.frameEffects(plan, f / FPS);
      if (inside(lip, f)) assert.ok(fx.bulge === 0 && fx.wave === 0, `${level} frame ${f}: no bulge or wave on the face`);
      if (!inside(quiet, f)) continue;
      assert.ok(fx.blur === 0 && fx.chroma <= effects.SUNG_SPLIT_PX && !fx.pixel && !fx.smear && !fx.jitter, `${level} frame ${f}: no distortion while a word is sung`);
      assert.ok(!fx.split || Math.hypot(fx.split[0], fx.split[1]) <= effects.SUNG_SPLIT_PX + 0.2, `${level} frame ${f}: split ${fx.split}`);
      assert.ok(!fx.rgb && !fx.slices && !fx.blocks && !fx.vhs && !fx.roll && !fx.snow, `${level} frame ${f}: no glitch over the face`);
      assert.ok(!fx.noise || fx.noise[0] <= 0.25, `${level} frame ${f}: light noise`);
    }
    for (const event of plan.events) {
      const spec = effects.KINDS[event.k];
      if (!spec) continue;
      const n = event.n || 1;
      if (spec.lip === false) assert.ok(!touches(lip, event.f, n), `${level}: ${event.k} at ${event.f} in a lip-sync cut`);
      if (spec.sung === false) assert.ok(!touches(quiet, event.f, n), `${level}: ${event.k} at ${event.f} on a sung word`);
    }
    for (const copy of plan.copies) assert.ok(!touches(quiet, copy.f, copy.n), `${level}: a copy at ${copy.f} on a sung word`);
  }
  // the words: one frame before and after, inside the cut; a gap of one frame is closed
  const g = {
    ...short,
    cuts: [{ start: 0, end: 2, kind: 'performance' }, { start: 2, end: 4, kind: 'story' }],
    lines: [{ start: 0.5, end: 3, words: [{ start: 0.5, end: 1 }, { start: 1.05, end: 1.5 }, { start: 1.9, end: 3 }] }]
  };
  assert.deepEqual(effects.quietOf(g), [[11, 37], [45, 48]], 'the words 0.5 to 1.5 s (with the gap of one frame), the third word only in the sung cut');
  assert.deepEqual(effects.lipOf(g), [[0, 48]]);
}

// A new graphic of the HUD is readable in its first half second: no effect over the whole picture in those frames.
function testFresh() {
  const fresh = effects.freshOf(song);
  assert.ok(fresh.length >= 20 && fresh.every(([a, b]) => b - a >= effects.FRESH_FRAMES));
  for (const level of ['strong', 'wild']) {
    const plan = planOf(busy, level);
    for (const event of plan.events) if (effects.WHOLE_KINDS.includes(event.k)) assert.ok(!touches(fresh, event.f, event.n || 1), `${level}: ${event.k} at ${event.f} over a new graphic`);
    for (const [a, b] of fresh) {
      for (let f = a; f < b; f += 1) {
        const fx = effects.frameEffects(plan, f / FPS);
        assert.ok(!fx.rgb && !fx.slices && !fx.blocks && !fx.vhs && !fx.roll && !fx.snow, `${level} frame ${f}`);
      }
    }
  }
}

// The copies of the footage (freeze, stutter, echo, mirror) are clips of HyperFrames with their own place in the footage: every copy and the frames it
// shows lie in the footage of one chunk, however the film is cut into chunks; the page has every copy of its chunk, frame exact.
function testCopies() {
  // the time of a frame: never above it (HyperFrames takes floor((time - start) * fps) as the frame of the clip), at most a microsecond below
  for (let frame = 0; frame < 30 * FPS; frame += 1) {
    const value = Number(composition.frameAttr(frame));
    assert.ok(value <= frame / FPS + 1e-12 && value > frame / FPS - 1.1e-6, `frame ${frame}: ${value}`);
    assert.equal(Math.floor((frame / FPS - value) * FPS + 1e-9), 0);
    assert.equal(Math.floor(((frame + 1) / FPS - value) * FPS + 1e-9), 1, `frame ${frame}: the next frame of the clip is its second`);
  }
  for (const [g, level] of [[song, 'strong'], [busy, 'wild'], [kubleSong, 'strong'], [film, 'wild']]) {
    const plan = planOf(g, level);
    assert.ok(plan.copies.length >= 5, `${level}: ${plan.copies.length} copies`);
    for (const copy of plan.copies) {
      assert.ok(copy.n >= 1 && copy.n <= effects.LONGEST_FRAMES && [1, 0.1].includes(copy.r) && copy.s in effects.COPY_STYLES, JSON.stringify(copy));
      if (copy.r === 0.1) assert.ok(copy.n <= effects.HOLD_FRAMES, 'a held frame: at most 4 frames a clip, so the frame stays exact');
    }
    for (const endcardSeconds of [0, 3]) {
      const chunks = chunksLib.planChunks(g, { endcardSeconds });
      for (const copy of plan.copies) {
        const chunk = chunks.find((item) => copy.f >= item.startFrame && copy.f < item.endFrame);
        assert.ok(chunk && copy.f + copy.n <= chunk.endFrame && copy.m >= chunk.startFrame && copy.m + Math.ceil(copy.n * copy.r) <= chunk.endFrame, `${level}: the copy ${JSON.stringify(copy)} leaves its chunk`);
      }
    }
    const chunks = chunksLib.planChunks(g, { endcardSeconds: 3 });
    for (const chunk of chunks) {
      const html = composition.buildChunkHtml({ graphics: g, chunk, clipFile: 'a.mp4', options: { karaoke: false, effects: level } });
      const mine = plan.copies.filter((copy) => copy.f >= chunk.startFrame && copy.f < chunk.endFrame);
      const clips = [...html.matchAll(/<video id="fxc(\d+)" class="clip" src="a\.mp4" muted playsinline data-start="([\d.]+)" data-duration="([\d.]+)" data-media-start="([\d.]+)"(?: data-playback-rate="([\d.]+)")? data-track-index="(\d+)"(?: style="([^"]*)")?><\/video>/g)];
      assert.equal(clips.length, mine.length, `chunk ${chunk.index + 1}`);
      clips.forEach((clip, i) => {
        const copy = mine[i];
        assert.equal(clip[2], composition.frameAttr(copy.f - chunk.startFrame));
        assert.equal(clip[3], composition.durationAttr(copy.n / FPS));
        assert.equal(clip[4], composition.frameAttr(copy.m - chunk.startFrame));
        assert.equal(clip[5], copy.r === 1 ? undefined : String(copy.r));
        assert.equal(clip[6], String(i + 1), 'every clip on a track of its own');
        assert.equal(clip[7] || '', effects.COPY_STYLES[copy.s]);
      });
    }
  }
}

/* ---------- the frames ---------- */

// The page of a chunk carries the part of the plan it needs: every frame of every chunk is the frame of the whole plan, also at the seams; the zoom
// always covers the screen when the picture moves, turns or waves.
function testFrames() {
  for (const [g, level] of [[song, 'strong'], [kubleSong, 'wild'], [busy, 'subtle']]) {
    const plan = planOf(g, level);
    const chunks = chunksLib.planChunks(g, { endcardSeconds: 3 });
    assert.ok(chunks.length >= 5);
    for (const chunk of chunks) {
      const slice = json(effects.sliceEffects(plan, chunk.start, chunk.start + chunk.duration));
      assert.ok(slice.events.length < plan.events.length);
      const frames = Math.round(chunk.duration * FPS);
      for (let i = 0; i < frames; i += 1) {
        const t = chunk.start + i / FPS;
        assert.deepEqual(effects.frameEffects(slice, t), effects.frameEffects(plan, t), `${g.theme} ${level}: chunk ${chunk.index + 1}, frame ${i}`);
      }
    }
  }
  let moved = 0;
  for (const plan of [strong, wild]) {
    for (let f = 0; f < song.endFrame; f += 1) {
      const fx = effects.frameEffects(plan, f / FPS);
      for (const value of Object.values(fx)) if (typeof value === 'number') assert.ok(Number.isFinite(value));
      if (fx.x || fx.y || fx.rot) moved += 1;
      const angle = (fx.rot * Math.PI) / 180;
      for (const [cx, cy] of [[-960, -540], [960, -540], [-960, 540], [960, 540]]) {
        const vx = cx - fx.x;
        const vy = cy - fx.y;
        const px = (vx * Math.cos(angle) + vy * Math.sin(angle)) / fx.zoom;
        const py = (-vx * Math.sin(angle) + vy * Math.cos(angle)) / fx.zoom;
        const margin = fx.wave / 2 + (fx.dir === 1 ? fx.blur * 2.5 : 0);
        assert.ok(Math.abs(px) <= 960 - margin + 0.6 && Math.abs(py) <= 540 + 0.6, `frame ${f}: the corner ${cx},${cy} is off the picture`);
      }
    }
  }
  assert.ok(moved > 200, 'the picture moves');
  const punch = strong.events.find((event) => event.k === 'punch' && event.a > 0.05);
  const zoomAt = (f) => effects.frameEffects(strong, f / FPS).zoom;
  assert.ok(zoomAt(punch.f) >= 1 + punch.a - 1e-4 && zoomAt(punch.f + 6) < zoomAt(punch.f));
}

/* ---------- visible ---------- */

// Every kind draws as strong as the measure on the film of 2026-10-09 found visible (IMPLEMENTATION-NOTES WP49): at strong with the slider at its
// default the weakest accent of every kind is at least the amplitude whose frames changed by more than VISIBLE of the picture there (the exposure
// pulse, which fades in 9 frames: on its first frames).
function testVisible() {
  const plan = planOf(busy, 'strong');
  const look = (event, f = event.f) => effects.frameEffects(plan, f / FPS);
  const firstOf = (kind) => plan.events.filter((event) => event.k === kind && event.x && !event.w);
  const svgValue = (drawn, id, attribute) => Number((drawn.svg.find(([a, b]) => a === id && b === attribute) || [])[2]);
  const checks = {
    punch: (e) => look(e).zoom >= 1.039,
    pulse: (e) => look(e).b - partAt(plan, e.f).g[0] >= 0.129,
    shake: (e) => Math.max(...[0, 1, 2].map((k) => Math.hypot(look(e, e.f + k).x, look(e, e.f + k).y))) >= 4,
    turn: (e) => Math.abs(look(e).rot) >= 1.1,
    bulge: (e) => look(e).bulge >= 79,
    wave: (e) => Math.max(...[0, 1, 2, 3, 4].map((k) => look(e, e.f + k).wave)) >= 13,
    chroma: (e) => look(e).chroma >= 31,
    blur: (e) => look(e, e.f + 1).blur >= 13,
    flash: (e) => look(e).flash && look(e).flash.alpha >= 0.5,
    rgb: (e) => Math.abs(svgValue(effects.view(look(e)), 'fa-rgb-r', 'dx')) + Math.abs(svgValue(effects.view(look(e)), 'fa-rgb-r', 'dy')) >= 7,
    noise: (e) => effects.view(look(e)).grain.startsWith('opacity:') && look(e).noise[0] >= 0.41,
    snow: (e) => look(e).snow[0] >= 0.37,
    blocks: (e) => look(e).blocks[1] >= 105,
    slices: (e) => Math.max(...look(e).slices.map((slice) => Math.abs(slice[2]))) >= 30,
    pixel: (e) => look(e).pixel >= 16,
    scan: (e) => look(e).scan >= 0.29 && look(e).jitter[0] >= 10,
    vhs: (e) => look(e).vhs[2] >= 89,
    roll: (e) => look(e, e.f + Math.floor(e.n / 2)).roll >= 400,
    smear: (e) => look(e, e.f + e.n - 1).smear[0] >= 119,
    stutter: (e) => plan.copies.some((copy) => copy.f === e.f),
    echo: (e) => plan.copies.some((copy) => copy.f === e.f && copy.s === 'echo' && copy.m === e.f - 4),
    mirror: (e) => plan.copies.some((copy) => copy.f === e.f && ['left', 'right', 'kx'].includes(copy.s))
  };
  for (const kind of Object.keys(effects.KINDS)) {
    const list = firstOf(kind);
    assert.ok(list.length, `the busy film has ${kind}`);
    for (const event of list) {
      // while a word is sung the kinds that may be there are smaller on purpose (testSungWords)
      if (effects.KINDS[kind].sung === 'small' && touches(plan.quiet, event.f, event.n || 3)) continue;
      assert.ok(checks[kind](event), `${kind} at ${event.f} is too weak: ${JSON.stringify(event)}`);
    }
  }
  // the long split of the drop: 9 px and more in its middle
  const split = plan.spans.find((span) => span.k === 'split');
  const middle = look(split, split.f + Math.floor(split.n / 2)).split;
  assert.ok(Math.hypot(middle[0], middle[1] * 2) >= 9);
}

// With the HyperFrames of the render node: a page of 8 s with one effect of each sort at known frames on moving test footage, drawn with the effects
// (on) and without them on a reference footage (ref) whose frames are already frozen and repeated where the freeze and the stutter are. Every effect
// changes its frames (more than VISIBLE of the picture by more than 16 of 255 in a channel), the frames before and after it stay (frame exact); the
// freeze and the stutter show exactly the frames of the reference (the HUD moves the camera over them as over the footage).
const VISIBLE = 0.05;
async function testRender(binaries) {
  const cli = path.join(__dirname, '..', 'render-node', 'node_modules', 'hyperframes', 'dist', 'cli.js');
  if (process.env.HUD_FX_RENDER === '0' || !fs.existsSync(cli)) return 'HyperFrames of the render node is not installed (or HUD_FX_RENDER=0)';
  const { execFile } = require('child_process');
  const run = (file, args, options = {}) => new Promise((resolve, reject) => execFile(file, args, { maxBuffer: 1024 * 1024 * 1024, encoding: 'buffer', ...options }, (err, stdout, stderr) => (err ? reject(new Error(`${path.basename(file)}: ${String(stderr).slice(-600) || err.message}`)) : resolve(stdout))));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hud-fx-render-'));
  try {
    // the HUD without words and graphics, one long shot: the middle of the picture is the footage, no cut moves it
    const g = prepare({ ...songInput, lines: [], graphics: [], cuts: [{ ...songInput.cuts[1], start: 0, end: songInput.duration, crop: { scale: 1, x: 0.5, y: 0.5 }, transition: 'cut' }] });
    const startFrame = 24 * 24;
    const frames = 8 * 24;
    const chunk = { index: 0, startFrame, endFrame: startFrame + frames, start: startFrame / FPS, end: (startFrame + frames) / FPS, frames, seconds: frames / FPS, clipSeconds: frames / FPS, duration: frames / FPS, pageFrames: frames, last: false };
    const hold = (f, n) => Array.from({ length: Math.ceil(n / 4) }, (_x, k) => ({ f: f + 4 * k, n: Math.min(4, n - 4 * k), m: f, r: 0.1, s: 'plain' }));
    const items = [
      ['rgb', { k: 'rgb', n: 6, a: 30, v: 1 }],
      ['slices', { k: 'slices', n: 6, a: 240, v: 2 }],
      ['blocks', { k: 'blocks', n: 6, a: 240, v: 0 }],
      ['vhs', { k: 'vhs', n: 6, a: 140, h: 150, y0: 300, y1: 600 }],
      ['roll', { k: 'roll', n: 6 }],
      ['snow', { k: 'snow', n: 4, a: 0.55, v: 1 }],
      ['noise', { k: 'noise', n: 4, a: 0.6, v: 1 }],
      ['scan', { k: 'scan', n: 6, a: 0.42, j: 18 }],
      ['pixel', { k: 'pixel', n: 4, a: 32 }],
      ['smear', { k: 'smear', n: 6, a: 200 }, (f) => hold(f, 6)],
      ['echo', { k: 'echo', n: 6 }, (f) => [{ f, n: 6, m: f - 4, r: 1, s: 'echo' }]],
      ['mirror', { k: 'mirror', n: 6, v: 0 }, (f) => [{ f, n: 6, m: f, r: 1, s: 'left' }]],
      ['freeze', { k: 'stutter', n: 8, v: 1 }, (f) => hold(f, 8)],
      ['stutter', { k: 'stutter', n: 8, v: 0 }, (f) => [{ f, n: 4, m: f - 4, r: 1, s: 'plain' }, { f: f + 4, n: 4, m: f - 4, r: 1, s: 'plain' }]],
      ['flash', { k: 'flash', c: 1, a: 0.65, n: 2, m: 1 }]
    ];
    let at = startFrame + 6;
    const placed = [];
    const events = [];
    const copies = [];
    for (const [name, event, makeCopies] of items) {
      placed.push({ name, f: at, n: event.n });
      events.push({ ...event, f: at });
      if (makeCopies) copies.push(...makeCopies(at));
      at += event.n + 5;
    }
    assert.ok(at < startFrame + frames - 3);
    const base = planOf(g, 'strong');
    const plan = { ...base, parts: [{ f0: 0, f1: g.endFrame, k: 'verse', n: 1, g: [1, 1, 1], m: 0, palette: [] }], quiet: [], fresh: [], events, spans: [], copies };
    // the footage: a test pattern with edges in both directions that scrolls, so every frame differs from the one before it; the reference: the same
    // with the frame of the freeze held and the four frames before the stutter twice
    const local = (name) => placed.find((item) => item.name === name).f - startFrame;
    const [F, S] = [local('freeze'), local('stutter')];
    const pieces = [`trim=end_frame=${F}`, `trim=start_frame=${F}:end_frame=${F + 1},setpts=PTS-STARTPTS,loop=loop=7:size=1:start=0`, `trim=start_frame=${F + 8}:end_frame=${S}`, `trim=start_frame=${S - 4}:end_frame=${S}`, `trim=start_frame=${S - 4}:end_frame=${S}`, `trim=start_frame=${S + 8}`];
    const graph = [
      `[0:v]split[a][b];[b]transpose=1,scale=1920:1080,hflip[c];[a][c]blend=all_mode=average,scroll=horizontal=0.004:vertical=0.002,format=yuv420p,trim=end_frame=${frames},split=${pieces.length + 1}[out]${pieces.map((_p, i) => `[s${i}]`).join('')}`,
      ...pieces.map((piece, i) => `[s${i}]${piece},setpts=PTS-STARTPTS[p${i}]`),
      `${pieces.map((_p, i) => `[p${i}]`).join('')}concat=n=${pieces.length}:v=1:a=0,setpts=N/24/TB[ref]`
    ].join(';');
    const encode = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p'];
    await run(binaries.ffmpeg, ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24', '-filter_complex', graph, '-map', '[out]', ...encode, path.join(dir, 'footage.mp4'), '-map', '[ref]', ...encode, path.join(dir, 'ref.mp4')]);
    const env = { ...process.env, HYPERFRAMES_NO_UPDATE_CHECK: '1', HYPERFRAMES_NO_AUTO_INSTALL: '1', HYPERFRAMES_NO_TELEMETRY: '1', HYPERFRAMES_SKIP_SKILLS: '1', PRODUCER_EXPERIMENTAL_FAST_CAPTURE: 'false' };
    const outs = {};
    for (const [name, footage] of [['on', 'footage.mp4'], ['ref', 'ref.mp4']]) {
      const project = path.join(dir, name);
      fs.mkdirSync(path.join(project, 'compositions'), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '..', 'render-node', 'template', 'hyperframes.json'), path.join(project, 'hyperframes.json'));
      fs.copyFileSync(path.join(dir, footage), path.join(project, 'vid-001.mp4'));
      const html = composition.buildChunkHtml({ graphics: g, chunk, clipFile: 'vid-001.mp4', options: { karaoke: false, endcard: false, effects: name === 'on' ? 'strong' : 'off', plan } });
      fs.writeFileSync(path.join(project, 'index.html'), html);
      try {
        await run(process.execPath, [cli, 'render', project, '-o', path.join(project, 'out.mp4'), '-q', 'standard', '-f', '24'], { env, timeout: 600000 });
      } catch (err) {
        if (/browser|chrome|chromium/i.test(err.message) && /not found|could not find|no such file|install/i.test(err.message)) return `HyperFrames has no browser here (${err.message.slice(0, 120)})`;
        throw err;
      }
      const raw = await run(binaries.ffmpeg, ['-nostdin', '-v', 'error', '-i', path.join(project, 'out.mp4'), '-vf', 'scale=480:270:flags=area,format=rgb24', '-f', 'rawvideo', 'pipe:1']);
      const size = 480 * 270 * 3;
      outs[name] = Array.from({ length: raw.length / size }, (_x, i) => raw.subarray(i * size, (i + 1) * size));
      assert.equal(outs[name].length, frames, `${name}: every frame of the page`);
    }
    // the share of the pixels with a channel changed by more than 16
    const changed = (a, b) => {
      let count = 0;
      for (let p = 0; p < a.length / 3; p += 1) if (Math.max(Math.abs(a[3 * p] - b[3 * p]), Math.abs(a[3 * p + 1] - b[3 * p + 1]), Math.abs(a[3 * p + 2] - b[3 * p + 2])) > 16) count += 1;
      return count / (a.length / 3);
    };
    const { on, ref } = outs;
    const report = [];
    for (const item of placed) {
      const f = item.f - startFrame;
      const inWindow = [];
      for (let k = 0; k < item.n; k += 1) inWindow.push(changed(on[f + k], ref[f + k]));
      const mean = inWindow.reduce((sum, value) => sum + value, 0) / item.n;
      report.push(`${item.name} ${(100 * mean).toFixed(1)} %`);
      assert.ok(changed(on[f - 1], ref[f - 1]) < 0.005, `${item.name}: the frame before it is untouched`);
      assert.ok(changed(on[f + item.n], ref[f + item.n]) < 0.005, `${item.name}: the frame after it is untouched`);
      if (item.name === 'freeze' || item.name === 'stutter') {
        inWindow.forEach((value, k) => assert.ok(value < 0.005, `${item.name}: frame ${k} is the frame of the reference (${(100 * value).toFixed(2)} %)`));
      } else {
        assert.ok(mean >= VISIBLE, `${item.name}: ${(100 * mean).toFixed(1)} % of the picture changed, at least ${100 * VISIBLE} %`);
        assert.ok(inWindow[0] > 0.01 && inWindow[item.n - 1] > 0.01, `${item.name}: drawn from its first to its last frame`);
      }
    }
    // the footage moves, so the freeze and the stutter are not the plain footage: the last frame of each differs from the frame after it by far
    assert.ok(changed(ref[F + 7], ref[F + 8]) > 0.02 && changed(ref[S + 7], ref[S + 8]) > 0.02, 'the footage moves on after the freeze and the stutter');
    console.log(`  rendered with HyperFrames, changed: ${report.join(', ')}`);
    return null;
  } finally {
    if (process.env.HUD_FX_KEEP === '1') console.log(`  kept ${dir}`);
    else await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ---------- the page ---------- */

function testPage() {
  for (const g of [song, kubleSong]) {
    const chunks = chunksLib.planChunks(g, { endcardSeconds: 3 });
    for (const chunk of [chunks[0], chunks[3], chunks[chunks.length - 1]]) {
      for (const options of [{ karaoke: false, endcard: true }, { karaoke: true, endcard: false }]) {
        const before = composition.buildChunkHtml({ graphics: g, chunk, clipFile: 'a.mp4', options });
        for (const level of ['off', undefined, 'OFF', 'loud']) {
          assert.equal(composition.buildChunkHtml({ graphics: g, chunk, clipFile: 'a.mp4', options: { ...options, effects: level, glitch: 0.9 } }), before, `${g.theme}: effects ${level} is the page of before`);
        }
        assert.ok(!before.includes('id="fx"') && !before.includes('HudEffects') && !before.includes('fxall'));
        for (const level of ['subtle', 'strong', 'wild']) {
          const html = composition.buildChunkHtml({ graphics: g, chunk, clipFile: 'a.mp4', options: { ...options, effects: level } });
          assert.ok(Buffer.byteLength(html) < composition.MAX_HTML_BYTES, 'under the limit of the render node');
          assert.ok(Buffer.byteLength(html) - Buffer.byteLength(before) < 260000, `the effects add ${Buffer.byteLength(html) - Buffer.byteLength(before)} bytes`);
          assert.match(html, /<div id="fxall"><div id="stage"><div id="fx"><div id="cam"><video id="v1" class="clip" src="a\.mp4"[^>]*><\/video>(<video id="fxc\d+"[^>]*><\/video>)*<\/div><\/div><div id="fx-grain" class="layer"><\/div><div id="fx-scan" class="layer"><\/div><div id="fx-light" class="layer"><\/div>\n<div id="scrim" class="layer">/);
          assert.match(html, /<div id="l-kar" class="layer"><\/div><\/div><div id="fx-snow" class="layer"><\/div><\/div>\n<div id="l-over" class="layer"><\/div><div id="l-end" class="layer"><\/div>/, 'the end card and the layer over it outside the effects');
          assert.match(html, /<svg id="fx-defs" width="0" height="0" aria-hidden="true">/);
          assert.match(html, /#fx-grain,#fx-snow\{background-image:url\(data:image\/png;base64,/);
          assert.equal(html.match(/<script>/g).length, 8, 'data, themes, state, view, runtime, the plan of the effects, effects.js, its runtime');
          const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
          for (const url of urls) assert.ok(url === 'a.mp4' || url.startsWith('data:image/png;base64,') || url.startsWith('data:font/') || url.startsWith('https://cdn.jsdelivr.net/npm/gsap@'), url);
          assert.equal(html.split('Content-Security-Policy').length, 2);
          const fxData = JSON.parse(/window\.__HUD_FX=(.*?);<\/script>/s.exec(html)[1]);
          assert.deepEqual(fxData, json(effects.sliceEffects(composition.effectsPlan(g, level), chunk.start, chunk.start + chunk.duration)));
          // the rest of the page is the one of before: the effects take nothing away
          const without = html
            .replace(/\n#fx-grain,#fx-snow\{[^}]*\}/, '')
            .replace(/\n<style>[^]*?<\/style>/, '')
            .replace(/<svg id="fx-defs"[^]*?<\/svg>\n/, '')
            .replace('<div id="fxall">', '')
            .replace('<div id="fx">', '')
            .replace(/<video id="fxc\d+"[^>]*><\/video>/g, '')
            .replace('</div><div id="fx-grain" class="layer"></div><div id="fx-scan" class="layer"></div><div id="fx-light" class="layer"></div>', '')
            .replace('<div id="fx-snow" class="layer"></div></div>', '')
            .replace(/<script>window\.__HUD_FX=[^]*$/, '');
          const beforeStripped = before.replace(/\n<style>[^]*?<\/style>/, '').replace(/<\/div><\/body><\/html>\n$/, '');
          assert.equal(without, beforeStripped);
        }
      }
    }
  }
  // the slider goes into the plan of the page
  const chunk = chunkAt(song, DROP_FRAME);
  const fxOf = (options) => JSON.parse(/window\.__HUD_FX=(.*?);<\/script>/s.exec(composition.buildChunkHtml({ graphics: song, chunk, clipFile: 'a.mp4', options }))[1]);
  assert.equal(fxOf({ effects: 'subtle' }).level, 'subtle');
  assert.equal(fxOf({ effects: 'strong', glitch: 0.2 }).glitch, 0.2);
  assert.ok(fxOf({ effects: 'strong', glitch: 0 }).events.every((event) => !(effects.KINDS[event.k] && effects.KINDS[event.k].glitch)));
  assert.ok(fxOf({ effects: 'subtle' }).events.length < fxOf({ effects: 'strong' }).events.length);
}

// The filters of the page: every id that view() sets exists, the values are numbers, the maps and the noise are small PNG images
function testFilters() {
  const defs = fxsvg.svgDefs();
  const filterIds = ['fx-bulge', 'fx-wave', 'fx-zoom', 'fx-blur', 'fx-chroma', 'fx-smear', 'fx-split', 'fx-jitter', 'fx-pixel', 'fa-rgb', 'fa-slices', 'fa-blocks0', 'fa-blocks1', 'fa-blocks2', 'fa-vhs', 'fa-roll'];
  for (const id of filterIds) assert.ok(defs.includes(`<filter id="${id}" `), id);
  const ids = new Set([...defs.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]));
  const used = new Set();
  for (const level of ['strong', 'wild']) {
    const plan = planOf(busy, level);
    for (let f = 0; f < busy.endFrame; f += 1) {
      const drawn = effects.view(effects.frameEffects(plan, f / FPS));
      for (const [id, attribute, value] of drawn.svg) {
        assert.ok(ids.has(id), `${id} is in the page`);
        assert.ok(/^-?[\d.]+( 0)?$/.test(value), `${id} ${attribute}="${value}"`);
        used.add(id);
      }
      for (const match of `${drawn.fx} ${drawn.all}`.matchAll(/url\(#([a-z0-9-]+)\)/g)) {
        assert.ok(ids.has(match[1]));
        used.add(match[1]);
      }
      for (const style of [drawn.fx, drawn.all, drawn.light, drawn.grain, drawn.scan, drawn.snow]) assert.ok(!/NaN|undefined|Infinity/.test(style), style);
    }
  }
  for (const id of filterIds) assert.ok(used.has(id), `the busy film uses ${id}`);
  // a frame without anything is plain
  assert.deepEqual(effects.view(effects.frameEffects(null, 0)), { fx: 'transform:none;filter:none', all: 'filter:none', light: 'opacity:0', grain: 'opacity:0', scan: 'opacity:0', snow: 'opacity:0', svg: [] });
  const maps = fxsvg.maps();
  for (const [name, value] of Object.entries(maps)) {
    for (const url of [].concat(value)) {
      const png = Buffer.from(url.replace('data:image/png;base64,', ''), 'base64');
      assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], name);
      assert.ok(png.length < 18000, `${name}: ${png.length} bytes`);
    }
  }
  assert.ok(Buffer.byteLength(defs) < 80000, `the filters: ${Buffer.byteLength(defs)} bytes`);
  // the colours of the style: HUD Blue white seams and lines, the RGB split and grey negative blocks; Kuble its blue and the split as a prism
  assert.equal((defs.match(/flood-color="#FFFFFF"/g) || []).length, 2);
  assert.ok(defs.includes('values="-0.3 -0.59 -0.11 0 1 -0.3 -0.59 -0.11 0 1 -0.3 -0.59 -0.11 0 1 0 0 0 1 0"'), 'a grey negative');
  const kubleBlue = themes.get('kuble').colors.blue;
  const kubleDefs = fxsvg.svgDefs({ light: kubleBlue, prism: true, negative: kubleBlue });
  assert.equal((kubleDefs.match(new RegExp(`flood-color="${kubleBlue}"`, 'g')) || []).length, 2);
  const others = (text) => text.replace(/<filter id="(fa-rgb|fx-split|fa-blocks\d)" [\s\S]*?<\/filter>/g, '').split(kubleBlue).join('#FFFFFF');
  assert.equal(others(kubleDefs), others(defs), 'the other filters are the same');
  // the parts of the prism add up to the picture (each row of the three matrices, summed), the negative is dark where the picture is white
  const prismRows = [...kubleDefs.match(/<filter id="fa-rgb" [\s\S]*?<\/filter>/)[0].matchAll(/values="([^"]+)"/g)].map((match) => match[1].split(' ').map(Number));
  assert.equal(prismRows.length, 3);
  assert.deepEqual(prismRows[0].map((_value, i) => Math.round(1000 * (prismRows[0][i] + prismRows[1][i] + prismRows[2][i])) / 1000), [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 3, 0]);
  const negRows = kubleDefs.match(/<feColorMatrix in="d" type="matrix" values="([^"]+)"/)[1].split(' ').map(Number);
  for (let row = 0; row < 3; row += 1) assert.ok(Math.abs(negRows[row * 5] + negRows[row * 5 + 1] + negRows[row * 5 + 2] + negRows[row * 5 + 4]) < 0.002, 'white goes dark');
  assert.ok(negRows[14] === 1 && negRows[4] < 0.2, 'black goes blue');
  const pageOf = (g) => composition.buildChunkHtml({ graphics: g, chunk: chunksLib.planChunks(g, { endcardSeconds: 3 })[1], options: { effects: 'strong' } });
  assert.ok(pageOf(kubleSong).includes(kubleDefs) && pageOf(song).includes(defs));
  // the bulge map moves nothing in the middle and at the edge, the most at 0.58 of the radius
  const pixels = (url, width) => {
    const png = Buffer.from(url.replace('data:image/png;base64,', ''), 'base64');
    const idat = png.subarray(png.indexOf('IDAT') + 4, png.indexOf('IEND') - 8);
    const raw = zlib.inflateSync(idat);
    return (x, y) => [raw[y * (width * 3 + 1) + 1 + x * 3], raw[y * (width * 3 + 1) + 2 + x * 3]];
  };
  const bulge = pixels(maps.bulge, fxsvg.MAP.width);
  for (const [x, y] of [[47, 26], [48, 26], [47, 27], [48, 27]]) assert.ok(bulge(x, y).every((value) => Math.abs(value - 128) <= 7), `${x},${y}: ${bulge(x, y)}`);
  assert.deepEqual(bulge(0, 0), [128, 128], 'the corner stays');
  assert.ok(bulge(Math.round(fxsvg.MAP.width * 0.21), fxsvg.MAP.height / 2)[0] > 240, 'the left part is pulled to the middle');
  // the noise: grey, every value of the tile its own (no pattern that repeats inside it)
  const noise = Buffer.from(maps.noise.replace('data:image/png;base64,', ''), 'base64');
  assert.equal(noise[25], 0, 'greyscale');
  const raw = zlib.inflateSync(noise.subarray(noise.indexOf('IDAT') + 4, noise.indexOf('IEND') - 8));
  const values = new Set();
  for (let y = 0; y < fxsvg.NOISE.size; y += 1) values.add(raw.subarray(y * (fxsvg.NOISE.size + 1) + 1, (y + 1) * (fxsvg.NOISE.size + 1)).toString('hex'));
  assert.equal(values.size, fxsvg.NOISE.size, 'no two rows the same');
}

// The runtime of the page: a second tween on the timeline of the HUD; for every frame the wrappers, the layers and the filters as frameEffects says;
// the layers of the HUD as in the page without the effects.
function testRuntime() {
  for (const [g, level] of [[song, 'strong'], [kubleSong, 'wild']]) {
    const chunk = chunkAt(g, DROP_FRAME);
    const load = (effectsLevel) => {
      const html = composition.buildChunkHtml({ graphics: g, chunk, clipFile: 'a.mp4', options: { karaoke: false, endcard: true, effects: effectsLevel } });
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((entry) => entry[1]);
      const elements = {};
      const element = (id) => (elements[id] = { id, innerHTML: '', className: '', style: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = String(value); this.writes = (this.writes || 0) + 1; } });
      const ticks = [];
      const sandbox = {
        document: { getElementById: (id) => elements[id] || element(id) },
        gsap: { timeline: () => ({ to(target, options, position) { ticks.push({ target, options, position }); return this; } }) },
        console
      };
      sandbox.window = sandbox;
      sandbox.self = sandbox;
      vm.createContext(sandbox);
      for (const script of scripts) vm.runInContext(script, sandbox, { filename: `${effectsLevel}-page-script.js` });
      const drawAt = (local) => {
        for (const tick of ticks) {
          tick.target.t = local;
          tick.options.onUpdate();
        }
      };
      return { elements, ticks, drawAt, sandbox };
    };
    const on = load(level);
    const off = load('off');
    assert.equal(off.ticks.length, 1);
    assert.equal(on.ticks.length, 2, 'the effects add their own tween');
    assert.equal(on.ticks[1].position, 0);
    assert.equal(on.ticks[1].options.duration, on.ticks[0].options.duration, 'as long as the page');
    assert.equal(typeof on.sandbox.HudEffects.frameEffects, 'function');
    const plan = composition.effectsPlan(g, level);
    const frames = Math.round(chunk.duration * FPS);
    const layers = { fx: 'fx', all: 'fxall', light: 'fx-light', grain: 'fx-grain', scan: 'fx-scan', snow: 'fx-snow' };
    let changes = 0;
    let lastAll = '';
    let wholeFrames = 0;
    for (let i = 0; i < frames; i += 1) {
      on.drawAt(i / FPS);
      off.drawAt(i / FPS);
      const expected = effects.view(effects.frameEffects(plan, chunk.start + i / FPS));
      for (const [key, id] of Object.entries(layers)) assert.equal(on.elements[id].attributes.style, expected[key], `frame ${i}: ${id}`);
      for (const [id, attribute, value] of expected.svg) assert.equal(on.elements[id].attributes[attribute], value, `frame ${i}: ${id}`);
      for (const layer of ['l-dev', 'l-hud', 'l-kar', 'l-over', 'l-end', 'stage', 'cam']) {
        assert.equal(on.elements[layer].innerHTML, off.elements[layer].innerHTML, `frame ${i}: ${layer}`);
        assert.deepEqual(on.elements[layer].attributes, off.elements[layer].attributes, `frame ${i}: ${layer}`);
      }
      if (on.elements.fxall.attributes.style !== lastAll) changes += 1;
      if (expected.all !== 'filter:none') wholeFrames += 1;
      lastAll = on.elements.fxall.attributes.style;
    }
    assert.ok(wholeFrames > 5, `${level}: glitch over the whole picture in ${wholeFrames} frames of the chunk`);
    assert.ok(on.elements.fxall.writes <= changes + 1, 'an attribute is only written when it changes');
    const film0 = view.render(state.frameState(g, chunk.start + 2, { karaoke: false, endcard: true }));
    on.drawAt(2);
    assert.equal(on.elements['l-hud'].innerHTML, film0.hud);
  }
}

/* ---------- the post-pass ---------- */

const files = { listFile: '/s/chunks.txt', songFile: '/s/song.wav', outFile: '/s/film.mp4' };

// Off is the command of before. On: every glitch is in the pages, so the post-pass has no windows and is the graph of the effects off without glitch:
// grain, vignette (Kuble: and its bloom), BT.709, the song and the encoding.
function testPostArgs() {
  for (const g of [song, kubleSong, short]) {
    for (const params of [{ grain: 0.35, glitch: 0.6 }, { grain: 0, glitch: 0 }, {}]) {
      const before = post.buildPostArgs({ ...files, graphics: g, params, endcardSeconds: 3 });
      for (const level of ['off', undefined, 'nonsense']) assert.deepEqual(post.buildPostArgs({ ...files, graphics: g, params: { ...params, effects: level }, endcardSeconds: 3 }).args, before.args);
    }
  }
  for (const g of [song, kubleSong]) {
    const plain = post.buildPostArgs({ ...files, graphics: g, params: { grain: 0.35, glitch: 0 }, endcardSeconds: 3 });
    for (const level of ['subtle', 'strong', 'wild']) {
      for (const glitch of [0, 0.6, 1]) {
        const built = post.buildPostArgs({ ...files, graphics: g, params: { grain: 0.35, glitch, effects: level }, endcardSeconds: 3 });
        assert.equal(built.windows.length, 0, `${level} ${glitch}: no glitch window`);
        assert.deepEqual(built.args, plain.args, `${level} ${glitch}: the graph without glitch`);
      }
    }
    assert.ok(!/trim=start_frame|rgbashift|negate|maskedmerge|enable='/.test(plain.filter), 'one pass over the film, no glitch');
    // the effects off keep their glitch on the hits and cuts
    assert.ok(post.buildPostArgs({ ...files, graphics: g, params: { grain: 0.35, glitch: 0.6 }, endcardSeconds: 3 }).windows.length > 0);
  }
  assert.equal(typeof post.fxGlitchWindows, 'undefined', 'the glitch windows of WP45 are gone');
}

/* ---------- with ffmpeg ---------- */

// The post-pass with the effects on: every frame of the film and of the end card, the checks of the node pass.
async function testFfmpeg(binaries) {
  const { execFile } = require('child_process');
  const raw = (args) => new Promise((resolve, reject) => execFile(binaries.ffmpeg, args, { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr) || err.message)) : resolve(stdout))));
  const run = (args) => raw(['-nostdin', '-v', 'error', '-y', ...args]);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hud-fx-'));
  try {
    const chunk = path.join(dir, 'chunk-1.mp4');
    const frames = short.endFrame + FPS;
    await run(['-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=24', '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', chunk]);
    const songFile = path.join(dir, 'song.wav');
    await run(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=14', '-ar', '48000', songFile]);
    fs.writeFileSync(path.join(dir, 'chunks.txt'), post.concatListText([chunk]));
    for (const theme of ['hud', 'kuble']) {
      const graphics = theme === 'kuble' ? prepare(graphicsLib.demoGraphics({ duration: 12 }), { theme }) : short;
      const out = path.join(dir, `${theme}.mp4`);
      const built = post.buildPostArgs({ listFile: path.join(dir, 'chunks.txt'), songFile, outFile: out, graphics, params: { grain: 0.35, glitch: 0.6, effects: 'strong' }, endcardSeconds: 1, inputColor: { color_space: 'bt709', color_range: 'tv' } });
      await raw(built.args);
      const probe = JSON.parse(String(await new Promise((resolve, reject) => execFile(binaries.ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', out], (err, stdout) => (err ? reject(err) : resolve(stdout))))));
      assert.deepEqual(post.verifyOutput(probe, { frames: built.frames, seconds: built.seconds }), [], theme);
      assert.equal(Number(probe.streams.find((stream) => stream.codec_type === 'video').nb_read_frames), frames, `${theme}: every frame of the film and the card`);
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ---------- the node, its texts, the templates ---------- */

function testNode() {
  const def = require('../lib/nodes/registry').get('music_video.hud_render');
  const param = def.params.find((item) => item.id === 'effects');
  assert.deepEqual([param.kind, param.options, param.default], ['select', ['off', 'subtle', 'strong', 'wild'], 'strong']);
  assert.ok(def.params.findIndex((item) => item.id === 'effects') < def.params.findIndex((item) => item.id === 'glitch'), 'effects before the strength of the glitch');
  assert.match(def.description, /Effects \(strong by default, subtle, wild or off\)/);
  assert.match(def.description, /a palette of its own for every part of the song/);
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'nodes', 'nodes-music-video-hud.js'), 'utf8');
  assert.ok(source.includes('effects: params.effects, glitch: params.glitch }'), 'the pages get the level and the strength of the glitch');
  assert.ok(source.includes('glitch: params.glitch, effects: params.effects }'), 'the post-pass gets the level');
  const { rows } = require('../public/nodes/i18n-nodes');
  const text = (key, lang) => (rows.find((row) => row[0] === key) || [])[{ de: 1, en: 2, es: 3 }[lang]];
  for (const [lang, label, wildLabel] of [['de', 'Effekte', 'Wild'], ['en', 'Effects', 'Wild'], ['es', 'Efectos', 'Salvaje']]) {
    assert.equal(text('nodes.param.effects', lang), label);
    for (const option of param.options) assert.ok(text(`nodes.option.${option}`, lang), `${lang}: ${option}`);
    assert.equal(text('nodes.option.wild', lang), wildLabel);
    const tip = text('nodes.type.music_video.hud_render.tip.3', lang);
    assert.ok(!tip.includes('ß') && tip.length <= 240, `${lang}: ${tip.length}`);
    assert.match(tip, lang === 'de' ? /«Effekte».*«Glitch».*«Wild»/ : lang === 'en' ? /“Effects”.*“Glitch”.*“Wild”/ : /«Efectos».*«Glitch».*«Salvaje»/);
  }
  const templates = require('../lib/nodes/templates');
  for (const id of ['music-video-hud', 'music-video-hud-elevenlabs', 'music-video-hud-suno']) {
    const resolved = templates.resolveTemplate(id, { lang: 'en' });
    const node = resolved.graph.nodes.find((item) => item.type === 'music_video.hud_render');
    assert.equal(node.params.effects, 'strong', id);
    const fields = resolved.app.inputs.map((entry) => `${entry.node}.${entry.param}`);
    assert.equal(fields.indexOf(`${node.id}.effects`), fields.indexOf(`${node.id}.karaoke`) + 1, `${id}: the field after the karaoke line`);
    for (const [lang, label] of [['de', 'Effekte'], ['en', 'Effects'], ['es', 'Efectos']]) {
      assert.equal(templates.resolveTemplate(id, { lang }).app.inputs.find((entry) => entry.param === 'effects').label, label, `${id} ${lang}`);
    }
    const after = resolved.graph.edges.filter((edge) => edge.from.node === node.id).map((edge) => resolved.graph.nodes.find((item) => item.id === edge.to.node).type);
    assert.ok(after.length >= 2 && after.every((type) => type === 'output.result'), `${id}: ${after.join(', ')}`);
  }
}

async function main() {
  if (process.env.HUD_FX_ONLY_RENDER === '1') {
    const skipped = await testRender(require('../lib/ffmpeg').binaries());
    console.log(skipped ? `skipped testRender: ${skipped}` : 'ok testRender');
    return;
  }
  const tests = [testLevels, testParts, testPalettes, testVariety, testLengths, testDeterminism, testFlashLimit, testNoRed, testEndcardFree, testSungWords, testFresh, testCopies, testFrames, testVisible, testPage, testFilters, testRuntime, testPostArgs, testNode];
  let passed = 0;
  for (const test of tests) {
    test();
    passed += 1;
    console.log(`ok ${test.name}`);
  }
  const binaries = require('../lib/ffmpeg').binaries();
  if (binaries.available) {
    await testFfmpeg(binaries);
    passed += 1;
    console.log('ok testFfmpeg');
    const skipped = await testRender(binaries);
    if (skipped) console.log(`skipped testRender: ${skipped}`);
    else {
      passed += 1;
      console.log('ok testRender');
    }
  } else {
    console.log('skipped testFfmpeg and testRender: ffmpeg is not installed');
  }
  console.log(`${passed} tests passed`);
  console.log('test-music-video-hud-effects.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
