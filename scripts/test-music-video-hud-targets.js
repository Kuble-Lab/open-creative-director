'use strict';

// Tags that point at the right place (WP51): lib/music-video-hud/targets.js (the place a tag names, where it is on the screen, the leader line),
// lib/music-video-hud/faces.js (the face finder and the track under the tags), the pages of the chunks (composition.js, graphics.js sliceGraphics), the
// planner (the target in its prompt and in its answer) and the node music_video.hud_render (the measurement, the cache stamp). No network, nothing paid,
// no footage of anybody: the finder is checked on made-up pictures and made-up finds (its accuracy on a real film is in IMPLEMENTATION-NOTES, WP51).
//   text       the place from the words of a tag in several languages, the fallback, the target of the plan first
//   prompt     the planner asks for the target; its answer keeps a known one and drops another without asking again
//   geometry   the boxes of the places through the crop and the beat effects, the leader line that keeps off the eyes and the mouth, the brackets
//   track      the face from frame to frame: joined, held, faded, never across a cut
//   none       no target, no face, no figure, a film that was not measured
//   main       plans of main (tags without a target) still work and point by their words
//   pages      a page without a tag is the one of main, byte for byte (with and without a track); a page with a tag carries the script and its part of
//              the track; the page draws the new brackets instead of the old ones, with and without the effects, in both styles
//   finder     the files of the cascades, the frames to look at, the ffmpeg arguments, the chains of a track, the thread, determinism
//   node       the cache stamp (a film without a tag keeps its key) and the measurement on a made-up video with ffmpeg

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const targets = require('../lib/music-video-hud/targets');
const faces = require('../lib/music-video-hud/faces');
const graphicsLib = require('../lib/music-video-hud/graphics');
const chunksLib = require('../lib/music-video-hud/chunks');
const composition = require('../lib/music-video-hud/composition');
const state = require('../lib/music-video-hud/state');
const view = require('../lib/music-video-hud/view');
const hudPlan = require('../lib/music-video-hud/plan');
const hudNodes = require('../lib/nodes/nodes-music-video-hud');
const { FIGURE_TEXT, makeSong, goodAnswer, scriptedModel } = require('./support/hud-plan-fixtures');

const FPS = 24;
const near = (actual, expected, tolerance, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} !== ${expected} (±${tolerance})`.trim());
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const IDENTITY = Object.freeze({ scale: 1, tx: 0, ty: 0 });

/* ---------- the place from the words ---------- */

function testText() {
  const cases = {
    'LIP GLOSS ON': 'mouth',
    'LIPGLOSS 3 ML': 'mouth',
    'Lippenstift: rot': 'mouth',
    'Lippen': 'mouth',
    'labios': 'mouth',
    'GLOSSARY': 'face',
    'ADDRESS CHECK': 'face',
    'UNDRESS': 'face',
    'GLOSSED': 'face',
    'LÄCHELN 100%': 'mouth',
    'LABIOS ROJOS': 'mouth',
    'EYELINER 2 MM': 'eyes',
    'AUGEN ZU': 'eyes',
    'PESTAÑAS XL': 'eyes',
    'NEW BOB': 'hair',
    'NEUE HAARSPANGE': 'hair',
    'FLEQUILLO': 'hair',
    'NAILS DONE': 'hands',
    'RED DRESS': 'outfit',
    'KLEID AUS SEIDE': 'outfit',
    'SKIN 2.0': 'face',
    'PHONE AT 3%': 'object',
    'HANDY AUS': 'object',
    'CLAUDIA CLAUDIA': 'face',
    'SHE POSTS FROM': 'face',
    '': 'face'
  };
  for (const [text, target] of Object.entries(cases)) assert.equal(targets.targetFromText(text), target, text);
  // the first word that names a place decides
  assert.equal(targets.targetFromText('EYES ON THE LIPS'), 'eyes');
  assert.equal(targets.targetFromText('LIPS, THEN EYES'), 'mouth');
  // a short word is no prefix of a longer one (RING is no RINGTONE)
  assert.equal(targets.targetFromText('RINGTONE 3'), 'face');
  assert.equal(targets.FALLBACK, 'face');
  // the target of the plan first, when it is a known one (any case, spaces); else the words
  assert.equal(targets.targetOf({ text: 'LIP GLOSS ON', target: 'hair' }), 'hair');
  assert.equal(targets.targetOf({ text: 'LIP GLOSS ON', target: ' Eyes ' }), 'eyes');
  assert.equal(targets.targetOf({ text: 'LIP GLOSS ON', target: 'lips' }), 'mouth');
  assert.equal(targets.targetOf({ text: 'LIP GLOSS ON', target: 7 }), 'mouth');
  assert.equal(targets.targetOf({ text: 'CLAUDIA' }), 'face');
  assert.equal(targets.targetOf(null), 'face');
  assert.deepEqual([...targets.TARGETS], ['face', 'eyes', 'mouth', 'hair', 'hands', 'outfit', 'object', 'none']);
  assert.deepEqual([...targets.LOCATED], ['face', 'eyes', 'mouth', 'hair', 'outfit']);
  // every place has words, and no word stands for two places of the same kind of list twice in a way that changes the answer
  for (const target of ['mouth', 'eyes', 'hair', 'hands', 'outfit', 'face', 'object']) assert.ok(targets.WORDS[target].length >= 10, target);
  for (const [target, words] of Object.entries(targets.WORDS)) for (const word of words) assert.match(word, /^[A-Z0-9]+$/, `${target}: ${word} is upper case without accents`);
}

/* ---------- the planner ---------- */

async function testPrompt() {
  for (const theme of ['hud', 'kuble']) {
    for (const hudLanguage of ['en', 'de', 'es']) {
      const system = hudPlan.systemPrompt({ theme, hudLanguage });
      assert.ok(system.includes('give every tag a "target" (face, eyes, mouth, hair, hands, outfit, object or none)'), `${theme} ${hudLanguage}: the rule`);
      assert.ok(system.includes('"LIP GLOSS ON" → mouth'), `${theme} ${hudLanguage}: an example`);
      assert.ok(system.includes('tag: {"type": "tag", "text": ≤ 32 characters, "target": "face | eyes | mouth | hair | hands | outfit | object | none"}'), `${theme} ${hudLanguage}: the catalogue`);
    }
  }
  // the answer: a known target is kept (lower case), another one and a missing one leave the tag without it; neither is a problem of the answer
  const song = makeSong({ seconds: 60, seed: 3 });
  const options = { motionShare: 0.3, maxUnits: 40 };
  const grid = hudPlan.planGrid(song.analysis, song.timing, options);
  const figure = hudPlan.parseFigure(FIGURE_TEXT);
  const given = ['MOUTH', 'lips', null];
  const answer = goodAnswer(grid, figure, {
    mutate: (a) => {
      let at = 0;
      for (const line of a.lines) {
        for (const graphic of line.graphics) {
          if (graphic.type !== 'tag') continue;
          const value = given[at % given.length];
          if (value !== null) graphic.target = value;
          at += 1;
        }
      }
    }
  });
  const read = hudPlan.readAnswer(JSON.stringify(answer), { grid, figure });
  const tags = read.content.lines.flatMap((line) => line.graphics).filter((graphic) => graphic.type === 'tag');
  assert.ok(tags.length >= 3, 'the answer has tags');
  tags.forEach((tag, at) => {
    if (at % 3 === 0) assert.equal(tag.target, 'mouth');
    else assert.equal(tag.target, undefined, `tag ${at}: no target kept`);
  });
  assert.ok(!read.problems.some((problem) => /target/.test(problem)), 'a target is never a problem');
  const model = scriptedModel([answer]);
  const result = await hudPlan.runPlanner({ analysis: song.analysis, timing: song.timing, brief: 'A light that stays on', figureText: FIGURE_TEXT, options, ask: model.ask, prices: {} });
  assert.equal(model.calls.length, 1, 'one answer of the model is enough');
  const planned = result.plan.graphics.graphics.filter((d) => d.type === 'tag');
  assert.ok(planned.some((d) => d.target === 'mouth'), 'the plan keeps the target');
  assert.ok(planned.every((d) => d.target === undefined || d.target === 'mouth'));
  // the plan goes through the renderer's check with its targets
  const { graphics, warnings } = graphicsLib.normalizeGraphics(result.plan.graphics);
  assert.deepEqual(warnings, []);
  assert.deepEqual(graphics.graphics.filter((d) => d.type === 'tag').map((d) => d.target), planned.map((d) => d.target));
  // graphics.js: a known target stays, any other is dropped
  const normal = graphicsLib.normalizeGraphics({ duration: 10, cuts: [{ start: 0, end: 10 }], graphics: [{ type: 'tag', text: 'A', target: 'Hair', start: 1 }, { type: 'tag', text: 'B', target: 'nose', start: 2 }] }).graphics.graphics;
  assert.deepEqual(normal.map((d) => d.target), ['hair', undefined]);
  assert.ok(!('target' in normal[1]));
}

/* ---------- the geometry ---------- */

function testGeometry() {
  const face = { x: 960, y: 400, d: 200, a: 0, alpha: 1 };
  const centre = (box) => [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2];
  const size = (box) => [box.x1 - box.x0, box.y1 - box.y0];
  // the places in pupil units round the pupils
  const eyes = targets.boxOf(face, 'eyes', IDENTITY, null);
  assert.deepEqual(centre(eyes), [960, 400]);
  assert.deepEqual(size(eyes), [420, 160]);
  const mouth = targets.boxOf(face, 'mouth', IDENTITY, null);
  near(centre(mouth)[1], 400 + 1.19 * 200, 1e-9, 'the mouth is 1.19 pupil distances below the pupils');
  const hair = targets.boxOf(face, 'hair', IDENTITY, null);
  assert.ok(hair.y1 < eyes.y0, 'the hair is above the eyes');
  const facebox = targets.boxOf(face, 'face', IDENTITY, null);
  assert.ok(facebox.y0 < eyes.y0 && facebox.y1 > mouth.y1 && facebox.x0 < mouth.x0 && facebox.x1 > mouth.x1, 'the face holds the eyes and the mouth');
  assert.equal(targets.boxOf(face, 'hands', IDENTITY, null), null, 'nothing measures the hands');
  // a turned head: the mouth goes along with the turn (the line through the pupils turned by 20 degrees, the mouth to the left of below)
  const turned = targets.boxOf({ ...face, a: 20 }, 'mouth', IDENTITY, null);
  assert.ok(centre(turned)[0] < 960 - 70, 'turned to the left');
  // the crop of the cut: the camera of state.js (a punch-in of 1.35 round x 0.5, y 0.42) moves and grows the box like the footage
  const camera = state.camera({ scale: 1.35, x: 0.5, y: 0.42 }, 0);
  const cropped = targets.boxOf(face, 'eyes', camera, null);
  near(centre(cropped)[0], 960 * 1.35 + camera.tx, 1e-6);
  near(centre(cropped)[1], 400 * 1.35 + camera.ty, 1e-6);
  near(size(cropped)[0], 420 * 1.35, 1e-6);
  // the beat effects: zoom, move and turn round the middle of the screen
  const [x, y] = targets.toScreen([1060, 540], IDENTITY, { zoom: 1.1, x: 10, y: -4, rot: 0 });
  near(x, 960 + 10 + 100 * 1.1, 1e-9);
  near(y, 540 - 4, 1e-9);
  const [rx, ry] = targets.toScreen([1060, 540], IDENTITY, { zoom: 1, x: 0, y: 0, rot: 90 });
  near(rx, 960, 1e-9);
  near(ry, 640, 1e-9);
  assert.deepEqual(targets.toScreen([100, 200], IDENTITY, { zoom: 1, x: 0, y: 0, rot: 0 }), [100, 200], 'no effect, no change');
  // kept on the screen; a place mostly off it is not pointed at (the clothes below a big close-up)
  assert.equal(targets.boxOf({ x: 960, y: 700, d: 300, a: 0 }, 'outfit', IDENTITY, null), null);
  const low = targets.boxOf({ x: 960, y: 640, d: 120, a: 0 }, 'outfit', IDENTITY, null);
  assert.ok(low && low.y1 <= 1072, 'cut at the edge of the screen');

  // the line: from the side of the tag that faces the box to the near side of the box, as level as the box allows
  const tagLeft = { x: 96, y: 530, w: 150, h: 34 };
  const line = targets.lineOf(tagLeft, mouth, [eyes]);
  assert.equal(line.length, 2);
  assert.deepEqual(line[0], [246, 547]);
  assert.equal(line[1][0], mouth.x0);
  assert.ok(line[1][1] >= mouth.y0 && line[1][1] <= mouth.y1);
  const tagRight = { x: 1640, y: 530, w: 150, h: 34 };
  const back = targets.lineOf(tagRight, mouth, []);
  assert.deepEqual(back[0], [1640, 547]);
  assert.equal(back[1][0], mouth.x1);
  // it keeps off the eyes and the mouth when it points elsewhere: every segment of every line to the hair and the clothes, from tags all round
  const outfit = targets.boxOf({ x: 960, y: 300, d: 120, a: 0 }, 'outfit', IDENTITY, null);
  const small = { eyes: targets.boxOf({ x: 960, y: 300, d: 120, a: 0 }, 'eyes', IDENTITY, null), mouth: targets.boxOf({ x: 960, y: 300, d: 120, a: 0 }, 'mouth', IDENTITY, null) };
  for (const [place, avoid] of [[hair, [eyes, mouth]], [outfit, [small.eyes, small.mouth]], [mouth, [eyes]], [eyes, [mouth]]]) {
    for (const rect of [tagLeft, tagRight, { x: 96, y: 160, w: 200, h: 34 }, { x: 96, y: 900, w: 200, h: 34 }, { x: 1600, y: 160, w: 200, h: 34 }, { x: 1600, y: 900, w: 200, h: 34 }]) {
      const points = targets.lineOf(rect, place, avoid);
      for (let i = 0; i + 1 < points.length; i += 1) for (const other of avoid) assert.ok(!targets.crosses(points[i], points[i + 1], other), `the line from ${rect.x},${rect.y} crosses an avoided place`);
      const end = points[points.length - 1];
      assert.ok(end[0] >= place.x0 - 1e-9 && end[0] <= place.x1 + 1e-9 && end[1] >= place.y0 - 1e-9 && end[1] <= place.y1 + 1e-9, 'the line ends on the box');
    }
  }
  // A wall across the screen has no free route; a shorter wall allows a checked detour.
  const wall = { x0: 300, y0: 0, x1: 400, y1: 1080 };
  const behind = { x0: 600, y0: 500, x1: 700, y1: 560 };
  const rect = { x: 50, y: 513, w: 100, h: 34 };
  assert.deepEqual(targets.lineOf(rect, behind, [wall]), [], 'no route through or outside the wall');
  const shortWall = { ...wall, y0: 300, y1: 800 };
  const round = targets.lineOf(rect, behind, [shortWall]);
  assert.ok(round.length > 2, 'a detour around the short wall');
  for (let i = 1; i < round.length; i += 1) assert.ok(!targets.crosses(round[i - 1], round[i], shortWall), 'every detour segment clears the wall');
  // Every segment of the review example must clear the eyes and mouth.
  const moved = { x: 960, y: 400, d: 150, a: 10 };
  const blocked = { x: 900, y: 500, w: 150, h: 34 };
  const avoidMoved = ['eyes', 'mouth'].map((name) => targets.boxOf(moved, name, IDENTITY));
  const reviewRoute = targets.lineOf(blocked, targets.boxOf(moved, 'hair', IDENTITY), avoidMoved);
  assert.ok(reviewRoute.length > 2, 'the review example has a free detour');
  for (let i = 1; i < reviewRoute.length; i += 1) for (const other of avoidMoved) assert.ok(!targets.crosses(reviewRoute[i - 1], reviewRoute[i], other));
  const trapped = { ...blocked, x: 950 };
  assert.deepEqual(targets.lineOf(trapped, targets.boxOf(moved, 'hair', IDENTITY), avoidMoved), [], 'a line cannot leave an avoided box');
  const blockedState = { t: 1, cut: { subject: 'center' }, camera: IDENTITY,
    devices: [{ type: 'tag', d: { target: 'hair' }, rect: trapped, enter: 1, leave: 0 }] };
  const blockedSvg = targets.subjectHtml(blockedState, { cuts: [{ start: 0, end: 2, subject: 'center' }], faces: { points: [[24, 960, 400, 150, 10]] } });
  assert.equal((blockedSvg.match(/<path/g) || []).length, 4, 'the brackets remain without a leader line');
  // the segment test
  assert.equal(targets.crosses([0, 0], [10, 10], { x0: 4, y0: 4, x1: 6, y1: 6 }), true);
  assert.equal(targets.crosses([0, 0], [10, 0], { x0: 4, y0: 4, x1: 6, y1: 6 }), false);
  assert.equal(targets.crosses([0, 5], [3, 5], { x0: 4, y0: 4, x1: 6, y1: 6 }), false);
}

/* ---------- the track from frame to frame ---------- */

function testTrack() {
  const cut = { start: 90 / FPS, end: 140 / FPS, subject: 'center' };
  const track = { step: 4, points: [[100, 900, 400, 200, 0], [104, 910, 404, 200, 2], [108, 920, 408, 204, 4], [128, 1000, 400, 200, 0], [132, 1004, 400, 200, 0], [136, 1004, 400, 200, 0], [141, 500, 500, 100, 0]] };
  // between two points: a straight line
  const mid = targets.faceAt(track, cut, 102);
  assert.deepEqual([mid.x, mid.y, mid.d, mid.a], [905, 402, 200, 1]);
  assert.equal(targets.faceAt(track, cut, 104).x, 910);
  // after the last point of a run it holds HOLD_FRAMES and fades out; before the first one the same, fading in
  assert.equal(targets.HOLD_FRAMES, 4);
  const held = targets.faceAt(track, cut, 111);
  assert.equal(held.x, 920);
  assert.ok(held.alpha > 0 && held.alpha < 1, 'fading out');
  assert.equal(targets.faceAt(track, cut, 113), null, 'gone');
  assert.equal(targets.faceAt(track, cut, 120), null, 'two runs further apart than JOIN_FRAMES are not joined');
  const before = targets.faceAt(track, cut, 96);
  assert.equal(before.x, 900);
  assert.ok(before.alpha > 0 && before.alpha < 1, 'fading in');
  assert.equal(targets.faceAt(track, cut, 94), null);
  assert.equal(targets.faceAt(track, cut, 106).alpha, 1, 'whole in the middle of a run');
  // a run that reaches the end of its cut does not fade there (the line goes with the picture), and no point of the next cut counts
  const end = targets.faceAt(track, cut, 138);
  assert.equal(end.x, 1004);
  assert.equal(end.alpha, 1);
  assert.equal(targets.faceAt(track, cut, 125).alpha, 0.5, 'but fades in where it begins inside the cut');
  assert.equal(targets.faceAt(track, cut, 139).x, 1004, 'held to the last frame of the cut');
  const next = { start: 140 / FPS, end: 200 / FPS, subject: 'center' };
  assert.equal(targets.faceAt(track, next, 140).x, 500, 'the next cut has its own face');
  assert.equal(targets.faceAt(track, next, 146), null);
  // empty and missing tracks
  assert.equal(targets.faceAt({ step: 4, points: [] }, cut, 100), null);
  assert.equal(targets.faceAt(null, cut, 100), null);
}

/* ---------- no target, no face, no figure ---------- */

function frameWith({ text = 'LIP GLOSS ON', target, subject = 'center', framing = 'CU', crop = { scale: 1, x: 0.5, y: 0.5 }, faces: track, t = 2 } = {}) {
  const d = { id: 'g1', type: 'tag', text, ...(target === undefined ? {} : { target }) };
  const item = { id: 'g1', type: 'tag', d, rect: { x: 96, y: 530, w: 175, h: 34 }, enter: 1, leave: 0 };
  const cut = { start: 0, end: 10, subject, framing, crop, kind: 'performance' };
  const g = { cuts: [cut], ...(track === undefined ? {} : { faces: track }) };
  const frame = { t, cut: { ...cut, index: 0 }, camera: state.camera(crop, 0), devices: [item] };
  return { frame, g };
}

function testNone() {
  const measured = { step: 4, points: [[44, 960, 400, 200, 0], [48, 960, 400, 200, 0], [52, 960, 400, 200, 0]] };
  // a face in the frame: the brackets round the mouth and one line
  const drawn = (() => {
    const { frame, g } = frameWith({ faces: measured });
    return targets.subjectHtml(frame, g, null, false);
  })();
  assert.match(drawn, /^<svg class="subj" /);
  assert.equal((drawn.match(/<g opacity=/g) || []).length, 1, 'one set of brackets');
  assert.equal((drawn.match(/<path d="M[\d.]+ [\d.]+ L/g) || []).length, 1, 'one line');
  assert.ok(drawn.includes('stroke="rgba(255,255,255,.9)"'));
  // Kuble: the colour of its style
  const { frame: kFrame, g: kG } = frameWith({ faces: measured });
  assert.ok(targets.subjectHtml(kFrame, kG, null, true).includes('stroke="var(--sub)"'));
  // the tag stands alone: a target nothing measures, none, a frame without a face, a cut without the figure
  for (const target of ['hands', 'object', 'none']) {
    const { frame, g } = frameWith({ target, faces: measured });
    assert.equal(targets.subjectHtml(frame, g, null, false), '', target);
  }
  const { frame: noFace, g: noFaceG } = frameWith({ faces: { step: 4, points: [] } });
  assert.equal(targets.subjectHtml(noFace, noFaceG, null, false), '', 'a measured film without a face in the frame');
  const { frame: away, g: awayG } = frameWith({ faces: measured, t: 5 });
  assert.equal(targets.subjectHtml(away, awayG, null, false), '', 'a frame far from the faces found');
  const { frame: nobody, g: nobodyG } = frameWith({ subject: 'none', faces: measured });
  assert.equal(targets.subjectHtml(nobody, nobodyG, null, false), '', 'a cut without the figure');
  // a film that was not measured: the place is guessed from the framing and the subject
  const { frame: guessed, g: guessedG } = frameWith({ subject: 'left', framing: 'MS' });
  const svg = targets.subjectHtml(guessed, guessedG, null, false);
  assert.ok(svg.length > 0, 'a guess is drawn');
  const guess = targets.guessedFace({ subject: 'left', framing: 'MS' });
  assert.deepEqual([guess.x, guess.y, guess.d], [520, 400, 135]);
  assert.deepEqual([targets.guessedFace({ subject: 'right' }).x, targets.guessedFace({ subject: 'center', framing: 'CU' }).d], [1400, 200]);
  assert.equal(targets.guessedFace({ subject: 'none' }), null);
  // two tags on one place share the brackets; two places have two
  const { frame: two, g: twoG } = frameWith({ faces: measured });
  const second = { ...two.devices[0], id: 'g2', d: { id: 'g2', type: 'tag', text: 'EYELINER' }, rect: { x: 1600, y: 300, w: 150, h: 34 } };
  const both = targets.subjectHtml({ ...two, devices: [two.devices[0], second] }, twoG, null, false);
  assert.equal((both.match(/<g opacity=/g) || []).length, 2);
  const same = targets.subjectHtml({ ...two, devices: [two.devices[0], { ...second, d: { ...second.d, text: 'LIPS' } }] }, twoG, null, false);
  assert.equal((same.match(/<g opacity=/g) || []).length, 1);
  assert.equal((same.match(/ L/g) || []).length, 2, 'but each tag its line');
  // a tag that is fading takes its line with it
  const { frame: fading, g: fadingG } = frameWith({ faces: measured });
  fading.devices[0] = { ...fading.devices[0], enter: 0.5 };
  assert.match(targets.subjectHtml(fading, fadingG, null, false), /<g opacity="0\.5">/);
}

/* ---------- plans of main ---------- */

function testMain() {
  // a plan written before WP51: tags without a target; the data are the ones of before (the fingerprints of test-music-video-hud.js hold them too)
  const raw = { duration: 12, cuts: [{ start: 0, end: 12, kind: 'performance', framing: 'CU', subject: 'center' }], graphics: [{ type: 'tag', text: 'LIP GLOSS ON', start: 1, end: 8 }] };
  const plan = graphicsLib.prepareGraphics(raw).graphics;
  const tag = plan.devices.find((d) => d.type === 'tag');
  assert.ok(!('target' in tag), 'no target is made up in the data');
  assert.equal(targets.targetOf(tag), 'mouth', 'the words decide');
  assert.doesNotThrow(() => hudNodes.readGraphics(JSON.stringify(raw)));
  // drawn with a track: the line ends at the mouth
  plan.faces = { step: 4, points: [[48, 960, 410, 200, 0], [52, 960, 410, 200, 0], [56, 960, 410, 200, 0]] };
  const frame = state.frameState(plan, 52 / FPS, { karaoke: false });
  const svg = targets.subjectHtml(frame, plan, null, false);
  const mouth = targets.boxOf({ x: 960, y: 410, d: 200, a: 0 }, 'mouth', frame.camera, null);
  const end = svg.match(/<path d="M[\d.]+ [\d.]+ L([\d.]+) ([\d.]+)"/);
  assert.ok(end, 'a line');
  near(Number(end[1]), tag.rect.x > 960 ? mouth.x1 : mouth.x0, 0.06, 'on the side of the box that faces the tag');
  assert.ok(Number(end[2]) >= mouth.y0 && Number(end[2]) <= mouth.y1);
  // the view of a frame without a tag is the one of before: targets.js only wraps it
  const noTag = graphicsLib.prepareGraphics({ ...raw, graphics: [{ type: 'stamp', text: 'DONE', start: 1, end: 8 }] }).graphics;
  const plain = state.frameState(noTag, 3, { karaoke: false });
  const View = { ...view };
  targets.install(View, { graphics: noTag }, {});
  assert.deepEqual(View.render(plain), view.render(plain));
}

/* ---------- the pages ---------- */

// The SHA-256 of the pages of the chunks without a tag of the example (graphicsLib.demoGraphics, 72 s, without the karaoke line), as main (WP49) built
// them. Made again with PRINT_TARGETS_GOLDEN=1 after a change that is meant to change those pages.
const MAIN_PAGES = {
  'hud off 0': '9b87d5a27557f2adce2804224d94e505e099226980fc009d952c698aa82c155e',
  'hud off 1': '97f60409e9f1d56f0817e7421a5f01a5019b08d572a24e42560b661324e0b2b9',
  'hud off 3': '6fb254e448367b6d46b1d3b65b5c3cdb1346ce4e3ef4d85164ad98264506d1f8',
  'hud strong 0': '75a0cecda294b8c1b8b3489a4fe3f03f1574825df0758d2328cd9b2a0c129426',
  'hud strong 1': 'a0fd34052d5a953435c4d6caecfdb830c544962d34c1f8297539d0b6f60d27c0',
  'hud strong 3': 'f35bfb10ad295a408a3da5a7431c821cc7821d9e9f633749cca982ed737c7af7',
  'kuble off 0': 'f0e6219d21bf22456869b33ce50472ea47d3bca483548a39ca96186faf9faf12',
  'kuble off 1': '4fa0dfc89ddd6224a23a28d52a180c3723873cb17d7e2ff43beaf6fa94fd81f1',
  'kuble off 3': 'aab5b035c5c3f268b6e06aeced9149546a1f944a58f19bbe6ec6410946ed7822',
  'kuble strong 0': 'c2070e8de95292a81b3f39fbb546653b96e16580f1e74763d4f10b87501f75c2',
  'kuble strong 1': 'a914cc5b103f826860c96f982fe202dfb1e0a7c80e1e65a51b0d4a318b38aa6e',
  'kuble strong 3': 'bac97cf742ce17e47b67ae243623590ca6681e42a299fe561e6ff259df10ae25'
};

const TRACK = { step: 4, points: Array.from({ length: 80 }, (_, i) => [1180 + 4 * i, 950 + i, 420, 150, 0]) };

function pagesOf(theme, effects, withTrack) {
  const { graphics } = graphicsLib.prepareGraphics(graphicsLib.demoGraphics({ duration: 72 }), { theme, karaoke: false });
  if (withTrack) graphics.faces = TRACK;
  const chunks = chunksLib.planChunks(graphics, { endcardSeconds: graphics.endcard ? graphics.endcard.seconds : 0 });
  return chunks.map((chunk) => {
    const slice = graphicsLib.sliceGraphics(graphics, chunk.start, chunk.start + chunk.duration);
    return { chunk, graphics, slice, html: composition.buildChunkHtml({ graphics, chunk, clipFile: 'vid-001.mp4', options: { karaoke: false, effects } }) };
  });
}

function testPages() {
  const printed = {};
  let tagged = 0;
  for (const theme of ['hud', 'kuble']) {
    for (const effects of ['off', 'strong']) {
      const plain = pagesOf(theme, effects, false);
      const tracked = pagesOf(theme, effects, true);
      plain.forEach((page, index) => {
        const key = `${theme} ${effects} ${index}`;
        const hasTag = page.slice.devices.some((d) => d.type === 'tag');
        if (!hasTag) {
          printed[key] = sha(page.html);
          if (!process.env.PRINT_TARGETS_GOLDEN) assert.equal(sha(page.html), MAIN_PAGES[key], `${key}: the page of main, byte for byte`);
          assert.equal(tracked[index].html, page.html, `${key}: a track changes nothing in a page without a tag`);
          assert.ok(!page.html.includes('HudTargets'), `${key}: no script of the targets`);
          assert.ok(!('faces' in tracked[index].slice), `${key}: no track in its data`);
          return;
        }
        tagged += 1;
        assert.equal((page.html.match(/root\.HudTargets = factory\(\)/g) || []).length, 1, `${key}: the script of the targets, once`);
        assert.ok(page.html.indexOf('root.HudTargets') > page.html.indexOf('root.HudView = factory'), 'after view.js');
        assert.ok(page.html.indexOf('root.HudTargets') < page.html.indexOf('window.__hudRenderAt = renderAt'), 'before the runtime');
        assert.ok(!page.html.includes('"faces"'), `${key}: no track without one`);
        const slice = tracked[index].slice;
        assert.ok(slice.faces && slice.faces.points.length > 0 && slice.faces.points.length < TRACK.points.length, `${key}: its part of the track`);
        assert.ok(slice.faces.points.every((point) => point[0] >= Math.floor(page.chunk.start * FPS) - FPS && point[0] <= Math.ceil((page.chunk.start + page.chunk.duration) * FPS) + FPS));
        assert.ok(tracked[index].html.includes('"faces":{"step":4,"points":[['), `${key}: the track in the data of the page`);
      });
    }
  }
  assert.equal(tagged, 4, 'the chunk with the tag in each style and level');
  if (process.env.PRINT_TARGETS_GOLDEN) console.log(JSON.stringify(printed, null, 2));
  // the size: the script and the track add a few kilobytes
  const [withTag] = pagesOf('hud', 'off', true).filter((page) => page.slice.devices.some((d) => d.type === 'tag'));
  const [before] = pagesOf('hud', 'off', false).filter((page) => page.slice.devices.some((d) => d.type === 'tag'));
  const added = Buffer.byteLength(withTag.html) - Buffer.byteLength(before.html.replace(/<script>[^<]*root\.HudTargets[\s\S]*?<\/script>\n/, ''));
  assert.ok(added > 0 && added < 40 * 1024, `the targets add ${added} bytes`);
}

// The page runs: the script of the targets takes over the brackets of view.js in the frames with a tag and leaves the other frames alone; with the
// effects on it follows the transform of the footage.
function runPage(html) {
  const layers = {};
  const element = (id) => {
    const el = { id, innerHTML: '', className: '', style: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, getAttribute(name) { return this.attributes[name] || null; } };
    layers[id] = el;
    return el;
  };
  const ticks = [];
  const timeline = { to(target, options) { ticks.push({ target, options }); return timeline; } };
  const sandbox = { document: { getElementById: (id) => layers[id] || element(id) }, gsap: { timeline: () => timeline }, console };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const script of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((entry) => entry[1])) vm.runInContext(script, sandbox, { filename: 'page-script.js' });
  const drawAt = (local) => {
    for (const tick of ticks) {
      tick.target.t = local;
      tick.options.onUpdate();
    }
    return { dev: layers['l-dev'].innerHTML, fx: layers.fx ? layers.fx.attributes.style : null };
  };
  return { sandbox, drawAt };
}

function testRuntime() {
  for (const theme of ['hud', 'kuble']) {
    for (const effects of ['off', 'strong']) {
      const page = pagesOf(theme, effects, true).find((entry) => entry.slice.devices.some((d) => d.type === 'tag'));
      const tag = page.slice.devices.find((d) => d.type === 'tag');
      const { sandbox, drawAt } = runPage(page.html);
      assert.equal(typeof sandbox.HudTargets, 'object', 'the script ran');
      const local = tag.appear + 1 - page.chunk.start;
      const frame = drawAt(local);
      const svgs = frame.dev.match(/<svg class="subj"/g) || [];
      assert.equal(svgs.length, 1, `${theme} ${effects}: one layer of brackets`);
      assert.ok(frame.dev.startsWith('<svg class="subj" viewBox="0 0 1920 1080" width="1920" height="1080" fill="none" stroke='), 'under the devices');
      assert.ok(frame.dev.includes('<g opacity="1">'), `${theme} ${effects}: the brackets of the targets, not the ones of view.js`);
      assert.ok(!/NaN|undefined|Infinity/.test(frame.dev), 'no NaN');
      assert.ok(frame.dev.includes(theme === 'kuble' ? 'stroke="var(--sub)"' : 'stroke="rgba(255,255,255,.9)"'));
      // the same frame twice is the same drawing
      drawAt(local + 3);
      assert.equal(drawAt(local).dev, frame.dev);
      // the box follows the face: the track moves 1 px a step to the right
      const later = drawAt(local + 0.5);
      const firstX = (html) => Number(html.match(/<g opacity="[\d.]+"><path d="M([\d.]+) /)[1]);
      assert.ok(firstX(later.dev) > firstX(frame.dev), `${theme} ${effects}: the brackets move with the face`);
      // the place on the screen: the track through the camera of the cut and, with the effects on, through the transform of the footage
      const t = page.chunk.start + local;
      const s = state.frameState(page.slice, t, { karaoke: false });
      const fx = effects === 'off' ? null : sandbox.HudEffects.frameEffects(sandbox.__HUD_FX, t);
      const expected = targets.subjectHtml(s, page.slice, fx, theme === 'kuble', sandbox.__HUD_FX ? sandbox.__HUD_FX.copies : []);
      assert.equal(frame.dev.slice(0, expected.length), expected, `${theme} ${effects}: the page draws what targets.js computes`);
      // a frame without a tag keeps the drawing of view.js
      const without = drawAt(1);
      const viewOnly = view.render(state.frameState(page.slice, page.chunk.start + 1, { karaoke: false })).dev;
      assert.equal(without.dev, viewOnly);
    }
  }
}

// Copies are described in song frames; the camera and effects still act at live time.
function testCopyRuntime() {
  for (const theme of ['hud', 'kuble']) {
    const g = graphicsLib.prepareGraphics({ duration: 4, cuts: [{ start: 0, end: 4, subject: 'center', crop: { scale: 1.1, x: 0.55, y: 0.5 } }],
      graphics: [{ type: 'tag', text: 'LIP GLOSS ON', start: 0, end: 4 }] }, { theme, karaoke: false }).graphics;
    g.faces = { step: 4, points: Array.from({ length: 24 }, (_, i) => [i * 4, 800 + i * 8, 400, 150, 0]) };
    const chunk = chunksLib.planChunks(g, { endcardSeconds: 0 })[0];
    const { sandbox, drawAt } = runPage(composition.buildChunkHtml({ graphics: g, chunk, clipFile: 'test.mp4', options: { effects: 'strong', karaoke: false } }));
    const f = 24;
    const check = (copies, frame, sourceFrame) => {
      sandbox.__HUD_FX.copies = copies;
      const actual = drawAt(frame / FPS).dev;
      if (sourceFrame === null) {
        assert.ok(!actual.includes('<svg class="subj"'), 'ambiguous copies hide both line and brackets');
        assert.ok(actual.includes('LIP GLOSS ON'), 'the tag remains');
        return;
      }
      const live = state.frameState(g, frame / FPS, { karaoke: false });
      const face = targets.faceAt(g.faces, g.cuts[0], sourceFrame);
      const expectedG = { ...g, faces: { points: [[frame, face.x, face.y, face.d, face.a]] } };
      const fx = sandbox.HudEffects.frameEffects(sandbox.__HUD_FX, frame / FPS);
      const expected = targets.subjectHtml(live, expectedG, fx, theme === 'kuble');
      assert.ok(expected.includes('<svg class="subj"'));
      assert.ok(actual.startsWith(expected), 'the copy uses its source face with the live camera and effects');
    };
    for (const r of [0.1, 1]) {
      const copy = { f, n: 4, m: 20, r, s: 'plain' };
      check([copy], f + 3, Math.floor(20 + 3 * r));
      check([copy], f, 20);
      check([copy], f + 4, f + 4);
      check([copy], f - 1, f - 1);
      check([copy], f + 3, Math.floor(20 + 3 * r));
    }
    for (const s of ['echo', 'left', 'right', 'kx', 'ky', 'kxy']) {
      const copy = { f, n: 4, m: 20, r: 1, s };
      check([copy], f, null);
      check([copy], f + 3, null);
      check([copy], f + 4, f + 4);
    }
    check([{ f, n: 4, m: 20, r: 1, s: 'plain' }, { f, n: 4, m: 16, r: 1, s: 'echo' }], f + 1, null);
  }
}

/* ---------- the finder ---------- */

async function testFinder() {
  const { face, pupil } = faces.loadCascades();
  assert.deepEqual([face.depth, face.count], [6, 468], 'facefinder: 468 trees of depth 6');
  assert.deepEqual([pupil.stages, pupil.trees, pupil.depth], [5, 20, 10], 'puploc: 5 stages of 20 trees of depth 10');
  const sums = {
    'facefinder.bin': 'd8014993e7298c7b1865d1f8b855d6dbf4ec5c808bf879e2091ab6837abf90cd',
    'puploc.bin': 'aa01adf34e5af6ed333be75e934275fc39fba2b63790cb340353b2d459c96ccc'
  };
  for (const [file, sum] of Object.entries(sums)) assert.equal(sha(fs.readFileSync(path.join(__dirname, '..', 'lib', 'music-video-hud', 'cascades', file))), sum, file);
  // nothing in an even grey picture; the same picture, the same finds (no random numbers)
  const size = faces.GRID.w * faces.GRID.h;
  assert.deepEqual(faces.findFaces(Buffer.alloc(size, 128)), []);
  const noise = Buffer.alloc(size);
  let seed = 7;
  for (let i = 0; i < size; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = (seed >> 16) & 255;
  }
  const once = faces.findFaces(noise, { minScore: -1e9 });
  assert.deepEqual(faces.findFaces(noise, { minScore: -1e9 }), once, 'deterministic');
  for (const found of once) assert.ok(['x', 'y', 'd', 'a', 's', 'q'].every((key) => Number.isFinite(found[key])));
  // the clusters: overlapping windows are one face
  const clusters = faces.clusterFinds([[100, 100, 50, 10], [102, 101, 52, 8], [300, 300, 50, 5]]);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters[0], [101, 100.5, 51, 18]);

  // the frames to look at: every 4th frame from 8 frames before a tag to 8 after its end (+ the exit), only in cuts with the figure
  const g = {
    start: 0,
    endFrame: 24 * 20,
    cuts: [{ start: 0, end: 5, subject: 'center' }, { start: 5, end: 8, subject: 'none' }, { start: 8, end: 20, subject: 'left' }],
    devices: [{ type: 'tag', appear: 2, start: 2, end: 6 }, { type: 'stamp', appear: 12, end: 14 }, { type: 'tag', appear: 9, end: 10 }]
  };
  const frames = faces.samplesOf(g);
  assert.ok(frames.every((frame) => frame % 4 === 0));
  assert.equal(frames[0], 40, 'from 8 frames before the first tag');
  assert.ok(!frames.some((frame) => frame >= 120 && frame < 192), 'nothing in the cut without the figure');
  assert.ok(frames.includes(208) && !frames.includes(204) && frames[frames.length - 1] === 260, 'the second tag, from 8 frames before it to 8 after its end and exit');
  assert.ok(!frames.some((frame) => frame > 300), 'the stamp is no tag');
  assert.deepEqual(faces.samplesOf({ ...g, devices: g.devices.filter((d) => d.type !== 'tag') }), []);
  // the ffmpeg arguments: the picture of the pages, then the frames by number, grey 640 x 360
  const args = faces.framesArgs({ inputFile: '/s/base.mp4', outFile: '/s/faces.raw', frames: [40, 44, 48, 100, 104], origin: 0.5 });
  assert.equal(args.includes('-ss'), false, 'read the last real frame even when every sample is after EOF');
  assert.equal(args[args.indexOf('-i') + 1], '/s/base.mp4');
  const filter = args[args.indexOf('-vf') + 1];
  assert.ok(filter.startsWith('scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=5,trim=start_frame=28,select='));
  assert.ok(filter.includes("select='between(n\\,0\\,8)*not(mod(n-0\\,4))+between(n\\,60\\,64)*not(mod(n-60\\,4))'"));
  assert.ok(filter.endsWith('scale=640:360:flags=area,format=gray'));
  assert.equal(args[args.indexOf('-frames:v') + 1], '5');
  assert.throws(() => faces.framesArgs({ inputFile: 'a', outFile: 'b', frames: [] }));

  // the chains: the figure through the cut, not a mirror that shows up twice, not a face of the set that is found once; one face per frame
  const at = (x, y, s, q) => ({ x, y, d: 0.38 * s, a: 0, s, q });
  const perFrame = [];
  for (let frame = 0; frame < 96; frame += 4) {
    const list = [at(900 + frame, 400, 300, 40)];
    if (frame === 20 || frame === 24) list.unshift(at(1600, 200, 120, 80));
    if (frame === 60) list.push(at(300, 700, 150, 200));
    perFrame.push({ frame, faces: list });
  }
  const one = { cuts: [{ start: 0, end: 4, subject: 'center' }] };
  const track = faces.trackOf(one, perFrame);
  assert.equal(track.step, 4);
  assert.equal(track.points.length, 24, 'every frame of the figure');
  assert.ok(track.points.every((point) => Math.abs(point[2] - 400) < 1e-9 && point[1] >= 900 && point[1] < 1000), 'only the figure');
  // smoothed: a jump of one find is softened
  const jumpy = perFrame.map((item) => ({ frame: item.frame, faces: [at(900 + (item.frame === 40 ? 40 : 0), 400, 300, 40)] }));
  const soft = faces.trackOf(one, jumpy).points.find((point) => point[0] === 40);
  assert.equal(soft[1], 920);
  // a cut without the figure has no track; a chain that is too weak counts nothing
  assert.deepEqual(faces.trackOf({ cuts: [{ start: 0, end: 4, subject: 'none' }] }, perFrame).points, []);
  assert.deepEqual(faces.trackOf(one, perFrame.map((item) => ({ frame: item.frame, faces: [at(900, 400, 300, 1)] }))).points, []);
  // a short cut with fewer frames than CHAIN.points takes what it has
  assert.equal(faces.trackOf({ cuts: [{ start: 0, end: 8 / FPS, subject: 'center' }] }, [{ frame: 0, faces: [at(900, 400, 300, 60)] }, { frame: 4, faces: [at(902, 400, 300, 60)] }]).points.length, 2);

  // the thread: the frames of a file, read one by one; the end of the run ends it
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-faces-'));
  try {
    const file = path.join(dir, 'faces.raw');
    fs.writeFileSync(file, Buffer.concat([Buffer.alloc(size, 128), noise, Buffer.alloc(size, 30)]));
    const g2 = { cuts: [{ start: 0, end: 1, subject: 'center' }] };
    const fromFile = await faces.trackFile(g2, file, [0, 4, 8]);
    assert.deepEqual(fromFile, faces.trackFaces(g2, fs.readFileSync(file), [0, 4, 8]), 'the thread finds what the function finds');
    // a file shorter than its frames: the missing frames have no face
    assert.deepEqual((await faces.trackFile(g2, file, [0, 4, 8, 12, 16])).step, 4);
    const controller = new AbortController();
    const running = faces.trackFile(g2, file, [0, 4, 8], { signal: controller.signal });
    controller.abort();
    await assert.rejects(running, (err) => err.name === 'AbortError');
    await assert.rejects(faces.trackFile(g2, path.join(dir, 'missing.raw'), [0]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------- the node ---------- */

async function testNode() {
  const render = hudNodes.definitions.find((def) => def.type === 'music_video.hud_render');
  const graphicsText = (list) => ({ graphics: { value: JSON.stringify({ duration: 10, cuts: [{ start: 0, end: 10 }], graphics: list }) } });
  const tag = [{ type: 'tag', text: 'LIP GLOSS ON', start: 1 }];
  const stamp = [{ type: 'stamp', text: 'DONE', start: 1 }];
  // a film without a tag keeps its key (the stamp of before: none with the effects off, the one of WP49 with them on)
  assert.equal(render.cacheStamp({ effects: 'off' }, { inputs: graphicsText(stamp) }), undefined);
  assert.deepEqual(render.cacheStamp({ effects: 'strong' }, { inputs: graphicsText(stamp) }), { effects: 'wp49' });
  assert.equal(render.cacheStamp({ effects: 'off' }, {}), undefined);
  assert.deepEqual(render.cacheStamp({ effects: 'strong' }, undefined), { effects: 'wp49' });
  // a film with a tag is drawn once more
  assert.deepEqual(render.cacheStamp({ effects: 'off' }, { inputs: graphicsText(tag) }), { tags: 'wp51' });
  assert.deepEqual(render.cacheStamp({ effects: 'strong' }, { inputs: graphicsText(tag) }), { effects: 'wp49', tags: 'wp51' });
  assert.equal(render.cacheStamp({ effects: 'off' }, { inputs: { graphics: { value: 'not json' } } }), undefined);
  assert.equal(hudNodes.planHasTag('{"graphics":[null,{"type":"tag"}]}'), true);
  assert.equal(hudNodes.planHasTag('{"graphics":{}}'), false);
  const coerced = [{ type: ['tag'], text: 'LIP GLOSS', start: 1 }];
  assert.equal(graphicsLib.prepareGraphics({ duration: 10, cuts: [{ start: 0, end: 10 }], graphics: coerced }).graphics.devices[0].type, 'tag');
  assert.deepEqual(render.cacheStamp({ effects: 'off' }, { inputs: graphicsText(coerced) }), { tags: 'wp51' });
  assert.deepEqual(render.cacheStamp({ effects: 'strong' }, { inputs: graphicsText(coerced) }), { effects: 'wp49', tags: 'wp51' });

  // the measurement with ffmpeg on a made-up video (no face in it): the frames under the tag are read and looked at; a failure is no reason to stop
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    console.log('ffmpeg is missing: the measurement of the node is not checked');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-measure-'));
  try {
    const video = path.join(dir, 'base.mp4');
    const made = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=24:duration=4', '-pix_fmt', 'yuv420p', video], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const graphics = graphicsLib.prepareGraphics({ duration: 4, cuts: [{ start: 0, end: 4, subject: 'center', framing: 'CU' }], graphics: [{ type: 'tag', text: 'LIP GLOSS ON', start: 1, end: 3 }] }).graphics;
    const logs = [];
    const ctx = { signal: undefined, withLocalSlot: (fn) => fn() };
    const track = await hudNodes.measureFaces(ctx, { videoFile: video, scratch: dir, graphics, log: (line) => logs.push(line) });
    assert.equal(track.step, 4);
    assert.ok(Array.isArray(track.points));
    assert.match(logs[0], /^the face under the 1 tags: \d+ frames looked at, a face in \d+, [\d.]+ s$/);
    assert.ok(!fs.existsSync(path.join(dir, 'faces.raw')), 'the frames are removed');
    // The source may be two seconds shorter. Sampling even wholly after EOF holds its final frame.
    const padded = path.join(dir, 'padded.raw');
    const final = path.join(dir, 'final.raw');
    const read = (outFile, frames) => {
      const result = spawnSync('ffmpeg', faces.framesArgs({ inputFile: video, outFile, frames }), { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return fs.readFileSync(outFile);
    };
    const last = read(final, [95]);
    const tailFrames = Array.from({ length: 12 }, (_, i) => 96 + i * 4);
    const held = read(padded, tailFrames);
    assert.equal(held.length, last.length * tailFrames.length);
    for (let i = 0; i < tailFrames.length; i += 1) assert.deepEqual(held.subarray(i * last.length, (i + 1) * last.length), last, 'the last footage frame is cloned');
    const heldGraphics = { cuts: [{ start: 0, end: 6, subject: 'center' }] };
    const heldTrack = faces.trackFaces(heldGraphics, held, tailFrames, { find: (pixels) => {
      assert.deepEqual(pixels, last);
      return [{ x: 800, y: 400, d: 150, a: 0, s: 300, q: 60 }];
    } });
    assert.equal(targets.faceAt(heldTrack, heldGraphics.cuts[0], 143).x, 800, 'the last measurement holds to the plan end');
    // a broken video: logged, the tags are guessed
    const broken = path.join(dir, 'broken.mp4');
    fs.writeFileSync(broken, 'no video');
    const none = await hudNodes.measureFaces(ctx, { videoFile: broken, scratch: dir, graphics, log: (line) => logs.push(line) });
    assert.equal(none, null);
    assert.match(logs[logs.length - 1], /could not be found .*: the tags point where the framing puts the face$/);
    // a film without a tag looks at nothing
    const noTag = graphicsLib.prepareGraphics({ duration: 4, cuts: [{ start: 0, end: 4 }], graphics: [{ type: 'stamp', text: 'DONE', start: 1, end: 3 }] }).graphics;
    assert.equal(await hudNodes.measureFaces(ctx, { videoFile: video, scratch: dir, graphics: noTag, log: () => assert.fail('nothing to log') }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  testText();
  await testPrompt();
  testGeometry();
  testTrack();
  testNone();
  testMain();
  testPages();
  testRuntime();
  testCopyRuntime();
  await testFinder();
  await testNode();
  console.log('test-music-video-hud-targets.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
