'use strict';

// Synthetic finds cover two singers without footage or a provider. The cut summary reserves both faces, the tag track chooses the larger
// stable face even when the smaller one scores higher, and leader lines and brackets leave the other face clear. Solo serialization stays as
// before, and a duet without measured faces reserves both sides before layout as well.
const assert = require('assert/strict');
const faces = require('../lib/music-video-hud/faces');
const graphics = require('../lib/music-video-hud/graphics');
const targets = require('../lib/music-video-hud/targets');
const plan = require('../lib/music-video-hud/plan');
const stateLib = require('../lib/music-video-hud/state');
const { makeSong, goodAnswer, FIGURE_TEXT } = require('./support/hud-plan-fixtures');

const at = (x, y, s, q) => ({ x, y, s, d: s * 0.38, a: 0, q });
const cut = { start: 0, end: 4, kind: 'performance', voice: 'duet', subject: 'center', framing: 'MS', crop: { scale: 1, x: 0.5, y: 0.5 } };
const finds = Array.from({ length: 24 }, (_v, index) => ({ frame: index * 4, faces: [at(520, 400, 240, 60), at(1400, 450, 300, 40)] }));
const [measured] = faces.cutFacesOf({ cuts: [cut] }, finds, { landmarks: true });
assert.equal(measured.count, 2);
assert.equal(measured.subject, 'right');
assert.equal(measured.people.length, 2);
const zone = graphics.faceZone({ ...cut, faces: measured });
assert.ok(zone.x0 <= 520 - 240 && zone.x1 >= 1400 + 300);
assert.ok(zone.y0 <= 400 - 240 && zone.y1 >= 450 + 300);
const planned = graphics.faceZone(cut);
assert.ok(planned.x0 <= 280 && planned.x1 >= 1640, 'without measurement both thirds stay clear');
const normalized = graphics.normalizeGraphics({ version: 1, duration: 4, cuts: [cut], graphics: [] }).graphics;
assert.equal(normalized.cuts[0].voice, 'duet');
assert.deepEqual(faces.cutSamplesOf(normalized), [19, 48, 76]);
// Exercise the layout as well as its exclusion geometry, before and after measurement, through a punch-in and chunk slicing.
for (const measuredCut of [cut, { ...cut, faces: measured }, { ...cut, faces: measured, crop: { scale: 1.15, x: 0.5, y: 0.5 } }]) {
  const g = graphics.resolveGraphics({ ...normalized, cuts: [measuredCut], graphics: [{ id: 'tag', type: 'tag', text: 'LIPS', start: 0.5, end: 3, position: 'middle_left' }] });
  const exclusion = graphics.faceZone(measuredCut);
  for (let frame = 0; frame < 96; frame += 1) {
    for (const item of stateLib.frameState(g, frame / 24).devices) {
      for (const rect of item.d.occupies || [item.rect]) {
        assert.equal(rect.x < exclusion.x1 && rect.x + rect.w > exclusion.x0 && rect.y < exclusion.y1 && rect.y + rect.h > exclusion.y0, false, 'no HUD panel covers either face');
      }
    }
  }
  assert.equal(graphics.sliceGraphics(g, 1, 3).cuts[0].voice, 'duet');
}
const track = faces.trackOf({ cuts: [{ ...cut, faces: measured }] }, finds);
assert.equal(track.points.length, finds.length);
assert.ok(track.points.every((point) => point[1] === 1400), 'size, rather than detector confidence, selects the unknown singer');
const camera = { scale: 1, tx: 0, ty: 0 };
for (const target of ['mouth', 'eyes', 'hair']) {
  const other = targets.boxOf(measured.people[0], 'face', camera);
  const state = { t: 2, cut, camera, devices: [{ type: 'tag', d: { target }, enter: 1, leave: 0, rect: { x: 100, y: 440, w: 180, h: 34 } }] };
  const svg = targets.subjectHtml(state, { cuts: [{ ...cut, faces: measured }], faces: track });
  assert.match(svg, /<svg/);
  const line = /<path d="M([^"]+)" opacity=/.exec(svg);
  if (line) {
    const points = line[1].split(' L').map((pair) => pair.split(' ').map(Number));
    for (let index = 1; index < points.length; index += 1) assert.equal(targets.crosses(points[index - 1], points[index], other), false, target);
  }
  const covered = targets.subjectHtml(state, { cuts: [{ ...cut, faces: { ...measured, people: [at(1400, 450, 300, 40), at(1401, 450, 300, 40)] } }], faces: track });
  assert.equal(covered, '', 'overlapping brackets are suppressed when they would cover the other face');
}
assert.equal(targets.guessedFace(cut).x, 520);
const solo = { ...cut }; delete solo.voice;
assert.deepEqual(faces.cutFacesOf({ cuts: [solo] }, finds.map((item) => ({ ...item, faces: [item.faces[0]] })), { landmarks: true }), [{ x0: 520, x1: 520, s: 240, count: 1, subject: 'left' }]);
assert.deepEqual(graphics.faceZone(solo), { x0: 720, y0: 80, x1: 1200, y1: 640 });

// The duet marker must survive the planner and normalizer; a manually marked cut alone would miss that contract.
const song = makeSong({ seconds: 60 });
const grid = plan.planGrid(song.analysis, song.timing, { motionShare: 0 });
const unit = grid.units.find((value) => value.kind === 'performance');
assert.ok(unit);
unit.voice = 'duet';
const figure = plan.parseFigure(FIGURE_TEXT);
const content = plan.readAnswer(JSON.stringify(goodAnswer(grid, figure)), { grid, figure }).content;
const built = plan.buildGraphics({ grid, content, figure });
assert.ok(built.graphics.cuts.filter((value) => value.unit === unit.index).every((value) => value.voice === 'duet'));
console.log('test-music-video-hud-duet-faces.js: ok');
