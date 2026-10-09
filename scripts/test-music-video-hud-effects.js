'use strict';

// The beat effects of the music video in the HUD style (WP45): the plan of the effects (lib/music-video-hud/effects.js), the page of a chunk with
// the effects (composition.js, runtime.fx.browser.js, fxsvg.js), the glitch of the post-pass (postpass.js), the parameter of the node and its texts.
// No network and nothing paid; ffmpeg is the real one (that part is skipped when it is missing).
//   plan       more in the drop and the chorus than in the verse, nothing in a break, less at `subtle`; the strength of a hit and the loudness as
//              percentiles of the song (the same plan for a quieter song); the same plan for the same input; at most 3 flashes in any second (the
//              flashes of the HUD counted too); no red flash; nothing on the end card and nothing before the film; the face in a lip-sync cut: no
//              bulge or wave, no other distortion while it sings, a glitch only between the words
//   frames     frameEffects is a pure function of the song time: the part of the plan in the page of a chunk gives the frames of the whole plan, also
//              at the seams of the chunks; the zoom always covers the screen
//   page       off is the page of before (byte for byte); on: the wrapper of the footage, the light, the filters, the scripts, the size; the runtime
//              draws in the page what frameEffects says and leaves the layers of the HUD as they are
//   post-pass  off is the command of before; the windows (at most 4 frames, apart, none at glitch 0), the five kinds in both styles, the pieces of
//              the film; with ffmpeg: every frame of the film is there and the glitch is only in its windows
//   node       the parameter (off, subtle, strong; strong by default), its texts in de, en and es, the field of the three templates

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
const near = (actual, expected, tolerance, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} !== ${expected} (±${tolerance})`.trim());
const prepare = (input, options = {}) => graphicsLib.prepareGraphics(input, { accent: '#3B82F6', ...options }).graphics;
// the example song of graphics.js: verses, choruses, drops, sung lines in lip-sync cuts
const film = prepare(graphicsLib.demoGraphics({ duration: 128.4 }));
const kubleFilm = prepare(graphicsLib.demoGraphics({ duration: 128.4 }), { theme: 'kuble' });
const short = prepare(graphicsLib.demoGraphics({ duration: 12 }));
const strong = effects.planEffects(film, { level: 'strong' });
const subtle = effects.planEffects(film, { level: 'subtle' });
const json = (value) => JSON.parse(JSON.stringify(value));
// the example with a hit on every third beat (the example itself has few hits): every kind of event and of glitch
const crowded = (g) => ({ ...g, music: { ...g.music, hits: g.music.beats.filter((_t, i) => i % 3 === 0).map((t, i) => ({ t, strength: 0.5 + ((i * 37) % 50) / 100 })) } });

// the zone of a frame of the plan
const zoneOf = (plan, f) => plan.zones.find((zone) => f >= zone.f0 && f < zone.f1);
// every start of a flash, the planned ones and those of the HUD, sorted; the most in any 24 frames
function mostInASecond(frames) {
  let most = 0;
  for (let i = 0; i < frames.length; i += 1) {
    let count = 0;
    for (let j = i; j < frames.length && frames[j] < frames[i] + FPS; j += 1) count += 1;
    most = Math.max(most, count);
  }
  return most;
}

/* ---------- the plan ---------- */

function testLevels() {
  assert.deepEqual(effects.LEVELS, ['off', 'subtle', 'strong']);
  assert.equal(effects.DEFAULT_LEVEL, 'strong');
  for (const [value, level] of [['strong', 'strong'], [' Subtle ', 'subtle'], ['off', 'off'], [undefined, 'off'], ['', 'off'], ['wild', 'off'], [3, 'off'], [null, 'off']]) {
    assert.equal(effects.normalizeLevel(value), level, JSON.stringify(value));
  }
  assert.equal(effects.planEffects(film, { level: 'off' }), null);
  assert.equal(effects.planEffects(film, {}), null, 'no level is off');
  for (const plan of [strong, subtle]) {
    assert.equal(plan.version, 1);
    assert.deepEqual([plan.fromF, plan.toF], [0, film.endFrame]);
    assert.ok(plan.events.length > 50 && plan.zones.length >= 4);
    for (let i = 1; i < plan.events.length; i += 1) assert.ok(plan.events[i].f >= plan.events[i - 1].f, 'the events in the order of their frames');
    for (const event of plan.events) assert.ok('pusrbwczhfi'.includes(event.k) && Number.isInteger(event.f), JSON.stringify(event));
    assert.ok(JSON.stringify(plan).length < 60000, 'small enough for the pages');
  }
  // the zones cover the film without a gap
  for (let i = 1; i < strong.zones.length; i += 1) assert.equal(strong.zones[i].f0, strong.zones[i - 1].f1);
  assert.ok(strong.zones[0].f0 <= 0 && strong.zones[strong.zones.length - 1].f1 >= film.endFrame);
}

// Dense in the drop and the chorus, calm in the verse, nothing in a break; subtle is calmer than strong and has no strobe, negative, turn or wave.
function testDensity() {
  const rate = (plan, kind, pick = () => true) => {
    let frames = 0;
    let count = 0;
    for (const zone of plan.zones.filter((item) => item.k === kind)) {
      const from = Math.max(zone.f0, plan.fromF);
      const to = Math.min(zone.f1, plan.toF);
      if (to <= from) continue;
      frames += to - from;
      count += plan.events.filter((event) => event.f >= from && event.f < to && pick(event)).length;
    }
    return frames ? (count * FPS) / frames : null;
  };
  const kinds = new Set(strong.zones.map((zone) => zone.k));
  for (const kind of ['break', 'verse', 'chorus', 'drop']) assert.ok(kinds.has(kind), `the example has a ${kind}`);
  const [breakRate, verse, chorus, drop] = ['break', 'verse', 'chorus', 'drop'].map((kind) => rate(strong, kind));
  assert.equal(breakRate, 0, 'nothing happens in a break');
  assert.ok(verse > 0.5 && chorus > verse * 1.8 && drop > chorus * 1.2, `events a second: verse ${verse}, chorus ${chorus}, drop ${drop}`);
  // the colour: the chorus brighter and more colourful than the verse, the drop more than the chorus, the break greyer
  const gradeOf = (kind) => strong.zones.find((zone) => zone.k === kind).g;
  assert.ok(gradeOf('chorus')[0] > gradeOf('verse')[0] && gradeOf('chorus')[2] > gradeOf('verse')[2] && gradeOf('drop')[2] > gradeOf('chorus')[2] && gradeOf('break')[2] < 1);
  // the strong things where they belong: the shake, the bulge, the strobe of the drop
  const strobe = strong.events.filter((event) => event.k === 'f' && event.n === 1);
  assert.ok(strobe.length >= 3 && strobe.every((event) => zoneOf(strong, event.f).k === 'drop'), 'the strobe is in the drop');
  assert.ok(strong.events.filter((event) => event.k === 'b').every((event) => ['chorus', 'drop'].includes(zoneOf(strong, event.f).k)), 'the bulge in the chorus and the drop');
  assert.ok(strong.events.some((event) => event.k === 'i') && strong.events.filter((event) => event.k === 'i').every((event) => zoneOf(strong, event.f).k === 'drop'));
  // subtle
  assert.ok(subtle.events.length < strong.events.length * 0.7, `${subtle.events.length} against ${strong.events.length}`);
  assert.ok(subtle.glitch.length < strong.glitch.length);
  assert.ok(!subtle.events.some((event) => event.k === 'i' || event.k === 'w' || event.k === 'r' || (event.k === 'f' && event.n === 1)), 'no negative, wave, turn or strobe');
  assert.equal(rate(subtle, 'break'), 0);
  assert.ok(rate(subtle, 'drop') > rate(subtle, 'verse'));
  for (const [kind, max] of [['p', 0.04], ['s', 11]]) {
    assert.ok(subtle.events.filter((event) => event.k === kind).every((event) => event.a <= max), `the ${kind} of subtle stays small`);
  }
  // the glitch of the post-pass: more in the drop and the chorus than in the verse, more kinds there
  const glitchIn = (plan, kind) => plan.glitch.filter((item) => zoneOf(plan, item.f).k === kind).length;
  assert.ok(glitchIn(strong, 'drop') + glitchIn(strong, 'chorus') > glitchIn(strong, 'verse'));
}

// The strength of a hit and the loudness count as percentiles of the song: a quieter song (all hits weaker, the energy lower) has the same plan.
// The plan of before took only hits of 0.8 and more: a song whose hits are all below got no glitch at all.
function testPercentiles() {
  const weaker = {
    ...film,
    music: {
      ...film.music,
      hits: film.music.hits.map((hit) => ({ ...hit, strength: hit.strength * hit.strength * 0.5 })),
      energy: film.music.energy.map((value) => value * 0.7)
    }
  };
  assert.ok(weaker.music.hits.every((hit) => hit.strength < 0.5));
  const plan = effects.planEffects(weaker, { level: 'strong' });
  assert.deepEqual(plan.zones, strong.zones, 'the same zones');
  assert.deepEqual(plan.events, strong.events, 'the same events');
  assert.deepEqual(plan.glitch, strong.glitch, 'the same glitch');
  assert.ok(plan.glitch.length >= 5);
  assert.equal(post.glitchWindows(weaker, { glitch: 0.6 }).filter((window) => window.strength > 0).length, post.glitchWindows({ ...weaker, music: { ...weaker.music, hits: [] } }).length, 'the windows of before: none on the hits');
  // the percentiles themselves
  assert.deepEqual(effects.ranks([3, 1, 2]), [1, 0, 0.5]);
  assert.deepEqual(effects.ranks([5, 5, 1]), [0.75, 0.75, 0]);
  assert.deepEqual(effects.ranks([7]), [0.5]);
}

function testDeterminism() {
  assert.deepEqual(effects.planEffects(film, { level: 'strong' }), strong);
  assert.deepEqual(effects.planEffects(json(film), { level: 'strong' }), strong, 'the same from a copy of the data');
  assert.deepEqual(json(strong), strong, 'the plan is plain data');
  for (const t of [0, 3.3, 47.125, 100]) assert.deepEqual(effects.frameEffects(strong, t), effects.frameEffects(json(strong), t));
  // the Kuble plan has the same events except the flashes (the pulse of the HUD of Kuble counts for the limit) and other colours
  const kuble = effects.planEffects(kubleFilm, { level: 'strong' });
  assert.deepEqual(kuble.events.filter((event) => event.k !== 'f' && event.k !== 'i'), strong.events.filter((event) => event.k !== 'f' && event.k !== 'i'));
  assert.notDeepEqual(kuble.look, strong.look);
}

// At most 3 flashes in any second: the planned ones (light, strobe, negative) and those the HUD draws (a cut with the transition flash, the pulse of
// Kuble). When the plan of the HUD alone has more, the effects add none there.
function testFlashLimit() {
  for (const [g, level] of [[film, 'strong'], [film, 'subtle'], [kubleFilm, 'strong'], [short, 'strong']]) {
    const plan = effects.planEffects(g, { level });
    const frames = effects.flashFrames(plan, g);
    assert.ok(mostInASecond(frames) <= effects.FLASH_LIMIT, `${g.theme} ${level}: ${mostInASecond(frames)} flashes in a second`);
  }
  // a crowded plan: a flash on every other cut, a strong hit on every beat
  const crowded = {
    ...kubleFilm,
    cuts: kubleFilm.cuts.map((cut, index) => ({ ...cut, transition: index % 2 ? 'flash' : cut.transition })),
    music: { ...kubleFilm.music, hits: kubleFilm.music.beats.map((t) => ({ t, strength: 0.95 })) }
  };
  const plan = effects.planEffects(crowded, { level: 'strong' });
  const own = effects.fixedFlashFrames(crowded);
  const all = effects.flashFrames(plan, crowded);
  for (let f = 0; f < crowded.endFrame; f += 6) {
    const count = (list) => list.filter((x) => x >= f && x < f + FPS).length;
    assert.ok(count(all) <= Math.max(effects.FLASH_LIMIT, count(own)), `frame ${f}: ${count(all)} flashes, ${count(own)} of the HUD`);
    if (count(own) >= effects.FLASH_LIMIT) assert.equal(count(all), count(own), `frame ${f}: no flash of the effects where the HUD has 3`);
  }
  // the check itself
  assert.equal(effects.flashFits([0, 10], 20), true);
  assert.equal(effects.flashFits([0, 10, 20], 23), false);
  assert.equal(effects.flashFits([0, 10, 20], 24), true);
}

// No red flash over the picture: a red accent flashes white (HUD Blue) or ink (Kuble, whose flashes are its ink and its blue whatever the accent is);
// the negative flash is grey (HUD Blue) or night blue (Kuble).
function testNoRed() {
  // a wider net than the saturated red of WCAG (red / (red + green + blue) of 0.8 or more): rose and dark red count as red too
  for (const hex of ['#FF0000', '#E11D48', '#C81E1E', '#FF3B30', '#D9145A', '#5A2020']) assert.equal(effects.isRed(hex), true, hex);
  for (const hex of ['#3B82F6', '#2E5CFF', '#FFFFFF', '#F2F4F8', '#22C55E', '#F7901F', '#3D3535', '#777777', '#000000']) assert.equal(effects.isRed(hex), false, hex);
  assert.equal(effects.safeFlashColor('#ff0000'), '#FFFFFF');
  assert.equal(effects.safeFlashColor('#3b82f6'), '#3B82F6');
  assert.equal(effects.safeFlashColor('not a colour'), '#FFFFFF');
  for (const [theme, accent] of [['hud', '#FF0000'], ['hud', '#E11D48'], ['hud', '#22C55E'], ['kuble', '#FF0000'], ['kuble', '#F7901F']]) {
    const g = prepare(graphicsLib.demoGraphics({ duration: 40 }), { theme, accent });
    const plan = effects.planEffects(g, { level: 'strong' });
    for (const color of plan.look.colors) assert.ok(!effects.isRed(color), `${theme} ${accent}: ${color}`);
    if (theme === 'kuble') assert.deepEqual(plan.look.colors, ['#F2F4F8', '#2E5CFF'], 'Kuble: ink and Kuble Blue, never amber');
    else assert.equal(plan.look.colors[1], effects.isRed(accent) ? '#FFFFFF' : accent);
    assert.match(plan.look.invert, /grayscale\(1\)/, 'the negative has no colour of the picture');
    const flashes = plan.events.filter((event) => event.k === 'f');
    assert.ok(flashes.length > 0);
    for (let t = 0; t < g.endFrame / FPS; t += 1 / FPS) {
      const flash = effects.frameEffects(plan, t).flash;
      if (flash) assert.ok(!effects.isRed(flash.color) && flash.alpha > 0 && flash.alpha <= 1);
    }
  }
}

// Nothing on the end card and nothing before the first frame of the film.
function testEndcardFree() {
  const withCard = prepare({ ...graphicsLib.demoGraphics({ duration: 30 }), endcard: { seconds: 3 } });
  const excerpt = { ...film, start: 40, endFrame: Math.round(70 * FPS), cuts: film.cuts.filter((cut) => cut.end > 40 && cut.start < 70) };
  for (const g of [withCard, film, excerpt]) {
    for (const level of ['subtle', 'strong']) {
      const plan = effects.planEffects(g, { level });
      const first = Math.round(g.start * FPS);
      assert.ok(plan.events.every((event) => event.f >= first && event.f + (event.n || 1) <= g.endFrame), `${level}: every event in the film`);
      assert.ok(plan.glitch.every((item) => item.f >= first && item.f + item.n <= g.endFrame), `${level}: every glitch in the film`);
      for (let f = g.endFrame; f < g.endFrame + 4 * FPS; f += 1) assert.deepEqual(effects.frameEffects(plan, f / FPS), effects.frameEffects(null, 0), `the end card, frame ${f}`);
      for (let f = Math.max(0, first - 30); f < first; f += 1) assert.deepEqual(effects.frameEffects(plan, f / FPS), effects.frameEffects(null, 0), `before the film, frame ${f}`);
      // the windows of the post-pass end before the end card
      const windows = post.fxGlitchWindows(g, { glitch: 1, level });
      const filmFrames = g.endFrame - first;
      assert.ok(windows.every((window) => window.frame >= 0 && window.frame + window.frames <= filmFrames));
    }
  }
}

// The face in a lip-sync cut: no bulge and no wave in the whole cut, no blur and no chromatic edges while a word is sung (one frame before and after
// it), a smaller shake; a glitch over the whole picture only between the words. Zoom and light are allowed.
function testSungWords() {
  const lip = effects.lipOf(film);
  const quiet = effects.quietOf(film);
  assert.ok(lip.length >= 10 && quiet.length >= 10, 'the example sings');
  const inside = (spans, f) => spans.some(([a, b]) => f >= a && f < b);
  for (const plan of [strong, subtle]) {
    for (let f = 0; f < film.endFrame; f += 1) {
      const fx = effects.frameEffects(plan, f / FPS);
      if (inside(lip, f)) assert.ok(fx.bulge === 0 && fx.wave === 0, `frame ${f}: no bulge or wave on the face`);
      if (inside(quiet, f)) assert.ok(fx.blur === 0 && fx.chroma === 0, `frame ${f}: no distortion while a word is sung`);
    }
    for (const item of plan.glitch) for (let f = item.f; f < item.f + item.n; f += 1) assert.ok(!inside(quiet, f), `the glitch at frame ${item.f} is between the words`);
  }
  // the words: one frame before and after, inside the cut; a gap of one frame is closed
  const g = {
    ...short,
    cuts: [{ start: 0, end: 2, kind: 'performance' }, { start: 2, end: 4, kind: 'story' }],
    lines: [{ start: 0.5, end: 3, words: [{ start: 0.5, end: 1 }, { start: 1.05, end: 1.5 }, { start: 1.9, end: 3 }] }]
  };
  assert.deepEqual(effects.quietOf(g), [[11, 37], [45, 48]], 'the words 0.5 to 1.5 s (with the gap of one frame), the third word only in the sung cut');
  assert.deepEqual(effects.lipOf(g), [[0, 48]]);
  // and the sung part of the real film stays sharp on the frames of its words
  const sungFrames = quiet.reduce((sum, [a, b]) => sum + b - a, 0);
  assert.ok(sungFrames > 10 * FPS);
}

/* ---------- the frames ---------- */

// The page of a chunk carries the part of the plan it needs: every frame of every chunk is the frame of the whole plan, also at the seams; the zoom
// always covers the screen when the picture moves, turns or waves.
function testFrames() {
  for (const [g, level] of [[film, 'strong'], [kubleFilm, 'strong'], [film, 'subtle']]) {
    const plan = effects.planEffects(g, { level });
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
  // the transform covers the screen: every corner of the screen lies on the picture
  let moved = 0;
  for (let f = 0; f < film.endFrame; f += 1) {
    const fx = effects.frameEffects(strong, f / FPS);
    for (const value of Object.values(fx)) if (typeof value === 'number') assert.ok(Number.isFinite(value));
    if (fx.x || fx.y || fx.rot) moved += 1;
    const angle = (fx.rot * Math.PI) / 180;
    for (const [cx, cy] of [[-960, -540], [960, -540], [-960, 540], [960, 540]]) {
      // the point of the picture (round the middle) that lands on the corner: undo the move, the turn, the zoom
      const vx = cx - fx.x;
      const vy = cy - fx.y;
      const px = (vx * Math.cos(angle) + vy * Math.sin(angle)) / fx.zoom;
      const py = (-vx * Math.sin(angle) + vy * Math.cos(angle)) / fx.zoom;
      const margin = fx.wave / 2 + (fx.dir === 1 ? fx.blur * 2.5 : 0);
      assert.ok(Math.abs(px) <= 960 - margin + 0.6 && Math.abs(py) <= 540 + 0.6, `frame ${f}: the corner ${cx},${cy} is off the picture`);
    }
  }
  assert.ok(moved > 200, 'the picture moves');
  // the punch on a downbeat of the drop, then it eases
  const punch = strong.events.find((event) => event.k === 'p' && zoneOf(strong, event.f).k === 'drop' && event.a > 0.05);
  const zoomAt = (f) => effects.frameEffects(strong, f / FPS).zoom;
  assert.ok(zoomAt(punch.f) >= 1 + punch.a - 1e-4 && zoomAt(punch.f + 6) < zoomAt(punch.f));
}

/* ---------- the page ---------- */

function testPage() {
  for (const g of [film, kubleFilm]) {
    const chunks = chunksLib.planChunks(g, { endcardSeconds: 3 });
    for (const chunk of [chunks[0], chunks[chunks.length - 1]]) {
      for (const options of [{ karaoke: false, endcard: true }, { karaoke: true, endcard: false }]) {
        const before = composition.buildChunkHtml({ graphics: g, chunk, clipFile: 'a.mp4', options });
        for (const level of ['off', undefined, 'OFF', 'loud']) {
          assert.equal(composition.buildChunkHtml({ graphics: g, chunk, clipFile: 'a.mp4', options: { ...options, effects: level } }), before, `${g.theme}: effects ${level} is the page of before`);
        }
        assert.ok(!before.includes('id="fx"') && !before.includes('HudEffects'));
        const html = composition.buildChunkHtml({ graphics: g, chunk, clipFile: 'a.mp4', options: { ...options, effects: 'strong' } });
        assert.ok(Buffer.byteLength(html) < composition.MAX_HTML_BYTES, 'under the limit of the render node');
        assert.ok(Buffer.byteLength(html) - Buffer.byteLength(before) < 160000, `the effects add ${Buffer.byteLength(html) - Buffer.byteLength(before)} bytes`);
        assert.match(html, /<div id="stage"><div id="fx"><div id="cam"><video id="v1" class="clip" src="a\.mp4"[^>]*><\/video><\/div><\/div><div id="fx-light" class="layer"><\/div>\n<div id="scrim" class="layer">/);
        assert.match(html, /<svg id="fx-defs" width="0" height="0" aria-hidden="true">/);
        assert.equal(html.match(/<script>/g).length, 8, 'data, themes, state, view, runtime, the plan of the effects, effects.js, its runtime');
        // nothing is loaded from elsewhere: the maps are data URLs, the only script from outside is GSAP of before
        const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
        for (const url of urls) assert.ok(url === 'a.mp4' || url.startsWith('data:image/png;base64,') || url.startsWith('data:font/') || url.startsWith('https://cdn.jsdelivr.net/npm/gsap@'), url);
        assert.equal(html.split('Content-Security-Policy').length, 2);
        // the part of the plan of this chunk
        const fxData = JSON.parse(/window\.__HUD_FX=(.*?);<\/script>/s.exec(html)[1]);
        assert.deepEqual(fxData, json(effects.sliceEffects(composition.effectsPlan(g, 'strong'), chunk.start, chunk.start + chunk.duration)));
        // the rest of the page is the one of before: the effects take nothing away
        const without = html.replace(/\n<style>[^]*?<\/style>/, '').replace(/<svg id="fx-defs"[^]*?<\/svg>\n/, '').replace('<div id="fx">', '').replace('</div><div id="fx-light" class="layer"></div>', '').replace(/<script>window\.__HUD_FX=[^]*$/, '');
        const beforeStripped = before.replace(/\n<style>[^]*?<\/style>/, '').replace(/<\/div><\/body><\/html>\n$/, '');
        assert.equal(without, beforeStripped);
      }
    }
  }
  // subtle and strong: other plans
  const chunk = chunksLib.planChunks(film, { endcardSeconds: 3 })[2];
  const fxOf = (level) => JSON.parse(/window\.__HUD_FX=(.*?);<\/script>/s.exec(composition.buildChunkHtml({ graphics: film, chunk, clipFile: 'a.mp4', options: { effects: level } }))[1]);
  assert.equal(fxOf('subtle').level, 'subtle');
  assert.ok(fxOf('subtle').events.length < fxOf('strong').events.length);
}

// The filters of the page: the ids that view() sets exist, the maps are small PNG images
function testFilters() {
  const defs = fxsvg.svgDefs();
  for (const id of ['fx-bulge', 'fx-wave', 'fx-zoom', 'fx-blur', 'fx-chroma']) assert.ok(defs.includes(`<filter id="${id}" `), id);
  const ids = new Set([...defs.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]));
  const busy = effects.planEffects(crowded(film), { level: 'strong' });
  const states = [];
  for (let f = 0; f < film.endFrame; f += 1) states.push(effects.frameEffects(busy, f / FPS));
  const used = new Set();
  for (const s of states) {
    const drawn = effects.view(s);
    for (const [id, attribute, value] of drawn.svg) {
      assert.ok(ids.has(id), `${id} is in the page`);
      assert.ok(/^-?[\d.]+( 0)?$/.test(value), `${id} ${attribute}="${value}"`);
      used.add(id);
    }
    for (const match of drawn.fx.matchAll(/url\(#([a-z-]+)\)/g)) assert.ok(ids.has(match[1]));
    assert.ok(!/NaN|undefined|Infinity/.test(drawn.fx + drawn.light));
  }
  for (const id of ['fx-bulge-d', 'fx-wave-d', 'fx-zoom-3', 'fx-blur-g', 'fx-chroma-r']) assert.ok(used.has(id), `the film uses ${id}`);
  // a frame without anything is plain: no filter, no transform, no light
  assert.deepEqual(effects.view(effects.frameEffects(null, 0)), { fx: 'transform:none;filter:none', light: 'opacity:0', svg: [] });
  // the maps
  const maps = fxsvg.maps();
  for (const [name, url] of Object.entries(maps)) {
    const png = Buffer.from(url.replace('data:image/png;base64,', ''), 'base64');
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], name);
    assert.ok(png.length < 12000, `${name}: ${png.length} bytes`);
  }
  // the bulge map moves nothing in the middle and at the edge, the most at 0.58 of the radius
  const pixels = (url, width) => {
    const png = Buffer.from(url.replace('data:image/png;base64,', ''), 'base64');
    const idat = png.subarray(png.indexOf('IDAT') + 4, png.indexOf('IEND') - 8);
    const raw = zlib.inflateSync(idat);
    return (x, y) => [raw[y * (width * 3 + 1) + 1 + x * 3], raw[y * (width * 3 + 1) + 2 + x * 3]];
  };
  const bulge = pixels(maps.bulge, fxsvg.MAP.width);
  // the pixels round the middle move by less than a twentieth of the most
  for (const [x, y] of [[47, 26], [48, 26], [47, 27], [48, 27]]) assert.ok(bulge(x, y).every((value) => Math.abs(value - 128) <= 7), `${x},${y}: ${bulge(x, y)}`);
  assert.deepEqual(bulge(0, 0), [128, 128], 'the corner stays');
  assert.ok(bulge(Math.round(fxsvg.MAP.width * 0.21), fxsvg.MAP.height / 2)[0] > 240, 'the left part is pulled to the middle');
}

// The runtime of the page: a second tween on the timeline of the HUD; for every frame the wrapper, the light and the filters as frameEffects says;
// the layers of the HUD as in the page without the effects.
function testRuntime() {
  for (const g of [film, kubleFilm]) {
    const chunk = chunksLib.planChunks(g, { endcardSeconds: 3 })[3];
    const load = (level) => {
      const html = composition.buildChunkHtml({ graphics: g, chunk, clipFile: 'a.mp4', options: { karaoke: false, endcard: true, effects: level } });
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
      for (const script of scripts) vm.runInContext(script, sandbox, { filename: `${level}-page-script.js` });
      const drawAt = (local) => {
        for (const tick of ticks) {
          tick.target.t = local;
          tick.options.onUpdate();
        }
      };
      return { elements, ticks, drawAt, sandbox };
    };
    const on = load('strong');
    const off = load('off');
    assert.equal(off.ticks.length, 1);
    assert.equal(on.ticks.length, 2, 'the effects add their own tween');
    assert.equal(on.ticks[1].position, 0);
    assert.equal(on.ticks[1].options.duration, on.ticks[0].options.duration, 'as long as the page');
    assert.equal(typeof on.sandbox.HudEffects.frameEffects, 'function');
    const plan = composition.effectsPlan(g, 'strong');
    const frames = Math.round(chunk.duration * FPS);
    let changes = 0;
    let lastFx = '';
    for (let i = 0; i < frames; i += 1) {
      on.drawAt(i / FPS);
      off.drawAt(i / FPS);
      const expected = effects.view(effects.frameEffects(plan, chunk.start + i / FPS));
      assert.equal(on.elements.fx.attributes.style, expected.fx, `frame ${i}`);
      assert.equal(on.elements['fx-light'].attributes.style, expected.light, `frame ${i}`);
      for (const [id, attribute, value] of expected.svg) assert.equal(on.elements[id].attributes[attribute], value, `frame ${i}: ${id}`);
      for (const layer of ['l-dev', 'l-hud', 'l-kar', 'l-over', 'l-end', 'stage', 'cam']) {
        assert.equal(on.elements[layer].innerHTML, off.elements[layer].innerHTML, `frame ${i}: ${layer}`);
        assert.deepEqual(on.elements[layer].attributes, off.elements[layer].attributes, `frame ${i}: ${layer}`);
      }
      if (on.elements.fx.attributes.style !== lastFx) changes += 1;
      lastFx = on.elements.fx.attributes.style;
    }
    assert.ok(changes > frames / 4, `the footage moves (${changes} of ${frames} frames)`);
    assert.ok(on.elements.fx.writes <= changes + 1, 'an attribute is only written when it changes');
    // the HUD of the page is the one of the film
    const film0 = view.render(state.frameState(g, chunk.start + 2, { karaoke: false, endcard: true }));
    on.drawAt(2);
    assert.equal(on.elements['l-hud'].innerHTML, film0.hud);
  }
}

/* ---------- the post-pass ---------- */

const files = { listFile: '/s/chunks.txt', songFile: '/s/song.wav', outFile: '/s/film.mp4' };

function testPostArgs() {
  // off is the command of before
  for (const g of [film, kubleFilm, short]) {
    for (const params of [{ grain: 0.35, glitch: 0.6 }, { grain: 0, glitch: 0 }, {}]) {
      const before = post.buildPostArgs({ ...files, graphics: g, params, endcardSeconds: 3 });
      for (const level of ['off', undefined, 'nonsense']) assert.deepEqual(post.buildPostArgs({ ...files, graphics: g, params: { ...params, effects: level }, endcardSeconds: 3 }).args, before.args);
    }
  }
  for (const g of [film, kubleFilm]) {
    const built = post.buildPostArgs({ ...files, graphics: g, params: { grain: 0.35, glitch: 0.6, effects: 'strong' }, endcardSeconds: 3 });
    const windows = built.windows;
    const plan = effects.planEffects(g, { level: 'strong' });
    assert.equal(windows.length, plan.glitch.length);
    for (let i = 0; i < windows.length; i += 1) {
      const window = windows[i];
      assert.ok(window.frames >= 1 && window.frames <= 4, 'at most 4 frames over the whole picture');
      assert.ok(effects.GLITCH_KINDS.includes(window.kind));
      assert.ok(window.strength > 0 && window.strength <= 0.6 + 1e-9, 'the slider sets the strength');
      near(window.start, (window.frame - 0.5) / FPS, 1e-9);
      near(window.end, (window.frame + window.frames - 0.5) / FPS, 1e-9);
      if (i) assert.ok(window.frame >= windows[i - 1].frame + windows[i - 1].frames + effects.GLITCH_GAP_FRAMES, 'two windows never join');
      // the piece of the film that is the window
      assert.ok(built.filter.includes(`trim=start_frame=${window.frame}:end_frame=${window.frame + window.frames},setpts=PTS-STARTPTS`), `the piece of the window at ${window.frame}`);
    }
    const pieces = (built.filter.match(/trim=start_frame=/g) || []).length;
    assert.equal(pieces, (/concat=n=(\d+):v=1:a=0/.exec(built.filter) || [])[1] * 1);
    assert.ok(built.filter.includes(`trim=start_frame=${windows[windows.length - 1].frame + windows[windows.length - 1].frames},setpts`), 'the last piece runs to the end');
    assert.ok(!/enable='/.test(built.filter.split(';').filter((part) => /\[w\d+\]|\[x\d+/.test(part)).join(';')), 'the filters of a window work on its frames only');
    // the rest of the command is the one of before
    const before = post.buildPostArgs({ ...files, graphics: g, params: { grain: 0.35, glitch: 0.6 }, endcardSeconds: 3 });
    const at = built.args.indexOf('-filter_complex');
    assert.deepEqual([built.args.slice(0, at), built.args.slice(at + 2)], [before.args.slice(0, at), before.args.slice(at + 2)]);
    assert.equal(built.frames, before.frames);
    assert.ok(built.filter.endsWith(before.filter.slice(before.filter.lastIndexOf(';'))), 'the same sound');
  }
  // glitch 0: no window, the graph of before without glitch
  for (const g of [film, kubleFilm]) {
    const none = post.buildPostArgs({ ...files, graphics: g, params: { grain: 0.35, glitch: 0, effects: 'strong' }, endcardSeconds: 3 });
    assert.equal(none.windows.length, 0);
    assert.equal(none.filter, post.buildPostArgs({ ...files, graphics: g, params: { grain: 0.35, glitch: 0 }, endcardSeconds: 3 }).filter);
  }
  // a song as the analysis finds it: a hit on every beat, nearly all of them weaker than 0.8 (the film of 2026-10-09 had 338 of 340 below). The
  // windows of before came only from the hits of 0.8 and more; the effects take the strongest hits of each part of the song
  const real = { ...film, music: { ...film.music, hits: film.music.beats.map((t, i) => ({ t, strength: i % 150 === 7 ? 0.85 : 0.3 + 0.45 * effects.hash(i, 3, 5) })) } };
  const before = post.glitchWindows(real, { glitch: 0.6 }).length;
  const now = post.fxGlitchWindows(real, { glitch: 0.6, level: 'strong' }).length;
  assert.ok(now >= 20 && now > 3 * before, `${now} windows, before ${before}`);
  // the slider scales every window
  const half = post.fxGlitchWindows(film, { glitch: 0.3, level: 'strong' });
  const full = post.fxGlitchWindows(film, { glitch: 1, level: 'strong' });
  half.forEach((window, i) => near(window.strength, full[i].strength * 0.3, 1e-3));
}

// The five kinds in both styles, each in its colours: HUD Blue the RGB shift of before, blocks with a negative, a white seam; Kuble its prism, its
// shards, a seam in its blue for writing, a VHS track tinted Kuble Blue and noise in night blue. No red anywhere.
function testGlitchKinds() {
  // a song full of hits gives many kinds, two windows in a row never the same
  for (const g of [film, kubleFilm]) {
    const id = themes.get(g.theme).id;
    const planned = post.fxGlitchWindows(crowded(g), { glitch: 0.8, level: 'strong' });
    assert.ok(new Set(planned.map((window) => window.kind)).size >= 4, `${id}: ${[...new Set(planned.map((window) => window.kind))]}`);
    assert.ok(planned.every((window) => window.kind !== 'noise' || window.frames <= 2), 'the noise is short');
    for (let i = 1; i < planned.length; i += 1) assert.notEqual(planned[i].kind, planned[i - 1].kind, 'two windows in a row differ');
    // every kind and every variant of it, each in the colours of the style
    const windows = [];
    let frame = 10;
    for (const kind of effects.GLITCH_KINDS) {
      for (let variant = 0; variant < 3; variant += 1) {
        windows.push({ frame, frames: kind === 'noise' ? 2 : 3, kind, variant, strength: 0.5 + variant * 0.2 });
        frame += 12;
      }
    }
    const filter = post.fxVideoFilter({ windows, grain: 0.35, theme: themes.get(g.theme) });
    assert.equal((filter.match(/trim=start_frame=/g) || []).length, windows.length * 2 + 1, `${id}: a piece for every window and every gap`);
    if (id === 'kuble') {
      assert.ok(filter.includes('maskedmerge') && filter.includes('blend=all_mode=subtract'), 'the shards and the prism of Kuble');
      assert.ok(filter.includes(`color=0x${themes.get('kuble').colors.blueText.replace('#', '')}@0.9`), 'the seam in its blue for writing');
      assert.ok(filter.includes('noise=c0s=') && /c1s=(\d+)/.exec(filter)[1] * 1 > /c0s=(\d+)/.exec(filter.slice(filter.indexOf('noise=c0s=')))[1] * 1, 'the noise more blue than green');
      assert.ok(!filter.includes('white@'), 'no white seam in Kuble');
    } else {
      assert.ok(filter.includes('rgbashift=rh=') && filter.includes(',negate[') && filter.includes('color=white@0.85'), 'the RGB shift, the negative block, the white seam');
    }
    assert.ok(!/red|0xff0000|#ff0000/i.test(filter), 'no red');
    assert.ok(filter.includes('format=yuv420p,noise=c0s=') || filter.includes('noise=c0s=4:c0f=t+u'), 'the grain of before');
  }
}

/* ---------- with ffmpeg ---------- */

async function testFfmpeg(binaries) {
  const { execFile } = require('child_process');
  const raw = (args) => new Promise((resolve, reject) => execFile(binaries.ffmpeg, args, { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr) || err.message)) : resolve(stdout))));
  const run = (args) => raw(['-nostdin', '-v', 'error', '-y', ...args]);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hud-fx-'));
  try {
    // the footage of the film (12 s) and of the end card (1 s) as the render node returns it, a song of one tone
    const g = short;
    const plan = effects.planEffects(g, { level: 'strong' });
    assert.ok(plan.glitch.length >= 2, 'the example has glitch windows');
    const chunk = path.join(dir, 'chunk-1.mp4');
    const frames = g.endFrame + FPS;
    await run(['-f', 'lavfi', '-i', `testsrc2=size=480x270:rate=24`, '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', chunk]);
    const song = path.join(dir, 'song.wav');
    await run(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=14', '-ar', '48000', song]);
    fs.writeFileSync(path.join(dir, 'chunks.txt'), post.concatListText([chunk]));
    const greys = async (file) => {
      const out = await raw(['-nostdin', '-v', 'error', '-i', file, '-vf', 'scale=64:36:flags=area,format=gray', '-f', 'rawvideo', 'pipe:1']);
      const size = 64 * 36;
      return Array.from({ length: out.length / size }, (_frame, i) => out.subarray(i * size, (i + 1) * size));
    };
    for (const theme of ['hud', 'kuble']) {
      const graphics = theme === 'kuble' ? prepare(graphicsLib.demoGraphics({ duration: 12 }), { theme }) : g;
      const outs = {};
      for (const [name, params] of [['fx', { grain: 0, glitch: 1, effects: 'strong' }], ['plain', { grain: 0, glitch: 0, effects: 'strong' }]]) {
        const out = path.join(dir, `${theme}-${name}.mp4`);
        const built = post.buildPostArgs({ listFile: path.join(dir, 'chunks.txt'), songFile: song, outFile: out, graphics, params, endcardSeconds: 1, inputColor: { color_space: 'bt709', color_range: 'tv' } });
        await raw(built.args);
        const probe = JSON.parse(String(await new Promise((resolve, reject) => execFile(binaries.ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', out], (err, stdout) => (err ? reject(err) : resolve(stdout))))));
        assert.deepEqual(post.verifyOutput(probe, { frames: built.frames, seconds: built.seconds }), [], `${theme} ${name}`);
        assert.equal(Number(probe.streams.find((stream) => stream.codec_type === 'video').nb_read_frames), frames, `${theme} ${name}: every frame of the film and the card`);
        outs[name] = { frames: await greys(out), windows: built.windows };
      }
      const windows = outs.fx.windows;
      assert.ok(windows.length >= 2);
      const inWindow = new Set(windows.flatMap((window) => Array.from({ length: window.frames }, (_x, i) => window.frame + i)));
      const diff = (i) => {
        let sum = 0;
        for (let p = 0; p < outs.fx.frames[i].length; p += 1) sum += Math.abs(outs.fx.frames[i][p] - outs.plain.frames[i][p]);
        return sum / outs.fx.frames[i].length;
      };
      for (let i = 0; i < frames; i += 1) {
        if (inWindow.has(i)) assert.ok(diff(i) > 2, `${theme}: frame ${i} of a window is glitched (${diff(i).toFixed(2)})`);
        else assert.ok(diff(i) < 1.5, `${theme}: frame ${i} outside the windows is untouched (${diff(i).toFixed(2)})`);
      }
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ---------- the node, its texts, the templates ---------- */

function testNode() {
  const def = require('../lib/nodes/registry').get('music_video.hud_render');
  const param = def.params.find((item) => item.id === 'effects');
  assert.deepEqual([param.kind, param.options, param.default], ['select', ['off', 'subtle', 'strong'], 'strong']);
  assert.ok(def.params.findIndex((item) => item.id === 'effects') < def.params.findIndex((item) => item.id === 'glitch'), 'effects before the strength of the glitch');
  assert.match(def.description, /Effects \(strong by default, subtle or off\)/);
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'nodes', 'nodes-music-video-hud.js'), 'utf8');
  assert.ok(source.includes('effects: params.effects }'), 'the pages get the level');
  assert.ok(source.includes('glitch: params.glitch, effects: params.effects }'), 'the post-pass gets the level');
  // the texts
  const { rows } = require('../public/nodes/i18n-nodes');
  const text = (key, lang) => (rows.find((row) => row[0] === key) || [])[{ de: 1, en: 2, es: 3 }[lang]];
  for (const [lang, label] of [['de', 'Effekte'], ['en', 'Effects'], ['es', 'Efectos']]) {
    assert.equal(text('nodes.param.effects', lang), label);
    for (const option of param.options) assert.ok(text(`nodes.option.${option}`, lang), `${lang}: ${option}`);
    const tip = text('nodes.type.music_video.hud_render.tip.3', lang);
    assert.ok(!tip.includes('ß') && tip.length <= 240);
    assert.match(tip, lang === 'de' ? /«Effekte».*«Glitch»/ : lang === 'en' ? /“Effects”.*“Glitch”/ : /«Efectos».*«Glitch»/);
  }
  // the three templates: the field after the karaoke line, strong; the node only feeds the results (a change of the field runs no paid node again)
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
  const tests = [testLevels, testDensity, testPercentiles, testDeterminism, testFlashLimit, testNoRed, testEndcardFree, testSungWords, testFrames, testPage, testFilters, testRuntime, testPostArgs, testGlitchKinds, testNode];
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
  } else {
    console.log('skipped testFfmpeg: ffmpeg is not installed');
  }
  console.log(`${passed} tests passed`);
  console.log('test-music-video-hud-effects.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
