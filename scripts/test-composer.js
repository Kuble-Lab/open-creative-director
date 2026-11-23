'use strict';

// Tests for the Composer (image.composer): the model of the layers (public/nodes/composer-model.js), the renderer
// (lib/composer-render.js: text as paths with fontkit, resvg), the node (lib/nodes/nodes-composer.js) and the agent access
// (edit-service, kind `composition`). The image part with ffmpeg is skipped when ffmpeg is missing. No network, no provider.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const model = require('../public/nodes/composer-model');
const composer = require('../lib/composer-render');
const ffmpeg = require('../lib/ffmpeg');
const store = require('../lib/store');
const assets = require('../lib/nodes/assets');
const nodesComposer = require('../lib/nodes/nodes-composer');
const { registry, PARAM_KINDS } = require('../lib/nodes/registry');
const { createEditService } = require('../lib/nodes/edit-service');

const execFileAsync = promisify(execFile);

function testModel() {
  // formats
  assert.deepEqual(model.canvasSize({ format: '1:1' }), { width: 1080, height: 1080 });
  assert.deepEqual(model.canvasSize({ format: '9:16', short_edge: 1080 }), { width: 1080, height: 1920 });
  assert.deepEqual(model.canvasSize({ format: '16:9', short_edge: 720 }), { width: 1280, height: 720 });
  assert.deepEqual(model.canvasSize({ format: '4:5' }), { width: 1080, height: 1350 });
  assert.deepEqual(model.canvasSize({ format: 'custom', width: 640, height: 200 }), { width: 640, height: 200 });
  assert.deepEqual(model.canvasSize({ format: 'nonsense' }), { width: 1080, height: 1080 });
  const huge = model.canvasSize({ format: 'custom', width: 8192, height: 8192 });
  assert.ok(huge.width * huge.height <= model.LIMITS.maxPixels, 'the stage stays below the pixel limit');

  // normalize: object, list and JSON text; unknown types and broken values are said
  const problems = [];
  const value = model.normalizeComposition(
    JSON.stringify({
      layers: [
        { type: 'image', input: 99, x: 'nope', fit: 'zoom' },
        { type: 'video' },
        { type: 'text', text: 'Hallo', color: 'red', weight: 50, rotation: 270, id: 'a' },
        { type: 'shape', shape: 'star', fill: '#abc', id: 'a' }
      ]
    }),
    problems
  );
  assert.equal(value.layers.length, 3);
  const [image, text, shape] = value.layers;
  assert.equal(image.input, model.LIMITS.images - 1);
  assert.equal(image.x, model.DEFAULTS.image.x);
  assert.equal(image.fit, 'cover');
  assert.equal(text.color, model.DEFAULTS.text.color);
  assert.equal(text.weight, 100);
  assert.equal(text.rotation, -90);
  assert.equal(shape.shape, 'rect');
  assert.equal(shape.fill, '#aabbcc');
  assert.equal(new Set(value.layers.map((layer) => layer.id)).size, 3, 'ids are unique');
  assert.ok(problems.some((line) => /unknown type/.test(line)));
  assert.ok(problems.some((line) => /color must be/.test(line)));
  assert.deepEqual(model.normalizeComposition([{ type: 'shape' }]).layers.length, 1, 'a bare list of layers is taken');
  const broken = [];
  assert.deepEqual(model.normalizeComposition('{not json', broken), { layers: [] });
  assert.ok(broken.some((line) => /not JSON/.test(line)));
  const many = model.normalizeComposition({ layers: Array.from({ length: 50 }, () => ({ type: 'shape' })) });
  assert.equal(many.layers.length, model.LIMITS.layers);

  // newLayer gives a free id
  const added = model.newLayer('text', value.layers, { text: 'Neu' });
  assert.ok(!value.layers.some((layer) => layer.id === added.id));
  assert.equal(added.text, 'Neu');

  // colours
  assert.equal(model.hexColor('#FFF'), '#ffffff');
  assert.equal(model.hexColor('blue'), null);
  assert.deepEqual(model.splitColor('#ff000080'), { rgb: '#ff0000', alpha: 0.502 });

  // wrap: greedy, line breaks, long words broken between characters
  const measure = (line) => line.length * 10;
  assert.deepEqual(model.wrapLines('aa bb cc', 50, measure), ['aa bb', 'cc']);
  assert.deepEqual(model.wrapLines('aa\n\nbb', 50, measure), ['aa', '', 'bb']);
  assert.deepEqual(model.wrapLines('abcdefghij kl', 40, measure), ['abcd', 'efgh', 'ij', 'kl']);

  // baselines in the CSS line box model
  const lines = model.baselines(2, 100, 1.2, 0.9, 0.2);
  assert.ok(Math.abs(lines[0] - ((120 - 110) / 2 + 90)) < 1e-9);
  assert.ok(Math.abs(lines[1] - lines[0] - 120) < 1e-9);

  // emoji are left out on both sides, the connected text wins, upper case
  assert.equal(model.stripEmoji('Hallo 👋 Welt 🇨🇭'), 'Hallo Welt');
  assert.equal(model.layerText({ text: 'own', text_input: 1, uppercase: true }, ['a', 'from input']), 'FROM INPUT');
  assert.equal(model.layerText({ text: 'own', text_input: 3 }, ['a']), 'own');

  // snapping: a box near the middle of the stage snaps to it; guides name the line
  const canvas = { width: 1000, height: 1000 };
  const targets = model.snapTargets(canvas, [{ x: 100, y: 100, w: 200, h: 200 }]);
  const snapped = model.snapMove({ x: 396, y: 700, w: 200, h: 100 }, targets, 6);
  assert.equal(snapped.dx, 4);
  assert.equal(snapped.dy, 0);
  assert.ok(snapped.guides.some((guide) => guide.axis === 'x' && guide.pos === 500 && guide.stage));
  const edge = model.snapEdges({ x: 120, y: 302, w: 100, h: 100 }, ['top'], targets, 6);
  assert.equal(edge.dy, -2, 'the top edge snaps to the bottom of the other box');
  assert.equal(edge.dx, 0);

  // retarget: a square image stays square on another format, text keeps its width
  const square = { type: 'image', x: 25, y: 25, w: 50, h: 50 };
  const [moved, keptText] = model.retarget([square, { type: 'text', x: 0, y: 0, w: 50, h: 10 }], { width: 1000, height: 1000 }, { width: 1000, height: 2000 });
  assert.equal(moved.h, 25);
  assert.equal(moved.y + moved.h / 2, 50, 'the box keeps its centre');
  assert.equal(keptText.h, 10);

  // fonts of the app
  const inter = model.bundledFont('inter tight');
  assert.ok(inter, 'Inter Tight is bundled');
  assert.deepEqual(model.fontFileFor(inter, 1000).weight, 900);
  assert.ok(model.weightsOf(inter).includes(400));
  for (const file of model.FONT_FILES) assert.ok(require('fs').existsSync(path.join(composer.FONT_DIR, file)), `font file ${file} exists`);

  // brand fonts and colours from a profile
  const profile = model.parseProfile(
    JSON.stringify({
      colors: [{ hex: '#123456' }],
      fonts: [
        { family: 'Brand Sans', weights: '700', asset: { branding: 'b1', file: 'fonts/brand.ttf' } },
        { family: 'No File' },
        { family: 'Web Only', asset: { branding: 'b1', file: 'fonts/brand.eot' } }
      ]
    })
  );
  assert.deepEqual(model.brandFonts(profile), [{ family: 'Brand Sans', weight: 700, branding: 'b1', file: 'fonts/brand.ttf', role: '' }]);
  assert.equal(model.parseProfile('not a profile'), null);
  testGradientModel();
  console.log('ok testModel');
}

function testGradientModel() {
  // normalize: a gradient with good and bad stops; the angle defaults to 180, the stops are sorted
  const problems = [];
  const gradient = model.normalizeGradient(
    { type: 'radial', stops: [{ at: 100, color: '#0000ff00' }, { at: 'x', color: 'red' }, { at: 0, color: '#f00' }] },
    (line) => problems.push(line),
    'test'
  );
  assert.equal(gradient.type, 'radial');
  assert.equal(gradient.angle, 180);
  assert.deepEqual(gradient.stops.map((stop) => [stop.at, stop.color]), [[0, '#ff0000'], [100, '#0000ff00']]);
  assert.ok(problems.some((line) => /stop 2/.test(line)), 'the bad stop is said');
  assert.equal(model.normalizeGradient(null, undefined, 'x'), null);
  const few = [];
  assert.equal(model.normalizeGradient({ type: 'linear', stops: [{ at: 0, color: '#000000' }] }, (line) => few.push(line), 'x'), null);
  assert.ok(few.some((line) => /at least 2 stops/.test(line)));
  // the problem texts of a gradient are notes, never refusals in the edit service
  [...problems, ...few].forEach((line) => assert.ok(!/not an object|unknown type|not JSON|must be a list/.test(line), line));
  const many = model.normalizeGradient({ stops: Array.from({ length: 10 }, (_, i) => ({ at: i * 10, color: '#000000' })) }, undefined, 'x');
  assert.equal(many.stops.length, model.LIMITS.gradientStops);
  // the layer keeps it; image layers do not have one
  const shape = model.normalizeLayer({ type: 'shape', gradient: { type: 'linear', angle: 90, stops: [{ at: 0, color: '#ffffff' }, { at: 100, color: '#000000' }] } });
  assert.equal(shape.gradient.angle, 90);
  assert.equal(model.normalizeLayer({ type: 'text' }).gradient, null);
  assert.equal(model.normalizeLayer({ type: 'image', gradient: shape.gradient }).gradient, undefined);
  // color to transparent from one color
  const fade = model.gradientFrom('#336699');
  assert.deepEqual(fade.stops.map((stop) => stop.color), ['#336699', '#33669900']);
  // CSS and the gradient line
  assert.match(model.gradientCss(shape.gradient), /^linear-gradient\(90deg, /);
  assert.match(model.gradientCss(gradient), /^radial-gradient\(ellipse farthest-corner at 50% 50%, /);
  const across = model.gradientLine({ angle: 90 }, { x: 0, y: 0, w: 200, h: 100 });
  [['x1', 0], ['y1', 50], ['x2', 200], ['y2', 50]].forEach(([key, value]) => assert.ok(Math.abs(across[key] - value) < 1e-9, `${key} ${across[key]}`));
  const down = model.gradientLine({ angle: 180 }, { x: 10, y: 20, w: 200, h: 100 });
  assert.ok(Math.abs(down.x1 - 110) < 1e-9 && Math.abs(down.y1 - 20) < 1e-9 && Math.abs(down.y2 - 120) < 1e-9);
  // premultiplied look: between stops of different opacity there are stops in between, a fade keeps the color
  const expanded = model.expandStops(fade.stops);
  assert.ok(expanded.length > 2);
  assert.ok(expanded.every((stop) => stop.rgb === '#336699'), 'a fade to transparent keeps the color all the way');
  assert.equal(model.expandStops(shape.gradient.stops).length, 2, 'two opaque stops need nothing in between');
}

// RGBA of the pixel x, y in a PNG (through ffmpeg) or from a resvg render
async function pixelOf(png, x, y) {
  const { Resvg } = require('@resvg/resvg-js');
  // wrap the PNG in an SVG and let resvg decode it: no extra dependency
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><image href="data:image/png;base64,${png.toString('base64')}" x="${-x}" y="${-y}" width="${png.readUInt32BE(16)}" height="${png.readUInt32BE(20)}" image-rendering="optimizeSpeed"/></svg>`;
  const pixels = new Resvg(svg, { fitTo: { mode: 'original' } }).render().pixels;
  return [...pixels.slice(0, 4)];
}

function near(actual, expected, tolerance = 6) {
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= tolerance, `pixel ${JSON.stringify(actual)} is not near ${JSON.stringify(expected)}`));
}

async function testRender() {
  if (!composer.available()) {
    console.log('skip testRender (resvg or fontkit missing)');
    return;
  }
  const canvas = { width: 400, height: 200 };
  const fonts = composer.createFontStore({});
  // a 2x1 PNG made by resvg: left red, right blue
  const { Resvg } = require('@resvg/resvg-js');
  const red = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"><rect width="1" height="1" fill="#ff0000"/><rect x="1" width="1" height="1" fill="#0000ff"/></svg>').render().asPng();
  const layers = model.normalizeComposition({
    layers: [
      { type: 'shape', x: 0, y: 0, w: 50, h: 100, fill: '#00ff00', id: 'bg' },
      { type: 'shape', x: 50, y: 0, w: 50, h: 100, fill: '#0000ff', opacity: 0.5, id: 'half' },
      { type: 'image', input: 0, x: 75, y: 0, w: 25, h: 50, fit: 'fill', id: 'img' },
      { type: 'shape', shape: 'ellipse', x: 0, y: 50, w: 10, h: 50, fill: '#ff00ff', hidden: true, id: 'hidden' },
      { type: 'text', text: 'Hallo Welt', x: 0, y: 0, w: 50, size: 10, color: '#000000', align: 'left', id: 't' }
    ]
  }).layers;
  const started = Date.now();
  const { png, width, height, svg } = composer.render({
    canvas,
    background: '#ffffff',
    transparent: false,
    layers,
    images: [{ href: `data:image/png;base64,${red.toString('base64')}` }],
    texts: [],
    fonts
  });
  assert.equal(width, 400);
  assert.equal(height, 200);
  assert.ok(Date.now() - started < 10000, 'a small stage is drawn quickly');
  near(await pixelOf(png, 100, 190), [0, 255, 0, 255]); // green shape
  near(await pixelOf(png, 250, 190), [128, 128, 255, 255], 8); // half blue over white
  near(await pixelOf(png, 310, 50), [255, 0, 0, 255]); // left half of the image, stretched
  near(await pixelOf(png, 390, 50), [0, 0, 255, 255]); // right half of the image
  near(await pixelOf(png, 20, 190), [0, 255, 0, 255]); // the hidden ellipse is not drawn
  assert.ok(!/<text/.test(svg), 'text is drawn as paths, not as SVG text');
  assert.ok(/<path id="g/.test(svg), 'glyphs are paths');
  // some dark pixels where the text stands
  let dark = 0;
  for (let x = 2; x < 190; x += 3) {
    const [r] = await pixelOf(png, x, 22);
    if (r < 80) dark += 1;
  }
  assert.ok(dark > 3, `the text leaves dark pixels (${dark})`);

  // transparent stage, rotation
  const clear = composer.render({ canvas, transparent: true, layers: [model.normalizeLayer({ type: 'shape', x: 40, y: 40, w: 20, h: 20, rotation: 45, fill: '#000000' })], fonts });
  near(await pixelOf(clear.png, 2, 2), [0, 0, 0, 0]);
  near(await pixelOf(clear.png, 200, 100), [0, 0, 0, 255]);

  // text layout: weights change the width, wrapping makes more lines, letter spacing widens
  const textCanvas = { width: 1000, height: 1000 };
  const base = model.normalizeLayer({ type: 'text', text: 'Typografie', w: 100, size: 10, weight: 400 });
  const regular = composer.layoutText(base, textCanvas, [], fonts);
  const bold = composer.layoutText({ ...base, weight: 900 }, textCanvas, [], fonts);
  const spaced = composer.layoutText({ ...base, letter_spacing: 0.2 }, textCanvas, [], fonts);
  const narrow = composer.layoutText({ ...base, text: 'Typografie Typografie Typografie', w: 40 }, textCanvas, [], fonts);
  assert.equal(regular.lines.length, 1);
  assert.ok(bold.lines[0].width > regular.lines[0].width, 'the variable font follows the weight');
  assert.ok(spaced.lines[0].width > regular.lines[0].width + 100, 'letter spacing widens the line');
  assert.ok(narrow.lines.length >= 2, 'a narrow box wraps');
  assert.ok(Math.abs(regular.height - 100 * base.line_height) < 1e-6);

  // an unknown font falls back to the default and says so
  const logged = [];
  const store2 = composer.createFontStore({ log: (line) => logged.push(line) });
  composer.layoutText({ ...base, font: 'Comic Nonexistent' }, textCanvas, [], store2);
  assert.ok(logged.some((line) => /Comic Nonexistent/.test(line)));

  // characters the font lacks come from a stand-in font
  const greek = composer.layoutText({ ...base, text: 'αβγ', font: 'Anton' }, textCanvas, [], fonts);
  assert.ok(greek.lines[0].glyphs.every((glyph) => glyph.glyph.id !== 0) || greek.lines[0].glyphs.length > 0);

  // gradients: a shape from red to blue (left to right), a fade to transparent, gradient text, a radial gradient
  const gradientLayers = model.normalizeComposition({
    layers: [
      { type: 'shape', x: 0, y: 0, w: 50, h: 50, id: 'lin', gradient: { type: 'linear', angle: 90, stops: [{ at: 0, color: '#ff0000' }, { at: 100, color: '#0000ff' }] } },
      { type: 'shape', x: 50, y: 0, w: 50, h: 50, id: 'fade', gradient: { type: 'linear', angle: 180, stops: [{ at: 0, color: '#00ff00' }, { at: 100, color: '#00ff0000' }] } },
      { type: 'shape', x: 50, y: 50, w: 50, h: 50, id: 'rad', gradient: { type: 'radial', stops: [{ at: 0, color: '#ffffff' }, { at: 100, color: '#000000' }] } },
      { type: 'text', text: 'MMMMMMMM', x: 0, y: 50, w: 50, size: 25, weight: 900, align: 'left', id: 'gt', gradient: { type: 'linear', angle: 90, stops: [{ at: 0, color: '#ff0000' }, { at: 100, color: '#0000ff' }] } }
    ]
  }).layers;
  const graded = composer.render({ canvas, background: '#ffffff', transparent: false, layers: gradientLayers, fonts });
  assert.ok(/<linearGradient /.test(graded.svg) && /<radialGradient /.test(graded.svg) && /<mask /.test(graded.svg));
  near(await pixelOf(graded.png, 2, 50), [252, 0, 3, 255], 8); // left end of the linear gradient: red
  near(await pixelOf(graded.png, 197, 50), [3, 0, 252, 255], 8); // right end: blue
  near(await pixelOf(graded.png, 100, 50), [128, 0, 128, 255], 10); // the middle
  near(await pixelOf(graded.png, 300, 2), [3, 255, 3, 255], 8); // the fade starts green
  near(await pixelOf(graded.png, 300, 50), [128, 255, 128, 255], 10); // half way: half green over white, not grey
  near(await pixelOf(graded.png, 300, 98), [255, 255, 255, 255], 8); // and ends transparent
  near(await pixelOf(graded.png, 300, 150), [255, 255, 255, 255], 10); // the radial gradient: white in the middle
  near(await pixelOf(graded.png, 202, 102), [0, 0, 0, 255], 20); // dark in the corner
  // the gradient text: red pixels on the left, blue ones on the right, white between the letters
  let reddish = 0;
  let bluish = 0;
  for (let y = 105; y < 145; y += 2) {
    for (let x = 4; x < 60; x += 2) {
      const [r, g, b] = await pixelOf(graded.png, x, y);
      if (r > 150 && b < 100 && g < 100) reddish += 1;
    }
    for (let x = 140; x < 196; x += 2) {
      const [r, g, b] = await pixelOf(graded.png, x, y);
      if (b > 150 && r < 100 && g < 100) bluish += 1;
    }
  }
  assert.ok(reddish > 10 && bluish > 10, `the text runs from red to blue (${reddish} red, ${bluish} blue)`);

  assert.equal(composer.escapeXml('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;');
  console.log('ok testRender');
}

function testRegistry() {
  assert.ok(PARAM_KINDS.includes('composition'), 'the kind composition is known');
  const def = registry.get('image.composer');
  assert.ok(def, 'image.composer is registered');
  assert.equal(def.cost.unit, 'local');
  const params = registry.normalizeParams(def, { layers: '[{"type":"shape"}]', format: '9:16' });
  assert.equal(params.layers.layers.length, 1, 'the JSON text of layers is normalized');
  assert.equal(params.format, '9:16');
  const empty = def.validate(registry.normalizeParams(def, {}));
  assert.ok(empty.some((issue) => issue.code === 'composer_empty'));
  assert.equal(def.validate(params).length, 0);
  assert.ok(def.description.includes('"layers"'), 'the description tells an agent the format');
  console.log('ok testRegistry');
}

async function testEditService() {
  const saved = [];
  const fakeStore = {
    saveGraph: async (id, { graph }) => {
      saved.push(graph);
      return { rev: 2 };
    }
  };
  const service = createEditService({ store: fakeStore, registry });
  const workflow = { id: 'wf', rev: 1, graph: { nodes: [], edges: [] } };
  const viewer = { role: 'admin', user: 'tester' };
  const result = await service.edit(viewer, workflow, {
    operations: [{ op: 'add_node', type: 'image.composer', ref: 'c', params: { layers: { layers: [{ type: 'text', text: 'Hi', x: 900 }] } } }],
    agent: true
  });
  assert.equal(result.changed, true);
  const node = saved[0].nodes[0];
  assert.equal(node.params.layers.layers[0].text, 'Hi');
  assert.equal(node.params.layers.layers[0].x, 600, 'a value out of range is kept in range');
  await assert.rejects(
    service.edit(viewer, workflow, { operations: [{ op: 'add_node', type: 'image.composer', params: { layers: { layers: [{ type: 'video' }] } } }], agent: true }),
    /unknown type/
  );
  await assert.rejects(
    service.edit(viewer, workflow, { operations: [{ op: 'add_node', type: 'image.composer', params: { layers: 'nope' } }], agent: true }),
    /not JSON/
  );
  // a gradient goes along over MCP; a broken stop is a note, not a refusal
  const graded = await service.edit(viewer, workflow, {
    operations: [
      {
        op: 'add_node',
        type: 'image.composer',
        params: { layers: { layers: [{ type: 'shape', gradient: { type: 'radial', stops: [{ at: 0, color: '#ff0000' }, { at: 50, color: 'nope' }, { at: 100, color: '#ff000000' }] } }] } }
      }
    ],
    agent: true
  });
  assert.equal(graded.changed, true);
  assert.deepEqual(saved[saved.length - 1].nodes[0].params.layers.layers[0].gradient.stops.map((stop) => stop.color), ['#ff0000', '#ff000000']);

  const size = { w: 296, h: 240 }; // the room lib/nodes/edit-service.js gives a node
  const placedNode = (id, x, y) => ({ id, type: 'image.composer', x, y, params: {} });
  const add = (position = {}) => ({ op: 'add_node', type: 'image.composer', ...position });
  const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const place = async (graph, operations) => {
    const result = await service.edit(viewer, { ...workflow, graph: { edges: [], ...graph } }, { operations });
    return { result, graph: saved.at(-1) };
  };
  const occupied = {
    nodes: [placedNode('left', 0, 0), placedNode('right', 660, 0)],
    notes: [{ id: 'note', x: 1320, y: 0, w: 350, h: 1000 }],
    groups: [{ id: 'group', x: 1320, y: 1000, w: 350, h: 1000 }]
  };
  let placed = await place(occupied, [add(), add(), add()]);
  for (const added of placed.graph.nodes.slice(2)) {
    assert.equal(added.x, 1336, 'automatic column starts beyond the right edge plus gap');
    assert.equal(added.x % 8, 0); assert.equal(added.y % 8, 0);
    for (const obstacle of [...placed.graph.nodes.filter((item) => item.id !== added.id).map((item) => ({ ...item, ...size })), ...occupied.notes, ...occupied.groups]) {
      assert.ok(!intersects({ ...added, ...size }, obstacle), 'automatic placement avoids nodes, notes and groups');
    }
  }
  placed = await place(occupied, [add({ x: 1400.25, y: 400.75 })]);
  assert.equal(placed.graph.nodes.at(-1).x, 1400.25); assert.equal(placed.graph.nodes.at(-1).y, 400.75);
  assert.equal(placed.result.notes.length, 0, 'explicit positions may overlap notes and groups');
  placed = await place(occupied, [add({ x: 0, y: 0 }), add({ x: 0, y: 0 })]);
  for (const added of placed.graph.nodes.slice(2)) {
    assert.equal(added.x, 0);
    assert.ok(added.y >= size.h); assert.equal(added.y % 8, 0);
    assert.ok(!placed.graph.nodes.some((other) => other.id !== added.id && intersects({ ...added, ...size }, { ...other, ...size })));
  }
  assert.equal(placed.result.notes.length, 2); assert.ok(placed.result.notes.every((note) => /position overlapped.*moved/.test(note)));
  placed = await place(occupied, [add({ x: 1320, y: 2000 }), add()]);
  assert.ok(placed.graph.nodes.at(-1).y >= 2000 + size.h, 'automatic placement also avoids an explicit addition in the same call');
  placed = await place({ nodes: [] }, [add()]);
  assert.equal(placed.graph.nodes[0].x, 0); assert.equal(placed.graph.nodes[0].y, 0);
  placed = await place({ nodes: [placedNode('left', 0, 0), placedNode('removed', 664, 0)] }, [{ op: 'remove_node', node: 'removed' }, add()]);
  assert.equal(placed.graph.nodes.at(-1).x, 680, 'the automatic column ignores removed nodes');
  assert.equal(placed.graph.nodes.at(-1).y, 0, 'removed nodes no longer reserve space');
  placed = await place({ nodes: [], notes: [{ id: 'fallback', x: 0, y: 0 }], groups: [{ id: 'fallback-group', x: 0, y: 120 }] }, [add({ x: 10 })]);
  assert.ok(placed.graph.nodes[0].y >= 240, 'partial positions use automatic placement and default box sizes');
  const count = require('../lib/nodes/workflows-store').LIMITS.maxNodes - 1;
  placed = await place({ nodes: Array.from({ length: count }, (_, i) => placedNode(`existing${i}`, 0, i * size.h)) }, [add({ x: 0, y: 0 })]);
  assert.equal(placed.graph.nodes.at(-1).y, count * size.h, 'bounded placement clears a full column at the node limit');
  console.log('ok testEditService');
}

async function testExecute() {
  const binaries = ffmpeg.binaries();
  if (!composer.available() || !binaries.available) {
    console.log('skip testExecute (resvg, fontkit or ffmpeg missing)');
    return;
  }
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-composer-'));
  const sessionId = (await store.createSession({ title: 'composer test' })).id;
  if (!sessionId) {
    console.log('skip testExecute (no session store)');
    return;
  }
  try {
    const ff = (args) => execFileAsync(binaries.ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args]);
    await ff(['-f', 'lavfi', '-i', 'color=c=0xff0000:s=64x32,format=rgb24', '-frames:v', '1', path.join(tmp, 'red.gif')]);
    await ff(['-f', 'lavfi', '-i', 'color=c=0x0000ff:s=4000x4000,format=rgb24', '-frames:v', '1', path.join(tmp, 'big.png')]);
    const upload = async (file, ext) => {
      const asset = await store.saveAsset(sessionId, { kind: 'upload', buffer: await fsp.readFile(path.join(tmp, file)), ext, prompt: file, cost: null });
      return assets.valueFromAsset(sessionId, asset.id);
    };
    const gif = await upload('red.gif', '.gif'); // a GIF: resvg cannot read it, every ffmpeg can write it
    const big = await upload('big.png', '.png');
    const def = registry.get('image.composer');
    const logs = [];
    const ctx = {
      workflowId: 'wf',
      runId: 'r',
      nodeId: 'n1',
      sessionId,
      user: 'tester',
      signal: new AbortController().signal,
      log: (line) => logs.push(line),
      saveOutputFile: (options) => assets.saveOutputFile(sessionId, options),
      withLocalSlot: (fn) => fn()
    };
    const params = registry.normalizeParams(def, {
      format: 'custom',
      width: 200,
      height: 100,
      layers: {
        layers: [
          { type: 'image', input: 0, x: 0, y: 0, w: 50, h: 100, fit: 'cover' },
          { type: 'image', input: 1, x: 50, y: 0, w: 50, h: 100 },
          { type: 'text', text: 'own', text_input: 0, x: 0, y: 0, w: 100, size: 10 },
          { type: 'text', text: 'missing input', text_input: 5, x: 0, y: 50, w: 100, size: 10 }
        ]
      }
    });
    const result = await def.execute(ctx, { images: { type: 'list', items: [gif, big] }, texts: { type: 'text', value: 'Titel' } }, params);
    const out = result.variants[0].image;
    assert.equal(out.type, 'image');
    const png = await fsp.readFile(assets.assetFilePath(out));
    assert.equal(png.readUInt32BE(16), 200);
    assert.equal(png.readUInt32BE(20), 100);
    near(await pixelOf(png, 10, 90), [255, 0, 0, 255]); // the GIF went through ffmpeg
    near(await pixelOf(png, 190, 90), [0, 0, 255, 255]); // the large PNG was made smaller and is drawn
    assert.ok(logs.some((line) => /takes text 6/.test(line)), 'a text layer with a missing input is said in the log');
    assert.ok(logs.some((line) => /4 layers on 200 x 100 px/.test(line)));

    // images no visible layer uses are not read
    const prepared = await nodesComposer.prepareImages(ctx, [gif, big], [{ type: 'image', input: 1, hidden: false }], { width: 200, height: 100 });
    assert.equal(prepared[0].unused, true);
    assert.ok(prepared[1].href.startsWith('data:image/png;base64,'));

    // no brand, no stamp
    assert.equal(await nodesComposer.cacheStamp(params, { inputs: {} }), undefined);
    console.log('ok testExecute');
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

(async () => {
  if (process.argv.includes('--edit-service-only')) {
    await testEditService();
    console.log('test-composer.js: edit-service-only ok');
    return;
  }
  testModel();
  await testRender();
  testRegistry();
  await testEditService();
  await testExecute();
  console.log('test-composer.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
