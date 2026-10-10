'use strict';

// The figure Claudia with her official images (WP50): the character sheet of the HUD music video gets three official images of claudia.gallery as references
// when the figure is Claudia. What is covered (no network, nothing paid):
//   - the images: in the repository, JPEG (the image pipeline takes PNG, JPEG and WebP; JPEG goes to every model), big enough for the face, small (at most
//     about 600 KB together), and the README beside them with the ID, the URL, the date of the retrieval, the credit and the terms of the site
//   - which figure gets them: the canon text of Claudia (the default of the templates) and a figure named Claudia with her bob and streak; another figure never
//   - the prompt of the sheet: with the images it says what they fix (face, hair, streak, star clip, microphone), the adult age and that clothes and light come
//     from the text; without images it is the prompt of before, byte for byte
//   - the keys of the saved workflows: a workflow made from a template of main (before WP50) keeps the cache key of every node, so a deploy makes nothing paid
//     run again; a new workflow from the templates of now differs only in the planner (the switch "official images") and the sheet (the images as input)
//   - the templates: the switch on, the images go from the planner to the sheet, the form is the one of before

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const figures = require('../lib/music-video-hud/figures');
const hudPlan = require('../lib/music-video-hud/plan');
const { registry } = require('../lib/nodes/registry');
const engine = require('../lib/nodes/engine');
const types = require('../lib/nodes/types');
const hudNodes = require('../lib/nodes/nodes-music-video-hud');

const HUD_TEMPLATES = ['music-video-hud', 'music-video-hud-elevenlabs', 'music-video-hud-suno'];
const templateDoc = (id) => JSON.parse(fs.readFileSync(path.join(root, 'lib', 'nodes', 'templates', `${id}.json`), 'utf8'));
const CLAUDIA_TEXT = templateDoc('music-video-hud').graph.nodes.find((node) => node.id === 'n4').params.figure;

// The size of a JPEG from its SOF marker.
function jpegSize(buffer) {
  assert.ok(buffer[0] === 0xff && buffer[1] === 0xd8, 'a JPEG file');
  let at = 2;
  while (at < buffer.length) {
    if (buffer[at] !== 0xff) throw new Error('bad JPEG marker');
    const marker = buffer[at + 1];
    const length = buffer.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { height: buffer.readUInt16BE(at + 5), width: buffer.readUInt16BE(at + 7) };
    at += 2 + length;
  }
  throw new Error('no SOF marker');
}

function testImages() {
  const files = figures.referenceFiles('claudia');
  assert.deepEqual(files.map((file) => file.id), ['ev-14-dist.dist-cu.2', 'ev-17-merge.tag-to-lens.1', 'ev-01.lead-black-face.3'], 'two photographs and face sheet 3');
  let total = 0;
  for (const file of files) {
    const buffer = fs.readFileSync(file.path);
    total += buffer.length;
    const size = jpegSize(buffer);
    assert.ok(size.width >= 1000 && size.height >= 560, `${file.id}: big enough for the face (${size.width} x ${size.height})`);
    assert.ok(buffer.length < 250 * 1024, `${file.id}: ${buffer.length} bytes`);
    assert.equal(path.extname(file.path), '.jpg');
    assert.match(file.url, /^https:\/\/claudia\.gallery\/i\/[a-z0-9.-]+\/$/);
  }
  assert.ok(total <= 600 * 1024, `all three together ${total} bytes, at most about 600 KB`);
  assert.deepEqual(figures.referenceFiles('nobody'), []);
  assert.equal(figures.MAX_REFERENCES, 3);
  // nothing in the folder that the README does not name
  const dir = path.join(root, 'lib', 'music-video-hud', 'figures', 'claudia');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['README.md', ...files.map((file) => path.basename(file.path))].sort());
  // the README: every image with its ID, page and source file, the date, the credit and the terms of the site in its own words
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  for (const file of files) {
    assert.ok(readme.includes(`\`${path.basename(file.path)}\``) && readme.includes(`\`${file.id}\``) && readme.includes(file.url), `the README names ${file.id}`);
  }
  for (const source of ['/img/ev-14-dist/dist-cu-2.m.webp', '/img/ev-17-merge/tag-to-lens-1.m.webp', '/img/ev-01/lead-black-face-3.m.webp']) assert.ok(readme.includes(`https://claudia.gallery${source}`), source);
  assert.match(readme, /Retrieved on 2026-10-10/);
  assert.match(readme, /\*\*Claudia by anabology\*\*/);
  assert.match(readme, /Use the images on this\n> site as references, as image prompts, or as material\. You don't need to ask\. A credit \("Claudia by anabology"\) is appreciated, not\n> required\./);
  assert.match(readme, /\*\*Make her an adult, always\.\*\* She is in her late twenties\. Nothing that reads under-age, and nothing explicit\./);
  assert.match(readme, /\*\*Say what's generated\.\*\*/);
  assert.match(readme, /not affiliated with or endorsed by Anthropic/);
  assert.match(readme, /https:\/\/claudia\.gallery\/use\.md/);
  assert.match(readme, /Midjourney v8\.2 \(AI-generated\)/);
}

function testWhoGetsThem() {
  const of = (text) => figures.figureOf(hudPlan.parseFigure(text));
  assert.equal(of(CLAUDIA_TEXT)?.id, 'claudia', 'the default of the templates');
  assert.equal(figures.CLAUDIA_FULL, hudPlan.parseFigure(CLAUDIA_TEXT).full, 'the canon text of the module is the FULL: line of the templates');
  assert.equal(of(figures.CLAUDIA_FULL)?.id, 'claudia', 'the canon text without labels');
  assert.equal(of(`${figures.CLAUDIA_FULL}.`)?.id, 'claudia');
  assert.equal(of('NAME: Claudia\nFULL: a 29-year-old woman with a glossy black bob, one clay-orange streak and a star clip')?.id, 'claudia', 'her name and her head, other words');
  assert.equal(of('NAME: claudia\nFULL: a woman with a black bob and a clay streak')?.id, 'claudia');
  for (const description of [
    'Claudia, a 28-year-old woman with a black bob and a clay-orange streak',
    'NAME: Claudia\nFULL: eine erwachsene Frau mit schwarzem Bob und einer tonorangen Strähne',
    'Claudia mit schwarzem Bob und einer orangen Strähne',
    'NAME: Claudia\nFULL: una mujer adulta con bob negro y un mechón naranja',
    'Claudia, una mujer con bob negro y una mecha naranja'
  ]) assert.equal(of(description)?.id, 'claudia', description);
  for (const description of [
    'NAME: Mira\nFULL: Claudia with a bob and an orange streak',
    'Claudia with long hair and an orange streak',
    'Claudia with a black bob',
    'Claudia with a bob and a blue streak',
    'A woman with a black bob and an orange streak',
    'Claudia-like woman with a bob and an orange streak'
  ]) assert.equal(of(description), null, description);
  // any other figure: nothing of Claudia
  assert.equal(of('NAME: Mira\nFULL: a 30-year-old woman with a strong jaw and short copper hair'), null);
  assert.equal(of(`NAME: Mira\nFULL: ${figures.CLAUDIA_FULL}`), null, 'another name');
  assert.equal(of('NAME: Claudia\nFULL: a bald man with round glasses'), null, 'the name alone is not enough');
  assert.equal(of('a bald man with round glasses'), null);
  assert.equal(of(''), null);
  assert.equal(figures.figureOf(null), null);
  // the node: the switch, the figure, the pictures of an own figure
  const image = { type: 'image', sessionId: 's1', assetId: 'a1', file: 'a1.jpg' };
  const refs = (inputs, params, text) => hudNodes.sheetReferencesOf(inputs, params, text);
  const official = refs({}, { official_images: true }, CLAUDIA_TEXT);
  assert.deepEqual([official.kind, official.count, official.figure.id], ['claudia', 3, 'claudia']);
  assert.equal(refs({}, { official_images: false }, CLAUDIA_TEXT), null, 'off: the sheet of before');
  assert.equal(refs({}, {}, CLAUDIA_TEXT), null);
  assert.equal(refs({}, { official_images: true }, 'NAME: Mira\nFULL: a woman with copper hair'), null);
  const own = refs({ figure_image: types.listValue('image', [image]) }, { official_images: true }, CLAUDIA_TEXT);
  assert.deepEqual([own.kind, own.count, own.own.map((item) => item.assetId)], ['own', 1, ['a1']], 'own pictures win over the images of Claudia');
  assert.equal(refs({ figure_image: image }, { official_images: false }, 'NAME: Mira\nFULL: a woman').kind, 'own', 'and need no switch');
}

function testSheetPrompt() {
  const claudia = hudPlan.parseFigure(CLAUDIA_TEXT);
  // without references: the prompt of main, byte for byte (the key of the sheet of a saved workflow)
  assert.equal(
    hudPlan.sheetPrompt(claudia),
    `Character reference portrait for a music video, photographic film still: ${figures.CLAUDIA_FULL}. Head and shoulders, facing the camera, neutral calm expression, mouth closed, plain mid-grey studio background, soft even key light from the front, natural colour, sharp focus on the eyes, 85 mm lens. Exactly one person. No text, no letters, no logos.`
  );
  assert.equal(hudPlan.sheetPrompt(claudia, null), hudPlan.sheetPrompt(claudia));
  assert.equal(hudPlan.sheetPrompt(claudia, 'nobody'), hudPlan.sheetPrompt(claudia), 'an unknown kind: the prompt of before');
  const prompt = hudPlan.sheetPrompt(claudia, 'claudia');
  assert.ok(prompt.startsWith('Character reference portrait for a music video, photographic film still of Claudia by anabology, an adult woman in her late twenties. The attached images are official reference images of her.'));
  assert.match(prompt, /Her face is exactly the face in the two photographs, the same person/);
  for (const part of [
    /Take her glossy black blunt jaw-length bob with heavy straight bangs/,
    /the one clay-orange streak through the bangs on her right side \(the viewer's left\)/,
    /the small flat clay-orange eight-pointed star clip on her left side above the ear/,
    /the thin headset microphone at her cheek exactly from them as well/,
    /an adult woman in her late twenties/,
    /not the drawn style or the grid of the face sheet, not their clothes, light, background, colour grade or framing; those come from this text/,
    /Photographic, not illustrated\./,
    /Head and shoulders, facing the camera/,
    /Exactly one person\. No text, no letters, no logos\.$/
  ]) {
    assert.match(prompt, part);
  }
  assert.doesNotMatch(prompt, /\byoung\b/i, 'never the word young');
  assert.ok(!prompt.includes(figures.CLAUDIA_FULL), 'the live-tested prompt leaves the angular-face canon out');
  const own = hudPlan.sheetPrompt(hudPlan.parseFigure('NAME: Mira\nFULL: a 30-year-old woman with copper hair'), 'own');
  assert.match(own, /^Character reference portrait for a music video, photographic film still: a 30-year-old woman with copper hair\. The attached images show this person: take the face, the hair and every accessory exactly from them, and the age from the text\./);
  assert.doesNotMatch(own, /Claudia|streak|star clip/);
}

// The cache keys of every node of a template, with the same made-up inputs for every connection (a text names its source, a media value is an asset of
// its source): the keys of the parameters and of the connections of the node, as the engine computes them.
function keysOf(doc) {
  const keys = {};
  for (const node of doc.graph.nodes) {
    const def = registry.get(node.type);
    const params = engine.effectiveParams(registry, def, node, {});
    const inputs = {};
    for (const edge of doc.graph.edges.filter((item) => item.to.node === node.id)) {
      const port = def.inputs.find((item) => item.id === edge.to.port);
      const base = String(port.type).replace('[]', '');
      const one = base === 'text' ? types.textValue(`${edge.from.node}.${edge.from.port}`) : { type: base, sessionId: 'S', assetId: `${edge.from.node}-${edge.from.port}` };
      if (port.multiple) inputs[port.id] = types.listValue(base, [...(inputs[port.id]?.items || []), one]);
      else inputs[port.id] = port.type.endsWith('[]') ? types.listValue(base, [one]) : one;
    }
    keys[node.id] = engine.computeCacheKey(def, params, inputs).slice(7, 19);
  }
  return keys;
}

// The graph of a template as main had it before WP50: without the edge of the reference images and without the switch of the planner.
function asOnMain(doc) {
  const copy = JSON.parse(JSON.stringify(doc));
  copy.graph.edges = copy.graph.edges.filter((edge) => edge.from.port !== 'sheet_refs');
  for (const node of copy.graph.nodes) if (node.type === 'music_video.hud_plan') delete node.params.official_images;
  return copy;
}

// The keys of main (8748a79, before WP50), computed with the code of main for the templates of main.
const MAIN_KEYS = {
  'music-video-hud': { n1: 'c5d1c3176b52', n2: '17ec91e51dd2', n3: '27c8d79c9d73', n4: '276e783e10b8', n5: 'c0b29418b9b4', n6: 'f05407d2bb5a', n7: 'b8c73276e2ac', n8: 'e61721a997d2', n9: 'd9adb83fa971', n10: 'adc8e1de1f85', n11: 'db0f26a4e289', n12: '3a5865e06dea', n13: '383b029ac20a', n14: 'b2b0b8a00121', n15: '925c55ffd5fa', n16: '2e3975e1de33', n17: '97985cb3f79c', n18: '71461982f79f', n19: '24a2dd15e8bf', n20: 'feb9ad26f19a', n21: '54a1d6af1077', n22: '15e48c57ea37', n23: '13391326e00e', n24: '5746092ec90f', n30: '5ce93f92b639' },
  'music-video-hud-elevenlabs': { n25: '76709e1fddbc', n26: '6cb2be119d7a', n27: '5907cd2506dc', n28: '30ef9ad482a7', n1: 'ff4d36062319', n29: '1c207c481e68', n2: '51cdf920a9ce', n3: '451995b05356', n4: '7a7e099b114d', n5: 'c0b29418b9b4', n6: 'f05407d2bb5a', n7: 'b8c73276e2ac', n8: 'e61721a997d2', n9: 'd9adb83fa971', n10: 'adc8e1de1f85', n11: 'db0f26a4e289', n12: '3a5865e06dea', n13: '383b029ac20a', n14: 'b2b0b8a00121', n15: '925c55ffd5fa', n16: '2e3975e1de33', n17: '97985cb3f79c', n18: '71461982f79f', n19: '24a2dd15e8bf', n20: 'feb9ad26f19a', n21: '54a1d6af1077', n22: '15e48c57ea37', n23: '13391326e00e', n24: '5746092ec90f' },
  'music-video-hud-suno': { n25: '76709e1fddbc', n26: '9dbf42c88fe3', n27: '1c41466d9452', n28: 'a937b88011fa', n29: 'ab86cda6bc72', n1: 'c5d1c3176b52', n2: '17ec91e51dd2', n3: '27c8d79c9d73', n4: '7a7e099b114d', n5: 'c0b29418b9b4', n6: 'f05407d2bb5a', n7: 'b8c73276e2ac', n8: 'e61721a997d2', n9: 'd9adb83fa971', n10: 'adc8e1de1f85', n11: 'db0f26a4e289', n12: '3a5865e06dea', n13: '383b029ac20a', n14: 'b2b0b8a00121', n15: '925c55ffd5fa', n16: '2e3975e1de33', n17: '97985cb3f79c', n18: '71461982f79f', n19: '24a2dd15e8bf', n20: 'feb9ad26f19a', n21: '54a1d6af1077', n22: '15e48c57ea37', n23: '13391326e00e', n24: '5746092ec90f' }
};

// The keys of main at WP52a (8ace67b, after WP52b), computed with the code of main for the templates of main: WP52a (B-roll, the share, the plain plan) changes
// none of them.
const MAIN_KEYS_WP52 = {
  'music-video-hud': { n1: 'c5d1c3176b52', n2: '17ec91e51dd2', n3: '27c8d79c9d73', n4: 'f25041112af2', n5: 'fdb75486c201', n6: 'f05407d2bb5a', n7: 'b8c73276e2ac', n8: 'e61721a997d2', n9: 'd9adb83fa971', n10: 'adc8e1de1f85', n11: 'db0f26a4e289', n12: '3a5865e06dea', n13: '383b029ac20a', n14: 'b2b0b8a00121', n15: '925c55ffd5fa', n16: '2e3975e1de33', n17: '97985cb3f79c', n18: '71461982f79f', n19: '24a2dd15e8bf', n20: 'feb9ad26f19a', n21: '54a1d6af1077', n22: '15e48c57ea37', n23: '13391326e00e', n24: '5746092ec90f', n30: '5ce93f92b639' },
  'music-video-hud-elevenlabs': { n25: '76709e1fddbc', n26: '6cb2be119d7a', n27: '5907cd2506dc', n28: '30ef9ad482a7', n1: 'ff4d36062319', n29: '1c207c481e68', n2: '51cdf920a9ce', n3: '451995b05356', n4: 'b4047a69c97c', n5: 'fdb75486c201', n6: 'f05407d2bb5a', n7: 'b8c73276e2ac', n8: 'e61721a997d2', n9: 'd9adb83fa971', n10: 'adc8e1de1f85', n11: 'db0f26a4e289', n12: '3a5865e06dea', n13: '383b029ac20a', n14: 'b2b0b8a00121', n15: '925c55ffd5fa', n16: '2e3975e1de33', n17: '97985cb3f79c', n18: '71461982f79f', n19: '24a2dd15e8bf', n20: 'feb9ad26f19a', n21: '54a1d6af1077', n22: '15e48c57ea37', n23: '13391326e00e', n24: '5746092ec90f' },
  'music-video-hud-suno': { n25: '76709e1fddbc', n26: '9dbf42c88fe3', n27: '1c41466d9452', n28: 'a937b88011fa', n29: 'ab86cda6bc72', n1: 'c5d1c3176b52', n2: '17ec91e51dd2', n3: '27c8d79c9d73', n4: 'b4047a69c97c', n5: 'fdb75486c201', n6: 'f05407d2bb5a', n7: 'b8c73276e2ac', n8: 'e61721a997d2', n9: 'd9adb83fa971', n10: 'adc8e1de1f85', n11: 'db0f26a4e289', n12: '3a5865e06dea', n13: '383b029ac20a', n14: 'b2b0b8a00121', n15: '925c55ffd5fa', n16: '2e3975e1de33', n17: '97985cb3f79c', n18: '71461982f79f', n19: '24a2dd15e8bf', n20: 'feb9ad26f19a', n21: '54a1d6af1077', n22: '15e48c57ea37', n23: '13391326e00e', n24: '5746092ec90f' }
};

function testKeys() {
  for (const id of HUD_TEMPLATES) {
    const doc = templateDoc(id);
    // a workflow saved from the template of main: every key as before the deploy (the planner, the sheet, the pictures, the clips, the cut, the render)
    assert.deepEqual(keysOf(asOnMain(doc)), MAIN_KEYS[id], `${id}: a workflow of main keeps its keys`);
    // a new workflow from the template of now: the planner (the switch) and the sheet (the images) are new, everything else would follow from their results
    const now = keysOf(doc);
    const changed = Object.keys(now).filter((nodeId) => now[nodeId] !== MAIN_KEYS[id][nodeId]);
    assert.deepEqual(changed, ['n4', 'n5'], `${id}: only the planner and the sheet differ`);
  }
  // the switch at its default is no part of the key; on, it is
  const def = registry.get('music_video.hud_plan');
  const keyOf = (params) => engine.computeCacheKey(def, engine.effectiveParams(registry, def, { id: 'n4', type: def.type, params }), {});
  const saved = { figure: CLAUDIA_TEXT, theme: 'hud' };
  assert.equal(keyOf(saved), keyOf({ ...saved, official_images: false }));
  assert.notEqual(keyOf(saved), keyOf({ ...saved, official_images: true }));
  // WP52a: every key of the templates as on main before WP52a, and the two new settings at their defaults are no part of a key; changed, they are
  for (const id of HUD_TEMPLATES) assert.deepEqual(keysOf(templateDoc(id)), MAIN_KEYS_WP52[id], `${id}: the keys of main before WP52a`);
  assert.equal(keyOf(saved), keyOf({ ...saved, broll_share: 0.35, allow_plain: false }));
  assert.notEqual(keyOf(saved), keyOf({ ...saved, broll_share: 0.5 }));
  assert.notEqual(keyOf(saved), keyOf({ ...saved, allow_plain: true }));
  const flag = def.params.find((param) => param.id === 'official_images');
  assert.deepEqual([flag.kind, flag.default, flag.cacheOmitDefault], ['boolean', false, true]);
  // the sheet with images is another key than without (without, it is the key of main: MAIN_KEYS above)
  const sheet = registry.get('image.generate');
  const sheetParams = engine.effectiveParams(registry, sheet, { id: 'n5', type: 'image.generate', params: { model: 'google/gemini-nano-banana-2.1', prompt: '', aspect_ratio: '3:4', count: 1 } });
  const prompt = { prompt: types.textValue('x') };
  assert.notEqual(engine.computeCacheKey(sheet, sheetParams, prompt), engine.computeCacheKey(sheet, sheetParams, { ...prompt, images: types.listValue('image', [{ type: 'image', sessionId: 'S', assetId: 'a' }]) }));
}

function testTemplates() {
  for (const id of HUD_TEMPLATES) {
    const doc = templateDoc(id);
    const plan = doc.graph.nodes.find((node) => node.type === 'music_video.hud_plan');
    const sheet = doc.graph.nodes.find((node) => node.type === 'image.generate');
    assert.equal(plan.params.official_images, true, `${id}: the switch is on`);
    assert.equal(plan.params.figure, CLAUDIA_TEXT, `${id}: Claudia is the default`);
    assert.equal(figures.figureOf(hudPlan.parseFigure(plan.params.figure))?.id, 'claudia');
    const into = doc.graph.edges.filter((edge) => edge.to.node === sheet.id).map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.port}`);
    assert.deepEqual(into, [`${plan.id}.sheet_prompt>prompt`, `${plan.id}.sheet_refs>images`], `${id}: the prompt and the images of the sheet come from the planner`);
    assert.deepEqual([sheet.params.model, sheet.params.aspect_ratio], ['google/gemini-nano-banana-2.1', '3:4']);
    // the pictures of the units still take the sheet, nothing else
    for (const edit of doc.graph.nodes.filter((node) => node.type === 'image.edit')) {
      assert.deepEqual(doc.graph.edges.filter((edge) => edge.to.node === edit.id && edge.to.port === 'images').map((edge) => `${edge.from.node}.${edge.from.port}`), [`${sheet.id}.image`]);
    }
    // the form is the one of before: no field for a picture of the figure (see IMPLEMENTATION-NOTES, WP50); the descriptions name the official images
    assert.ok(!doc.app.inputs.some((entry) => entry.param === 'figure_image' || entry.param === 'official_images'), `${id}: no new field`);
    assert.match(doc.description, /official images of Claudia/, `${id}: en`);
    assert.match(doc.i18n.de.description, /offiziellen Bildern von Claudia/, `${id}: de`);
    assert.match(doc.i18n.es.description, /imágenes oficiales de Claudia/, `${id}: es`);
  }
  // the board says what the sheet gets (estimate: the sheet with three references)
  const prices = hudNodes.hudPrices('anthropic/claude-opus-5.5', 3);
  assert.ok(Math.abs(prices.sheet - 0.03652) < 1e-9);
  assert.equal(hudNodes.hudPrices('anthropic/claude-opus-5.5', 0).sheet, undefined);
}

function main() {
  testImages();
  testWhoGetsThem();
  testSheetPrompt();
  testKeys();
  testTemplates();
  console.log('Claudia mit offiziellen Bildern: Dateien, README, Auswahl der Figur, Prompt des Figurenblatts, Schlüssel bestehender Workflows und Vorlagen sind korrekt.');
  console.log('test-music-video-hud-figure.js: ok');
}

main();
