'use strict';

// The planner of the music video in the HUD style (WP44, part 2): lib/music-video-hud/plan.js and the node music_video.hud_plan
// (lib/nodes/nodes-music-video-hud.js). No network and nothing paid: the language model is a double that answers from a script, and the made-up
// songs come from scripts/support/hud-plan-fixtures.js. ffmpeg is the real one for the song slices (that part is skipped when it is missing).
//   grid        the film cut on the beat: cuts on beats and strong hits (the start of a sung window may lie in the gap before its first word), sung
//               windows of 5 to 8 s that hold whole lines, clips of at most the clip length, a hook cut of at most 1.5 s, the limit of units, the
//               settings and their ranges, the errors for a song that is too long or has no sung line, the same input gives the same grid
//   prompts     the template fills only its {{...}} places, the figure forms and the rows of the song, the second try carries the problems and the
//               previous answer, the style block follows the style, the catalogue names the sizes
//   answer      every rule of the brief is found in a wrong answer and told to the model in a sentence (graphics per line, rising keys, six types,
//               no run of three, counters, the share of the figure, plates, identity texts, "young", limits of the texts); what is cut or added
//               by the code is a note
//   planner     a good answer needs one request; a bad one is asked again with its problems; an empty one at the limit of tokens is asked again with
//               less thinking; what is still missing is made plainly; the costs of all answers (also empty ones) are counted; fatal errors end it
//   graphics    the graphics of every good plan pass the layout of the renderer without a note; the layout loop and its problems for the model
//   plan        the shots, the lists in unit order and the song slices match the engine (at most 50), `with_figure: false` is a cut without the figure
//   price       the estimate from the real price tables, for a song of 60 and of 120 seconds, the board and the node description agree with it
//   node        the definition, the settings, the estimate hook, the texts in German, English and Spanish, and the whole run with the model replaced

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const planLib = require('../lib/music-video-plan');
const hudPlan = require('../lib/music-video-hud/plan');
const graphicsLib = require('../lib/music-video-hud/graphics');
const { FIGURE_TEXT, FIGURE_NO_SHORT, makeSong, goodAnswer, scriptedModel } = require('./support/hud-plan-fixtures');

const near = (actual, expected, tolerance, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} !== ${expected} (±${tolerance})`.trim());
const errorOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
};

// The songs of the tests (each gives a good answer without a note of the layout, see the fixtures). `options` are the settings of the grid: a share
// of motion of 0.3 and at most 40 units (the defaults before every unit moved), so that the grids hold all three kinds of unit; the defaults (every unit
// a clip, at most 50 units) have tests of their own (testAllMotion, the prices).
const MIXED = Object.freeze({ motionShare: 0.3, maxUnits: 40 });
const SONGS = {
  s60: { song: { seconds: 60, seed: 3 }, options: MIXED },
  s72: { song: { seconds: 72, seed: 7 }, options: MIXED },
  dense: { song: { seconds: 72, seed: 11, pace: 0.3 }, options: MIXED },
  slow: { song: { seconds: 100, seed: 5, bpm: 96 }, options: MIXED },
  fast: { song: { seconds: 120, seed: 9, bpm: 140 }, options: MIXED },
  long: { song: { seconds: 150, seed: 2 }, options: { ...MIXED, maxUnits: 50 } }
};
const songOf = (name) => makeSong(SONGS[name].song);
const gridOf = (name, extra = {}) => {
  const song = songOf(name);
  return { song, grid: hudPlan.planGrid(song.analysis, song.timing, { ...SONGS[name].options, ...extra }) };
};
const figureOf = (text = FIGURE_TEXT) => hudPlan.parseFigure(text);
// 1, 2, 3, 7, 8 -> "1 to 3, 7, 8" (as the planner lists indexes)
function rangesOf(list) {
  const sorted = [...new Set(list)].sort((a, b) => a - b);
  const out = [];
  for (let at = 0; at < sorted.length; at += 1) {
    let end = at;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end += 1;
    out.push(end > at + 1 ? `${sorted[at]} to ${sorted[end]}` : sorted.slice(at, end + 1).join(', '));
    at = end;
  }
  return out.join(', ');
}

// The whole planner with a script for the model.
async function plan(name, steps, extra = {}) {
  const song = songOf(name);
  const model = scriptedModel(steps, extra.model);
  const logs = [];
  const result = await hudPlan.runPlanner({
    analysis: song.analysis,
    timing: song.timing,
    brief: 'A made-up film about a light that stays on',
    figureText: extra.figureText || FIGURE_TEXT,
    style: extra.style || '',
    theme: extra.theme || 'hud',
    hudLanguage: extra.hudLanguage || 'en',
    options: { ...SONGS[name].options, ...(extra.options || {}) },
    ask: model.ask,
    log: (line) => logs.push(line),
    prices: extra.prices || {},
    fatal: extra.fatal,
    ...(extra.allowPlain ? { allowPlain: true } : {}),
    ...(extra.brollShare !== undefined ? { brollShare: extra.brollShare } : {})
  });
  return { result, model, logs, song };
}
const answerFor = (name, mutate, figureText = FIGURE_TEXT) => {
  const { grid } = gridOf(name);
  return goodAnswer(grid, figureOf(figureText), { mutate });
};

/* ---------- the grid ---------- */

function checkGrid(grid, song, label, { rate = true } = {}) {
  const { analysis, timing } = song;
  const strong = analysis.hits.filter((hit) => hit.strength >= 0.5).map((hit) => hit.t);
  const onGrid = (time) => [0, grid.duration, ...analysis.beats, ...strong].some((point) => Math.abs(point - time) <= 0.001);
  const insideWord = (time) => timing.words.some((word) => word.start + 0.001 < time && time < word.end - 0.001);
  const settings = grid.settings;

  // the cuts follow each other from 0 to the end of the song, the units are made of them
  assert.ok(grid.cuts.length > 0, label);
  near(grid.cuts[0].start, 0, 1e-9, `${label}: first cut`);
  near(grid.cuts[grid.cuts.length - 1].end, grid.duration, 1e-6, `${label}: last cut`);
  grid.cuts.forEach((cut, at) => {
    assert.ok(cut.end > cut.start, `${label}: cut ${at} has a length`);
    if (at > 0) near(cut.start, grid.cuts[at - 1].end, 1e-6, `${label}: cut ${at} follows cut ${at - 1}`);
  });
  const fromUnits = grid.units.flatMap((unit) => unit.cuts);
  assert.deepEqual(fromUnits, grid.cuts, `${label}: the units hold the cuts in order`);

  // the places of the cuts: beats and strong hits; only the start of a sung window may lie between, in a gap of the singing (WP52a: and the end of a window
  // that ends in a gap between two words, WORD_WINDOWS)
  const wordWindows = grid.warnings.includes('WORD_WINDOWS');
  grid.cuts.forEach((cut, at) => {
    if (at === 0) return;
    if (onGrid(cut.start)) return;
    const unit = grid.units[cut.unit];
    const before = at > 0 ? grid.units[grid.cuts[at - 1].unit] : null;
    const windowEdge = (unit.kind === 'performance' && Math.abs(cut.start - unit.start) <= 1e-6) || (wordWindows && before && before.kind === 'performance' && Math.abs(cut.start - before.end) <= 1e-6);
    assert.ok(windowEdge, `${label}: cut ${at} at ${cut.start} s is not on a beat or a strong hit`);
    assert.ok(!insideWord(cut.start), `${label}: the window of unit ${unit.index} starts or ends inside a word`);
  });
  // the sung windows: 5 to 8 s with whole lines (WP52a: in a dense song up to 10 s, from a gap between two words to a gap), two to four cuts that zoom in and out;
  // never a cut inside a word, never a word of a choir in a window
  const sung = grid.units.filter((unit) => unit.kind === 'performance');
  for (const unit of sung) {
    assert.ok(unit.duration >= 5.05 - 0.002 && unit.duration <= (wordWindows ? hudPlan.WINDOW_MAX_LONG : 8) + 0.002, `${label}: unit ${unit.index} is sung for ${unit.duration} s`);
    assert.ok(unit.cuts.length >= 2 && unit.cuts.length <= (unit.duration >= 9 ? 4 : 3), `${label}: the sung unit ${unit.index} has ${unit.cuts.length} cuts`);
    assert.ok(unit.cuts.every((cut) => cut.zoom === 1 || cut.zoom === 1.35), `${label}: zoom of the cuts of unit ${unit.index}`);
    assert.equal(unit.cuts[0].zoom, 1, `${label}: a window starts wide`);
    assert.ok(unit.lines.length >= 1, `${label}: a window holds lines`);
    for (const edge of [unit.start, unit.end]) assert.ok(!insideWord(edge), `${label}: an edge of unit ${unit.index} at ${edge} s lies inside a word`);
    for (const line of grid.lines.filter((item) => item.voice === 'choir')) {
      assert.ok(line.words.every((word) => word.end <= unit.start + 0.002 || word.start >= unit.end - 0.002), `${label}: a word of the choir line ${line.index} is in unit ${unit.index}`);
    }
    if (wordWindows) continue;
    for (const index of unit.lines) {
      const line = grid.lines[index];
      assert.ok(line.words[0].start >= unit.start - 0.002 && line.words[line.words.length - 1].end <= unit.end + 0.002, `${label}: line ${index} is whole inside unit ${unit.index}`);
    }
  }
  // the others: at most the clip length, one or two cuts; no sung line is cut in two by them
  for (const unit of grid.units.filter((item) => item.kind !== 'performance')) {
    assert.ok(unit.duration <= settings.clipSeconds + 0.002, `${label}: unit ${unit.index} (${unit.kind}) is ${unit.duration} s, the clip is ${settings.clipSeconds} s`);
    assert.ok(unit.cuts.length >= 1 && unit.cuts.length <= 2, `${label}: unit ${unit.index} has ${unit.cuts.length} cuts`);
  }
  // the hook, the limit of the units, the share of the singing, the number of cuts
  assert.ok(grid.cuts[0].end - grid.cuts[0].start <= 1.5 + 0.002, `${label}: the hook cut is ${grid.cuts[0].end} s`);
  assert.ok(grid.units.length <= settings.maxUnits && grid.units.length <= planLib.MAX_SCENES, `${label}: ${grid.units.length} units`);
  assert.deepEqual(grid.units.map((unit) => unit.index), grid.units.map((_unit, at) => at), `${label}: the units are numbered`);
  grid.units.forEach((unit, at) => {
    if (at > 0) near(unit.start, grid.units[at - 1].end, 1e-6, `${label}: unit ${at} follows`);
  });
  // (the sung windows and the clip length set a floor under the rate: a few cuts per minute cannot be had with 5 s clips, see the case of the slow cuts)
  const perMinute = (grid.cuts.length * 60) / grid.duration;
  if (rate) assert.ok(perMinute >= settings.cutsPerMinute * 0.7 && perMinute <= settings.cutsPerMinute * 1.3, `${label}: ${perMinute.toFixed(1)} cuts per minute for ${settings.cutsPerMinute} asked`);
  assert.equal(grid.stats.cuts, grid.cuts.length);
  assert.equal(grid.stats.units, grid.units.length);
  assert.equal(grid.stats.sung + grid.stats.story + grid.stats.still, grid.units.length);
  // every kind gets its own index into its list (the clip number of the engine)
  for (const kind of ['performance', 'story', 'still']) assert.deepEqual(grid.units.filter((unit) => unit.kind === kind).map((unit) => unit.clip), grid.units.filter((unit) => unit.kind === kind).map((_unit, at) => at), `${label}: ${kind} clips`);
  // transitions and drops
  const special = grid.cuts.filter((cut, at) => at > 0 && cut.transition !== 'cut');
  assert.ok(special.length <= Math.ceil(grid.cuts.length / 4), `${label}: ${special.length} transitions in ${grid.cuts.length} cuts`);
  assert.ok(grid.cuts.every((cut) => ['cut', 'glitch', 'wipe', 'flash'].includes(cut.transition)), `${label}: transition names`);
  assert.ok(grid.drops.length <= 3 && grid.drops.every((time, at) => at === 0 || time - grid.drops[at - 1] >= 20), `${label}: drops ${grid.drops}`);
  // the lines: all of them, in order, without a word twice
  assert.equal(grid.lines.length, timing.lines.length, `${label}: lines`);
  const seen = new Set();
  for (const line of grid.lines) {
    for (const word of line.words) {
      const key = `${word.text}@${word.start}`;
      assert.ok(!seen.has(key), `${label}: the word ${key} is in two lines`);
      seen.add(key);
    }
  }
}

function testGrid() {
  for (const name of Object.keys(SONGS)) {
    const { song, grid } = gridOf(name);
    checkGrid(grid, song, name);
    near(grid.duration, song.seconds, 1e-9);
    assert.ok(grid.stats.sung >= 2, `${name}: some sung windows (${grid.stats.sung})`);
    assert.ok(grid.stats.story >= 1 && grid.stats.still >= 1, `${name}: story and still units`);
    // the same input, the same grid (the planner has no random element)
    const again = hudPlan.planGrid(song.analysis, song.timing, SONGS[name].options);
    assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(grid)), `${name}: deterministic`);
    // the text forms of the inputs work as the objects
    const fromText = hudPlan.planGrid(JSON.stringify(song.analysis), JSON.stringify(song.timing), SONGS[name].options);
    assert.deepEqual(JSON.parse(JSON.stringify(fromText)), JSON.parse(JSON.stringify(grid)), `${name}: text input`);
  }

  // the first section of the song is at 0 and the last at the end; the chapters are the sections, joined where one is too short
  const { grid } = gridOf('s72');
  assert.equal(grid.sections[0].start, 0);
  assert.equal(grid.sections[grid.sections.length - 1].end, grid.duration);
  assert.deepEqual(grid.kinds, ['intro', 'verse', 'chorus', 'verse', 'chorus', 'outro']);
  assert.ok(grid.lines.every((line) => line.section >= 1 && line.section <= 4), 'the lines are in the verses and the choruses');
  assert.ok(grid.cuts.filter((cut) => cut.start < grid.sections[1].start).length >= 2, 'the intro is cut fast');
  // the music block for the graphics plan
  assert.equal(grid.music.bpm, 120);
  assert.ok(grid.music.beats.length > 100 && grid.music.downbeats.length > 20 && grid.music.hits.length > 10);
  assert.equal(grid.music.energy.length, Math.ceil(grid.duration));

  // the settings and their ranges
  const song = songOf('s72');
  const read = (options) => hudPlan.normalizeSettings(options);
  assert.deepEqual(read({}), { cutsPerMinute: 24, maxUnits: 50, lipsyncSecondsPerMinute: 22, motionShare: 1, clipSeconds: 5 });
  assert.deepEqual(read({ cutsPerMinute: 5, maxUnits: 99, lipsyncSecondsPerMinute: 99, motionShare: 2, clipSeconds: 1 }), { cutsPerMinute: 14, maxUnits: 50, lipsyncSecondsPerMinute: 60, motionShare: 1, clipSeconds: 2 });
  assert.deepEqual(read({ cutsPerMinute: 99, maxUnits: 1, motionShare: -1, clipSeconds: 99 }), { cutsPerMinute: 40, maxUnits: 6, lipsyncSecondsPerMinute: 22, motionShare: 0, clipSeconds: 10 });
  assert.equal(read({ cutsPerMinute: 'x', maxUnits: null }).cutsPerMinute, 24, 'a setting that is no number is the default');
  const fast = hudPlan.planGrid(song.analysis, song.timing, { cutsPerMinute: 40 });
  const slow = hudPlan.planGrid(song.analysis, song.timing, { cutsPerMinute: 14 });
  assert.ok(fast.cuts.length > grid.cuts.length && grid.cuts.length > slow.cuts.length, `cuts per minute: ${slow.cuts.length} < ${grid.cuts.length} < ${fast.cuts.length}`);
  checkGrid(fast, song, 'fast cuts');
  checkGrid(slow, song, 'slow cuts', { rate: false });
  const slower = hudPlan.planGrid(song.analysis, song.timing, { cutsPerMinute: 14, clipSeconds: 10 });
  assert.ok(slower.cuts.length < slow.cuts.length, `longer clips allow fewer cuts: ${slower.cuts.length} < ${slow.cuts.length}`);
  checkGrid(slower, song, 'slow cuts, long clips', { rate: false });
  // no lip sync, no story: units of one kind
  const silent = hudPlan.planGrid(song.analysis, song.timing, { lipsyncSecondsPerMinute: 0 });
  assert.equal(silent.stats.sung, 0, 'no lip sync, no sung window');
  checkGrid(silent, song, 'no lip sync');
  const noMotion = hudPlan.planGrid(song.analysis, song.timing, { motionShare: 0 });
  assert.equal(noMotion.stats.story, 0, 'no motion, no story clip');
  const motion = hudPlan.planGrid(song.analysis, song.timing, { motionShare: 0.6 });
  assert.ok(motion.stats.story > grid.stats.story, `motion share: ${motion.stats.story} > ${grid.stats.story}`);
  // the default: every unit that is not sung is a clip of the video model, the first one (the portrait of the hook) too, so no still is left
  const everything = hudPlan.planGrid(song.analysis, song.timing, {});
  assert.equal(everything.stats.still, 0, 'every unit moves: no still');
  assert.equal(everything.stats.story, everything.units.length - everything.stats.sung);
  assert.ok(everything.units[0].kind === 'story' || everything.units[0].kind === 'performance', `the hook moves too (${everything.units[0].kind})`);
  checkGrid(everything, song, 'every unit moves');
  // just under 1, the hook stays a still
  const almost = hudPlan.planGrid(song.analysis, song.timing, { motionShare: 0.95 });
  assert.ok(almost.units[0].kind !== 'story', 'a share under 1 keeps the portrait of the hook a still');
  assert.ok(almost.stats.story > motion.stats.story, `${almost.stats.story} clips at 0.95 > ${motion.stats.story} at 0.6`);
  const shortClips = hudPlan.planGrid(song.analysis, song.timing, { clipSeconds: 3, maxUnits: 50 });
  checkGrid(shortClips, song, 'clips of 3 s');
  const fewUnits = hudPlan.planGrid(song.analysis, song.timing, { maxUnits: 20 });
  assert.ok(fewUnits.units.length <= 20, `${fewUnits.units.length} units for a limit of 20`);
  checkGrid(fewUnits, song, 'few units');
}

function testGridErrors() {
  const song = songOf('s72');
  // a song that is too long for the units: the error says what to change
  const longSong = makeSong({ seconds: 300, seed: 4 });
  const tooLong = (() => {
    try {
      hudPlan.planGrid(longSong.analysis, longSong.timing, {});
    } catch (err) {
      return err;
    }
    return null;
  })();
  assert.ok(tooLong, 'a song of 300 s does not fit into 50 units of 5 s');
  assert.equal(tooLong.code, 'HUDPLAN_TOO_LONG');
  assert.deepEqual(Object.keys(tooLong.data).sort(), ['clip', 'needed', 'seconds', 'units']);
  assert.equal(tooLong.data.seconds, 300);
  assert.equal(tooLong.data.units, 50);
  assert.equal(tooLong.data.clip, 5);
  assert.ok(tooLong.data.needed > 50, `${tooLong.data.needed} units are needed`);
  assert.match(tooLong.message, /300 s long.*5 s.*about \d+ units.*at most 50/);
  // more units or longer clips make it
  const bigger = hudPlan.planGrid(longSong.analysis, longSong.timing, { maxUnits: 50, clipSeconds: 10 });
  assert.ok(bigger.units.length <= 50);
  checkGrid(bigger, longSong, '300 s with 50 units of 10 s', { rate: false });

  // no sung line (an instrumental, or a transcript that heard no word): since WP48 a grid of clips, the warning says why there is no sung unit
  const silent = { version: 1, lines: [], words: [] };
  const instrumental = hudPlan.planGrid(song.analysis, silent, {});
  assert.deepEqual([instrumental.lines.length, instrumental.stats.sung, instrumental.warnings], [0, 0, ['NO_LINES']]);
  assert.ok(instrumental.units.length >= 1 && instrumental.units.every((unit) => unit.kind === 'story' && unit.lines.length === 0));
  checkGrid(instrumental, { ...song, timing: silent }, 'no sung line');
  // a timing that cannot be read is still an error
  for (const bad of ['', 'nothing', '{"words": []}', '[1,2]']) {
    const noLines = (() => {
      try {
        hudPlan.planGrid(song.analysis, bad, {});
      } catch (err) {
        return err;
      }
      return null;
    })();
    assert.equal(noLines && noLines.code, 'HUDPLAN_NO_LINES', JSON.stringify(bad));
  }
  // an analysis that cannot be read
  for (const bad of ['', 'nothing', '[1,2]', '{"beats": []}']) {
    let err = null;
    try {
      hudPlan.planGrid(bad, song.timing, {});
    } catch (caught) {
      err = caught;
    }
    assert.equal(err && err.code, 'MUSICVIDEO_ANALYSIS_INVALID', JSON.stringify(bad));
  }
  // lines that follow each other closely: every word is in one line only
  const tight = makeSong({ seconds: 72, seed: 7, pace: 0 });
  const closeLines = tight.timing.lines.map((line, at, all) => (at + 1 < all.length ? { ...line, end: Math.min(all[at + 1].start + 0.1, line.end + 0.1) } : line));
  const grid = hudPlan.planGrid(tight.analysis, { ...tight.timing, lines: closeLines }, {});
  const allWords = grid.lines.flatMap((line) => line.words.map((word) => `${word.text}@${word.start}`));
  assert.equal(new Set(allWords).size, allWords.length, 'no word belongs to two lines');
  assert.equal(allWords.length, tight.timing.words.length, 'no word is lost');
}

/* ---------- the prompts ---------- */

function testPrompts() {
  const { grid } = gridOf('s72');
  const figure = figureOf();
  const system = hudPlan.systemPrompt({ theme: 'hud', hudLanguage: 'en' });
  // only the places of the brief are filled
  assert.ok(!/\{\{|\}\}/.test(system), 'no place of the brief is left open');
  assert.match(system, /^You are the director and motion designer of an AI pop music video/);
  for (const part of ['THE FILM', 'THE HOOK', 'THE PICTURES', 'LIMITS AND FORMAT', 'DEVICE CATALOGUE', 'ANSWER SCHEMA']) assert.ok(system.includes(part), part);
  assert.ok(/All on-screen texts in English/.test(system));
  assert.ok(/All on-screen texts in German \(Swiss High German/.test(hudPlan.systemPrompt({ hudLanguage: 'de' })));
  assert.ok(/All on-screen texts in Spanish/.test(hudPlan.systemPrompt({ hudLanguage: 'es' })));
  assert.ok(/All on-screen texts in English/.test(hudPlan.systemPrompt({ hudLanguage: 'fr' })), 'a language that is none of the three is English');
  // the style block follows the style
  const kuble = hudPlan.systemPrompt({ theme: 'kuble' });
  assert.notEqual(kuble, system);
  assert.ok(kuble.length > 3000 && system.length > 3000);
  assert.equal(hudPlan.systemPrompt({ theme: 'nothing' }), system, 'an unknown style is the first one');
  // the schema is the one of the brief, the notes follow it; the short form is asked for only when the figure has none
  assert.ok(system.includes('"counter_values": [1, 7, 49, 2401]'));
  assert.ok(!system.includes('figure_short'), 'the figure has a SHORT form');
  assert.ok(hudPlan.systemPrompt({ needShort: true }).includes('"figure_short"'));
  // the catalogue holds every type with its limits and its size
  const catalogue = hudPlan.deviceCatalogue({ theme: 'hud' });
  for (const type of graphicsLib.DEVICE_TYPES) assert.ok(new RegExp(`^- ${type}`, 'm').test(catalogue), `catalogue: ${type}`);
  assert.ok(catalogue.includes(`≤ ${graphicsLib.LIMITS.tag.text} characters`) && catalogue.includes(`≤ ${graphicsLib.LIMITS.display.text} characters`), 'the limits come from graphics.js');
  assert.match(catalogue, /^- tag: .* — about \d+ x \d+ px$/m);
  assert.match(catalogue, /px per side in an ECU, \d+ in a CU/);
  // the sizes are measured: a clock is wider than a list, and the far side of a figure at the edge has more room
  const sizes = hudPlan.typicalSizes('hud');
  assert.ok(sizes.clock.w > sizes.list.w && sizes.chart.h > sizes.tag.h * 5, JSON.stringify(sizes));
  assert.deepEqual(Object.keys(sizes).sort(), graphicsLib.DEVICE_TYPES.filter((type) => type !== 'display').sort(), 'a size for every type');
  assert.ok(hudPlan.freeLanes({ framing: 'ECU', subject: 'left' }).right > hudPlan.freeLanes({ framing: 'ECU', subject: 'center' }).right);
  assert.ok(hudPlan.freeLanes({ framing: 'ECU', subject: 'center' }).left < hudPlan.freeLanes({ framing: 'MS', subject: 'center' }).left);

  // the message to the model
  const user = hudPlan.userPrompt({ brief: 'A film about a light', style: 'analog 16 mm', figure, grid });
  assert.ok(!/\{\{|\}\}/.test(user));
  assert.match(user, /^IDEA\nA film about a light\n\nSTYLE\nanalog 16 mm\n\nFIGURE \(identity text; the code puts it in for \[FIGURE\]\)\nNAME: Mira\nFULL: a 30-year-old woman/);
  assert.ok(user.includes(`SHORT: ${figure.short}`) && user.includes('LOOKS: a different coat colour for every chapter'), 'the forms and the notes of the figure');
  assert.ok(!user.includes('CREDIT:'), 'the credit line is for the end card only');
  assert.match(user, /duration 72 s, about 120 BPM, lyrics language English/);
  assert.ok(!user.includes('←'), 'the notes of the brief about the format of the rows are not sent');
  assert.ok(!/pro Zeile|bzw\./.test(user));
  // a row for every section, line and unit
  assert.match(user, /sections:\n0 intro 0\.0-/);
  for (const section of grid.sections) assert.match(user, new RegExp(`^${section.index} .* energy (low|medium|high)$`, 'm'));
  for (const line of grid.lines) assert.match(user, new RegExp(`^${line.index} \\| \\d+\\.\\d-\\d+\\.\\d s \\| .* \\| 0:${line.words[0].text}`, 'm'));
  for (const unit of grid.units) assert.match(user, new RegExp(`^${unit.index} \\| ${unit.kind} \\| \\d+\\.\\d-\\d+\\.\\d s \\| lines (-|[\\d,]+) \\| cuts ${unit.cuts.length} \\| chapter ${unit.section}( \\| drop)?$`, 'm'));
  // WP52a: the units the code suggests for B-roll are marked, and the note above the list says what the mark means
  const broll = hudPlan.suggestBroll(grid);
  const marked = hudPlan.userPrompt({ brief: 'x', style: '', figure, grid, broll });
  assert.ok(broll.size >= 4, `${broll.size} units suggested`);
  for (const unit of grid.units) assert.equal(new RegExp(`^${unit.index} \\| .* \\| b-roll$`, 'm').test(marked), broll.has(unit.index), `unit ${unit.index}: marked as suggested`);
  assert.match(marked, /^UNITS \(already cut on the beat by the code; one plate per unit; "b-roll": suggested for a picture without the figure\)$/m);
  assert.ok(!/b-roll/.test(user), 'without a suggestion no mark');
  assert.ok(user.endsWith('Return the JSON object now.'));
  assert.match(hudPlan.userPrompt({ brief: 'x', style: '', figure, grid }), /STYLE\n\(none given\)/);
  assert.match(hudPlan.userPrompt({ brief: 'x', style: '', figure: figureOf('a woman with a red coat'), grid }), /FULL: a woman with a red coat\nSHORT: \(none given: write it yourself/);

  // the second try: the problems and the previous answer come before the last line
  const retry = hudPlan.userPrompt({ brief: 'x', style: '', figure, grid, problems: ['unit 3: the plate is missing', 'line 4: needs 1 to 3 graphics (has 5)'], previous: '{"treatment":"old"}' });
  assert.ok(retry.indexOf('YOUR PREVIOUS ANSWER HAD THESE PROBLEMS') > retry.indexOf('UNITS'));
  assert.ok(retry.includes('- unit 3: the plate is missing') && retry.includes('- line 4: needs 1 to 3 graphics (has 5)') && retry.includes('YOUR PREVIOUS ANSWER\n{"treatment":"old"}'));
  assert.ok(retry.endsWith('Return the JSON object now.'));
  const many = hudPlan.userPrompt({ brief: 'x', style: '', figure, grid, problems: Array.from({ length: 45 }, (_item, at) => `problem ${at}`) });
  assert.ok(many.includes('- problem 29') && !many.includes('- problem 30') && many.includes('and 15 more of the same kind'), 'at most 30 problems are told');
  assert.ok(!hudPlan.userPrompt({ brief: 'x', style: '', figure, grid, problems: ['a problem'] }).includes('YOUR PREVIOUS ANSWER\n'), 'no previous answer when there is none');

  // the figure
  const parsed = figureOf();
  assert.equal(parsed.name, 'Mira');
  assert.equal(parsed.hudName, 'MIRA');
  assert.ok(parsed.full.startsWith('a 30-year-old woman') && parsed.short.startsWith('a woman with short copper hair'));
  assert.equal(parsed.credit, 'Mira by the test lab (example.org)');
  assert.equal(parsed.hasShort && parsed.hasFull, true);
  assert.deepEqual(parsed.notes, ['LOOKS: a different coat colour for every chapter', 'NEVER: a second Mira in the picture']);
  const free = figureOf('a tall man in a green raincoat, a scar over the left eye');
  assert.equal(free.full, 'a tall man in a green raincoat, a scar over the left eye');
  assert.equal(free.hasShort, false);
  assert.equal(free.name, '');
  assert.equal(hudPlan.deriveShort(free.full), free.full, 'a short sentence is its own short form');
  assert.ok(hudPlan.deriveShort(`${'a person with a very long description, '.repeat(12)}and more`).length < 260, 'a long one is cut at a part of the sentence');
  // the sheet prompt holds the full form
  const sheet = hudPlan.sheetPrompt(parsed);
  assert.ok(sheet.startsWith('Character reference portrait for a music video') && sheet.includes(parsed.full.replace(/[.;:,\s]+$/, '')) && /mouth closed/.test(sheet) && !/\{\{/.test(sheet));
}

/* ---------- the answer ---------- */

function testAnswer() {
  const { grid } = gridOf('s72');
  const figure = figureOf();
  const read = (answer, who = figure) => hudPlan.readAnswer(typeof answer === 'string' ? answer : JSON.stringify(answer), { grid, figure: who });
  const good = () => goodAnswer(grid, figure);
  const problemsOf = (mutate, who = figure, answerOf = null) => read(answerOf ? answerOf(mutate) : goodAnswer(grid, who, { mutate }), who).problems;
  const has = (problems, pattern, message = '') => assert.ok(problems.some((problem) => pattern.test(problem)), `${message} ${pattern} is not in ${JSON.stringify(problems)}`.trim());
  // exactly one problem, and it is this one
  const only = (mutate, pattern, who = figure) => {
    const problems = problemsOf(mutate, who);
    has(problems, pattern);
    assert.equal(problems.length, 1, `only one problem for ${pattern}: ${JSON.stringify(problems)}`);
    return problems;
  };

  // a good answer has no problem and no note, and its parts have the size of the grid
  const ok = read(good());
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.notes, []);
  assert.equal(ok.content.units.length, grid.units.length);
  assert.equal(ok.content.lines.length, grid.lines.length);
  assert.equal(ok.content.chapters.length, grid.sections.length);
  assert.deepEqual(ok.content.hud.counterValues, [1, 3, 9, 27, 81, 243]);
  assert.equal(ok.content.hud.instancesLabel, 'MOTHS');
  assert.ok(ok.content.units.every((unit) => unit && unit.plate.endsWith('no text, no letters, no logos')));
  assert.ok(ok.content.units.filter((unit, at) => grid.units[at].kind === 'story').every((unit) => unit.motion.endsWith('No text, letters or logos.')));
  assert.ok(ok.content.units.filter((unit, at) => grid.units[at].kind !== 'story').every((unit) => unit.motion === ''));
  assert.equal(ok.content.endcard.title, 'MOTH PARADE');
  // fenced and numbered like a model does it
  assert.equal(read(`Here it is:\n\`\`\`json\n${JSON.stringify(good())}\n\`\`\``).ok, true, 'a fenced answer');
  assert.deepEqual(read(good()).problems, read(JSON.stringify(good(), null, 2)).problems);
  // an answer that is no object
  for (const text of ['', 'no json at all', '[1,2,3]', '"text"']) {
    const bad = read(text);
    assert.equal(bad.ok, false, JSON.stringify(text));
    assert.deepEqual(bad.problems, ['The answer is not a JSON object.']);
    assert.equal(bad.content, null);
  }

  // the rules of the brief, one by one: every wrong answer is found and told in a sentence that says what to do
  only((a) => { a.units = a.units.slice(0, 10); }, /^units: units 10 to 21 have no entry$/);
  assert.equal(read(goodAnswer(grid, figure, { mutate: (a) => { a.units = a.units.slice(0, 10); } })).content.units[15], null, 'a unit without an entry is null');
  has(problemsOf((a) => { a.lines[0].graphics = Array.from({ length: 5 }, () => a.lines[0].graphics[0]); }), /^line 0: needs 1 to 3 graphics \(has 5\)$/);
  only((a) => { a.lines[2].graphics = []; }, /^line 2: needs 1 to 3 graphics \(has 0\)$/);
  has(problemsOf((a) => { a.lines[1].graphics = [{ key: 3, type: 'tag', text: 'LATE' }, { key: 1, type: 'tag', text: 'EARLY' }]; }), /^line 1: the "key" values of the graphics have to rise from graphic to graphic \(they are 3, 1\)$/);
  has(problemsOf((a) => { a.lines[1].graphics = [{ key: 2, type: 'tag', text: 'ONE' }, { key: 2, type: 'stamp', text: 'TWO', count: 1 }]; }), /have to rise/, 'equal keys');
  has(problemsOf((a) => { a.lines[1].graphics[0].key = 99; }), /^line 1, graphic 1 \(\w+\): "key" has to be a word index of the line \(0 to \d+\)$/);
  assert.deepEqual(problemsOf((a) => { a.lines[1].graphics[0].key = '0'; }), [], 'a number as a string is a number');
  has(problemsOf((a) => { a.lines.forEach((line) => { line.graphics = [{ key: 0, type: 'tag', text: `LINE ${line.index}` }]; }); }), /^the film uses only 1 different graphic types, use at least 6 \(.*are free\)$/);
  has(problemsOf((a) => { for (const at of [3, 4, 5]) a.lines[at].graphics = [{ key: 0, type: 'counter', label: 'COUNT', format: 'int', from: 0, to: at }]; }), /^lines (\d+), (\d+) and (\d+) all open with a counter: change the first graphic of line \2 \(never the same type three lines in a row\)$/);
  // the types: not enough lines, no rule
  const few = (() => {
    const song = makeSong({ seconds: 30, seed: 5 });
    const small = hudPlan.planGrid(song.analysis, song.timing, {});
    assert.ok(small.lines.length < 8, `${small.lines.length} lines`);
    const answer = goodAnswer(small, figure);
    answer.lines.forEach((line) => { line.graphics = [{ key: 0, type: 'tag', text: `LINE ${line.index}` }]; });
    return hudPlan.readAnswer(JSON.stringify(answer), { grid: small, figure });
  })();
  assert.ok(!few.problems.some((problem) => /different graphic types/.test(problem)), 'six types are asked for from eight lines on');
  // the counters of the HUD
  const counters = problemsOf((a) => { a.hud.counter_values = [5, 3, 9]; });
  has(counters, /^hud\.counter_values: needs 6 values, one per chapter \(has 3\)$/);
  has(counters, /^hud\.counter_values: the values have to rise from chapter to chapter \(they are 5, 3, 9\)$/);
  const repaired = read(goodAnswer(grid, figure, { mutate: (a) => { a.hud.counter_values = [5, 3, 9]; } })).content.hud.counterValues;
  assert.equal(repaired.length, 6, 'repaired to the number of chapters');
  assert.ok(repaired.every((value, at) => at === 0 || value > repaired[at - 1]), `rising: ${repaired}`);
  only((a) => { delete a.hud.instances_values; }, /^hud\.instances_values: missing \(needs 6 rising numbers, one per chapter\)$/);
  has(problemsOf((a) => { a.hud.counter_values = [1, 1, 2, 3, 4, 5]; }), /have to rise/, 'equal values do not rise');
  only((a) => { a.hud.ticker = a.hud.ticker.slice(0, 3); }, /^hud\.ticker: needs 8 to 12 lines \(has 3\)$/);
  only((a) => { a.hud.title = 'A TITLE THAT IS MUCH TOO LONG FOR THE FRAME'; }, /^hud\.title: \d+ characters, at most 22$/);
  assert.ok(read(goodAnswer(grid, figure, { mutate: (a) => { a.hud.title = 'A TITLE THAT IS MUCH TOO LONG FOR THE FRAME'; } })).content.hud.title.length <= 22, 'cut to the limit');
  only((a) => { a.chapters = a.chapters.slice(0, 2); }, /^chapters: needs one entry for each of the 6 sections \(sections 2 to 5 are missing\)$/);
  only((a) => { delete a.treatment; }, /^treatment: missing$/);
  // the share of the figure, the B-roll (WP52a) and the hook
  const open = grid.units.filter((unit) => unit.kind !== 'performance' && unit.index > 0);
  const lineWords = (unit) => (unit.lines.length ? grid.lines[unit.lines[0]].text : '');
  const asBroll = (entry, unit, scene) => Object.assign(entry, { with_figure: false, framing: 'WS', shows: lineWords(unit) || 'light', plate: `WS, 24 mm lens, ${scene}, photographic film still, cinematic light, natural colour, film grain, no text, no letters, no logos` });
  const brollOf = (answer) => answer.units.filter((unit) => unit.with_figure === false).map((unit) => unit.index);
  assert.ok(brollOf(good()).length >= hudPlan.brollRange(open.length, hudPlan.DEFAULT_BROLL_SHARE).min, 'the good answer has its B-roll');
  // too much B-roll: every unit with a line without the figure
  const tooMuch = problemsOf((a) => { open.filter((unit) => unit.lines.length).forEach((unit, at) => asBroll(a.units[unit.index], unit, `a picture of the words ${lineWords(unit)} number ${at}`)); });
  has(tooMuch, new RegExp(`^\\d+ of the ${open.length} story and still units show no figure, at most \\d+: put the figure back into some of them \\(for example units [\\d, ]+\\)$`));
  // four in a row (units 1 to 4: no sung unit between them)
  assert.ok([1, 2, 3, 4].every((at) => grid.units[at].kind !== 'performance'));
  has(problemsOf((a) => { for (const at of [1, 2, 3, 4]) asBroll(a.units[at], grid.units[at], ['a burning moon', 'a flood of neon', 'rows of mannequins', 'a sky of screens'][at - 1]); }), /^units 1 to \d+: \d+ units without the figure in a row, at most 3: put the figure into one of them$/);
  // too little: every unit with the figure
  const tooLittle = problemsOf((a) => { a.units.forEach((unit) => { if (unit.with_figure === false) Object.assign(unit, { with_figure: true, framing: 'MS', subject: 'left', plate: `MS, 35 mm lens, [FIGURE], scene ${unit.index}, photographic film still, cinematic light, natural colour, film grain, no text, no letters, no logos` }); }); });
  assert.deepEqual(tooLittle, [`only 0 of the ${open.length} story and still units show no figure, at least ${hudPlan.brollRange(open.length, 0.35).min} are needed (about 35%, B-roll): show the image of their line without the figure in more of them (for example units ${[...hudPlan.suggestBroll(grid)].sort((x, y) => x - y).slice(0, 6).join(', ')})`]);
  // the figure on the screen: at least 55% of the film
  has(problemsOf((a) => { a.units.forEach((unit, at) => { if (grid.units[at].kind !== 'performance') unit.with_figure = false; }); }), /^the figure is on the screen for only \d+% of the film, at least 55% are needed: put the figure into more story and still units \(for example units [\d, ]+;/);
  // a unit without the figure: "shows" names words that are sung there, the plate has no figure, no two pictures are nearly the same
  const brollAt = brollOf(good())[0];
  const brollUnit = grid.units[brollAt];
  only((a) => { a.units[brollAt].shows = 'purple elephants'; }, new RegExp(`^unit ${brollAt} \\(WS, (story|still), no figure\\): "shows" \\(«purple elephants»\\) is not sung here: show the image of a line sung in this unit \\(«${lineWords(brollUnit)}»\\)$`));
  only((a) => { delete a.units[brollAt].shows; }, new RegExp(`^unit ${brollAt} \\(.*no figure\\): "shows" is missing: give the words of the line whose image it shows`));
  only((a) => { a.units[brollAt].shows = 'of the and'; }, new RegExp(`^unit ${brollAt} \\(.*no figure\\): "shows" \\(«of the and»\\) names no image`));
  only((a) => { a.units[brollAt].plate = `WS, [FIGURE] in ${a.units[brollAt].plate}`; }, new RegExp(`^unit ${brollAt} \\(.*no figure\\): the plate has \\[FIGURE\\] although the unit has no figure`));
  only((a) => { a.units[brollAt].plate = `${a.units[brollAt].plate}, ${figure.short}`; }, new RegExp(`^unit ${brollAt} \\(.*no figure\\): the plate describes the figure although the unit has none`));
  only((a) => { a.units[brollAt].plate = `${a.units[brollAt].plate}, Mira on a balcony`; }, /the plate describes the figure although the unit has none/);
  const [first, second] = brollOf(good());
  only((a) => { a.units[second].plate = a.units[first].plate.replace('24 mm', '28 mm'); a.units[second].shows = a.units[second].shows; }, new RegExp(`^units ${first} and ${second}: the two pictures without the figure are nearly the same, show a different image in each$`));
  // no B-roll asked for (broll_share 0): every unit shows the figure
  const none = hudPlan.readAnswer(JSON.stringify(good()), { grid, figure, brollShare: 0 }).problems;
  assert.equal(none.length, 1);
  assert.match(none[0], new RegExp(`^units ${rangesOf(brollOf(good()))}: this film has no pictures without the figure, put her into them \\("with_figure": true\\)$`));
  assert.deepEqual(hudPlan.readAnswer(JSON.stringify(goodAnswer(grid, figure, { brollShare: 0 })), { grid, figure, brollShare: 0 }).problems, [], 'an answer without B-roll for a film without B-roll');
  const sings = read(goodAnswer(grid, figure, { mutate: (a) => { a.units[grid.units.findIndex((unit) => unit.kind === 'performance')].with_figure = false; } }));
  assert.ok(sings.notes.some((note) => /^unit \d+ sings, so the figure is in it$/.test(note)), 'a note, not a problem');
  assert.equal(sings.content.units[grid.units.findIndex((unit) => unit.kind === 'performance')].withFigure, true);
  only((a) => { a.units[0].framing = 'WS'; a.units[0].plate = a.units[0].plate.replace('CU,', 'WS,'); }, /^unit 0 \(the hook\): must be a close portrait of the figure \(framing ECU, CU or MCU, "with_figure": true\), not WS$/);
  const sungAt = grid.units.findIndex((unit) => unit.kind === 'performance');
  has(problemsOf((a) => { a.units[sungAt].framing = 'WS'; }), new RegExp(`^unit ${sungAt} \\(sung\\): the face and the whole mouth must be big enough to see: framing ECU, CU, MCU or MS, not WS$`));
  has(problemsOf((a) => { a.units[2].framing = 'closeup'; }), /^unit 2: "framing" has to be one of ECU, CU, MCU, MS, MWS, WS, FS, EWS, OTS$/);
  // the plates
  has(problemsOf((a) => { a.units[3].plate = a.units[2].plate; }), /^units 2 and 3: the plates are identical, write a different picture for each unit$/);
  // WP52a: the identity text comes from the code: [FIGURE] becomes the full form up to MS and the short form from MWS on; a plate that holds the right form is
  // taken as it is, one with the other form gets the right one, one without any gets it after the framing (notes, no problem)
  const placed = read(good());
  placed.content.units.forEach((unit, at) => {
    if (!unit.withFigure) return assert.ok(!unit.plate.includes(figure.short) && !unit.plate.includes('[FIGURE]'), `unit ${at}: no figure`);
    const close = ['ECU', 'CU', 'MCU', 'MS'].includes(unit.framing);
    assert.ok(unit.plate.includes(close ? figure.full : figure.short) && !unit.plate.includes('[FIGURE]'), `unit ${at}: the ${close ? 'full' : 'short'} form`);
    if (!close) assert.ok(!unit.plate.includes(figure.full), `unit ${at}: not the full form`);
  });
  const verbatim = read(goodAnswer(grid, figure, { mutate: (a) => { a.units[0].plate = a.units[0].plate.replace('[FIGURE]', figure.full); } }));
  assert.deepEqual([verbatim.problems, verbatim.notes], [[], []], 'the full form verbatim, as before');
  assert.equal(verbatim.content.units[0].plate, placed.content.units[0].plate);
  const forgotten = read(goodAnswer(grid, figure, { mutate: (a) => { a.units[0].plate = a.units[0].plate.replace('[FIGURE], ', ''); } }));
  assert.deepEqual(forgotten.problems, []);
  assert.deepEqual(forgotten.notes, ['unit 0: "[FIGURE]" was missing: the identity text was put in after the framing']);
  assert.ok(forgotten.content.units[0].plate.startsWith(`CU, 85 mm lens, ${figure.full.replace(/[.;:,\s]+$/, '')}, chapter 0 look`), forgotten.content.units[0].plate);
  const wide = grid.units.findIndex((unit, at) => at > 0 && good().units[at].with_figure && ['MWS', 'WS'].includes(good().units[at].framing));
  assert.ok(wide > 0);
  const swapped = read(goodAnswer(grid, figure, { mutate: (a) => { a.units[wide].plate = a.units[wide].plate.replace('[FIGURE]', figure.full); } }));
  assert.deepEqual(swapped.problems, []);
  assert.deepEqual(swapped.notes, [`unit ${wide}: the short identity text was put in for the full one`]);
  assert.ok(swapped.content.units[wide].plate.includes(figure.short) && !swapped.content.units[wide].plate.includes(figure.full));
  const twice = read(goodAnswer(grid, figure, { mutate: (a) => { a.units[0].plate = a.units[0].plate.replace('[FIGURE]', '[FIGURE] beside [figure]'); } }));
  assert.ok(twice.content.units[0].plate.includes(`${figure.full} beside the same person`), 'a second placeholder is the same person, never a second figure');
  has(problemsOf((a) => { a.units[3].plate = `${a.units[3].plate}, a young woman`; }), /^unit 3 \(.*\): the plate has the word "young"$/);
  assert.deepEqual(problemsOf((a) => { a.units[3].plate = `${a.units[3].plate}, a young woman`; }, read(good()).ok ? figureOf(`${FIGURE_TEXT.replace('a 30-year-old woman', 'a young woman')}`) : figure), [], 'a figure that is described as young may use the word');
  has(problemsOf((a) => { a.units[3].plate = 'x'.repeat(1600); }), /^unit 3 \(.*\): the plate has \d+ characters with the identity text, at most 1500$/);
  has(problemsOf((a) => { a.units[3].plate = ''; }), /^unit 3 \(.*\): the plate is missing$/);
  const storyAt = grid.units.findIndex((unit) => unit.kind === 'story');
  only((a) => { a.units[storyAt].motion = ''; }, new RegExp(`^unit ${storyAt} \\(.*story(, no figure)?\\): the motion prompt is missing$`));
  has(problemsOf((a) => { a.units[storyAt].motion = 'A young man walks. No text, letters or logos.'; }), /the motion prompt has the word "young"/);
  only((a) => { a.treatment = 'A young woman and a light.'; }, /^treatment: has the word "young"$/);
  // what the code adds: the ending that keeps text out of the picture
  const noEnding = read(goodAnswer(grid, figure, { mutate: (a) => { a.units[3].plate = a.units[3].plate.replace(', no text, no letters, no logos', ''); a.units[storyAt].motion = 'Slow push-in on the face.'; } }));
  assert.deepEqual(noEnding.problems, []);
  assert.ok(noEnding.notes.includes('unit 3: "no text, no letters, no logos" was added to the plate'), JSON.stringify(noEnding.notes));
  assert.ok(noEnding.content.units[3].plate.endsWith(', no text, no letters, no logos'));
  assert.equal(noEnding.content.units[storyAt].motion, 'Slow push-in on the face. No text, letters or logos.');
  // a figure without a SHORT form: the answer brings one
  const noShort = figureOf(FIGURE_NO_SHORT);
  assert.equal(noShort.hasShort, false);
  const withShort = read(goodAnswer(grid, noShort), noShort);
  assert.deepEqual(withShort.problems, []);
  assert.equal(withShort.content.figureShort, 'a woman with short copper hair and a grey wool coat');
  has(problemsOf((a) => { delete a.figure_short; }, noShort, (mutate) => goodAnswer(grid, noShort, { mutate })), /^figure_short: missing/);
  // the entries of the graphics
  has(problemsOf((a) => { a.lines[1].graphics[0] = { key: 0, type: 'hologram' }; }), /^line 1, graphic 1: the type "hologram" is not in the catalogue$/);
  has(problemsOf((a) => { a.lines[1].graphics = [{ key: 0, type: 'counter', label: 'X' }]; }), /^line 1, graphic 1 \(counter\): a counter needs a number in "to"$/);
  has(problemsOf((a) => { a.lines[1].graphics = [{ key: 0, type: 'chart', title: 'T', values: [1, 2, 3], marker: 'M' }]; }), /^line 1, graphic 1 \(chart\): needs 5 to 12 values \(has 3\)$/);
  has(problemsOf((a) => { a.lines[1].graphics = [{ key: 0, type: 'spec', title: 'T', rows: [['A', 'B']] }]; }), /^line 1, graphic 1 \(spec\): needs 2 to 6 rows of \["label", "value"\]$/);
  has(problemsOf((a) => { a.lines[1].graphics = [{ key: 0, type: 'counter', label: 'X', format: 'roman', to: 4 }]; }), /the format "roman" is none of int, percent, money, clock, fraction, multiplier/);
  has(problemsOf((a) => { a.lines[1].graphics = [{ key: 0, type: 'clock', time: 'noon', label: 'X' }]; }), /"time" has to be "HH:MM"/);
  has(problemsOf((a) => { a.lines[1].graphics = [{ key: 0, type: 'tag' }]; }), /^line 1, graphic 1 \(tag\): the text is missing$/);
  has(problemsOf((a) => { a.lines.pop(); }), new RegExp(`^lines: line ${grid.lines.length - 1} has no entry$`));
  has(problemsOf((a) => { a.lines.push({ index: 99, graphics: [] }); }), /^lines: the entry with index 99 does not belong to a line$/);
  has(problemsOf((a) => { a.lines.push(a.lines[0]); }), /^line 0: appears twice$/);
  // the texts are cut to the limits of graphics.js, and the answer is told
  const longTag = read(goodAnswer(grid, figure, { mutate: (a) => { a.lines[1].graphics = [{ key: 0, type: 'tag', text: 'ABCDEF GHIJKL MNOPQR STUVWX YZABCD EFGHIJ' }]; } }));
  has(longTag.problems, /^line 1, graphic 1 \(tag\) text: 41 characters, at most 32$/);
  assert.ok(longTag.content.lines[1].graphics[0].text.length <= graphicsLib.LIMITS.tag.text, `cut to ${longTag.content.lines[1].graphics[0].text}`);
  assert.equal(longTag.content.lines[1].graphics[0].text, 'ABCDEF GHIJKL MNOPQR STUVWX', 'cut at a word');
  const display = read(goodAnswer(grid, figure, { mutate: (a) => { a.lines[1].display = { style: 'neon', rows: [1, 2, 3, 4, 5].map((n) => ({ text: `WORD NUMBER ${n} LONG`, size: 'xl', box: true })) }; } }));
  has(display.problems, /^line 1 display: the style "neon" is none of condensed, serif, around$/);
  has(display.problems, /^line 1 display: 5 rows, at most 4$/);
  has(display.problems, /^line 1 display: only one row may have "box": true$/);
  has(display.problems, /^line 1 display row 1: 18 characters, at most 14$/);
  assert.equal(display.content.lines[1].display.rows.length, 4);
  assert.equal(display.content.lines[1].display.rows.filter((row) => row.box).length, 1);
  has(problemsOf((a) => { a.lines[1].display = { style: 'around', rows: [{ text: 'A' }, { text: 'B' }, { text: 'C' }] }; }), /"around" takes 2 rows/);
  // the texts of the screen are cleaned the way graphics.js cleans them
  const dirty = read(goodAnswer(grid, figure, { mutate: (a) => { a.hud.title = 'LIGHTS\n\u0007ON'; a.lines[1].graphics = [{ key: 0, type: 'tag', text: 'A\u0000B\tC' }]; } }));
  assert.ok(!/[\u0000-\u001f]/.test(dirty.content.hud.title) && !/[\u0000-\u001f]/.test(dirty.content.lines[1].graphics[0].text), JSON.stringify([dirty.content.hud.title, dirty.content.lines[1].graphics[0].text]));
  // the end card: cut to its limits, or none
  assert.equal(read(goodAnswer(grid, figure, { mutate: (a) => { delete a.endcard; } })).content.endcard, null);
  const longCard = read(goodAnswer(grid, figure, { mutate: (a) => { a.endcard = { title: 'T'.repeat(40), lines: ['one', 'two', 'three'] }; } }));
  has(longCard.problems, /^endcard\.title: 40 characters, at most 32$/);
  assert.equal(longCard.content.endcard.lines.length, 2);
  // a lot of wrong things at once do not stop the reading: everything is a problem, nothing throws
  const mess = read({ treatment: 5, hud: 'x', chapters: 'y', units: [null, 3, 'a', { index: 0 }, { index: 1, framing: 'CU', plate: 'x' }], lines: [{}, 'z', { index: 1, graphics: [null, 3, { type: {} }] }], endcard: [] });
  assert.equal(mess.ok, true);
  assert.ok(mess.problems.length > 5);
  assert.ok(mess.content.units.every((unit) => unit === null || typeof unit.plate === 'string'));
}

/* ---------- the plain values ---------- */

function testPlain() {
  const { grid } = gridOf('s72');
  const figure = figureOf();
  const { content, fallbacks } = hudPlan.completeContent(null, { grid, figure, brief: 'A film about a light that stays on', theme: 'hud' });
  assert.equal(fallbacks.units.length, grid.units.length);
  assert.equal(fallbacks.lines.length, grid.lines.length);
  assert.equal(fallbacks.chapters.length, grid.sections.length);
  assert.equal(fallbacks.hud, true);
  assert.equal(fallbacks.treatment, true);
  // the plain plates: framing, identity text by the framing, the action, the ending that keeps text out; WP52a: the units the code suggests for B-roll are
  // plain pictures without the figure (wide, the image words of the line, a hard move)
  const kinds = grid.units.map((unit) => unit.kind);
  const suggested = hudPlan.suggestBroll(grid);
  assert.ok(suggested.size >= 4, `${suggested.size} units without the figure`);
  content.units.forEach((unit, at) => {
    assert.ok(unit.plate.length <= planLib.MAX_PROMPT_CHARS && unit.plate.endsWith('no text, no letters, no logos'), `plate ${at}`);
    assert.ok(unit.plate.startsWith(`${unit.framing}, `), `plate ${at} starts with its framing`);
    if (suggested.has(at)) {
      assert.deepEqual([unit.withFigure, unit.framing], [false, 'WS'], `plate ${at}: B-roll`);
      assert.ok(unit.plate.startsWith('WS, 24 mm lens, no people, ') && !unit.plate.includes(figure.short) && !/mira/i.test(unit.plate), unit.plate);
      const words = grid.units[at].lines.length ? grid.lines[grid.units[at].lines[0]].text.split(' ').filter((word) => word.length >= 4) : [];
      if (words.length) assert.ok(words.some((word) => unit.plate.includes(word.toLowerCase())), `plate ${at} shows its line: ${unit.plate}`);
      if (kinds[at] === 'story') assert.match(unit.motion, /^(Fast|Rapid) .* No text, letters or logos\.$/);
      return;
    }
    assert.ok(unit.plate.includes(['ECU', 'CU', 'MCU', 'MS'].includes(unit.framing) ? figure.full : figure.short), `plate ${at} holds its identity text`);
    assert.equal(unit.withFigure, true);
    assert.ok(['left', 'center', 'right'].includes(unit.subject));
    if (kinds[at] === 'story') assert.ok(unit.motion.length > 20 && unit.motion.endsWith('No text, letters or logos.'), `motion ${at}`);
    else assert.equal(unit.motion, '');
    if (kinds[at] === 'performance') assert.ok(/mouth/.test(unit.plate) && ['ECU', 'CU', 'MCU', 'MS'].includes(unit.framing), `a sung unit shows the mouth (${at})`);
  });
  assert.equal(content.units[0].framing, 'CU', 'the hook is a close portrait');
  assert.equal(new Set(content.units.map((unit) => unit.plate)).size, content.units.length, 'no plate twice');
  // the plain plan passes the checks of B-roll (share, runs, no plate twice)
  const checked = hudPlan.readData({ units: content.units.map((unit, index) => ({ index, framing: unit.framing, with_figure: unit.withFigure, subject: unit.subject, plate: unit.plate, motion: unit.motion, shows: unit.shows })) }, { grid, figure, brief: 'A film about a light that stays on' });
  assert.deepEqual(checked.problems.filter((problem) => /without the figure|show no figure|on the screen|identical|nearly the same/.test(problem)), []);
  // a metaphor of the lyrics is never a picture: no needle, vein or blood, and never the name of the figure, in a plain picture without the figure
  const dark = JSON.parse(JSON.stringify(grid));
  const brollLine = [...suggested].map((at) => dark.units[at]).find((unit) => unit.lines.length);
  dark.lines[brollLine.lines[0]].text = 'Mira threads the net like a needle through a vein of blood and poison';
  const darkPlate = hudPlan.completeContent(null, { grid: dark, figure, brief: 'x', theme: 'hud' }).content.units[brollLine.index].plate;
  assert.ok(!/needle|vein|blood|poison|mira/i.test(darkPlate) && /threads/.test(darkPlate), darkPlate);
  // no B-roll asked for: every plain unit shows the figure
  assert.ok(hudPlan.completeContent(null, { grid, figure, brief: 'x', theme: 'hud', broll: new Set() }).content.units.every((unit) => unit.withFigure));
  // the plain chapters and HUD
  assert.deepEqual(content.chapters.map((chapter) => chapter.name), ['INTRO', 'VERSE I', 'CHORUS I', 'VERSE II', 'CHORUS II', 'OUTRO']);
  assert.equal(content.hud.title, 'FILM LIGHT STAYS', 'the first words of the brief that say something');
  assert.equal(hudPlan.completeContent(null, { grid, figure, brief: 'The of and', theme: 'hud' }).content.hud.title, 'MUSIC VIDEO');
  assert.equal(content.hud.counterLabel, 'CHAPTER');
  assert.deepEqual(content.hud.counterValues, [1, 2, 3, 4, 5, 6]);
  assert.equal(content.hud.instancesValues, null);
  assert.ok(content.hud.ticker.length >= 8 && content.hud.ticker.length <= 12 && content.hud.ticker.every((entry) => entry.length <= 40 && entry === entry.toUpperCase()));
  assert.equal(content.hud.figure, 'MIRA');
  assert.ok(content.hud.console.length <= 40);
  // the plain graphics: a counter for a number in the line, else a tag with the words; a display of the longest words
  grid.lines.forEach((line, at) => {
    const entry = content.lines[at];
    assert.ok(entry.graphics.length === 1 && entry.key >= 0 && entry.key < line.words.length, `line ${at}`);
    const hasNumber = line.words.some((word) => /^forty$/i.test(word.text));
    if (hasNumber) {
      const counter = entry.graphics.find((device) => device.type === 'counter');
      assert.ok(counter && counter.to === 40, `line ${at} says forty`);
      assert.equal(counter.key, line.words.findIndex((word) => /^forty$/i.test(word.text)), 'the counter appears with the number');
    } else {
      assert.equal(entry.graphics[0].type, 'tag', `line ${at}`);
      assert.ok(entry.graphics[0].text.length <= graphicsLib.LIMITS.tag.text && entry.graphics[0].text === entry.graphics[0].text.toUpperCase());
    }
    if (entry.display) assert.ok(entry.display.rows.every((row) => row.text.length <= graphicsLib.LIMITS.display.text));
  });
  // numbers in a line: figures, percent, words, other languages
  const numbered = (text) => hudPlan.numberInLine({ words: text.split(' ').map((word) => ({ text: word })) });
  assert.deepEqual(numbered('they sold 2,048 tickets'), { at: 2, value: 2048, percent: false, noun: 'tickets' });
  assert.deepEqual(numbered('ninety eight 64% sure'), { at: 0, value: 90, percent: false, noun: 'eight' });
  assert.equal(numbered('forty percent').percent, true);
  assert.equal(numbered('vierzig mal').value, 40);
  assert.equal(numbered('nothing to count here'), null);
  // a half answer: what is there stays, the rest is plain
  const half = goodAnswer(grid, figure);
  half.units = half.units.slice(0, 5);
  half.lines = half.lines.slice(0, 4);
  delete half.hud;
  const read = hudPlan.readAnswer(JSON.stringify(half), { grid, figure });
  const mixed = hudPlan.completeContent(read.content, { grid, figure, brief: 'A film', theme: 'hud' });
  assert.equal(mixed.fallbacks.units.length, grid.units.length - 5);
  assert.equal(mixed.fallbacks.lines.length, grid.lines.length - 4);
  assert.equal(mixed.fallbacks.hud, true);
  assert.equal(mixed.fallbacks.chapters.length, 0);
  assert.equal(mixed.fallbacks.treatment, false);
  assert.equal(mixed.content.units[2].plate, read.content.units[2].plate, 'a unit that was answered stays');
  assert.ok(mixed.content.units[2].plate.includes(figure.full) || mixed.content.units[2].plate.includes(figure.short), 'with the identity text the code put in');
  assert.equal(mixed.content.chapters[3].name, half.chapters[3].name);
  assert.equal(mixed.content.treatment, half.treatment);
}

/* ---------- the planner ---------- */

const emptyAnswer = (finishReason, usd = 0.9) => Object.assign(new Error(`The model returned an empty answer (finish_reason ${finishReason})`), { emptyAnswer: true, finishReason, usd });
const checkPlanClean = (result, label) => {
  assert.deepEqual(result.problems, [], `${label}: problems`);
  assert.deepEqual(result.fallbacks, { units: [], lines: [], chapters: [], hud: false, treatment: false }, `${label}: fallbacks`);
  assert.deepEqual(result.leftOut, [], `${label}: left out`);
};

async function testPlanner() {
  const { grid } = gridOf('s72');
  const figure = figureOf();
  const good = () => goodAnswer(grid, figure);

  /* a good answer: one request */
  {
    const { result, model, logs } = await plan('s72', [good()]);
    assert.equal(model.calls.length, 1);
    const request = model.calls[0];
    assert.equal(request.json, true);
    // WP52a: room for the thinking and the whole answer (see the comment at PLAN_MAX_TOKENS), and a medium effort
    assert.equal(request.maxTokens, 64000, 'the biggest film leaves room for thinking and text');
    assert.equal(hudPlan.PLAN_MAX_TOKENS, 64000);
    assert.equal(request.reasoningEffort, 'medium');
    assert.equal(hudPlan.PLAN_REASONING_EFFORT, 'medium');
    assert.equal(request.system, hudPlan.systemPrompt({ theme: 'hud', hudLanguage: 'en', needShort: false }));
    assert.equal(request.prompt, hudPlan.userPrompt({ brief: 'A made-up film about a light that stays on', style: '', figure, grid, broll: hudPlan.suggestBroll(grid) }));
    assert.match(request.prompt, /\| b-roll$/m, 'the suggestion of the code goes to the model');
    assert.deepEqual(result.broll, [...hudPlan.suggestBroll(grid)].sort((a, b) => a - b));
    assert.equal(result.plain, false);
    assert.deepEqual(result.tries.map((record) => [record.attempt, record.finish, record.effort]), [[1, 'complete', 'medium']]);
    assert.match(result.board, /^MODEL {6}the language model · try 1: effort medium, limit 64,000 tokens, complete, 0\.25 USD$/m);
    assert.equal(result.attempts, 1);
    assert.deepEqual(result.costs, [0.25]);
    checkPlanClean(result, 'good');
    assert.deepEqual(logs, [], 'a clean run says nothing');
    assert.deepEqual(result.notes, []);
    assert.equal(result.plan.shots.shots.length, grid.units.length);
    assert.equal(result.sheetPrompt, hudPlan.sheetPrompt(figure));
    assert.equal(result.effort, 'medium');
    // the style and the language go to the model
    const kuble = await plan('s72', [good()], { theme: 'kuble', hudLanguage: 'de' });
    assert.equal(kuble.model.calls[0].system, hudPlan.systemPrompt({ theme: 'kuble', hudLanguage: 'de', needShort: false }));
    assert.equal(kuble.result.plan.graphics.theme, 'kuble');
    assert.equal(result.plan.graphics.theme, 'hud');
    const styled = await plan('s72', [good()], { style: 'analog 16 mm, grainy' });
    assert.match(styled.model.calls[0].prompt, /STYLE\nanalog 16 mm, grainy/);
  }

  /* a bad answer, then a good one: the problems and the answer go to the second request, the second answer is the film */
  {
    const bad = good();
    bad.units = bad.units.slice(0, 10);
    bad.lines[0].graphics = Array.from({ length: 5 }, () => bad.lines[0].graphics[0]);
    const { result, model, logs } = await plan('s72', [bad, good()]);
    assert.equal(model.calls.length, 2);
    const second = model.calls[1];
    assert.match(second.prompt, /YOUR PREVIOUS ANSWER HAD THESE PROBLEMS/);
    assert.ok(second.prompt.includes('- units: units 10 to 21 have no entry') && second.prompt.includes('- line 0: needs 1 to 3 graphics (has 5)'));
    assert.ok(second.prompt.includes(`YOUR PREVIOUS ANSWER\n${JSON.stringify(bad)}`), 'the previous answer is in the request');
    assert.equal(second.system, model.calls[0].system, 'the same instructions');
    assert.equal(second.maxTokens, 64000);
    assert.equal(second.reasoningEffort, 'medium', 'a wrong answer is not an empty one: the same thinking');
    assert.equal(result.attempts, 2);
    assert.deepEqual(result.costs, [0.25, 0.25]);
    checkPlanClean(result, 'second answer');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^The answer of the language model had \d+ problems: asking once more \(units: units 10 to 21 have no entry; line 0: needs 1 to 3 graphics \(has 5\)/);
  }

  /* an answer that is no JSON: told, and no previous answer to repeat */
  {
    const { result, model } = await plan('s72', ['I am sorry, I cannot do that.', good()]);
    assert.equal(model.calls.length, 2);
    assert.ok(model.calls[1].prompt.includes('- The answer is not a JSON object.') && !model.calls[1].prompt.includes('YOUR PREVIOUS ANSWER\n'));
    checkPlanClean(result, 'after a text');
  }

  /* two bad answers: the better one is the film, what is missing is plain, and the problems are listed */
  {
    const worse = good();
    worse.units = worse.units.slice(0, 4);
    worse.lines = worse.lines.slice(0, 3);
    const better = good();
    better.units = better.units.slice(0, 18);
    for (const order of [[worse, better], [better, worse]]) {
      const { result, model, logs } = await plan('s72', order);
      assert.equal(model.calls.length, 2, 'never a third request');
      assert.equal(result.attempts, 2);
      assert.deepEqual(result.fallbacks.units, [18, 19, 20, 21], 'the better answer is used');
      assert.deepEqual(result.fallbacks.lines, [], 'the better answer has all lines');
      assert.equal(result.problems.length, 1);
      assert.equal(result.plan.shots.shots.length, grid.units.length, 'the film has all its units');
      assert.match(logs[logs.length - 1], /^1 problem left after the last try: the node corrected them where it could \(units: units 18 to 21 have no entry\)$/);
    }
    // equally good: the later one
    const same = [good(), good()];
    same[0].treatment = 'FIRST';
    same[0].units = same[0].units.slice(0, 20);
    same[1].treatment = 'SECOND';
    same[1].units = same[1].units.slice(0, 20);
    const { result } = await plan('s72', same);
    assert.equal(result.content.treatment, 'SECOND');
  }

  /* an empty answer: at the limit of the tokens the next request thinks less; for another reason it does not */
  {
    const { result, model, logs } = await plan('s72', [emptyAnswer('length'), good()]);
    assert.equal(model.calls.length, 2);
    assert.equal(model.calls[0].reasoningEffort, 'medium');
    assert.equal(model.calls[1].reasoningEffort, 'low');
    assert.equal(hudPlan.RETRY_REASONING_EFFORT, 'low');
    assert.equal(model.calls[1].prompt, model.calls[0].prompt, 'the same request: there was no answer to talk about');
    assert.deepEqual(result.costs, [0.9, 0.25], 'the empty answer was billed');
    assert.equal(result.attempts, 1, 'one answer was made');
    assert.equal(result.effort, 'low');
    checkPlanClean(result, 'after an empty answer');
    assert.match(logs[0], /^Attempt 1 of 2: the language model wrote nothing/);
    assert.match(logs[1], /^The model thought until the limit of 64000 tokens and wrote nothing: the next try thinks less \(effort low\)\.$/);
    assert.match(result.board, /^MODEL {6}the language model · try 1: effort medium, limit 64,000 tokens, empty, 0\.90 USD · try 2: effort low, limit 64,000 tokens, complete, 0\.25 USD$/m);
    const other = await plan('s72', [emptyAnswer('stop', null), good()]);
    assert.equal(other.model.calls[1].reasoningEffort, 'medium', 'an empty answer for another reason: the same thinking');
    assert.deepEqual(other.result.costs, [0.25], 'an empty answer without a reported cost adds none');
  }

  /* nothing usable twice: WP52a, the node stops (HUDPLAN_MODEL_FAILED) and the expensive nodes behind it do not run; with "Allow a plain plan" the film is made of
     plain values as before, and every empty answer is counted */
  {
    const failed = await errorOf(plan('s72', [emptyAnswer('length'), emptyAnswer('length', 0.7)]));
    assert.equal(failed && failed.code, 'HUDPLAN_MODEL_FAILED');
    assert.deepEqual(failed.costs, [0.9, 0.7]);
    assert.deepEqual(failed.data, { attempts: 2, usd: '1.60', plainUnits: grid.units.length, units: grid.units.length, plainLines: grid.lines.length, lines: grid.lines.length, tokens: 0, thinking: 0, limit: 64000, cut: false, model: '' });
    assert.match(failed.message, /^The language model delivered no usable plan in 2 attempts \(empty answer; the language model · try 1: effort medium, limit 64,000 tokens, empty, 0\.90 USD · try 2: effort low, limit 64,000 tokens, empty, 0\.70 USD\): 22 of 22 units and 15 of 15 lines would be plain, 1\.60 USD were paid\. Run the node again, choose another model, or switch on "Allow a plain plan"/);
    assert.equal((await errorOf(plan('s72', ['not json', 'still not json']))).code, 'HUDPLAN_MODEL_FAILED', 'two answers that are no objects');
    const { result, model, logs } = await plan('s72', [emptyAnswer('length'), emptyAnswer('length', 0.7)], { allowPlain: true });
    assert.equal(model.calls.length, 2);
    assert.equal(result.plain, true);
    assert.deepEqual(result.costs, [0.9, 0.7]);
    assert.equal(result.attempts, 0);
    assert.equal(result.fallbacks.units.length, grid.units.length);
    assert.equal(result.fallbacks.lines.length, grid.lines.length);
    assert.equal(result.fallbacks.hud, true);
    assert.ok(logs.some((line) => /delivered no usable answer: the plates, the graphics and the HUD values are plain ones \(allowed by "Allow a plain plan"\)/.test(line)));
    assert.equal(result.plan.shots.shots.length, grid.units.length);
    assert.equal(result.plan.graphics.cuts.length, grid.cuts.length);
    assert.match(result.board, /^PLAIN {6}made without the language model: 22 plates \(units 0 to 21\), 15 lines of graphics \(lines 0 to 14\), the HUD values, 6 chapter names, no treatment \(a plain plan, allowed by "Allow a plain plan"\)$/m);
    // the plain plan has its B-roll too
    assert.ok(result.content.units.some((unit) => !unit.withFigure) && result.content.units[0].withFigure);
    const text = await plan('s72', ['not json', 'still not json'], { allowPlain: true });
    assert.equal(text.result.fallbacks.units.length, grid.units.length, 'two answers that are no objects');
    assert.equal(text.result.attempts, 2);
    assert.deepEqual(text.result.costs, [0.25, 0.25]);
  }

  /* an error of the request itself: the first answer is needed; a second request that fails leaves the first answer */
  {
    const down = new Error('The language model is down');
    const first = await errorOf(plan('s72', [down]));
    assert.equal(first, down, 'the error of the first request ends the node');
    const bad = good();
    bad.units = bad.units.slice(0, 18);
    const { result, model, logs } = await plan('s72', [bad, down]);
    assert.equal(model.calls.length, 2);
    assert.equal(result.attempts, 1);
    assert.deepEqual(result.fallbacks.units, [18, 19, 20, 21]);
    assert.ok(logs.some((line) => /^The second request to the language model failed \(The language model is down\): the first answer is used\.$/.test(line)), logs.join(' | '));
    // the end of the run, a budget that is used up: always ends the node
    const budget = Object.assign(new Error('The budget is used up'), { name: 'BudgetError' });
    const ended = await errorOf(plan('s72', [bad, budget], { fatal: (err) => err.name === 'BudgetError' }));
    assert.equal(ended, budget);
    const abort = Object.assign(new Error('stopped'), { name: 'AbortError' });
    assert.equal(await errorOf(plan('s72', [abort], { fatal: (err) => err.name === 'AbortError' })), abort);
    // an empty answer that is fatal: no second request
    const fatalEmpty = Object.assign(emptyAnswer('length'), { name: 'BudgetError' });
    const ended2 = await errorOf(plan('s72', [fatalEmpty, good()], { fatal: (err) => err.name === 'BudgetError' }));
    assert.equal(ended2, fatalEmpty);
  }

  /* the figure without a SHORT form: the model is asked for one and the plates use it */
  {
    const noShort = figureOf(FIGURE_NO_SHORT);
    const { result, model } = await plan('s72', [goodAnswer(grid, noShort)], { figureText: FIGURE_NO_SHORT });
    assert.match(model.calls[0].system, /"figure_short"/);
    assert.match(model.calls[0].prompt, /SHORT: \(none given: write it yourself and return it as "figure_short"\)/);
    checkPlanClean(result, 'no short form');
    assert.equal(result.content.figureShort, 'a woman with short copper hair and a grey wool coat');
    assert.equal(result.figure.credit, 'Mira by the test lab (example.org)');
  }

  /* the layout is part of the answer: a graphic that cannot stand beside the face is told to the model, with the room and what would fit */
  {
    const unitOfLine = (line) => grid.units.find((unit) => line.words[0].start >= unit.start - 1e-6 && line.words[0].start < unit.end - 1e-6).index;
    const entries = goodAnswer(grid, figure).units;
    const target = grid.lines.find((line) => ['CU', 'ECU'].includes(entries[unitOfLine(line)].framing));
    assert.ok(target, 'a line in a close-up');
    const at = unitOfLine(target);
    const bad = goodAnswer(grid, figure, {
      mutate: (a) => {
        a.units[at].subject = 'center';
        a.lines[target.index].graphics = [{ key: 0, type: 'chart', title: 'CHART', values: [23, 27, 26, 34, 41, 58], marker: 'MAX' }];
        a.lines[target.index].display = null;
      }
    });
    const { result, model } = await plan('s72', [bad, good()]);
    assert.equal(model.calls.length, 2, 'the layout found a graphic without room');
    const told = model.calls[1].prompt;
    const room = hudPlan.freeLanes({ framing: entries[at].framing, subject: 'center' }).left;
    const sentenceText = `line ${target.index}: the chart \\(about \\d+ px wide\\) does not fit beside the face in unit ${at} \\(${entries[at].framing}, figure center: ${room} px are free\\): choose a smaller type \\((\\w+(, \\w+)*)\\), or put the figure at the left or right of the picture in unit ${at} \\("subject"\\), or make unit ${at} wider \\(MS or more\\)`;
    const sentence = new RegExp(`^${sentenceText}$`);
    assert.match(told, new RegExp(`- ${sentenceText}`));
    const fits = new RegExp(sentenceText).exec(told)[1].split(', ');
    const sizes = hudPlan.typicalSizes('hud');
    assert.ok(fits.length >= 2 && fits.every((type) => sizes[type].w <= room / (graphicsLib.MIN_SCALE[type] || 1)), `what is suggested fits: ${fits}`);
    checkPlanClean(result, 'after the layout told');
    // the same answer twice: the graphic stays without room, it is listed on the board and in the problems, and the film is made all the same
    const stuck = await plan('s72', [bad]);
    assert.equal(stuck.model.calls.length, 2);
    assert.equal(stuck.result.leftOut.length, 1);
    assert.deepEqual(stuck.result.leftOut[0], { id: `g${target.index}a`, line: target.index, key: 0, type: 'chart', unit: at });
    assert.equal(stuck.result.problems.length, 1);
    assert.match(stuck.result.problems[0], sentence);
    assert.match(stuck.result.board, new RegExp(`^LEFT OUT {3}1 graphic found no place beside the face and is not drawn: chart on line ${target.index} \\(unit ${at}\\)$`, 'm'));
    assert.equal(stuck.result.plan.shots.shots.length, grid.units.length);
    assert.equal(stuck.result.plan.graphics.graphics.length, graphicsLib.prepareGraphics(stuck.result.plan.graphics, {}).graphics.devices.length + 1, 'the renderer leaves out the one that has no room');
  }
}

/* ---------- WP52a: an answer cut off at the limit of tokens, no silent plain plan, dense songs ---------- */

// The JSON of a good answer, cut off inside the unit `index` (as an answer that reached the limit of tokens ends).
function cutInsideUnit(answer, index) {
  const text = JSON.stringify(answer, null, 2);
  const units = text.indexOf('"units": [');
  const at = text.indexOf(`"index": ${index},`, units);
  assert.ok(units > 0 && at > units, `unit ${index} in the answer`);
  return text.slice(0, at + 30);
}
const CUT_USAGE = { completion_tokens: 64000, completion_tokens_details: { reasoning_tokens: 41000 } };

async function testRescue() {
  const { grid } = gridOf('s72');
  const figure = figureOf();
  const full = goodAnswer(grid, figure);
  const whole = JSON.stringify(full, null, 2);

  /* salvageJson: the complete parts of a cut answer, and nothing more */
  {
    const cut = cutInsideUnit(full, 14);
    const salvaged = hudPlan.salvageJson(cut);
    assert.equal(salvaged.cut, true);
    assert.deepEqual(Object.keys(salvaged.data), ['treatment', 'hud', 'chapters', 'units']);
    assert.deepEqual(salvaged.data.units, full.units.slice(0, 14), 'the units before the cut, the unit that was cut is left out');
    assert.deepEqual([salvaged.data.treatment, salvaged.data.hud, salvaged.data.chapters], [full.treatment, full.hud, full.chapters]);
    // a fence around the answer (```json) and text before it change nothing
    assert.deepEqual(hudPlan.salvageJson('```json\n' + cut), salvaged);
    assert.deepEqual(hudPlan.salvageJson('Here is the plan:\n```json\n' + cut), salvaged);
    // a whole answer is read whole, also in a fence
    assert.deepEqual(hudPlan.salvageJson(whole), { data: full, cut: false });
    assert.deepEqual(hudPlan.salvageJson('```json\n' + whole + '\n```'), { data: full, cut: false });
    // cut inside a string of the treatment: nothing but the object without it; no object at all: nothing
    assert.deepEqual(hudPlan.salvageJson('{"treatment": "A film about'), { data: {}, cut: true });
    assert.deepEqual(hudPlan.salvageJson('not json'), { data: null, cut: false });
    assert.deepEqual(hudPlan.salvageJson(''), { data: null, cut: false });
    // what is missing, and the merge of the rest (the kept parts win)
    const missing = hudPlan.missingParts(salvaged.data, grid, figure);
    assert.deepEqual(missing, { treatment: false, hud: false, endcard: true, figureShort: false, chapters: [], units: [14, 15, 16, 17, 18, 19, 20, 21], lines: grid.lines.map((line) => line.index) });
    const rest = { units: full.units.slice(13), lines: full.lines, endcard: full.endcard, treatment: 'another treatment' };
    rest.units[0] = { ...rest.units[0], plate: 'a plate written twice' };
    const merged = hudPlan.mergeAnswers(salvaged.data, rest);
    assert.equal(merged.treatment, full.treatment);
    assert.deepEqual(merged.units, full.units, 'unit 13 is the kept one');
    assert.deepEqual([merged.lines, merged.endcard], [full.lines, full.endcard]);
  }

  /* cut off at the limit: the complete parts are kept, the second try thinks less and asks only for the rest; the film is the one of a whole answer */
  {
    const cut = cutInsideUnit(full, 14);
    let asked = null;
    const steps = [
      { reply: { text: '```json\n' + cut, finishReason: 'length', usage: CUT_USAGE, model: 'anthropic/claude-opus-5.5' } },
      (request) => {
        asked = request;
        return { units: full.units.slice(14), lines: full.lines, endcard: full.endcard };
      }
    ];
    const { result, model, logs } = await plan('s72', steps);
    assert.equal(model.calls.length, 2);
    assert.deepEqual(model.calls.map((call) => [call.maxTokens, call.reasoningEffort]), [[64000, 'medium'], [64000, 'low']], 'the second try thinks less');
    assert.equal(asked.system, model.calls[0].system);
    assert.match(asked.prompt, /^YOUR PREVIOUS ANSWER WAS CUT OFF AT THE LIMIT OF TOKENS\. /m);
    assert.match(asked.prompt, /"units" with the units 14 to 21, "lines" with the lines 0 to 14, "endcard", in the schema above/);
    assert.ok(asked.prompt.includes(JSON.stringify(hudPlan.salvageJson(cut).data)), 'the kept parts go with it');
    assert.doesNotMatch(asked.prompt, /HAD THESE PROBLEMS/);
    assert.ok(asked.prompt.length < model.calls[0].prompt.length + whole.length, 'the prompt holds the kept parts once');
    assert.ok(logs.includes('The answer of the language model was cut off at the limit of 64000 tokens after 14 of 22 units and 0 of 15 lines: the complete parts are kept and the next try asks only for the rest (effort low).'), logs.join(' | '));
    checkPlanClean(result, 'a cut answer and its rest');
    const clean = (await plan('s72', [full])).result;
    assert.deepEqual(result.content, clean.content, 'the same film as from one whole answer');
    assert.deepEqual(result.plan.graphics, clean.plan.graphics);
    assert.deepEqual(result.costs, [0.25, 0.25]);
    assert.deepEqual(result.tries.map((record) => [record.attempt, record.rest, record.effort, record.finish, record.completion, record.reasoning, record.units, record.lines]), [
      [1, false, 'medium', 'cut', 64000, 41000, 14, 0],
      [2, true, 'low', 'complete', null, null, 8, 15]
    ]);
    assert.match(
      result.board,
      /^MODEL {6}anthropic\/claude-opus-5\.5 · try 1: effort medium, 64,000 of 64,000 tokens \(thinking 41,000, text 23,000\), cut off at the limit, 14 of 22 units and 0 of 15 lines complete, 0\.25 USD · try 2 \(the rest\): effort low, limit 64,000 tokens, complete, 0\.25 USD$/m
    );
    assert.doesNotMatch(result.board, /^PLAIN/m);
  }

  /* the rest is cut off too, a little: what is still missing is plain, and the board names exactly which plates and lines */
  {
    const restText = JSON.stringify({ units: full.units.slice(14), lines: full.lines, endcard: full.endcard }, null, 2);
    const linesAt = restText.indexOf('"lines": [');
    const cutRest = restText.slice(0, restText.indexOf('"index": 13,', linesAt) + 20);
    const steps = [
      { reply: { text: cutInsideUnit(full, 14), finishReason: 'length', usage: CUT_USAGE } },
      { reply: { text: cutRest, finishReason: 'length', usage: { completion_tokens: 64000 } } }
    ];
    const { result } = await plan('s72', steps);
    assert.deepEqual(result.fallbacks.units, []);
    assert.deepEqual(result.fallbacks.lines, [13, 14]);
    assert.equal(result.fallbacks.treatment, false);
    assert.match(result.board, /^PLAIN {6}made without the language model: 2 lines of graphics \(lines 13, 14\)$/m);
    assert.match(result.board, / · try 2 \(the rest\): effort low, 64,000 of 64,000 tokens, cut off at the limit, 8 of 22 units and 13 of 15 lines complete, 0\.25 USD$/m);
  }

  /* too little in the end (the second request fails after a cut answer: 8 of 22 plates would be plain): HUDPLAN_MODEL_FAILED, with "Allow a plain plan" the rest is plain */
  {
    const steps = [{ reply: { text: cutInsideUnit(full, 14), finishReason: 'length', usage: CUT_USAGE } }, new Error('429 too many requests')];
    const failed = await errorOf(plan('s72', steps));
    assert.equal(failed && failed.code, 'HUDPLAN_MODEL_FAILED');
    assert.deepEqual(failed.data, { attempts: 2, usd: '0.25', plainUnits: 8, units: 22, plainLines: 15, lines: 15, tokens: 64000, thinking: 41000, limit: 64000, cut: true, model: '' });
    assert.match(failed.message, /^The language model delivered no usable plan in 2 attempts \(cut off at the limit of 64,000 tokens, failed request; /);
    const { result, logs } = await plan('s72', steps, { allowPlain: true });
    assert.deepEqual(result.fallbacks.units, [14, 15, 16, 17, 18, 19, 20, 21]);
    assert.match(result.board, /^PLAIN {6}made without the language model: 8 plates \(units 14 to 21\), 15 lines of graphics \(lines 0 to 14\) \(a plain plan, allowed by "Allow a plain plan"\)$/m);
    assert.ok(logs.some((line) => /^The language model delivered too little \(8 of 22 plates and 15 of 15 lines are plain\): the rest is plain \(allowed by "Allow a plain plan"\)\.$/.test(line)), logs.join(' | '));
    // up to a quarter plain is no failure: 5 of 22 units missing in both answers
    const short = { ...full, units: full.units.slice(0, 17) };
    const some = (await plan('s72', [short, short])).result;
    assert.deepEqual(some.fallbacks.units, [17, 18, 19, 20, 21]);
    assert.match(some.board, /^PLAIN {6}made without the language model: 5 plates \(units 17 to 21\)$/m);
  }

  /* broken off without the limit (invalid JSON in the middle): the complete parts are kept as well, with the same thinking */
  {
    const broken = whole.slice(0, whole.indexOf('"lines": [')) + '"lines": [ {"index": 0, oops';
    const { result, model } = await plan('s72', [broken, { lines: full.lines, endcard: full.endcard }]);
    assert.deepEqual(model.calls.map((call) => call.reasoningEffort), ['medium', 'medium']);
    assert.match(model.calls[1].prompt, /"lines" with the lines 0 to 14, "endcard", in the schema above/);
    checkPlanClean(result, 'broken off');
    assert.equal(result.tries[0].finish, 'broken');
    assert.match(result.board, /try 1: effort medium, limit 64,000 tokens, broke off \(invalid JSON\), 22 of 22 units and 0 of 15 lines complete/);
  }
}

// A song without a sung line: no line to show, so no share of B-roll is asked for (pictures without the figure stay allowed)
function testBrollWithoutLines() {
  const song = songOf('s72');
  const grid = hudPlan.planGrid(song.analysis, { version: 1, words: [], lines: [] }, MIXED);
  const figure = figureOf();
  const answer = goodAnswer(grid, figure);
  assert.ok(answer.units.every((unit) => unit.with_figure !== false));
  assert.deepEqual(hudPlan.readAnswer(JSON.stringify(answer), { grid, figure, brief: 'A made-up film about a light that stays on' }).problems, []);
}

// A song sung without pauses (the real song of WP52a had 5 windows in 33 s of 76 s asked): long lines with tiny gaps between them, a gap of 0.14 to 0.2 s after
// every fourth word, a line of a choir in every chorus. The windows of whole lines do not find enough; the windows between words do.
function denseSong() {
  const base = makeSong({ seconds: 120, seed: 13 });
  let seed = 29;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const vocabulary = ['silver', 'door', 'light', 'engine', 'flood', 'sky', 'again', 'clone', 'river', 'signal', 'night', 'fire', 'glass', 'begin'];
  const lines = [];
  const words = [];
  for (const section of base.analysis.sections.filter((item) => /verse|chorus/i.test(item.name))) {
    let time = section.start + 0.4;
    let count = 0;
    while (time < section.end - 3) {
      const line = [];
      for (let at = 0, size = 14 + Math.floor(rnd() * 8); at < size; at += 1) {
        const length = 0.22 + rnd() * 0.22;
        line.push({ text: vocabulary[Math.floor(rnd() * vocabulary.length)], start: Math.round(time * 1000) / 1000, end: Math.round((time + length) * 1000) / 1000 });
        time += length + (at % 4 === 3 ? 0.14 + rnd() * 0.06 : 0.04);
      }
      if (line[line.length - 1].end > section.end - 0.3) break;
      words.push(...line);
      const choir = /chorus/i.test(section.name) && count === 1;
      lines.push({ text: line.map((word) => word.text).join(' '), start: line[0].start, end: line[line.length - 1].end, ...(choir ? { voice: 'choir' } : {}) });
      time += 0.08;
      count += 1;
    }
  }
  return { seconds: 120, analysis: base.analysis, timing: { version: 1, lines, words } };
}

function testDenseWindows() {
  const song = denseSong();
  assert.equal(song.timing.lines.filter((line) => line.voice === 'choir').length, 2);
  for (const options of [{}, MIXED]) {
    const grid = hudPlan.planGrid(song.analysis, song.timing, options);
    const label = `dense ${JSON.stringify(options)}`;
    const asked = (grid.settings.lipsyncSecondsPerMinute * grid.duration) / 60;
    // before WP52a: 2 windows, 12.1 s of 44 s (27 %); now at least 80 % of what is asked
    assert.ok(grid.stats.lipsyncSeconds >= hudPlan.WINDOW_GOAL * asked, `${label}: ${grid.stats.lipsyncSeconds} s of ${asked} s`);
    assert.ok(grid.stats.lipsyncSeconds <= asked * 1.15, `${label}: not much more than asked`);
    assert.ok(grid.warnings.includes('WORD_WINDOWS'), label);
    checkGrid(grid, song, label, { rate: false });
    const sung = grid.units.filter((unit) => unit.kind === 'performance');
    assert.ok(sung.length >= 6, `${label}: ${sung.length} windows`);
    // spread over the song: windows in the first, the middle and the last third, and in every chorus
    for (const third of [0, 1, 2]) assert.ok(sung.some((unit) => unit.start >= (third * grid.duration) / 3 && unit.start < ((third + 1) * grid.duration) / 3), `${label}: third ${third}`);
    for (const section of song.analysis.sections.filter((item) => /chorus/i.test(item.name))) {
      assert.ok(sung.some((unit) => unit.start < section.end && unit.end > section.start), `${label}: a window in ${section.name}`);
    }
    // a window between two words starts and ends in a gap of at least 0.12 s (or at the end of a line), never inside a word, never on a word of the choir
    for (const unit of sung) {
      for (const edge of [unit.start, unit.end]) {
        assert.ok(!song.timing.words.some((word) => word.start + 0.001 < edge && edge < word.end - 0.001), `${label}: an edge of unit ${unit.index} inside a word`);
      }
    }
  }
  // the suggested B-roll is spread over the song: every third of the units that are not sung has some, also a quiet first part
  for (const name of ['s72', 'slow', 'fast', 'long']) {
    const { grid } = gridOf(name, { motionShare: 1, maxUnits: 50 });
    const open = grid.units.filter((unit) => unit.kind !== 'performance' && unit.index > 0).map((unit) => unit.index);
    const picked = hudPlan.suggestBroll(grid);
    for (const third of [0, 1, 2]) {
      const part = open.slice(Math.floor((third * open.length) / 3), Math.floor(((third + 1) * open.length) / 3));
      assert.ok(part.some((index) => picked.has(index)), `${name}: B-roll in the third ${third} of the song (${[...picked]})`);
    }
  }
  // a song that reaches the goal with whole lines keeps the grid of before (no window between words)
  for (const name of ['s60', 's72', 'slow', 'fast', 'long']) assert.ok(!gridOf(name).grid.warnings.includes('WORD_WINDOWS'), name);
}

/* ---------- the graphics for the renderer ---------- */

async function testGraphics() {
  for (const name of Object.keys(SONGS)) {
    const { grid } = gridOf(name);
    const { result, song } = await plan(name, [answerFor(name)]);
    checkPlanClean(result, name);
    const graphics = result.plan.graphics;
    // through the renderer's own reader and layout: no note, with and without the karaoke line, also after the trip through the text of the port
    for (const input of [graphics, JSON.parse(JSON.stringify(graphics)), JSON.stringify(graphics)]) {
      for (const karaoke of [false, true]) assert.deepEqual(graphicsLib.prepareGraphics(input, { karaoke }).warnings, [], `${name}: karaoke ${karaoke}`);
    }
    const { graphics: prepared } = graphicsLib.prepareGraphics(graphics, { karaoke: false });
    assert.equal(prepared.cuts.length, grid.cuts.length, `${name}: no cut is lost`);
    assert.equal(prepared.lines.length, grid.lines.length, `${name}: no line is lost`);
    assert.equal(prepared.devices.length, graphics.graphics.length, `${name}: no device is left out`);

    assert.equal(graphics.version, 1);
    near(graphics.duration, song.seconds, 1e-9);
    assert.deepEqual([graphics.fps, graphics.width, graphics.height], [24, 1920, 1080]);
    assert.equal(graphics.theme, 'hud');
    assert.equal(graphics.accent, graphicsLib.accentFor('hud', graphicsLib.DEFAULT_ACCENT));
    // the HUD
    const hud = graphics.hud;
    assert.equal(hud.title, 'MOTH PARADE');
    assert.equal(hud.counter.label, 'WATTS');
    assert.equal(hud.counter.steps.length, grid.sections.length);
    assert.deepEqual(hud.counter.steps.map((step) => step.at), grid.sections.map((section, index) => (index === 0 ? 0 : section.start)));
    assert.deepEqual(hud.counter.steps.map((step) => step.value), [1, 3, 9, 27, 81, 243]);
    assert.equal(hud.instances.label, 'MOTHS');
    assert.equal(hud.instances.steps.length, grid.sections.length);
    assert.equal(hud.chapters.length, grid.sections.length);
    hud.chapters.forEach((chapter, index) => {
      near(chapter.start, index === 0 ? 0 : hud.chapters[index - 1].end, 1e-6);
      assert.ok(chapter.name === chapter.name.toUpperCase() && chapter.name.length <= 18);
    });
    near(hud.chapters[hud.chapters.length - 1].end, song.seconds, 1e-6);
    assert.ok(hud.ticker.length >= 8 && hud.ticker.length <= 12);
    assert.equal(hud.figure, 'MIRA');
    assert.equal(hud.rec, 'REC · CAM A · 24 FPS · ISO 800');
    assert.deepEqual(hud.drops, grid.drops);
    // the music block is the one of the grid
    assert.deepEqual(graphics.music, grid.music);
    // the cuts: the ones of the grid, with the framing and the place of the figure of the answer
    graphics.cuts.forEach((cut, index) => {
      const planned = grid.cuts[index];
      assert.deepEqual([cut.start, cut.end, cut.unit, cut.transition], [planned.start, planned.end, planned.unit, planned.transition]);
      assert.equal(cut.kind, grid.units[cut.unit].kind);
      assert.equal(cut.crop.scale, planned.zoom);
      // WP52a: a cut of B-roll has no subject and no framing (its tags stand without a line, its graphics have the whole screen)
      if (cut.subject === 'none') {
        assert.ok(!('framing' in cut) && grid.units[cut.unit].kind !== 'performance' && cut.unit > 0, `${name}: cut ${index} without the figure`);
        assert.deepEqual([cut.crop.x, cut.crop.y], [0.5, 0.5]);
        return;
      }
      assert.ok(['left', 'center', 'right'].includes(cut.subject) && graphicsLib.FRAMINGS.includes(cut.framing), `${name}: cut ${index}`);
      if (planned.zoom > 1) assert.deepEqual([cut.crop.x, cut.crop.y], [{ left: 0.27, center: 0.5, right: 0.73 }[cut.subject], 0.42], 'a punch-in goes to the figure');
      else assert.deepEqual([cut.crop.x, cut.crop.y], [0.5, 0.5]);
    });
    // the lines
    graphics.lines.forEach((line, index) => {
      assert.equal(line.words.length, grid.lines[index].words.length);
      assert.ok(Number.isInteger(line.key) && line.key >= 0 && line.key < line.words.length);
    });
    // the devices: their own word, at least a second on the screen, a known place, an id of the line, one to three per line, the big words besides
    const ids = new Set();
    for (const device of graphics.graphics) {
      assert.ok(!ids.has(device.id), `${name}: ${device.id} twice`);
      ids.add(device.id);
      const line = grid.lines[device.line];
      assert.ok(line && device.key >= 0 && device.key < line.words.length, `${name}: ${device.id}`);
      assert.ok(graphicsLib.DEVICE_TYPES.includes(device.type) && graphicsLib.POSITIONS.includes(device.position), `${name}: ${device.id} ${device.type} ${device.position}`);
      assert.ok(device.end - device.start >= 1.2 - 1e-9, `${name}: ${device.id} lives ${device.end - device.start} s`);
      assert.ok(device.end <= song.seconds + 0.4 + 1e-6, `${name}: ${device.id} ends at ${device.end}`);
      if (device.type !== 'display') {
        near(device.start, line.words[device.key].start, 0.0006, `${name}: ${device.id} appears with its word`);
        assert.match(device.id, new RegExp(`^g${device.line}[abc]$`));
      } else {
        assert.equal(device.id, `d${device.line}`);
        assert.ok(device.start >= line.start - 1e-6 && device.start <= line.words[device.key].start + 1e-6);
      }
      if (device.type === 'toggle') assert.ok(Array.isArray(device.flips));
    }
    for (const line of grid.lines) {
      const count = graphics.graphics.filter((device) => device.line === line.index && device.type !== 'display').length;
      assert.ok(count >= 1 && count <= 3, `${name}: line ${line.index} has ${count} graphics`);
    }
    // within a line the places are different
    for (const line of grid.lines) {
      const places = graphics.graphics.filter((device) => device.line === line.index && !['around', 'center', 'top'].includes(device.position)).map((device) => device.position);
      assert.equal(new Set(places).size, places.length, `${name}: line ${line.index} puts two graphics in one place`);
    }
    // the end card: the line of the person, the label of the AI, the credit of the figure
    assert.equal(graphics.endcard.seconds, 3);
    assert.equal(graphics.endcard.title, 'MOTH PARADE');
    assert.deepEqual(graphics.endcard.lines, ['A film about a light', 'AI-GENERATED MUSIC VIDEO · Images, clips and graphics made with AI', 'Mira by the test lab (example.org)']);
  }

  // the language of the label of the AI, the end card without a credit, without an answer for it
  const german = await plan('s60', [answerFor('s60')], { hudLanguage: 'de' });
  assert.deepEqual(german.result.plan.graphics.endcard.lines.slice(1, 2), ['KI-GENERIERTES MUSIKVIDEO · Bilder, Clips und Grafiken mit KI erstellt']);
  const spanish = await plan('s60', [answerFor('s60')], { hudLanguage: 'es' });
  assert.match(spanish.result.plan.graphics.endcard.lines[1], /^VIDEOCLIP GENERADO CON IA · /);
  const withoutCredit = FIGURE_TEXT.split('\n').filter((line) => !line.startsWith('CREDIT')).join('\n');
  const plain = await plan('s60', [answerFor('s60', (a) => { a.endcard = { title: 'THE END', lines: ['one', 'two', 'three'] }; }, withoutCredit)], { figureText: withoutCredit });
  assert.deepEqual(plain.result.plan.graphics.endcard.lines, ['one', 'two', 'AI-GENERATED MUSIC VIDEO · Images, clips and graphics made with AI']);
  assert.equal(plain.result.plan.graphics.endcard.title, 'THE END');
  const noCard = await plan('s60', [answerFor('s60', (a) => { delete a.endcard; })]);
  assert.equal(noCard.result.plan.graphics.endcard.title, 'MOTH PARADE', 'the title of the HUD');
  assert.deepEqual(noCard.result.plan.graphics.endcard.lines, ['AI-GENERATED MUSIC VIDEO · Images, clips and graphics made with AI', 'Mira by the test lab (example.org)']);

  // a unit without the figure (B-roll, WP52a) is a cut without a subject and without a framing; the board marks it with what it shows
  {
    const { grid } = gridOf('s72');
    const answer = answerFor('s72');
    const shortStills = answer.units.filter((unit) => unit.with_figure === false).map((unit) => unit.index);
    assert.ok(shortStills.length >= 4, `${shortStills.length} units of B-roll`);
    const { result } = await plan('s72', [answer]);
    checkPlanClean(result, 'B-roll');
    for (const cut of result.plan.graphics.cuts) {
      if (shortStills.includes(cut.unit)) {
        assert.equal(cut.subject, 'none');
        assert.ok(!('framing' in cut), 'no framing without a figure');
      } else {
        assert.notEqual(cut.subject, 'none');
      }
    }
    for (const at of shortStills) {
      assert.equal(result.plan.shots.shots[at].subject, 'none');
      assert.equal(result.plan.shots.shots[at].with_figure, false);
      // the picture nodes send the character sheet along: the prompt of B-roll says that she does not appear
      assert.ok(result.plan.shots.shots[at].prompt.endsWith(` ${hudPlan.NO_FIGURE_NOTE}`), result.plan.shots.shots[at].prompt);
    }
    assert.ok(result.plan.shots.shots.filter((shot) => shot.with_figure).every((shot) => !shot.prompt.includes(hudPlan.NO_FIGURE_NOTE)));
    assert.deepEqual(graphicsLib.prepareGraphics(result.plan.graphics, {}).warnings, []);
    assert.match(result.board, new RegExp(`^ ?${shortStills[0]} {2}\\d:\\d\\d\\.\\d–\\d:\\d\\d\\.\\d {2}(STILL|STORY) {2}WS, no figure`, 'm'));
    assert.match(result.board, new RegExp(`^ {8}B-ROLL «${answer.units[shortStills[0]].shows}»: `, 'm'));
    const open = grid.units.filter((unit) => unit.kind !== 'performance' && unit.index > 0).length;
    assert.match(result.board, new RegExp(`^NUMBERS .* · B-roll ${shortStills.length} of ${open} story units \\(${Math.round((shortStills.length / open) * 100)}%\\) · lip sync [\\d.]+ s of [\\d.]+ s asked in \\d+ windows · `, 'm'));
  }

  // the layout loop: shorter lives of the graphics make room when the screen is crowded
  {
    const { grid } = gridOf('dense');
    const figure = figureOf();
    const read = hudPlan.readAnswer(JSON.stringify(goodAnswer(grid, figure)), { grid, figure });
    const { content } = hudPlan.completeContent(read.content, { grid, figure, brief: 'x', theme: 'hud' });
    const args = { grid, content, figure, theme: 'hud', accent: graphicsLib.DEFAULT_ACCENT, hudLanguage: 'en' };
    const looped = hudPlan.layoutLoop(args);
    assert.ok(hudPlan.DEVICE_TAILS.includes(looped.tail));
    assert.equal(looped.check.leftOut.length, 0);
    // the tails are tried from the longest to the shortest: a crowded plan takes a shorter one, an empty plan keeps the longest
    assert.deepEqual([...hudPlan.DEVICE_TAILS], [...hudPlan.DEVICE_TAILS].sort((a, b) => b - a));
    const crowded = JSON.parse(JSON.stringify(content));
    crowded.lines.forEach((line) => {
      line.graphics = [line.graphics[0], { key: Math.min(1, 0), type: 'tag', text: 'ONE MORE' }].slice(0, 2);
      line.graphics[1].key = Math.min(line.key + 1, 1);
    });
    const tight = hudPlan.layoutLoop({ ...args, content: crowded });
    assert.ok(tight.tail <= looped.tail, `a crowded plan does not live longer (${tight.tail} s against ${looped.tail} s)`);
  }
}

/* ---------- the shots and the lists ---------- */

async function testShots() {
  for (const name of Object.keys(SONGS)) {
    const { grid } = gridOf(name);
    const { result } = await plan(name, [answerFor(name)]);
    const shots = result.plan.shots;
    // the reader of the nodes after this one takes it as it is
    const parsed = planLib.parseShots(JSON.stringify(shots));
    assert.ok(parsed, `${name}: music_video.edit can read the plan`);
    assert.equal(parsed.shots.length, grid.units.length);
    assert.ok(parsed.shots.length <= planLib.MAX_SCENES, `${name}: ${parsed.shots.length} scenes`);
    for (const kind of ['story', 'performance', 'still']) {
      const wanted = grid.units.filter((unit) => unit.kind === kind).length;
      assert.equal(parsed[kind], wanted, `${name}: ${kind} in the plan`);
      assert.equal(parsed.shots.filter((shot) => shot.kind === kind).length, wanted);
      assert.equal(result.plan[kind].length, wanted, `${name}: the list of ${kind}`);
      assert.ok(result.plan[kind].length <= planLib.MAX_SCENES);
      // the clips of the engine are numbered in the order of the list
      result.plan[kind].forEach((shot, position) => assert.equal(shot.clip, position));
    }
    near(shots.duration, grid.duration, 0.002);
    assert.equal(shots.aspect_ratio, '16:9');
    assert.equal(shots.cut_on, 'beats');
    // the units, one shot each, in order
    shots.shots.forEach((shot, index) => {
      const unit = grid.units[index];
      assert.deepEqual([shot.index, shot.start, shot.end, shot.kind, shot.section], [index, unit.start, unit.end, unit.kind, unit.section]);
      const plate = result.content.units[index].plate;
      assert.equal(shot.prompt, result.content.units[index].withFigure ? plate : `${plate.replace(/[\s.]+$/, '')}. ${hudPlan.NO_FIGURE_NOTE}`);
      assert.equal(shot.motion, result.content.units[index].motion);
      assert.equal(shot.framing, result.content.units[index].framing);
      assert.equal(shot.cuts, unit.cuts.length);
      assert.equal(shot.character, 'Mira');
    });
    // a sung window holds the sung lines; the song slices are made from exactly these
    for (const shot of result.plan.performance) {
      assert.ok(shot.duration >= 5.05 - 0.002 && shot.duration <= 8.002 && shot.line, `${name}: sung shot ${shot.index}`);
    }
    // the prompts of the lists are the plates, the motion of the story clips the motion
    assert.deepEqual(result.plan.story.map((shot) => shot.motion.length > 0), result.plan.story.map(() => true));
    assert.ok(result.plan.performance.every((shot) => shot.motion === '') && result.plan.still.every((shot) => shot.motion === ''));
    assert.equal(new Set(shots.shots.map((shot) => shot.prompt)).size, shots.shots.length, `${name}: no plate twice`);
  }
}

/* ---------- the price and the board ---------- */

async function testPrice() {
  const hudNode = require('../lib/nodes/nodes-music-video-hud');
  const explainerNodes = require('../lib/nodes/nodes-explainer');
  const imageModels = require('../lib/image-models');
  const r4 = (value) => Math.round(value * 10000) / 10000;

  // by hand: the parts of the price from the units (the prices are invented here, the arithmetic is the one of the brief)
  {
    const { grid } = gridOf('s72');
    const prices = { image: 0.05, lipsync: (seconds) => seconds * 0.1, clipPerSecond: 0.2, depth: 0.02, llm: { inputPerMillion: 3, outputPerMillion: 15, charsPerToken: 3 } };
    const promptChars = 9000;
    const cost = hudPlan.estimateCost({ grid, settings: grid.settings, prices, promptChars });
    const sung = grid.units.filter((unit) => unit.kind === 'performance');
    const expected = {
      sheet: 0.05,
      plates: r4(0.05 * grid.units.length),
      lipsync: r4(sung.reduce((sum, unit) => sum + Math.max(unit.duration, 5) * 0.1, 0)),
      clips: r4(grid.stats.story * 5 * 0.2),
      depth: r4(grid.stats.still * 0.02),
      // WP52a: the thinking (12 000 at the effort medium) and the text (1500 + 250 a unit + 260 a line)
      llm: r4((3000 * 3 + (12000 + 1500 + 250 * grid.units.length + 260 * grid.lines.length) * 15) / 1e6)
    };
    assert.deepEqual(cost.parts, expected);
    assert.equal(cost.total, r4(Object.values(expected).reduce((sum, value) => sum + value, 0)));
    assert.deepEqual(cost.unknown, []);
    assert.deepEqual(cost.tokens, { input: 3000, output: 12000 + 1500 + 250 * grid.units.length + 260 * grid.lines.length, text: 1500 + 250 * grid.units.length + 260 * grid.lines.length });
    assert.deepEqual([hudPlan.PLAN_THINKING_TOKENS, { ...hudPlan.PLAN_TEXT_TOKENS }], [12000, { film: 1500, unit: 250, line: 260 }]);
    // the biggest film fits the limit: 50 units and 60 lines, thinking included, use two thirds of PLAN_MAX_TOKENS, and the text fits into the half that the effort
    // medium leaves (the real song of WP52a, 50 units and 32 lines: 22 320 tokens of text); a song with even more lines that is cut off keeps its complete parts
    const biggest = hudPlan.llmTokens({ units: { length: 50 }, lines: { length: 60 } }, 0);
    assert.ok(biggest.output < 0.7 * hudPlan.PLAN_MAX_TOKENS && biggest.text < 0.5 * hudPlan.PLAN_MAX_TOKENS, JSON.stringify(biggest));
    near(cost.perMinute, (cost.total * 60) / grid.duration, 0.0001);
    // the lip sync is billed from 5 s on: a window of 5.05 s costs 5.05 s, a shorter one would cost 5 s
    assert.ok(sung.every((unit) => unit.duration >= 5.05 - 0.002));
    // a price that is not known keeps the total unknown, and the other parts stay
    const missing = hudPlan.estimateCost({ grid, settings: grid.settings, prices: { ...prices, image: null, llm: null }, promptChars });
    assert.equal(missing.total, null);
    assert.deepEqual(missing.unknown, ['sheet', 'plates', 'llm']);
    assert.equal(missing.parts.lipsync, expected.lipsync);
    assert.equal(missing.perMinute, null);
    assert.equal(hudPlan.estimateCost({ grid, settings: grid.settings, prices: {}, promptChars }).total, null);
    assert.deepEqual(hudPlan.estimateCost({ grid, settings: grid.settings, prices: { image: 0.05 }, promptChars }).unknown, ['lipsync', 'clips', 'depth', 'llm']);
    // the clip length is the length of the clips that are paid
    const longClips = hudPlan.estimateCost({ grid: { ...grid, units: grid.units }, settings: { ...grid.settings, clipSeconds: 10 }, prices, promptChars });
    assert.equal(longClips.parts.clips, r4(grid.stats.story * 10 * 0.2));
  }

  // the real tables of the other nodes: nothing is copied into the planner
  {
    const real = hudNode.hudPrices(explainerNodes.DEFAULT_MODEL);
    assert.equal(real.image, imageModels.estimateUsd(hudNode.PLATE_IMAGE_MODEL));
    assert.equal(real.image, 0.034, 'Nano Banana 2.1, per image (OpenRouter list price)');
    assert.equal(real.lipsync(5), 0.4, '0.08 USD per second of lip sync');
    assert.equal(real.lipsync(10), 0.8);
    assert.equal(real.lipsync(20), 1.92, 'above 15 s the price is 1.2 times higher');
    assert.equal(real.clipPerSecond, 0.04, 'H3 turbo, 768P');
    assert.equal(real.depth, 0.01);
    assert.deepEqual(real.llm, { inputPerMillion: 4, outputPerMillion: 20, charsPerToken: 3 }, 'Claude Opus 5.5');
    assert.equal(hudNode.hudPrices('vendor/unknown-model').llm, null, 'a model without a price: the language model is unknown');

    // the songs of 60 and 120 s at the default settings (every unit that is not sung is a clip) and with the share of motion of the songs (0.3: stills that
    // move by parallax), and the guide in the texts of the node
    const priced = (options) => {
      const rows = [];
      for (const name of ['s60', 's72', 'slow', 'fast', 'long']) {
        const { song, grid } = gridOf(name, options);
        const figure = figureOf();
        const chars = hudPlan.systemPrompt({ theme: 'hud' }).length + hudPlan.userPrompt({ brief: 'A made-up film about a light that stays on', style: '', figure, grid, broll: hudPlan.suggestBroll(grid) }).length;
        const cost = hudPlan.estimateCost({ grid, settings: grid.settings, prices: real, promptChars: chars });
        assert.notEqual(cost.total, null, name);
        rows.push({ name, seconds: song.seconds, cost });
      }
      const of = (name) => rows.find((row) => row.name === name).cost;
      const average = rows.reduce((sum, row) => sum + row.cost.perMinute, 0) / rows.length;
      return { rows, of, average };
    };
    const def = require('../lib/nodes/registry').get('music_video.hud_plan');
    {
      const { rows, of, average } = priced({ motionShare: hudPlan.DEFAULTS.motionShare, maxUnits: hudPlan.DEFAULTS.maxUnits });
      assert.ok(of('s60').total >= 5.6 && of('s60').total <= 6.4, `60 s: ${of('s60').total} USD`);
      assert.ok(of('fast').total >= 10.8 && of('fast').total <= 12.2, `120 s: ${of('fast').total} USD`);
      // WP52a: the language model with its thinking (PLAN_THINKING_TOKENS) and the answer without the identity texts
      assert.ok(of('s60').parts.llm >= 0.38 && of('s60').parts.llm <= 0.55 && of('fast').parts.llm >= 0.55 && of('fast').parts.llm <= 0.75, `the language model: about 0.45 and 0.65 USD (${of('s60').parts.llm}, ${of('fast').parts.llm})`);
      assert.ok(average >= 5.4 && average <= 6.1, `${average.toFixed(2)} USD per minute of song`);
      assert.match(def.description, /about 6 USD per minute of song at the default settings/, 'the guide in the description is the one measured here');
      assert.match(def.description, /about 12 USD for two minutes/);
      assert.match(def.description, /about 0\.45 USD for a minute of song and 0\.65 USD for two/);
      // the clips and the lip sync are the biggest parts, nothing is spent on depth maps
      for (const row of rows) {
        const { parts } = row.cost;
        assert.ok(parts.clips > parts.plates && parts.lipsync > parts.plates && parts.depth === 0, `${row.name}: ${JSON.stringify(parts)}`);
      }
    }
    {
      const { rows, average } = priced({});
      assert.ok(average >= 3.4 && average <= 4, `${average.toFixed(2)} USD per minute of song at a share of motion of 0.3`);
      assert.match(def.description, /about 3\.7 USD per minute at 0\.3/);
      // there the lip sync is the biggest part
      for (const row of rows) assert.ok(row.cost.parts.lipsync > row.cost.parts.plates && row.cost.parts.lipsync > row.cost.parts.clips, `${row.name}: ${JSON.stringify(row.cost.parts)}`);
    }
  }

  // the board: the same numbers, one block for every unit
  {
    const real = hudNode.hudPrices(explainerNodes.DEFAULT_MODEL);
    const { grid } = gridOf('s72');
    const figure = figureOf();
    const { result } = await plan('s72', [answerFor('s72')], { prices: real });
    const board = result.board;
    const lines = board.split('\n');
    assert.deepEqual(lines.slice(0, 2), ['TREATMENT', 'A made-up film about a woman and a light that stays on.']);
    assert.match(board, /^LEITMOTIF {2}MOTH PARADE · WATTS 01 → 03 → 09 → 27 → 81 → 243 · MOTHS 40 → 120 → 360 → 1,080 → 3,240 → 9,720$/m);
    assert.match(board, /^CHAPTERS {3}I DUSK \(0:00–0:07, look coat number 0, set place number 0\) · II THE LAMP \(/m);
    const stats = grid.stats;
    // WP52a: the share of the figure and of B-roll, and the seconds of lip sync against those asked for
    const seen = grid.units.reduce((sum, unit) => (result.content.units[unit.index].withFigure ? sum + unit.duration : sum), 0);
    const open = grid.units.filter((unit) => unit.kind !== 'performance' && unit.index > 0);
    const broll = open.filter((unit) => !result.content.units[unit.index].withFigure).length;
    assert.ok(broll >= 4);
    assert.match(board, new RegExp(`^NUMBERS {4}${stats.cuts} cuts \\(\\d+(\\.\\d+)?/min\\) · figure ${Math.round((seen / grid.duration) * 100)}% on screen · B-roll ${broll} of ${open.length} story units \\(${Math.round((broll / open.length) * 100)}%\\) · lip sync ${stats.lipsyncSeconds} s of 26.4 s asked in ${stats.sung} windows · ${stats.units} units \\(${stats.sung} sung, ${stats.story} story, ${stats.still} still\\) · estimate ${result.cost.total.toFixed(2)} USD$`, 'm'));
    const parts = result.cost.parts;
    assert.match(board, new RegExp(`^ESTIMATE {3}portrait sheet ${parts.sheet.toFixed(2)} \\+ ${stats.units} plates ${parts.plates.toFixed(2)} \\+ lip sync ${parts.lipsync.toFixed(2)} \\+ ${stats.story} clips ${parts.clips.toFixed(2)} \\+ ${stats.still} depth maps ${parts.depth.toFixed(2)} \\+ language model ${parts.llm.toFixed(2)} = ${result.cost.total.toFixed(2)} USD; a second attempt of the language model adds about ${parts.llm.toFixed(2)} USD$`, 'm'));
    // a block of two lines for every unit: the times, the kind, the framing, the first words, the graphics; then the scene
    const blocks = lines.filter((line) => /^ ?\d+ {2}\d+:\d\d\.\d–\d+:\d\d\.\d {2}(SUNG|STORY|STILL)/.test(line));
    assert.equal(blocks.length, grid.units.length);
    assert.equal(blocks.filter((line) => / SUNG /.test(line)).length, stats.sung);
    assert.equal(blocks.filter((line) => / STORY /.test(line)).length, stats.story);
    assert.equal(blocks.filter((line) => / STILL /.test(line)).length, stats.still);
    const first = lines.findIndex((line) => line === blocks[0]);
    assert.match(lines[first + 1], /^ {8}the figure, chapter 0 look, scene number 0 at the place number 0$/, 'the scene, without the framing, the identity text and the endings');
    const storyAt = grid.units.findIndex((unit) => unit.kind === 'story' && result.content.units[unit.index].withFigure);
    assert.match(lines[lines.findIndex((line) => line === blocks[storyAt]) + 1], /\[motion: Slow push-in on scene \d+, ending on a steady frame, exactly one person\.\]$/);
    const brollAt = grid.units.findIndex((unit) => unit.kind === 'story' && !result.content.units[unit.index].withFigure);
    assert.match(lines[lines.findIndex((line) => line === blocks[brollAt]) + 1], /^ {8}B-ROLL «[^»]+»: .*\[motion: Fast push-in as .* bursts toward the lens, ending on a wide frame\.\]$/);
    assert.ok(blocks.every((line) => /«/.test(line) || !/SUNG/.test(line)), 'a sung unit shows its words');
    assert.ok(blocks.some((line) => /Graphics: .*(tag|counter|toggle) «/.test(line)) && blocks.some((line) => /Words: /.test(line)));
    assert.ok(!/LEFT OUT|PLAIN/.test(board), 'nothing to say about a clean plan');
    // no price known: the board says so
    const unknown = await plan('s72', [answerFor('s72')]);
    assert.match(unknown.result.board, /estimate unknown USD$/m);
    assert.match(unknown.result.board, /^ESTIMATE {3}portrait sheet unknown \+ 22 plates unknown .* = unknown USD \(unknown: sheet, plates, lipsync, clips, depth, llm\);/m);
    // the board is English whatever the language of the graphics: the lines of the song stay as they are
    const german = await plan('s72', [answerFor('s72')], { hudLanguage: 'de' });
    assert.match(german.result.board, /^TREATMENT$/m);
  }
}

/* ---------- the node ---------- */

async function testDefinition() {
  const registryModule = require('../lib/nodes/registry');
  const explainerNodes = require('../lib/nodes/nodes-explainer');
  const real = registryModule.registry;
  const def = real.get('music_video.hud_plan');
  assert.ok(def, 'the node is registered');
  assert.equal(def.category, 'video');
  assert.equal(registryModule.providerOf(def), 'llm');
  assert.equal(def.paid, true);
  assert.equal(def.cost.unit, 'usd');
  assert.equal(typeof def.cost.estimate, 'function');
  assert.equal(def.cost.history, false, 'the price of an earlier song says nothing about this one');
  assert.equal(typeof def.cacheStamp, 'function');
  assert.equal(def.cacheStampAdopts, true);
  assert.equal(typeof explainerNodes.fallbackBrainStamp, 'function');
  const ports = (list) => list.map((port) => [port.id, port.type, Boolean(port.required), port.param || null]);
  // the idea is optional since WP48 (an empty field: the model writes the brief from the song), and the brief that was used is an output
  // WP50: pictures of the person's own figure (optional) in, the reference images of the portrait sheet out
  assert.deepEqual(ports(def.inputs), [['analysis', 'text', true, null], ['timing', 'text', true, null], ['brief', 'text', false, 'brief'], ['figure', 'text', true, 'figure'], ['song', 'audio', true, null], ['figure_image', 'image', false, null]]);
  assert.equal(def.inputs.find((port) => port.id === 'figure_image').multiple, true);
  assert.deepEqual(def.outputs.map((port) => [port.id, port.type]), [
    ['shots', 'text'], ['performance_prompts', 'text[]'], ['performance_audio', 'audio[]'], ['story_prompts', 'text[]'], ['story_motion', 'text[]'], ['still_prompts', 'text[]'], ['graphics', 'text'], ['board', 'text'], ['sheet_prompt', 'text'], ['brief', 'text'], ['sheet_refs', 'image[]']
  ]);
  // the same ports as the plan of the music video, so that the template of the nodes before and after it fits
  const plain = real.get('music_video.plan');
  for (const id of ['analysis', 'timing', 'brief', 'song']) assert.deepEqual(def.inputs.find((port) => port.id === id).type, plain.inputs.find((port) => port.id === id).type, id);
  for (const id of ['shots', 'story_prompts', 'story_motion', 'performance_prompts', 'performance_audio']) assert.equal(def.outputs.find((port) => port.id === id).type, plain.outputs.find((port) => port.id === id).type, id);
  const edit = real.get('music_video.edit');
  assert.equal(edit.inputs.find((port) => port.id === 'shots').type, def.outputs.find((port) => port.id === 'shots').type);
  const render = real.get('music_video.hud_render');
  assert.equal(render.inputs.find((port) => port.id === 'graphics').type, def.outputs.find((port) => port.id === 'graphics').type);

  // the settings, their defaults and their ranges
  assert.deepEqual(real.normalizeParams(def, {}), {
    model: '', brief: '', figure: '', style: '', theme: 'hud', accent: '#3B82F6', hud_language: 'en', brief_language: 'en', official_images: false, cuts_per_minute: 24, max_units: 50, lipsync_seconds_per_minute: 22, motion_share: 1, clip_seconds: 5, broll_share: 0.35, allow_plain: false
  });
  // WP52a: the share of B-roll and the switch for a plain plan, both added after plans were saved: at their defaults no part of the key
  const brollParam = def.params.find((param) => param.id === 'broll_share');
  assert.deepEqual([brollParam.kind, brollParam.min, brollParam.max, brollParam.step, brollParam.default, brollParam.cacheOmitDefault], ['slider', 0, 0.6, 0.05, hudPlan.DEFAULT_BROLL_SHARE, true]);
  const plainParam = def.params.find((param) => param.id === 'allow_plain');
  assert.deepEqual([plainParam.kind, plainParam.default, plainParam.cacheOmitDefault], ['boolean', false, true]);
  assert.deepEqual(def.params.find((param) => param.id === 'brief_language').options, ['en', 'de', 'es']);
  assert.deepEqual(real.normalizeParams(def, { cuts_per_minute: 99, max_units: 99, lipsync_seconds_per_minute: -3, motion_share: 5, clip_seconds: 1 }), {
    ...real.normalizeParams(def, {}), cuts_per_minute: 40, max_units: 50, lipsync_seconds_per_minute: 0, motion_share: 1, clip_seconds: 2
  });
  assert.deepEqual(def.params.find((param) => param.id === 'theme').options, ['hud', 'kuble'], 'the planner writes one of the two styles (auto is for the renderer)');
  assert.deepEqual(def.params.find((param) => param.id === 'hud_language').options, ['en', 'de', 'es']);
  assert.deepEqual(real.checkParams(def, real.normalizeParams(def, { theme: 'neon', hud_language: 'fr' })), ['param theme: "neon" is not a valid option', 'param hud_language: "fr" is not a valid option']);
  assert.deepEqual(real.checkParams(def, real.normalizeParams(def, { theme: 'kuble', hud_language: 'de' })), []);
  for (const id of ['cuts_per_minute', 'max_units', 'lipsync_seconds_per_minute', 'motion_share', 'clip_seconds']) {
    const param = def.params.find((item) => item.id === id);
    const name = { cuts_per_minute: 'cutsPerMinute', max_units: 'maxUnits', lipsync_seconds_per_minute: 'lipsyncSecondsPerMinute', motion_share: 'motionShare', clip_seconds: 'clipSeconds' }[id];
    assert.deepEqual([param.min, param.max, param.default], [...hudPlan.RANGES[name], hudPlan.DEFAULTS[name]], `${id}: the range of the node is the one of the planner`);
  }
  // the renderer takes "auto" besides the two styles
  const renderTheme = render.params.find((param) => param.id === 'theme');
  assert.deepEqual([renderTheme.options, renderTheme.default], [['auto', 'hud', 'kuble'], 'auto']);

  // an installation without ffmpeg or a language model cannot use it
  const ffmpegLib = require('../lib/ffmpeg');
  const openrouter = require('../lib/openrouter');
  const chatgpt = require('../lib/chatgpt');
  const saved = { binaries: ffmpegLib.binaries, hasKey: openrouter.hasKey, status: chatgpt.status };
  try {
    ffmpegLib.binaries = () => ({ available: false });
    assert.match(String(real.availability(def)), /ffmpeg/);
    ffmpegLib.binaries = () => ({ available: true });
    openrouter.hasKey = () => false;
    chatgpt.status = () => ({ connected: false });
    assert.match(String(real.availability(def)), /OPENROUTER_API_KEY is not set/);
    openrouter.hasKey = () => true;
    assert.equal(real.availability(def), true);
  } finally {
    ffmpegLib.binaries = saved.binaries;
    openrouter.hasKey = saved.hasKey;
    chatgpt.status = saved.status;
  }

  // the price of the node itself (the language model) before it runs
  const openrouter2 = require('../lib/openrouter');
  const original = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key-for-the-estimate-0123456789';
  try {
    assert.ok(openrouter2.hasKey());
    const song = songOf('s60');
    const inputs = (extra = {}) => ({
      analysis: { type: 'text', value: JSON.stringify(song.analysis) },
      timing: { type: 'text', value: JSON.stringify(song.timing) },
      brief: { type: 'text', value: 'A made-up film about a light that stays on' },
      figure: { type: 'text', value: FIGURE_TEXT },
      ...extra
    });
    const params = real.normalizeParams(def, {});
    const context = (extra = {}) => ({ config: {}, inputs: inputs(), connected: new Set(['analysis', 'timing', 'brief', 'figure']), ...extra });
    const estimate = def.cost.estimate(params, context());
    // WP52a: with the thinking at the effort medium about 0.45 USD for a minute of song
    assert.ok(estimate && estimate.usd > 0.35 && estimate.usd < 0.6, JSON.stringify(estimate));
    // it is the price of the model for the size of this song, not a guess from an earlier run
    const long = songOf('fast');
    const bigger = def.cost.estimate(params, context({ inputs: inputs({ analysis: { type: 'text', value: JSON.stringify(long.analysis) }, timing: { type: 'text', value: JSON.stringify(long.timing) } }) }));
    assert.ok(bigger.usd > estimate.usd * 1.25, `${bigger.usd} for 120 s against ${estimate.usd} for 60 s`);
    // the share of B-roll is part of the prompt and so of the estimate
    assert.notEqual(def.cost.estimate({ ...params, broll_share: 0 }, context()).usd, estimate.usd);
    // the fields of the node stand in for inputs that are not connected
    const fromFields = def.cost.estimate({ ...params, brief: 'A made-up film', figure: FIGURE_TEXT }, context({ inputs: { analysis: inputs().analysis, timing: inputs().timing }, connected: new Set(['analysis', 'timing']) }));
    assert.ok(fromFields && fromFields.usd > 0, 'brief and figure from the fields');
    // not known yet: an input that comes from a node that has not run, no input at all, a song that does not fit, a model without a price
    assert.equal(def.cost.estimate(params, context({ inputs: { timing: inputs().timing } })), null, 'the analysis comes from a node that has not run');
    assert.equal(def.cost.estimate(params, context({ inputs: {}, connected: new Set() })), null);
    assert.equal(def.cost.estimate(params, context({ inputs: inputs({ analysis: { type: 'text', value: 'nothing' } }) })), null, 'an unreadable analysis');
    assert.equal(def.cost.estimate({ ...params, model: 'vendor/unknown-model' }, context()), null, 'no price for the model');
    assert.ok(def.cost.estimate({ ...params, model: 'anthropic/claude-sonnet-5.5' }, context()) === null || def.cost.estimate({ ...params, model: 'anthropic/claude-sonnet-5.5' }, context()).usd > 0);
    assert.equal(def.cost.estimate(params, context({ config: { restrictedBrainModels: ['vendor/other-model'] } })), null, 'a person whose list lacks Opus gets another model');
    delete process.env.OPENROUTER_API_KEY;
    assert.equal(def.cost.estimate(params, context()), null, 'without OpenRouter the model is the one of the settings');
  } finally {
    if (original === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = original;
  }
}

/* ---------- the texts ---------- */

// The texts of the ports of the node in the help: a port whose id is an input and an output (the idea in, the brief out) has one text per side.
function portKeys(def) {
  const both = new Set(def.inputs.map((port) => port.id).filter((id) => def.outputs.some((port) => port.id === id)));
  return [
    ...def.inputs.map((port) => `nodes.portdesc.music_video.hud_plan.${port.id}${both.has(port.id) ? '.in' : ''}`),
    ...def.outputs.map((port) => `nodes.portdesc.music_video.hud_plan.${port.id}${both.has(port.id) ? '.out' : ''}`)
  ];
}

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
  const def = registryModule.get('music_video.hud_plan');
  const type = 'nodes.type.music_video.hud_plan';
  const keys = [
    `${type}.label`, `${type}.keywords`, `${type}.help`, `${type}.example`, `${type}.tip.1`, `${type}.tip.2`, `${type}.tip.3`,
    ...[...def.inputs, ...def.outputs].map((port) => `nodes.port.${port.id}`),
    ...[...def.inputs, ...def.outputs].map((port) => `nodes.portdesc.${port.id}`),
    ...portKeys(def),
    ...def.params.map((param) => `nodes.param.${param.id}`),
    'nodes.issue.HUDPLAN_BRIEF_FAILED', 'nodes.issue.HUDPLAN_IDEA_EMPTY', 'nodes.issue.HUDPLAN_NO_BRIEF', 'nodes.issue.HUDPLAN_NO_FIGURE', 'nodes.issue.HUDPLAN_NO_LINES', 'nodes.issue.HUDPLAN_TOO_LONG', 'nodes.issue.HUDPLAN_MODEL_FAILED',
    'nodes.paramhint.music_video.hud_plan.broll_share', 'nodes.paramhint.music_video.hud_plan.allow_plain'
  ];
  for (const lang of ['de', 'en', 'es']) {
    for (const key of keys) {
      const value = window.I18N[lang][key];
      assert.ok(typeof value === 'string' && value.trim(), `${lang}: ${key} is missing`);
      assert.ok(!value.includes('ß'), `${lang}: ${key} has a sharp s`);
    }
    // the limits of the help test
    assert.ok(window.I18N[lang][`${type}.help`].length <= 320 && window.I18N[lang][`${type}.example`].length <= 260, `${lang}: help and example`);
    for (const n of [1, 2, 3]) assert.ok(window.I18N[lang][`${type}.tip.${n}`].length <= 240, `${lang}: tip ${n}`);
    for (const port of [...def.inputs, ...def.outputs]) assert.ok(window.I18N[lang][`nodes.portdesc.${port.id}`].length >= 12 && window.I18N[lang][`nodes.portdesc.${port.id}`].length <= 360, `${lang}: nodes.portdesc.${port.id}`);
    for (const key of portKeys(def)) assert.ok(window.I18N[lang][key].length >= 12 && window.I18N[lang][key].length <= 360, `${lang}: ${key}`);
    const phrases = window.I18N[lang][`${type}.keywords`].split(',').map((item) => item.trim());
    assert.ok(phrases.length >= 3 && phrases.every(Boolean) && new Set(phrases.map((item) => item.toLowerCase())).size === phrases.length, `${lang}: keywords`);
    for (const param of def.params.filter((item) => item.kind === 'select' && item.options)) for (const option of param.options) assert.ok(window.I18N[lang][`nodes.option.${option}`], `${lang}: option ${option}`);
    assert.ok(window.I18N[lang]['nodes.option.auto'], `${lang}: the option auto of the style of the renderer`);
  }
  // the label of the style of the HUD is not the label of the text field of the planner
  assert.notEqual(window.I18N.de['nodes.param.theme'], window.I18N.de['nodes.param.style']);
  // the codes of the errors: every code the planner can throw has a text, and the figures it names are placeholders
  const source = fs.readFileSync(path.join(root, 'lib', 'nodes', 'nodes-music-video-hud.js'), 'utf8') + fs.readFileSync(path.join(root, 'lib', 'music-video-hud', 'plan.js'), 'utf8');
  const codes = new Set([...source.matchAll(/'(HUDPLAN_[A-Z_]+)'/g)].map((match) => match[1]));
  assert.deepEqual([...codes].sort(), ['HUDPLAN_BRIEF_FAILED', 'HUDPLAN_IDEA_EMPTY', 'HUDPLAN_MODEL_FAILED', 'HUDPLAN_NO_BRIEF', 'HUDPLAN_NO_FIGURE', 'HUDPLAN_NO_LINES', 'HUDPLAN_TOO_LONG']);
  for (const code of codes) for (const lang of ['de', 'en', 'es']) assert.ok(window.I18N[lang][`nodes.issue.${code}`], `${lang}: no text for ${code}`);
  for (const lang of ['de', 'en', 'es']) for (const name of ['seconds', 'units', 'clip', 'needed']) assert.ok(window.I18N[lang]['nodes.issue.HUDPLAN_TOO_LONG'].includes(`{${name}}`), `${lang}: HUDPLAN_TOO_LONG names {${name}}`);
  // WP52a: the error of a model that delivered too little names the tries, the tokens, the cost and what is missing (every placeholder is a field of err.data)
  const failedData = ['attempts', 'tokens', 'limit', 'thinking', 'usd', 'plainUnits', 'units', 'plainLines', 'lines'];
  for (const lang of ['de', 'en', 'es']) {
    const text = window.I18N[lang]['nodes.issue.HUDPLAN_MODEL_FAILED'];
    assert.deepEqual([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort(), failedData.slice().sort(), `${lang}: the placeholders of HUDPLAN_MODEL_FAILED`);
  }
  // the Design App shows a failed node with the text of its code as the editor does, not with the English message of the engine
  const appSource = fs.readFileSync(path.join(root, 'public', 'nodes', 'app-mode.js'), 'utf8');
  assert.match(appSource, /info\.code && ui\.hasIssueText\(info\.code\) \? ui\.issueText\(\{ code: info\.code, data: info\.data, message: info\.message \}, 'app'\)/);
  // the data of the error are the placeholders of the text
  let err = null;
  try {
    const long = makeSong({ seconds: 300, seed: 4 });
    hudPlan.planGrid(long.analysis, long.timing, {});
  } catch (caught) {
    err = caught;
  }
  assert.deepEqual(Object.keys(err.data).sort(), ['clip', 'needed', 'seconds', 'units']);
  // the language of the graphics is a setting with three languages whose names exist in all of them
  for (const lang of ['de', 'en', 'es']) for (const option of ['en', 'de', 'es']) assert.ok(window.I18N[lang][`nodes.option.${option}`]);
  // the tip of the renderer names the new option of the style
  for (const lang of ['de', 'en', 'es']) assert.ok(/HUD/.test(window.I18N[lang]['nodes.type.music_video.hud_render.tip.1']), lang);
}

module.exports = { checkGrid };

async function main() {
  testGrid();
  testGridErrors();
  testPrompts();
  testAnswer();
  testPlain();
  await testPlanner();
  await testRescue();
  testDenseWindows();
  testBrollWithoutLines();
  await testGraphics();
  await testShots();
  await testPrice();
  await testDefinition();
  testI18n();
  await testNode();
  console.log('test-music-video-hud-plan.js: ok');
}

/* ---------- the whole node ---------- */

// The node with the real engine pieces (the store, the song slices with ffmpeg, the cost of the model) and the language model replaced. This test writes a session into the data
// folder of the repository it runs in: start it through scripts/run-tests.js (it runs in a copy).
async function testNode() {
  const ffmpegLib = require('../lib/ffmpeg');
  if (!ffmpegLib.binaries().available) {
    console.log('test-music-video-hud-plan.js: ffmpeg is missing, the run of the node is skipped');
    return;
  }
  const store = require('../lib/store');
  const assets = require('../lib/nodes/assets');
  const llm = require('../lib/nodes/llm');
  const ops = require('../lib/nodes/ffmpeg-ops');
  const real = require('../lib/nodes/registry');
  const { textValue } = require('../lib/nodes/types');
  const { toneWav } = require('./support/explainer-media');
  const def = real.get('music_video.hud_plan');
  const hudNode = require('../lib/nodes/nodes-music-video-hud');

  const restorers = [];
  const patch = (target, key, value) => {
    const original = target[key];
    target[key] = value;
    restorers.push(() => {
      target[key] = original;
    });
  };
  const savedKey = process.env.OPENROUTER_API_KEY;
  try {
    const song = songOf('s60');
    const { grid } = gridOf('s60');
    const figure = figureOf();
    const session = await store.createSession();
    const sessionId = session.id;
    const saved = await store.saveAsset(sessionId, { kind: 'upload', buffer: toneWav(song.seconds + 2, 330), ext: '.wav', prompt: 'song of the test' });
    const songValue = await assets.valueFromAsset(sessionId, saved.id);
    const scratchLeft = async () => (await fsp.readdir(store.sessionAssetDir(sessionId))).filter((name) => name.startsWith('.nodes-'));

    // the language model: it answers from a script (an object or text is the answer, an Error is thrown, a function is asked), the good answer after the script
    const calls = [];
    let script = [];
    const LLM_USD = 0.25;
    patch(llm, 'completeText', async (options) => {
      calls.push(options);
      const next = script.length ? script.shift() : goodAnswer(grid, figure);
      const value = typeof next === 'function' ? next(options) : next;
      if (value instanceof Error) throw value;
      return { text: typeof value === 'string' ? value : JSON.stringify(value), usd: LLM_USD };
    });
    const reset = (steps = []) => {
      calls.length = 0;
      script = steps;
    };
    function makeCtx(extra = {}) {
      const controller = new AbortController();
      const logs = [];
      const config = { defaultBrain: 'vendor/default-brain', brainModels: ['vendor/default-brain'] };
      return {
        workflowId: 'wf-test',
        runId: 'r-test',
        nodeId: 'n1',
        sessionId,
        user: 'tester',
        config,
        signal: controller.signal,
        controller,
        toolCtx: { nodeView: true, sessionId, config, user: 'tester', emit() {}, signal: controller.signal },
        log: (line) => logs.push(line),
        saveOutputFile: (options) => assets.saveOutputFile(sessionId, options),
        withLocalSlot: (fn) => fn(),
        logs,
        ...extra
      };
    }
    const inputs = (extra = {}) => ({
      analysis: textValue(JSON.stringify(song.analysis)),
      timing: textValue(JSON.stringify(song.timing)),
      brief: textValue('A made-up film about a light that stays on'),
      figure: textValue(FIGURE_TEXT),
      song: songValue,
      ...extra
    });
    // the settings of the test songs (MIXED: stills, clips and sung windows); the defaults, where every unit moves, have a block of their own
    const exec = (ctx, ins, raw = {}) =>
      def.execute(ctx, ins, real.normalizeParams(def, { model: 'anthropic/claude-opus-5.5', motion_share: MIXED.motionShare, max_units: MIXED.maxUnits, ...raw }));

    /* a good answer: one request, every output, the slices of the song */
    {
      reset();
      const ctx = makeCtx();
      const result = await exec(ctx, inputs());
      assert.equal(calls.length, 1);
      assert.deepEqual([calls[0].model, calls[0].json, calls[0].maxTokens, calls[0].sessionId, calls[0].user], ['anthropic/claude-opus-5.5', true, 64000, sessionId, 'tester']);
      assert.equal(result.variants.length, 1);
      assert.deepEqual(result.cost, { usd: LLM_USD });
      const out = result.variants[0];
      // every output but the reference images of the sheet: a figure of its own and no official images (WP50)
      assert.deepEqual(Object.keys(out), def.outputs.map((port) => port.id).filter((id) => id !== 'sheet_refs'));
      for (const port of def.outputs.filter((item) => item.id !== 'sheet_refs')) assert.equal(out[port.id].type, port.type === 'text' ? 'text' : 'list', port.id);
      const shots = planLib.parseShots(out.shots.value);
      assert.ok(shots, 'the plan of the cut can be read');
      const stats = grid.stats;
      assert.deepEqual([shots.performance, shots.story, shots.still], [stats.sung, stats.story, stats.still]);
      const lengths = (id) => out[id].items.length;
      assert.deepEqual([lengths('performance_prompts'), lengths('performance_audio'), lengths('story_prompts'), lengths('story_motion'), lengths('still_prompts')], [stats.sung, stats.sung, stats.story, stats.story, stats.still]);
      assert.deepEqual(out.performance_prompts.items.map((item) => item.value), shots.shots.filter((shot) => shot.kind === 'performance').map((shot) => shot.prompt));
      assert.deepEqual(out.story_motion.items.map((item) => item.value), shots.shots.filter((shot) => shot.kind === 'story').map((shot) => shot.motion));
      assert.deepEqual(out.still_prompts.items.map((item) => item.value), shots.shots.filter((shot) => shot.kind === 'still').map((shot) => shot.prompt));
      // a slice of the song for every sung window, exactly as long as the window
      const windows = shots.shots.filter((shot) => shot.kind === 'performance');
      for (const [index, item] of out.performance_audio.items.entries()) {
        assert.equal(item.type, 'audio');
        const probe = await ops.probeMedia(assets.assetFilePath(item), { ffprobePath: ffmpegLib.binaries().ffprobe });
        near(probe.duration, windows[index].duration, 0.03, `slice ${index}`);
      }
      // the graphics, the board and the prompt of the figure
      const graphics = JSON.parse(out.graphics.value);
      assert.deepEqual(graphicsLib.prepareGraphics(graphics, {}).warnings, []);
      assert.equal(graphics.cuts.length, grid.cuts.length);
      assert.match(out.board.value, /^TREATMENT\n/);
      assert.equal(out.sheet_prompt.value, hudPlan.sheetPrompt(figure));
      assert.equal(out.brief.value, 'A made-up film about a light that stays on', 'the output "brief" is the idea that was given');
      assert.ok(!ctx.logs.some((line) => /^The brief \(output/.test(line)), 'no brief was written');
      // the price of the film on the board is the one of the table, and the log says what was made
      assert.match(out.board.value, /^NUMBERS .* estimate 3\.73 USD$/m);
      assert.ok(ctx.logs.some((line) => new RegExp(`^${stats.units} units \\(${stats.sung} sung, ${stats.story} story, ${stats.still} still\\), ${stats.cuts} cuts \\([\\d.]+/min\\), 60 s, \\d+ graphics for ${grid.lines.length} lines, 1 answer of the model, the film costs about 3\\.73 USD$`).test(line)), ctx.logs.join(' | '));
      assert.ok(!ctx.logs.some((line) => /plain|corrected|no place/.test(line)), 'a clean run says nothing about repairs');
      assert.deepEqual(await scratchLeft(), [], 'no scratch folder is left');
    }

    /* WP48: no idea (the field empty, nothing connected): the model writes the brief from the song, then plans with it; both calls are paid */
    {
      const written = [
        'Theme: a light that stays on in a harbour town, and everybody who comes to see it.',
        'Arc:',
        ...grid.sections.map((section, at) => `- Part ${at + 1}: the lamp at the window, a new street comes to see it, the counter climbs.`),
        'Machine in the HUD: LAMP WATCH counts VISITORS, watched by the night ferry; ticker: tides, fuses, moth reports.',
        'Look: a grey wool coat, wet stone, sodium light that turns into the blue of the dawn.',
        'Graphics for the lines: a visitor log, a tide chart, a map of the streets, a chat with the ferry.',
        'End card: STILL ON, the lamp outlasts the night.',
        'Not: no brands, no logos, no real people, nothing suggestive.'
      ].join('\n');
      reset([written, goodAnswer(grid, figure)]);
      const ctx = makeCtx();
      const { brief: _idea, ...withoutIdea } = inputs();
      const result = await exec(ctx, withoutIdea, { brief: '', brief_language: 'de' });
      assert.equal(calls.length, 2, 'two calls: the brief, then the plan');
      assert.equal(calls[0].system, hudPlan.briefSystemPrompt({ theme: 'hud', hudLanguage: 'en', briefLanguage: 'de' }));
      assert.equal(calls[0].prompt, hudPlan.briefUserPrompt({ grid, figure }));
      assert.deepEqual([calls[0].model, calls[0].json, calls[0].maxTokens, calls[0].sessionId], ['anthropic/claude-opus-5.5', undefined, hudPlan.BRIEF_MAX_TOKENS, sessionId]);
      assert.ok(calls[1].prompt.startsWith(`IDEA\n${written}\n\nSTYLE\n`), 'the brief is the idea of the plan');
      const out = result.variants[0];
      assert.equal(out.brief.value, written);
      near(result.cost.usd, 2 * LLM_USD, 1e-9);
      assert.match(out.board.value, /^BRIEF {6}written by the language model from the lyrics/);
      assert.match(out.board.value, /^ESTIMATE .* \+ brief [\d.]+ = [\d.]+ USD/m);
      assert.ok(ctx.logs.some((line) => /^The field "Idea" is empty: the language model wrote the brief from the lyrics \(\d+ words\)\.$/.test(line)), ctx.logs.join(' | '));
      assert.ok(ctx.logs.some((line) => /^The brief \(output "brief"\): anthropic\/claude-opus-5\.5, 0\.2500 USD; copy it into the field "Idea" to change it\.$/.test(line)), ctx.logs.join(' | '));
      // a brief that does not come: the error has a code, what was paid is counted, no plan is asked for
      reset([new Error('the service is busy'), 'Too short.']);
      const failed = await errorOf(exec(makeCtx(), withoutIdea, { brief: '' }));
      assert.equal(failed?.code, 'HUDPLAN_BRIEF_FAILED');
      assert.deepEqual(failed.costs, [LLM_USD]);
      assert.equal(calls.length, 2);
      assert.deepEqual(await scratchLeft(), []);
    }

    /* WP50: the official images of Claudia for the portrait sheet: only with the figure Claudia and the switch on; pictures of an own figure win */
    {
      const figuresLib = require('../lib/music-video-hud/figures');
      const claudiaText = require('../lib/nodes/templates/music-video-hud.json').graph.nodes.find((node) => node.id === 'n4').params.figure;
      const claudia = hudPlan.parseFigure(claudiaText);
      const official = figuresLib.referenceFiles('claudia');
      const officialLedger = async () => (await store.readLedger(sessionId)).filter((entry) => /^Official reference image of Claudia by anabology/.test(entry.prompt || ''));
      // the switch on, the figure Claudia: three images out, the prompt of the sheet says what they fix, the board and the log say it
      reset([goodAnswer(grid, claudia)]);
      let ctx = makeCtx();
      let result = await exec(ctx, inputs({ figure: textValue(claudiaText) }), { official_images: true });
      let out = result.variants[0];
      assert.equal(out.sheet_refs.type, 'list');
      assert.equal(out.sheet_refs.items.length, 3);
      for (const [index, item] of out.sheet_refs.items.entries()) {
        assert.deepEqual([item.type, item.sessionId], ['image', sessionId]);
        assert.ok(fs.readFileSync(assets.assetFilePath(item)).equals(fs.readFileSync(official[index].path)), `${official[index].id}: the file of the repository, unchanged`);
      }
      assert.equal(out.sheet_prompt.value, hudPlan.sheetPrompt(claudia, 'claudia'));
      assert.match(out.sheet_prompt.value, /^Character reference portrait for a music video, photographic film still of Claudia by anabology, an adult woman in her late twenties\. The attached images are official reference images of her\./);
      assert.match(out.sheet_prompt.value, /Her face is exactly the face in the two photographs, the same person/);
      // the face comes from the photographs: the words of the canon that made her gaunt (angular face, strong jawline) are not in the prompt
      assert.doesNotMatch(out.sheet_prompt.value, /angular|jawline|cheekbones|28-year-old/);
      assert.match(out.sheet_prompt.value, /her right side \(the viewer's left\).*star clip on her left side above the ear.*headset microphone/);
      assert.match(out.sheet_prompt.value, /not their clothes, light, background/);
      assert.doesNotMatch(out.sheet_prompt.value, /\byoung\b/i, 'never the word young');
      assert.match(out.board.value, /^SHEET {6}the portrait sheet gets 3 official reference images of Claudia/m);
      assert.ok(ctx.logs.some((line) => line === 'The portrait sheet gets 3 official reference images of Claudia by anabology (claudia.gallery) (output "sheet_refs").'), ctx.logs.join(' | '));
      const first = out.sheet_refs.items.map((item) => item.assetId);
      assert.equal((await officialLedger()).length, 3);
      // the plan again (another idea): the same assets, no second copy, so the sheet behind it keeps its key
      reset([goodAnswer(grid, claudia)]);
      result = await exec(makeCtx(), inputs({ figure: textValue(claudiaText), brief: textValue('Another idea') }), { official_images: true });
      assert.deepEqual(result.variants[0].sheet_refs.items.map((item) => item.assetId), first);
      assert.equal((await officialLedger()).length, 3, 'the images are in the workflow once');
      // a file of the workflow that is gone is copied in again
      await fsp.rm(assets.assetFilePath(result.variants[0].sheet_refs.items[0]));
      reset([goodAnswer(grid, claudia)]);
      result = await exec(makeCtx(), inputs({ figure: textValue(claudiaText) }), { official_images: true });
      assert.notEqual(result.variants[0].sheet_refs.items[0].assetId, first[0]);
      assert.deepEqual(result.variants[0].sheet_refs.items.slice(1).map((item) => item.assetId), first.slice(1));
      // the switch off (the default, every plan saved before WP50): no images, the prompt of before byte for byte
      reset([goodAnswer(grid, claudia)]);
      out = (await exec(makeCtx(), inputs({ figure: textValue(claudiaText) }))).variants[0];
      assert.equal(out.sheet_refs, undefined);
      assert.equal(out.sheet_prompt.value, hudPlan.sheetPrompt(claudia));
      assert.doesNotMatch(out.board.value, /^SHEET/m);
      // another figure with the switch on: nothing of Claudia comes along
      reset();
      out = (await exec(makeCtx(), inputs(), { official_images: true })).variants[0];
      assert.equal(out.sheet_refs, undefined, 'another figure gets no image of Claudia');
      assert.equal(out.sheet_prompt.value, hudPlan.sheetPrompt(figure));
      assert.doesNotMatch(out.sheet_prompt.value, /Claudia/);
      // pictures of the person's own figure: they are the references (also instead of Claudia's), the prompt says to take face, hair and accessories from them
      const ownSaved = await store.saveAsset(sessionId, { kind: 'image', buffer: fs.readFileSync(official[0].path), ext: '.jpg', prompt: 'my own figure' });
      const own = await assets.valueFromAsset(sessionId, ownSaved.id);
      for (const [text, answerFigure] of [[FIGURE_TEXT, figure], [claudiaText, claudia]]) {
        reset([goodAnswer(grid, answerFigure)]);
        ctx = makeCtx();
        out = (await exec(ctx, inputs({ figure: textValue(text), figure_image: { type: 'list', items: [own] } }), { official_images: true })).variants[0];
        assert.deepEqual(out.sheet_refs.items.map((item) => item.assetId), [own.assetId]);
        assert.equal(out.sheet_prompt.value, hudPlan.sheetPrompt(answerFigure, 'own'));
        assert.match(out.sheet_prompt.value, /take the face, the hair and every accessory exactly from them/);
        assert.match(out.board.value, /^SHEET {6}the portrait sheet gets 1 reference image of the figure/m);
      }
      // a picture of another workflow is refused before the language model is paid
      reset();
      const foreign = { ...own, sessionId: 'another-session' };
      const refused = await errorOf(exec(makeCtx(), inputs({ figure_image: { type: 'list', items: [foreign] } })));
      assert.match(refused.message, /^figure_image: asset .* belongs to another workflow$/);
      assert.equal(calls.length, 0);
      assert.ok(hudNode.definitions.find((def) => def.type === 'music_video.hud_plan').validate({}, { figure_image: { count: 5 } }).some((issue) => issue.port === 'figure_image'));
      const gif = await assets.valueFromAsset(sessionId, (await store.saveAsset(sessionId, { kind: 'upload', buffer: Buffer.from('GIF89a'), ext: '.gif' })).id);
      const pending = await store.reserveAsset(sessionId, { kind: 'image', ext: '.png' });
      const gone = await assets.valueFromAsset(sessionId, (await store.saveAsset(sessionId, { kind: 'image', buffer: Buffer.from('gone'), ext: '.png' })).id);
      await fsp.rm(assets.assetFilePath(gone));
      for (const [images, message] of [
        [Array(5).fill(own), /at most 3 images/],
        [[gif], /PNG, JPEG or WebP/],
        [[{ ...own, assetId: pending.id }], /not finished/],
        [[{ ...own, assetId: 'missing' }], /does not exist/],
        [[gone], /ENOENT/]
      ]) {
        reset();
        const err = await errorOf(exec(makeCtx(), inputs({ figure_image: { type: 'list', items: images } })));
        assert.match(err.message, message);
        assert.equal(calls.length, 0, 'invalid references never reach the paid planner');
      }
      reset([goodAnswer(grid, claudia)]);
      out = (await exec(makeCtx(), inputs({ figure: textValue(claudiaText), figure_image: { type: 'list', items: [] } }), { official_images: true })).variants[0];
      assert.equal(out.sheet_refs.items.length, 3, 'an empty connected input falls back to official images');
      reset();
      out = (await exec(makeCtx(), inputs({ figure_image: { type: 'list', items: [] } }))).variants[0];
      assert.equal(out.sheet_refs, undefined, 'empty connected input without official images stays empty');
      // the price of the sheet on the board: one image and its three references (the estimate of the whole film)
      const prices = hudNode.hudPrices('anthropic/claude-opus-5.5', 3);
      near(prices.sheet, 0.034 + 3 * 0.00084, 1e-9, 'Nano Banana 2.1: 0.034 USD an image, 0.00084 USD a reference image');
      assert.equal(hudNode.hudPrices('anthropic/claude-opus-5.5').sheet, undefined, 'without references the price of before');
      const costWith = hudPlan.estimateCost({ grid, settings: grid.settings, prices });
      const costWithout = hudPlan.estimateCost({ grid, settings: grid.settings, prices: hudNode.hudPrices('anthropic/claude-opus-5.5') });
      assert.deepEqual([costWithout.parts.sheet, costWith.parts.sheet], [0.034, 0.0365]);
      assert.deepEqual(await scratchLeft(), []);
    }

    /* the defaults of the node: every unit that is not sung is a clip, the list of the stills is empty (the nodes behind it make nothing) */
    {
      const everything = hudPlan.planGrid(song.analysis, song.timing, {});
      reset([goodAnswer(everything, figure)]);
      const ctx = makeCtx();
      const result = await exec(ctx, inputs(), { motion_share: def.params.find((param) => param.id === 'motion_share').default, max_units: def.params.find((param) => param.id === 'max_units').default });
      assert.equal(calls.length, 1, 'the answer for the grid of the defaults is good at once');
      const out = result.variants[0];
      const shots = planLib.parseShots(out.shots.value);
      assert.deepEqual([shots.still, shots.story, shots.performance], [0, everything.units.length - everything.stats.sung, everything.stats.sung]);
      assert.deepEqual([out.still_prompts.type, out.still_prompts.items.length], ['list', 0]);
      assert.equal(out.story_prompts.items.length, everything.stats.story);
      assert.match(out.board.value, /^NUMBERS .*· \d+ units \(\d+ sung, \d+ story, 0 still\)/m);
    }

    /* a bad answer, then a good one: both are paid, the problems go to the second request */
    {
      const bad = goodAnswer(grid, figure);
      bad.units = bad.units.slice(0, 8);
      reset([bad]);
      const ctx = makeCtx();
      const result = await exec(ctx, inputs());
      assert.equal(calls.length, 2);
      assert.match(calls[1].prompt, /YOUR PREVIOUS ANSWER HAD THESE PROBLEMS/);
      near(result.cost.usd, 2 * LLM_USD, 1e-9);
      assert.ok(ctx.logs.some((line) => /^The answer of the language model had \d+ problems?: asking once more/.test(line)));
      assert.ok(ctx.logs.some((line) => /, 2 answers of the model, /.test(line)));
      assert.ok(!ctx.logs.some((line) => /plain prompts/.test(line)));
    }

    /* an empty answer at the limit: the cost is counted, the next request thinks less, nothing is plain */
    {
      reset([emptyAnswer('length')]);
      const ctx = makeCtx();
      const result = await exec(ctx, inputs());
      assert.equal(calls.length, 2);
      assert.equal(calls[1].reasoningEffort, 'low');
      near(result.cost.usd, 0.9 + LLM_USD, 1e-9);
      assert.ok(ctx.logs.some((line) => /thinks less \(effort low\)/.test(line)));
    }

    /* nothing usable (WP52a): the node stops with HUDPLAN_MODEL_FAILED, both answers are paid, nothing comes out; with "Allow a plain plan" plain prompts and
       plain graphics, the log says how many */
    {
      reset([emptyAnswer('length', 0.7), 'not json at all']);
      const failed = await errorOf(exec(makeCtx(), inputs()));
      assert.equal(failed && failed.code, 'HUDPLAN_MODEL_FAILED');
      assert.match(failed.message, /^The language model delivered no usable plan in 2 attempts \(empty answer, no JSON object; the language model · try 1: effort medium, limit 64,000 tokens, empty, 0\.70 USD · try 2: effort low, /);
      near(failed.costs.reduce((sum, usd) => sum + usd, 0), 0.7 + LLM_USD, 1e-9);
      assert.equal(failed.data.attempts, 2);
      assert.equal(failed.data.model, '', 'the stub of the model names no model (a real answer does: the line then starts with its name)');
      // every request books its own cost in the journal and the budget (lib/nodes/llm.js), so the attempts of a failed node are not lost
      reset([emptyAnswer('length', 0.7), 'not json at all']);
      const ctx = makeCtx();
      const result = await exec(ctx, inputs(), { allow_plain: true });
      assert.equal(calls.length, 2);
      const out = result.variants[0];
      assert.equal(out.performance_prompts.items.length, grid.stats.sung, 'the film has all its units all the same');
      assert.ok(ctx.logs.some((line) => new RegExp(`^${grid.units.length} of ${grid.units.length} units got plain prompts`).test(line)), ctx.logs.join(' | '));
      assert.ok(ctx.logs.some((line) => new RegExp(`^${grid.lines.length} of ${grid.lines.length} lines got plain graphics`).test(line)));
      assert.match(out.board.value, /^PLAIN {6}made without the language model/m);
      near(result.cost.usd, 0.7 + LLM_USD, 1e-9);
      assert.deepEqual(graphicsLib.prepareGraphics(JSON.parse(out.graphics.value), {}).warnings, [], 'the plain graphics find their places too');
    }

    /* the model of the settings, and the model of the account when OpenRouter is not there */
    {
      process.env.OPENROUTER_API_KEY = 'test-key-for-the-estimate-0123456789';
      reset();
      await exec(makeCtx(), inputs(), { model: '' });
      assert.equal(calls[0].model, 'anthropic/claude-opus-5.5', 'Claude Opus 5.5 is the default');
      delete process.env.OPENROUTER_API_KEY;
      reset();
      const ctx = makeCtx();
      const result = await exec(ctx, inputs(), { model: '' });
      assert.equal(calls[0].model, 'vendor/default-brain', 'the default model of the settings');
      assert.ok(ctx.logs.some((line) => /^OPENROUTER_API_KEY is not set/.test(line)));
      assert.match(result.variants[0].board.value, /^NUMBERS .* estimate unknown USD$/m, 'the price of that model is not known');
      assert.deepEqual(await def.cacheStamp(real.normalizeParams(def, { model: '' }), ctx), { fallbackBrain: 'vendor/default-brain' }, 'the model of the settings is part of the key');
      assert.equal(await def.cacheStamp(real.normalizeParams(def, { model: 'anthropic/claude-opus-5.5' }), ctx), undefined);
    }

    /* the errors of the input: every one has a stable code, and nothing is paid */
    {
      reset();
      for (const [label, ins, code] of [
        ['no brief', inputs({ brief: textValue('   ') }), 'HUDPLAN_NO_BRIEF'],
        ['no figure', inputs({ figure: textValue('') }), 'HUDPLAN_NO_FIGURE'],
        ['an unreadable analysis', inputs({ analysis: textValue('nothing') }), 'MUSICVIDEO_ANALYSIS_INVALID'],
        ['no sung line', inputs({ timing: textValue(JSON.stringify({ words: [] })) }), 'HUDPLAN_NO_LINES']
      ]) {
        const err = await errorOf(exec(makeCtx(), ins));
        assert.equal(err?.code, code, `${label}: ${err && err.message}`);
      }
      const long = makeSong({ seconds: 300, seed: 4 });
      const tooLong = await errorOf(exec(makeCtx(), inputs({ analysis: textValue(JSON.stringify(long.analysis)), timing: textValue(JSON.stringify(long.timing)) })));
      assert.equal(tooLong?.code, 'HUDPLAN_TOO_LONG');
      assert.deepEqual(Object.keys(tooLong.data).sort(), ['clip', 'needed', 'seconds', 'units']);
      assert.equal(calls.length, 0, 'the model was not asked');
      assert.deepEqual(await scratchLeft(), []);
    }

    /* a failing model: the first request is needed; a failing second one leaves the first answer; an abort and a used-up budget end it */
    {
      reset([new Error('the language model is down')]);
      assert.match((await errorOf(exec(makeCtx(), inputs()))).message, /language model is down/);
      assert.equal(calls.length, 1);
      assert.deepEqual(await scratchLeft(), []);

      const bad = goodAnswer(grid, figure);
      bad.units = bad.units.slice(0, 16);
      reset([bad, new Error('429 too many requests')]);
      const ctx = makeCtx();
      const result = await exec(ctx, inputs());
      assert.equal(calls.length, 2);
      assert.ok(ctx.logs.some((line) => /^The second request to the language model failed \(429 too many requests\)/.test(line)));
      assert.deepEqual(result.cost, { usd: LLM_USD }, 'only the answer that came is paid');
      assert.equal(result.variants[0].story_prompts.items.length, grid.stats.story, 'the film is made');

      reset([bad, Object.assign(new Error('aborted'), { name: 'AbortError' })]);
      assert.equal((await errorOf(exec(makeCtx(), inputs()))).name, 'AbortError');
      reset([bad, Object.assign(new Error('The budget is used up'), { name: 'BudgetError' })]);
      assert.equal((await errorOf(exec(makeCtx(), inputs()))).name, 'BudgetError');
      reset([Object.assign(new Error('not allowed'), { name: 'RoleRestrictedError' })]);
      assert.equal((await errorOf(exec(makeCtx(), inputs()))).name, 'RoleRestrictedError');
      // the end of the run, whatever the error looks like
      const stopped = makeCtx();
      reset([() => {
        stopped.controller.abort();
        return new Error('network error');
      }]);
      assert.match((await errorOf(exec(stopped, inputs()))).message, /network error/);
      assert.equal(calls.length, 1, 'no second request after the end of the run');
      assert.deepEqual(await scratchLeft(), []);
    }

    /* the settings reach the grid: no lip sync gives no sung unit and no slice */
    {
      reset();
      const ctx = makeCtx();
      const result = await exec(ctx, inputs(), { lipsync_seconds_per_minute: 0, max_units: 24, cuts_per_minute: 14 });
      const out = result.variants[0];
      assert.equal(out.performance_audio.items.length, 0);
      assert.equal(out.performance_prompts.items.length, 0);
      const shots = JSON.parse(out.shots.value);
      assert.ok(shots.shots.length > 0 && shots.shots.length <= 24 && shots.shots.every((shot) => shot.kind !== 'performance'));
      assert.deepEqual(await scratchLeft(), []);
    }
  } finally {
    while (restorers.length) restorers.pop()();
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
