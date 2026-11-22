'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const words = require('../lib/music-video-hud/chorus-words');
const graphicsLib = require('../lib/music-video-hud/graphics');
const composition = require('../lib/music-video-hud/composition');
const state = require('../lib/music-video-hud/state');
const metrics = require('../lib/music-video-hud/metrics');
const { registry } = require('../lib/nodes/registry');
const engine = require('../lib/nodes/engine');
const pageSandbox = require('./support/hud-page-sandbox');

// Captured before the new parameter was added. Both saved named styles keep their planner and renderer keys.
const pinned = {
  'hud_plan.hud': 'sha256:ac5c8d90a8155d29fa4eb3e3ab7830d5ffe3389878f3656e6b0c01a369b75e0b',
  'hud_plan.kuble': 'sha256:f2b717ca34e894c1742f8b8179f871a71b015aebc7e1996fcdbb9b622ce91bf3',
  'hud_render.hud': 'sha256:a811c646ee5d817bae647f950f0e7a3f8af75d6e1c12fc8106f7d41fab709bf6',
  'hud_render.kuble': 'sha256:090c094abad49c9c492b6c14e3e5970409dad074ce9a434fef2e643ccce85e81'
};
for (const type of ['hud_plan', 'hud_render']) for (const theme of ['hud', 'kuble']) {
  const def = registry.get(`music_video.${type}`);
  const key = (params) => engine.computeCacheKey(def, engine.effectiveParams(registry, def, { id: 'n', type: def.type, params }), {});
  assert.equal(key({ theme }), pinned[`${type}.${theme}`]);
  if (type === 'hud_render') {
    assert.equal(key({ theme, chorus_words: 'off' }), pinned[`${type}.${theme}`]);
    assert.notEqual(key({ theme, chorus_words: 'on' }), pinned[`${type}.${theme}`]);
    const param = def.params.find((p) => p.id === 'chorus_words');
    assert.deepEqual([param.kind, param.options, param.default, param.cacheOmitDefault], ['select', ['off', 'on'], 'off', true]);
  }
}

const parts = [{ f0: 0, f1: 96, k: 'verse' }, { f0: 96, f1: 192, k: 'chorus' }, { f0: 192, f1: 288, k: 'verse' }];
const line = { start: 3, end: 9, key: 2, words: [
  { text: 'Before', start: 3, end: 3.5 }, { text: 'We', start: 4, end: 4.4 }, { text: 'ignite', start: 4.5, end: 5 },
  { text: 'this', start: 5.1, end: 5.5 }, { text: 'night', start: 5.7, end: 6.1 }, { text: 'After', start: 8, end: 8.5 }
] };
const width = (text) => metrics.textWidth('anton', text, 1);
const events = words.schedule({ lines: [line] }, parts, width);
assert.deepEqual(events.map((e) => e.text), ['WE', 'IGNITE', 'THIS', 'NIGHT']);
assert.deepEqual(events.map((e) => e.direction), [1, 2, 3, 0]);
assert.equal(events.find((e) => e.text === 'IGNITE').accent, true);
assert.ok(events.filter((e) => e.text !== 'IGNITE').every((e) => !e.accent));
assert.equal(words.wordAt({ events }, 3.99), null);
assert.equal(words.wordAt({ events }, 4).text, 'WE');
assert.equal(words.wordAt({ events }, 4.5).text, 'IGNITE');
assert.equal(words.wordAt({ events }, 6.61), null);
assert.equal(words.wordAt({ events }, 8), null);
for (const e of events) assert.ok(e.end - e.start <= 0.9 + 1e-6);
for (const texts of [['the', 'electricity', 'and'], ['die', 'Erinnerung', 'und'], ['la', 'electricidad', 'y']]) {
  assert.equal(words.keyOf({ words: texts.map((text) => ({ text })) }), 1);
}
assert.equal(words.keyOf({ words: [{ text: 'and' }, { text: 'the' }] }), -1);
assert.equal(words.keyOf({ key: 0, words: [{ text: 'and' }, { text: 'electricity' }] }), 0, 'explicit plan emphasis wins');
const unmarked = graphicsLib.normalizeGraphics({ duration: 12, cuts: [{ start: 0, end: 12 }], lines: [{ start: 4, end: 6, words: [{ text: 'the', start: 4, end: 4.5 }, { text: 'electricity', start: 4.5, end: 6 }] }] }).graphics.lines[0];
assert.equal(words.keyOf(unmarked), 1);
assert.ok(!JSON.stringify(unmarked).includes('keyMarked'));
const merged = words.schedule({ lines: [{ start: 4, end: 7, words: [
  { text: 'in', start: 4, end: 4.06 }, { text: 'a', start: 4.06, end: 4.12 }, { text: 'heartbeat', start: 4.12, end: 4.6 },
  { text: 'now', start: 5.8, end: 7 }
] }] }, parts, width);
assert.equal(merged[0].text, 'IN A HEARTBEAT');
assert.equal(merged[0].start, 4);
assert.ok(merged[0].end <= 4.9);
assert.equal(merged[0].accent, true);

// Full animation bounds, not just the final word: clipping uses the returned room, clear of every face.
for (const boxes of [[{ x0: 660, y0: 230, x1: 1260, y1: 850 }], [{ x0: 100, y0: 200, x1: 730, y1: 850 }], [{ x0: 48, y0: 280, x1: 850, y1: 840 }, { x0: 1250, y0: 280, x1: 1872, y1: 840 }]]) {
  const placed = words.placeWord(4, boxes);
  assert.ok(placed && placed.size >= words.MIN_SIZE);
  for (const b of boxes) assert.ok(!words.intersects(placed, { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 }));
  for (const e of events) for (const offset of [0, 1 / 24, 2 / 24, 0.2]) {
    const w = words.wordAt({ events }, e.start + offset, boxes);
    if (w) for (const b of boxes) assert.ok(!words.intersects(w.rect, { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 }));
  }
}
assert.equal(words.placeWord(4, [{ x0: 0, y0: 0, x1: 1920, y1: 1080 }]), null);
assert.equal(words.placeWord(100), null);
const base = { t: 4.6, devices: [{ id: 'large', type: 'display' }, { id: 'small', type: 'tag' }], karaoke: { words: ['line'] } };
assert.deepEqual(words.frameState(base, { events, parts }, []).devices.map((d) => d.id), ['small']);
assert.equal(words.frameState(base, { events, parts }, []).karaoke, null);
assert.deepEqual(words.frameState({ ...base, t: 3.5 }, { events, parts }, []).devices, base.devices);
assert.ok(words.frameState({ ...base, t: 6.8 }, { events, parts }, []).karaoke, 'karaoke returns during a gap');
assert.ok(words.frameState(base, { events, parts }, [{ x0: 0, y0: 0, x1: 1920, y1: 1080 }]).karaoke, 'skipped words do not hide karaoke');

for (const theme of ['hud', 'kuble', 'camcorder', 'zine']) {
  const graphics = graphicsLib.prepareGraphics(graphicsLib.demoGraphics({ duration: 64 }), { theme }).graphics;
  const chorus = composition.chorusPlan(graphics);
  assert.ok(chorus.events.length && chorus.parts.every((p) => p.k === 'chorus'));
  const chunk = { start: 0, duration: 24, clipSeconds: 24 };
  const html = composition.buildChunkHtml({ graphics, chunk, options: { chorus_words: 'on', karaoke: true, effects: 'off' } });
  assert.ok(Buffer.byteLength(html) < composition.MAX_HTML_BYTES);
  const page = pageSandbox(html);
  const g = page.sandbox.__HUD_DATA.graphics;
  let shown = 0;
  for (const time of [0, 1.5, 2, 4.5, 6.5, 8, 12, 16, 18, 21]) {
    const direct = page.sandbox.HudState.frameState(g, time, { karaoke: true });
    let stepped;
    for (let frame = 0; frame <= Math.round(time * 24); frame += 1) stepped = page.sandbox.HudState.frameState(g, frame / 24, { karaoke: true });
    assert.equal(JSON.stringify(direct), JSON.stringify(stepped), `${theme}: direct seeking equals stepping`);
    page.draw(time);
    if (direct.chorusWord) {
      shown += 1;
      assert.equal(page.elements['l-words'].firstElementChild.textContent, direct.chorusWord.text);
      assert.equal(page.elements['l-kar'].innerHTML, '');
      assert.equal(direct.karaoke, null);
      assert.equal(page.elements['l-words'].hidden, false);
      assert.ok(page.elements['l-words'].style.cssText.includes(direct.chorusWord.accent ? 'color:var(--acc)' : 'color:var(--word-ink'));
    }
    const isChorus = words.inPart(chorus.parts, time);
    if (isChorus) assert.ok(direct.devices.every((d) => d.type !== 'display'));
    else assert.deepEqual(Array.from(direct.devices, (d) => d.id), state.frameState(graphics, time).devices.map((d) => d.id));
  }
  assert.ok(shown > 0, `${theme}: the fixture must actually show chorus words`);
  // No word times: neither scripts nor data nor an extra layer are added, for every style and beat-effects level.
  for (const missing of ['words', 'chorus']) {
    const plain = graphicsLib.prepareGraphics({ duration: 12, cuts: [{ start: 0, end: 12, subject: 'none' }], lines: missing === 'words' ? [] : Array.from({ length: 12 }, (_, i) => ({ start: i, end: i + 0.8, words: [{ text: `unique${i}`, start: i, end: i + 0.8 }] })) }, { theme }).graphics;
    assert.equal(composition.chorusPlan(plain).events.length, 0);
    for (const effects of ['off', 'strong']) {
      const args = { graphics: plain, chunk: { start: 0, duration: 12, clipSeconds: 12 }, options: { effects } };
      assert.equal(composition.buildChunkHtml({ ...args, options: { effects, chorus_words: 'on' } }), composition.buildChunkHtml(args));
    }
  }
}

// Measured tracks are also sent to chunks without tags. Middle and side faces stay clear in the actual page adapter.
const targets = require('../lib/music-video-hud/targets');
for (const x of [960, 1400]) {
  const lines = Array.from({ length: 12 }, (_, i) => ({ start: i * 2, end: i * 2 + 1.8, key: 1,
    words: ['we', 'ignite', 'tonight'].map((text, j) => ({ text, start: i * 2 + 0.2 + j * 0.5, end: i * 2 + 0.7 + j * 0.5 })) }));
  const g = graphicsLib.prepareGraphics({ duration: 24, lines, cuts: [{ start: 0, end: 24, kind: 'performance', framing: 'MS', subject: x === 960 ? 'center' : 'right' }] }).graphics;
  g.cuts[0].faces = { x0: x, x1: x, s: 135 };
  g.faces = { step: 6, points: Array.from({ length: 96 }, (_, i) => [i * 6, x, 400, 135, 0]) };
  const args = { graphics: g, options: { chorus_words: 'on', karaoke: true } };
  const a = pageSandbox(composition.buildChunkHtml({ ...args, chunk: { start: 0, duration: 16, clipSeconds: 16 } }));
  const b = pageSandbox(composition.buildChunkHtml({ ...args, chunk: { start: 8, duration: 16, clipSeconds: 16 } }));
  assert.ok(a.sandbox.__HUD_DATA.graphics.faces.points.length > 0);
  let shown = 0;
  for (let f = 8 * 24; f < 16 * 24; f += 1) {
    const t = f / 24;
    const direct = a.sandbox.HudState.frameState(a.sandbox.__HUD_DATA.graphics, t);
    const other = b.sandbox.HudState.frameState(b.sandbox.__HUD_DATA.graphics, t);
    assert.equal(JSON.stringify(direct.chorusWord), JSON.stringify(other.chorusWord), 'word state crosses chunk seams unchanged');
    if (!direct.chorusWord) continue;
    shown += 1;
    const face = targets.boxOf(targets.faceAt(g.faces, g.cuts[0], f), 'face', direct.camera);
    assert.ok(!words.intersects(direct.chorusWord.rect, { x: face.x0, y: face.y0, w: face.x1 - face.x0, h: face.y1 - face.y0 }));
    if (x === 1400) assert.ok(direct.chorusWord.rect.x + direct.chorusWord.rect.w < face.x0, 'a face on the right sends words to the free left side');
  }
  assert.ok(shown > 0);
  // A footage-copy effect hides the word, but karaoke remains visible when no word is drawn.
  a.sandbox.__HUD_FX = { copies: [{ f: 8 * 24, n: 24, m: 8 * 24, r: 0.1, s: 'plain' }] };
  const copied = a.sandbox.HudState.frameState(a.sandbox.__HUD_DATA.graphics, 8.4);
  assert.equal(copied.chorusWord, null);
  assert.ok(copied.karaoke);
}

const sandbox = { window: { I18N: {} } };
vm.runInNewContext(fs.readFileSync(require('path').join(__dirname, '../public/nodes/i18n-nodes.js'), 'utf8'), sandbox);
for (const lang of ['de', 'en', 'es']) {
  for (const key of ['nodes.option.camcorder', 'nodes.param.chorus_words', 'nodes.option.on', 'nodes.option.off', 'nodes.paramhint.music_video.hud_render.chorus_words']) assert.ok(sandbox.window.I18N[lang][key], `${lang}: ${key}`);
}
console.log('test-music-video-hud-chorus.js: ok');
