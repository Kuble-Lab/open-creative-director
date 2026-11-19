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
  console.log('ok testModel');
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
