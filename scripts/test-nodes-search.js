'use strict';

// Search of the node palette (WP21): "golden queries" against the real registry and the real texts of the node view
// (labels and synonyms in German, English and Spanish), as participants (no Higgsfield) and as admin (with Higgsfield
// models). The palette entries are built the way palette.js builds them (graph.paletteEntry / paletteModelEntry with
// node-ui.js for the texts), the order comes from graph.rankPaletteEntries.
// Also: the renamed zoom node, old workflows, the translated reasons for "unavailable" and the registry watcher that
// keeps the availability fresh when the person comes back to the page.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const graphLib = require('../public/nodes/graph');
const registryModule = require('../lib/nodes/registry');

const dict = {};
vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'nodes', 'i18n-nodes.js'), 'utf8'), { window: { I18N: dict } });

// node-ui.js for one interface language (the same code the palette uses for names and synonyms).
function uiFor(lang) {
  const window = { I18N: dict, OCDNodes: { graph: graphLib }, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  window.t = (key, vars) => {
    let value = dict[lang][key];
    if (value === undefined) return key;
    for (const [name, replacement] of Object.entries(vars || {})) value = value.split(`{${name}}`).join(String(replacement));
    return value;
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'nodes', 'node-ui.js'), 'utf8'), { window, document: { createElement: () => ({}) } }, { filename: 'node-ui.js' });
  return window.OCDNodes.ui;
}

const payload = JSON.parse(JSON.stringify(registryModule.publicRegistry()));

// What a configured server sends: every node usable. Participants get what GET /api/nodes/registry does for them:
// Higgsfield and credit nodes are marked not available and restricted (the palette leaves those out).
function registryFor(role, { available = true } = {}) {
  const copy = JSON.parse(JSON.stringify(payload));
  for (const type of copy.nodeTypes) {
    if (available) type.available = true;
    if (role === 'participant' && (type.category === 'higgsfield' || type.cost?.unit === 'credits')) {
      type.available = 'Not available for your account';
      type.restricted = true;
    }
  }
  return graphLib.indexRegistry(copy);
}

const MODEL_NAMES = ['Kling 3.0', 'Kling 2.6', 'Kling 2.5 Turbo', 'Kling 2.1 Master', 'Kling O1', 'Kling Motion Control', 'Veo 3.1', 'Veo 3.1 Fast', 'Sora 2', 'Sora 2 Pro', 'Wan 2.6', 'Seedance 2.0', 'Minimax Hailuo 2.3'];

function modelName(index) {
  return MODEL_NAMES[index] || `Clip Engine ${index}`;
}

// Entries the way palette.js builds them: every node, plus one entry per Higgsfield video model.
function entriesFor(reg, ui, { models = 0 } = {}) {
  const text = { label: ui.typeLabel, keywords: ui.typeKeywords, categoryLabel: ui.categoryLabel };
  const entries = [];
  for (const def of reg.list) {
    if (def.restricted === true) continue;
    entries.push(graphLib.paletteEntry(def, text));
  }
  const def = reg.types.get('video.higgsfield');
  if (!def.restricted) {
    for (let i = 0; i < models; i += 1) {
      entries.push(graphLib.paletteModelEntry(def, { value: `model_${i}`, label: modelName(i) }, { type: 'video.higgsfield', kind: 'video' }, text));
    }
  }
  return entries;
}

const settings = {};
function setup(lang, role, models = 0) {
  const key = `${lang}/${role}/${models}`;
  if (!settings[key]) {
    const ui = uiFor(lang);
    const reg = registryFor(role);
    settings[key] = { ui, reg, entries: entriesFor(reg, ui, { models }) };
  }
  return settings[key];
}

function search(lang, role, query, { models = 0, filter = null, category = 'all' } = {}) {
  const { reg, entries } = setup(lang, role, models);
  return graphLib.rankPaletteEntries(reg, entries, { query, filter, category, limit: 150, modelLimit: category === 'higgsfield' ? 90 : 30 });
}

const types = (results, count = results.length) => results.slice(0, count).map((entry) => (entry.model ? `model:${entry.label}` : entry.type));
const indexOfType = (results, type) => results.findIndex((entry) => !entry.model && entry.type === type);

/* ---------- golden queries ---------- */

// [language, role, models, query, check(results), what]
const GOLDEN = [
  ['de', 'participant', 0, 'bild zu video', (r) => {
    const top = types(r, 3);
    assert.ok(top.includes('video.seedance') && top.includes('fal.h3_video'), `Seedance and H3 Max Video among the first 3: ${top}`);
    assert.notEqual(r[0].type, 'image.to_video', 'the zoom node does not win');
  }],
  ['de', 'admin', 40, 'bild zu video', (r) => {
    const top = types(r, 3);
    assert.ok(top.includes('video.seedance') && top.includes('fal.h3_video'), `Seedance and H3 Max Video among the first 3: ${top}`);
    assert.notEqual(r[0].type, 'image.to_video');
    const firstModel = r.findIndex((entry) => entry.model);
    assert.ok(firstModel === -1 || r.slice(0, firstModel).every((entry) => !entry.model), 'nodes come before models');
    assert.ok(r.filter((entry) => !entry.model).length >= 3);
  }],
  ['de', 'participant', 0, 'animieren', (r) => {
    assert.ok(indexOfType(r, 'video.seedance') >= 0, 'Seedance is found');
    const zoom = indexOfType(r, 'image.to_video');
    assert.ok(zoom === -1 || indexOfType(r, 'video.seedance') < zoom, 'Seedance before the zoom node');
    assert.equal(r[0].type, 'video.seedance');
  }],
  ['de', 'participant', 0, 'text zu video', (r) => {
    assert.ok(indexOfType(r, 'video.seedance') <= 1, `Seedance first or second: ${types(r, 4)}`);
  }],
  ['en', 'participant', 0, 'image to video', (r) => {
    assert.ok(indexOfType(r, 'video.seedance') >= 0 && indexOfType(r, 'video.seedance') <= 1, `Seedance among the first 2: ${types(r, 4)}`);
    assert.notEqual(r[0].type, 'image.to_video');
  }],
  ['de', 'participant', 0, 'lippen', (r) => {
    assert.ok(indexOfType(r, 'fal.h3_lipsync') >= 0 && indexOfType(r, 'fal.h3_lipsync') <= 2, `lip sync among the first 3: ${types(r, 4)}`);
  }],
  ['de', 'participant', 0, 'zeitlupe', (r) => assert.equal(r[0].type, 'video.speed')],
  ['de', 'admin', 13, 'zeitlupe', (r) => assert.equal(r[0].type, 'video.speed')],
  ['de', 'participant', 0, 'kling', (r) => {
    // no Higgsfield for participants: nothing, or at most the free fal.ai model, the video node with a model choice and the video
    // editing node (Kling O3), which all name Kling as a keyword. Never noise.
    assert.ok(r.every((entry) => ['fal.model', 'video.generate', 'fal.video_edit'].includes(entry.type)), `only the free fal.ai model may match: ${types(r)}`);
    assert.ok(!r.some((entry) => ['image.chroma_key', 'image.invert', 'image.adjust', 'image.crop'].includes(entry.type)));
  }],
  ['de', 'admin', 13, 'kling', (r) => {
    assert.ok(r.length >= 6, 'the Kling models are found');
    const klingy = (entry) => /kling/i.test([entry.label, ...(entry.keywords || [])].join(' '));
    assert.ok(r.every(klingy), `no noise, every hit names Kling: ${types(r)}`);
    assert.ok(r.slice(0, 6).every((entry) => /^Kling /.test(entry.label) || klingy(entry)), 'Kling models and Higgsfield nodes first');
  }],
  // the zoom node says "local", not "no AI": a search for the AI never puts exactly this node first
  ['de', 'participant', 0, 'ki', (r) => assert.notEqual(r[0].type, 'image.to_video')],
  ['en', 'participant', 0, 'ai', (r) => assert.ok(indexOfType(r, 'image.to_video') !== 0 && indexOfType(r, 'image.to_video') !== 1, `not among the first 2: ${types(r, 3)}`)],
  ['es', 'participant', 0, 'ia', (r) => assert.notEqual(r[0].type, 'image.to_video')],
  // one word that is a name: that node first (the Prompt node, not the prompt enhancer)
  ['de', 'participant', 0, 'prompt', (r) => assert.equal(r[0].type, 'input.prompt')],
  ['en', 'participant', 0, 'prompt', (r) => assert.equal(r[0].type, 'input.prompt')],
  ['es', 'participant', 0, 'prompt', (r) => assert.equal(r[0].type, 'input.prompt')],
  ['es', 'participant', 0, 'imagen a vídeo', (r) => {
    assert.ok(indexOfType(r, 'video.seedance') >= 0 && indexOfType(r, 'video.seedance') <= 2, `Seedance among the first 3: ${types(r, 4)}`);
  }],
  // WP30: the words of a song find the song text node first, the words of the sound find the music node first
  ['de', 'participant', 0, 'strophe', (r) => assert.deepEqual(types(r, 2), ['audio.music_plan', 'audio.music'])],
  ['de', 'participant', 0, 'refrain', (r) => assert.equal(r[0].type, 'audio.music_plan')],
  ['de', 'participant', 0, 'songtext', (r) => assert.equal(r[0].type, 'audio.music_plan')],
  ['en', 'participant', 0, 'verse', (r) => assert.equal(r[0].type, 'audio.music_plan')],
  ['es', 'participant', 0, 'estrofa', (r) => assert.equal(r[0].type, 'audio.music_plan')],
  ['de', 'participant', 0, 'musik', (r) => assert.equal(r[0].type, 'audio.music')],
  ['de', 'participant', 0, 'jingle', (r) => assert.equal(r[0].type, 'audio.music')],
  ['de', 'participant', 0, 'hintergrundmusik', (r) => assert.equal(r[0].type, 'audio.music')],
  ['en', 'participant', 0, 'music', (r) => assert.equal(r[0].type, 'audio.music')],
  ['es', 'participant', 0, 'música', (r) => assert.equal(r[0].type, 'audio.music')],
  // WP34: the words of a music video find the planning node first, the tempo its analysis, the times of the words their node, the cut its node
  ['de', 'participant', 0, 'musikvideo', (r) => assert.equal(r[0].type, 'music_video.plan')],
  ['en', 'participant', 0, 'music video', (r) => assert.equal(r[0].type, 'music_video.plan')],
  ['de', 'participant', 0, 'bpm', (r) => assert.equal(r[0].type, 'audio.beats')],
  ['de', 'participant', 0, 'wortzeiten', (r) => assert.equal(r[0].type, 'audio.lyrics_timing')],
  ['de', 'participant', 0, 'schnitt im takt', (r) => assert.equal(r[0].type, 'music_video.edit')],
  // WP35: captions and the sound wave are found in the three languages, by their name and by the words people use for them
  ['de', 'participant', 0, 'untertitel einbrennen', (r) => assert.equal(r[0].type, 'video.captions')],
  ['de', 'participant', 0, 'untertitel', (r) => assert.equal(r[0].type, 'video.captions')],
  ['de', 'participant', 0, 'karaoke', (r) => assert.ok(types(r, 2).includes('video.captions'), `captions among the first 2: ${types(r, 3)}`)],
  ['en', 'participant', 0, 'captions', (r) => assert.equal(r[0].type, 'video.captions')],
  ['es', 'participant', 0, 'subtítulos', (r) => assert.equal(r[0].type, 'video.captions')],
  ['de', 'participant', 0, 'klangwelle', (r) => assert.equal(r[0].type, 'video.soundwave')],
  ['de', 'participant', 0, 'equalizer', (r) => assert.equal(r[0].type, 'video.soundwave')],
  ['en', 'participant', 0, 'sound wave', (r) => assert.equal(r[0].type, 'video.soundwave')],
  ['es', 'participant', 0, 'onda de sonido', (r) => assert.equal(r[0].type, 'video.soundwave')]
];

function testGoldenQueries() {
  for (const [lang, role, models, query, check] of GOLDEN) {
    const results = search(lang, role, query, { models });
    try {
      check(results);
    } catch (error) {
      error.message = `[${lang} ${role} ${models} models "${query}"] ${error.message} (top: ${types(results, 6).join(', ')})`;
      throw error;
    }
  }
  assert.equal(GOLDEN.length, 41, 'the table lists the golden queries (the quick pick has its own test)');
}

function testAllVideoNodesSurviveManyModels() {
  const withoutModels = search('de', 'admin', 'video', { models: 0 });
  const withModels = search('de', 'admin', 'video', { models: 1000 });
  const nodesOf = (results) => results.filter((entry) => !entry.model).map((entry) => entry.type);
  assert.ok(nodesOf(withoutModels).length >= 20, 'many nodes match "video"');
  assert.deepEqual(nodesOf(withModels), nodesOf(withoutModels), 'not a single node falls out of the list because of 1000 models');
  const shown = withModels.filter((entry) => entry.model).length;
  assert.equal(shown, 30, 'at most 30 models are listed');
  assert.equal(withModels.hiddenModels, 970, 'the rest is counted for the hint');
  // every node whose name speaks of video is in
  const reg = setup('de', 'admin', 0).reg;
  const ui = setup('de', 'admin', 0).ui;
  for (const def of reg.list) {
    if (/video/i.test(ui.typeLabel(def))) assert.ok(nodesOf(withModels).includes(def.type), `${def.type} is listed for "video"`);
  }
  // nodes first on ties: the first model comes after the nodes whose name matches
  const firstModel = withModels.findIndex((entry) => entry.model);
  assert.ok(firstModel > 0 && withModels.slice(0, firstModel).every((entry) => !entry.model));
  // 1000 models and no search text: none of them in "All", the nodes in their category order
  const browse = search('de', 'admin', '', { models: 1000 });
  assert.ok(browse.every((entry) => !entry.model), 'no model entries in All without a search text');
  assert.equal(browse.length, reg.list.length, 'every node is there');
  assert.equal(browse.hiddenModels, 0);
  // the Higgsfield chip is the way to browse them: more than 30, up to the larger limit
  const chip = search('de', 'admin', '', { models: 1000, category: 'higgsfield' });
  assert.equal(chip.filter((entry) => entry.model).length, 90);
  assert.equal(chip.hiddenModels, 1000 - 90);
}

function testQuickPickFromImage() {
  const image = search('de', 'admin', '', { models: 13, filter: { dir: 'out', type: 'image' } });
  const top = types(image, 5);
  assert.ok(top.includes('video.seedance'), `Seedance among the first 5: ${top}`);
  assert.ok(image.every((entry) => !entry.model), 'models need a search text in the quick pick');
  const zoom = indexOfType(image, 'image.to_video');
  const firstEditor = image.findIndex((entry) => ['image.crop', 'image.resize', 'image.adjust', 'image.edit'].includes(entry.type));
  assert.ok(zoom > 0 && zoom < firstEditor, 'the local zoom follows the video generators and precedes the image editors');
  for (const type of ['fal.h3_video', 'video.higgsfield']) assert.ok(indexOfType(image, type) < firstEditor, `${type} before the image editors`);
  // not boosted: nodes that need a video of their own
  const rankOf = (type) => image.find((entry) => entry.type === type).compat.rank;
  assert.ok(rankOf('video.seedance') > rankOf('image.crop'));
  assert.ok(rankOf('image.to_video') > rankOf('image.crop') && rankOf('image.to_video') < rankOf('video.seedance'));
  assert.ok(rankOf('video.overlay_image') <= rankOf('image.crop'), 'an overlay needs a video of its own: no boost');
  // a text output: the video generators lead as well
  const text = search('de', 'participant', '', { filter: { dir: 'out', type: 'text' } });
  // (the scene node of the explainer video, WP37b, is one more video node that takes a text: the window grew by that one)
  assert.ok(types(text, 7).includes('video.seedance'), `Seedance near the top for a text output: ${types(text, 7)}`);
  // ... but "Generate image", the most common next step after a prompt, is not pushed below the video family
  assert.ok(indexOfType(text, 'image.generate') >= 0 && indexOfType(text, 'image.generate') < 6, `Generate image among the first 6 for a text output: ${types(text, 8)}`);
  assert.ok(indexOfType(text, 'image.generate') <= indexOfType(text, 'video.seedance') + 1);
  const textAdmin = search('de', 'admin', '', { models: 13, filter: { dir: 'out', type: 'text' } });
  assert.ok(indexOfType(textAdmin, 'image.generate') < 6, `... also as admin: ${types(textAdmin, 8)}`);
  const textRank = (type) => text.find((entry) => entry.type === type).compat.rank;
  assert.ok(textRank('video.seedance') === textRank('image.generate'), 'media generators share one rank');
  assert.ok(textRank('llm.chat') < textRank('image.generate'), 'helpers that merely take text stay behind');
  // a search text brings the models back into the quick pick, after the nodes
  const withText = search('de', 'admin', 'kling', { models: 13, filter: { dir: 'out', type: 'image' } });
  assert.ok(withText.some((entry) => entry.model), 'models show up with a search text');
  // dragging from an input (looking for sources) is not boosted
  const sources = graphLib.quickPickTargets(registryFor('admin'), 'in', 'image');
  assert.ok(sources.every((entry) => entry.rank <= 3));
}

function testNoiseAndTypos() {
  // only the video node that names Veo as a model it can use, no scattered letters
  assert.deepEqual(types(search('de', 'participant', 'veo')), ['video.generate'], '"veo" finds no scattered letters for participants');
  assert.deepEqual(types(search('de', 'participant', 'steuererklaerung')), [], 'nothing, instead of anything at random');
  assert.equal(search('de', 'participant', 'sedance')[0].type, 'video.seedance', 'a typo still finds the node while nothing else matches');
  assert.ok(search('de', 'participant', 'sprechend').some((entry) => entry.type === 'fal.h3_lipsync'));
  assert.equal(search('de', 'participant', 'ken burns')[0].type, 'image.to_video');
  assert.equal(search('de', 'participant', 'standbild')[0].type, 'image.to_video');
  assert.equal(search('de', 'participant', 'video analysieren')[0].type, 'llm.video_describer');
  assert.equal(search('en', 'participant', 'slow motion')[0].type, 'video.speed');
  assert.equal(search('es', 'participant', 'camara lenta')[0].type, 'video.speed', 'accents do not matter');
  assert.equal(search('de', 'participant', 'tts')[0].type, 'audio.tts');
  // one word that is a name: that node leads ("prompt" is the Prompt node, not the prompt enhancer)
  assert.equal(search('de', 'participant', 'prompt')[0].type, 'input.prompt');
  assert.equal(search('en', 'participant', 'image to video').some((entry) => entry.type === 'image.to_video'), true, 'the zoom node is still found, just not first');
  // the old English names keep working in the German interface
  // among the first three: the other video generators (the one with a model choice, the fal.ai one) share the top
  assert.ok(types(search('de', 'participant', 'text to video'), 3).includes('video.seedance'));
  // normal search needs every word
  assert.deepEqual(types(search('de', 'participant', 'zeitlupe xyzxyz')), []);
}

function testTieOrderAndAvailability() {
  const reg = registryFor('admin');
  const entry = (name, def) => ({ key: name, type: name, category: def.category || 'video', label: name, labels: [name], keywords: [], search: 'clip', def: { inputs: [], outputs: [], available: true, ...def } });
  const entries = [
    entry('Aaa clip', { available: 'FAL_KEY is not set' }),
    entry('Bbb clip', { category: 'edit-video', inputs: [{ id: 'video', type: 'video', required: true }], outputs: [{ id: 'video', type: 'video' }] }),
    entry('Ccc clip', { category: 'utility' }),
    entry('Ddd clip', {})
  ];
  const order = graphLib.rankPaletteEntries(reg, entries, { query: 'clip' }).map((e) => e.label);
  assert.deepEqual(order, ['Ddd clip', 'Bbb clip', 'Ccc clip', 'Aaa clip'], 'equal hits: usable first, then generator, editor, helper; unavailable at the end');
  // in the browse view the same rule holds inside a category
  const browse = graphLib.rankPaletteEntries(reg, entries.map((e) => ({ ...e, category: 'video' })), {}).map((e) => e.label);
  assert.deepEqual(browse, ['Ddd clip', 'Bbb clip', 'Ccc clip', 'Aaa clip']);
  // roles of the real nodes
  const role = (type) => graphLib.nodeRole(reg.types.get(type));
  assert.equal(role('video.seedance'), 0);
  assert.equal(role('fal.h3_video'), 0);
  assert.equal(role('fal.h3_lipsync'), 0);
  assert.equal(role('audio.tts'), 0);
  assert.equal(role('video.trim'), 1);
  assert.equal(role('hf.upscale_video'), 1);
  assert.equal(role('hf.motion_control'), 1);
  assert.equal(role('image.edit'), 1);
  assert.equal(role('image.to_video'), 1);
  assert.equal(role('input.video'), 2);
  assert.equal(role('media.info'), 2);
  assert.equal(role('output.result'), 2);
  // a search where several generators tie: all creators are ahead of every editor
  const all = search('de', 'participant', 'video');
  const lastCreator = Math.max(...all.map((e, i) => (graphLib.nodeRole(e.def) === 0 && e.labels[0].toLowerCase().includes('video') ? i : -1)));
  const firstEditor = all.findIndex((e) => graphLib.nodeRole(e.def) === 1 && e.labels[0].toLowerCase().includes('video'));
  assert.ok(lastCreator < firstEditor, 'name hits for "video": generators before editors');
}

/* ---------- the renamed zoom node ---------- */

function testZoomNodeRename() {
  const def = registryModule.get('image.to_video');
  assert.equal(def.label, 'Still image zoom (local)');
  assert.ok(!def.keywords.some((word) => /image to video|animate/i.test(word)), 'no "image to video" among the keywords');
  assert.ok(def.keywords.includes('ken burns') && def.keywords.includes('slideshow') && def.keywords.includes('zoom'));
  assert.equal(dict.de['nodes.type.image.to_video.label'], 'Standbild-Zoom (lokal)');
  assert.equal(dict.en['nodes.type.image.to_video.label'], 'Still image zoom (local)');
  assert.equal(dict.es['nodes.type.image.to_video.label'], 'Zoom de imagen fija (local)');
  for (const lang of ['de', 'en', 'es']) {
    const label = dict[lang]['nodes.type.image.to_video.label'];
    // the hint "no AI" must not be a word of the name: a search for the AI would find exactly this node
    assert.ok(!/\b(ki|ai|ia)\b/i.test(label), `${lang}: the name does not contain the word for AI`);
    assert.ok(!/\b(ki|ai|ia)\b/i.test(dict[lang]['nodes.type.image.to_video.keywords']), `${lang}: nor do the synonyms`);
    assert.ok(/\b(ki|ai|ia)\b/i.test(dict[lang]['nodes.portdesc.image.to_video.image']), `${lang}: the hint sits in the tooltip of the image input`);
    assert.ok(!/bild zu video|image to video|imagen a v[ií]deo|animier/i.test(label), `${lang}: the name promises no AI video`);
    const words = dict[lang]['nodes.type.image.to_video.keywords'].toLowerCase();
    assert.ok(!/bild zu video|image to video|imagen a v[ií]deo|animier|animate|animar/.test(words), `${lang}: no AI synonyms`);
    assert.ok(/ken burns/.test(words) && /zoom/.test(words));
    // other texts that name the node use the new name
    assert.ok(dict[lang]['nodes.portdesc.media.info.duration'].includes(label), `${lang}: the duration hint names the new label`);
  }
  // the server's own label is the same everywhere (the type id is unchanged)
  assert.equal(registryModule.get('image.to_video').type, 'image.to_video');
}

function testOldWorkflowsStillLoad() {
  const reg = graphLib.indexRegistry(payload);
  const workflow = {
    nodes: [
      { id: 'n1', type: 'input.image', x: 0, y: 0, params: {} },
      { id: 'n2', type: 'image.to_video', x: 300, y: 0, params: { duration: 6, zoom: 'in', fps: 24, match_audio: false } },
      { id: 'n3', type: 'output.result', x: 600, y: 0, params: {} }
    ],
    edges: [
      { id: 'e1', from: { node: 'n1', port: 'image' }, to: { node: 'n2', port: 'image' } },
      { id: 'e2', from: { node: 'n2', port: 'video' }, to: { node: 'n3', port: 'inputs' } }
    ],
    notes: [],
    groups: []
  };
  const graph = graphLib.normalizeLoaded(workflow);
  assert.deepEqual(graphLib.validate(reg, graph), [], 'a saved workflow with the zoom node validates as before');
  assert.equal(graph.nodes.find((node) => node.id === 'n2').type, 'image.to_video');
  assert.equal(graph.nodes.find((node) => node.id === 'n2').params.zoom, 'in', 'parameters are untouched');
  assert.equal(graph.edges.length, 2);
}

/* ---------- reasons for "unavailable" ---------- */

function testUnavailableReasons() {
  const libSource = fs
    .readdirSync(path.join(root, 'lib', 'nodes'))
    .filter((file) => file.endsWith('.js'))
    .map((file) => fs.readFileSync(path.join(root, 'lib', 'nodes', file), 'utf8'))
    .join('\n');
  const known = [
    'OPENROUTER_API_KEY is not set',
    'OPENROUTER_API_KEY is not set and ChatGPT is not connected',
    'Higgsfield is not connected',
    'FAL_KEY is not set',
    'ELEVENLABS_API_KEY is not set',
    'No render node configured',
    'ffmpeg/ffprobe not found',
    'ffmpeg has no libass (filter "ass")',
    '@resvg/resvg-js is not installed',
    'Not available for your account'
  ];
  for (const reason of known) assert.ok(libSource.includes(reason), `the server really says "${reason}"`);
  for (const lang of ['de', 'en', 'es']) {
    const ui = uiFor(lang);
    const seen = new Set();
    for (const reason of known) {
      const text = ui.availabilityReason(reason);
      assert.notEqual(text, reason, `${lang}: "${reason}" is translated`);
      assert.ok(text.length > 10 && !seen.has(text), `${lang}: every reason has its own text`);
      seen.add(text);
    }
    assert.equal(ui.availabilityReason('Something new happened'), 'Something new happened', 'unknown reasons stay as they are');
    assert.equal(ui.availabilityReason(''), '');
    assert.equal(ui.availabilityReason(undefined), '');
  }
  assert.match(uiFor('de').availabilityReason('FAL_KEY is not set'), /fal\.ai ist nicht eingerichtet/);
  assert.match(uiFor('de').availabilityReason('Higgsfield is not connected'), /Higgsfield ist nicht verbunden/);
  // the reasons the registry really produces without any configuration are all covered
  const unconfigured = registryModule.publicRegistry().nodeTypes.filter((def) => typeof def.available === 'string');
  const ui = uiFor('de');
  for (const def of unconfigured) {
    if (/^availability check failed|^unavailable$/.test(def.available)) continue;
    assert.notEqual(ui.availabilityReason(def.available), def.available, `${def.type}: "${def.available}" is translated`);
  }
}

/* ---------- fresh availability when the person comes back ---------- */

async function testRegistryWatcher() {
  const copy = (mutate) => {
    const next = JSON.parse(JSON.stringify(payload));
    for (const type of next.nodeTypes) type.available = type.category === 'higgsfield' ? 'Higgsfield is not connected' : true;
    if (mutate) mutate(next);
    return next;
  };
  let clock = 1000000;
  let calls = 0;
  let current = copy();
  const applied = [];
  const watcher = graphLib.createRegistryWatcher({
    load: async () => {
      calls += 1;
      return JSON.parse(JSON.stringify(current));
    },
    apply: (next) => applied.push(next),
    now: () => clock
  });
  watcher.prime(current);

  // coming back right away: nothing is fetched
  assert.equal(await watcher.check(), false);
  assert.equal(calls, 0, 'throttled: less than 15 s since the registry was loaded');
  clock += 14000;
  assert.equal(await watcher.check(), false);
  assert.equal(calls, 0);

  // after 15 s: fetched, but nothing changed -> not applied
  clock += 1500;
  assert.equal(await watcher.check(), false);
  assert.equal(calls, 1, 'fetched again after 15 s');
  assert.equal(applied.length, 0, 'unchanged availability: nothing to apply');
  assert.equal(await watcher.check(), false);
  assert.equal(calls, 1, 'throttled again right after a fetch');

  // Higgsfield gets connected in another tab
  current = copy((next) => {
    for (const type of next.nodeTypes) if (type.category === 'higgsfield') type.available = true;
  });
  clock += 20000;
  assert.equal(await watcher.check(), true);
  assert.equal(calls, 2);
  assert.equal(applied.length, 1);
  const fresh = graphLib.indexRegistry(applied[0]);
  assert.equal(fresh.types.get('video.higgsfield').available, true, 'the new availability arrives');
  assert.equal(fresh.types.get('video.seedance').available, true);

  // the same state again: no second apply
  clock += 20000;
  assert.equal(await watcher.check(), false);
  assert.equal(applied.length, 1);

  // two checks at once share one request
  current = copy();
  clock += 20000;
  const before = calls;
  const [a, b] = await Promise.all([watcher.check(), watcher.check()]);
  assert.equal(calls, before + 1, 'concurrent checks make one request');
  assert.equal(a, b);
  assert.equal(applied.length, 2, 'Higgsfield disconnected again: applied');

  // a changed reason text counts as a change, force skips the throttle
  current = copy((next) => {
    next.nodeTypes.find((type) => type.type === 'fal.h3_video').available = 'FAL_KEY is not set';
  });
  assert.equal(await watcher.check(), false, 'still throttled');
  assert.equal(await watcher.check({ force: true }), true);
  assert.equal(applied.length, 3);

  // an error keeps everything as it is and never throws
  const failing = graphLib.createRegistryWatcher({ load: async () => { throw new Error('offline'); }, apply: () => assert.fail('no apply on error'), now: () => clock });
  failing.prime(payload);
  clock += 60000;
  assert.equal(await failing.check(), false);
  clock += 1;
  assert.equal(await failing.check(), false, 'the failed request counts for the throttle');

  // the signature ignores everything but availability
  const sigA = graphLib.registrySignature(copy());
  const other = copy((next) => {
    next.nodeTypes[0].label = 'Renamed';
  });
  assert.equal(graphLib.registrySignature(other), sigA);
}

function testRegistryWatcherIsWired() {
  const main = fs.readFileSync(path.join(root, 'public', 'nodes', 'main.js'), 'utf8');
  assert.match(main, /graphLib\.createRegistryWatcher\(/, 'main.js creates the watcher');
  assert.match(main, /registryWatcher\.prime\(payload\)/);
  assert.match(main, /document\.addEventListener\('visibilitychange'[\s\S]{0,400}recheckRegistry\(\)/, 'a tab that becomes visible looks again');
  assert.match(main, /global\.addEventListener\('focus', recheckRegistry\)/, 'a window that gets focus looks again');
  assert.match(main, /function recheckRegistry\(\) \{\s*if \(!state\.active \|\| !state\.reg \|\| !registryWatcher\) return;/, 'nothing while the view is not shown');
  // the update reaches palette, cards, run buttons, inspector and the Higgsfield option lists
  const apply = main.slice(main.indexOf('function applyFreshRegistry'), main.indexOf('function refreshInspectorWhenIdle'));
  for (const piece of ['canvas.setRegistry(state.reg)', 'canvas.render(state.graph)', 'appView.setRegistry(state.reg)', "ui.refreshOptions(source)", 'palette.refresh()', 'runController.relabel()', 'refreshInspectorWhenIdle()']) {
    assert.ok(apply.includes(piece), `applyFreshRegistry: ${piece}`);
  }
  // ... but without throwing away what the person is typing in: no reset of every card, the inspector only for a
  // selected node whose type changed and not while a field of it has the focus
  assert.ok(!apply.includes('canvas.relabel()'), 'not every card is rebuilt');
  assert.ok(!/refreshInspector\(true\)/.test(apply), 'the inspector is not forced unconditionally');
  const idle = main.slice(main.indexOf('function refreshInspectorWhenIdle'), main.indexOf('function recheckRegistry'));
  assert.match(idle, /host\.contains\(active\)/);
  assert.match(idle, /'focusout'/);
  const canvasSource = fs.readFileSync(path.join(root, 'public', 'nodes', 'canvas.js'), 'utf8');
  const setRegistry = canvasSource.slice(canvasSource.indexOf('function setRegistry'), canvasSource.indexOf('function setTool'));
  assert.match(setRegistry, /\.available !== nextReg\.types\.get\(type\)\?\.available/, 'only cards of a type with changed availability are marked');
  assert.ok(!/cards\.clear|\.sig = null/.test(setRegistry));
  const appSource = fs.readFileSync(path.join(root, 'public', 'nodes', 'app-mode.js'), 'utf8');
  assert.match(appSource, /function setRegistry\(registry\) \{\s*if \(registry\) reg = registry;/);
  assert.match(main, /'higgsfield-video-models'/);
  assert.match(main, /'higgsfield-image-models'/);
  // no background timer for it
  assert.ok(!/setInterval\([^)]*[Rr]egistry/.test(main), 'no polling');
  const palette = fs.readFileSync(path.join(root, 'public', 'nodes', 'palette.js'), 'utf8');
  assert.match(palette, /function refresh\(\)/);
  assert.match(palette, /return \{ open, close, refresh,/);
  // "has a search text" is decided like the ranking does (a "-" is no search: group headings stay)
  assert.match(palette, /graphLib\.normalizeSearch\(state\.query\)/);
  assert.ok(!/state\.query\.trim\(\)/.test(palette), 'no second, different test for a search text');
}

/* ---------- ties, exact names, synonyms of the image editors ---------- */

function testExactNameIsFirst() {
  // searching a node by its exact name (in any language, as participant or admin) puts exactly that node first
  let checked = 0;
  for (const lang of ['de', 'en', 'es']) {
    for (const role of ['participant', 'admin']) {
      const { entries } = setup(lang, role, 0);
      for (const entry of entries) {
        for (const label of entry.labels) {
          const results = search(lang, role, label);
          const same = entries.filter((other) => other.labels.includes(label)).map((other) => other.type);
          assert.ok(results[0] && same.includes(results[0].type), `[${lang} ${role}] "${label}" finds ${entry.type} first, got ${results[0] && results[0].type}`);
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked > 400, `${checked} exact names checked`);
}

function testNodesBeforeModelsOnTies() {
  // a node and a model with the same hit: the node first, whatever the role or availability of the node
  const reg = registryFor('admin');
  const node = (label, def) => ({ key: label, type: label, category: 'utility', label, labels: [label], keywords: [], search: '', def: { inputs: [], outputs: [], available: true, ...def } });
  const model = { key: 'm:v', type: 'video.higgsfield', params: { model: 'v' }, category: 'higgsfield', label: 'Clip model', labels: ['Clip model'], keywords: [], model: true, search: '', def: { inputs: [], outputs: [], available: true } };
  const entries = [model, node('Clip helper', {}), node('Clip unavailable', { available: 'FAL_KEY is not set' })];
  const order = graphLib.rankPaletteEntries(reg, entries, { query: 'clip' }).map((e) => e.label);
  assert.deepEqual(order, ['Clip helper', 'Clip unavailable', 'Clip model']);
  // a model with "video" in the name comes after "Video input" for "video"
  const video = search('de', 'admin', 'video', { models: 13 });
  const inputAt = indexOfType(video, 'input.video');
  video.forEach((entry, index) => {
    if (entry.model && /video/i.test(entry.label) && /^video/i.test(entry.label)) assert.ok(index > inputAt, `${entry.label} after the video input`);
  });
}

function testImageEditingSynonyms() {
  const first = (lang, query) => search(lang, 'participant', query).map((entry) => entry.type);
  assert.equal(first('de', 'hochskalieren')[0], 'image.resize');
  assert.equal(first('de', 'vergrössern')[0], 'image.resize');
  // the AI cutout with fal (open to participants) answers "remove background" first; "freistellen" still starts with the chroma key
  assert.equal(first('de', 'freistellen')[0], 'image.chroma_key');
  assert.ok(first('de', 'freistellen').slice(0, 3).includes('fal.remove_background'));
  assert.equal(first('de', 'freisteller')[0], 'fal.remove_background');
  assert.equal(first('de', 'hintergrund entfernen')[0], 'fal.remove_background');
  assert.ok(first('en', 'remove background').slice(0, 3).includes('fal.remove_background'));
  assert.ok(first('es', 'quitar fondo').slice(0, 3).includes('fal.remove_background'));
  // "Hintergrundmusik" (music nodes) starts with the same word: all rank at the top, the editors behind the generators.
  assert.ok(first('de', 'hintergrund').slice(0, 4).includes('image.chroma_key'));
  assert.equal(first('de', 'überblenden')[0], 'image.composite');
  assert.equal(first('de', 'zusammenführen')[0], 'image.composite');
  assert.ok(first('de', 'heller').includes('image.adjust'));
  assert.ok(first('de', 'ausschnitt').includes('image.crop'));
  assert.equal(first('en', 'enlarge')[0], 'image.resize');
  assert.equal(first('en', 'green screen')[0], 'image.chroma_key');
  assert.equal(first('es', 'pantalla verde')[0], 'image.chroma_key');
  // the old searches still lead to the same nodes
  assert.equal(first('de', 'crop')[0], 'image.crop');
  assert.equal(first('de', 'zuschneiden')[0], 'image.crop');
  assert.ok(first('de', 'upscale').includes('image.resize'));
}

function testVideoGridSynonyms() {
  // the local comparison node (WP28): the words of the task lead to it, in the three languages
  const first = (lang, query) => search(lang, 'participant', query).map((entry) => entry.type);
  assert.equal(first('de', 'nebeneinander')[0], 'video.grid');
  assert.equal(first('de', 'videos nebeneinander')[0], 'video.grid');
  assert.equal(first('de', 'videos vergleichen')[0], 'video.grid');
  assert.ok(first('de', 'raster').slice(0, 3).includes('video.grid'), '"Raster" also finds "SVG rastern", the grid is among the first');
  assert.equal(first('de', 'vergleich')[0], 'video.grid');
  assert.equal(first('de', 'split screen')[0], 'video.grid');
  assert.ok(first('de', 'beschriftung').includes('video.grid'));
  assert.equal(first('en', 'side by side')[0], 'video.grid');
  assert.equal(first('en', 'compare videos')[0], 'video.grid');
  assert.equal(first('en', 'video grid')[0], 'video.grid');
  assert.equal(first('es', 'comparar vídeos')[0], 'video.grid');
  assert.equal(first('es', 'cuadrícula')[0], 'video.grid');
  // the node is open to everyone and local: participants find it, nothing marks it as restricted
  const entry = search('de', 'participant', 'nebeneinander').find((item) => item.type === 'video.grid');
  assert.ok(entry && entry.def.available === true && !entry.def.restricted);
}

function testVideoSegmentSynonyms() {
  // segmenting a video with SAM 3 (WP33): the words of the task lead to it, in the three languages
  const first = (lang, query) => search(lang, 'participant', query).map((entry) => entry.type);
  assert.equal(first('de', 'video segmentieren')[0], 'fal.video_segment');
  assert.ok(first('de', 'segmentieren').slice(0, 3).includes('fal.video_segment'));
  assert.ok(first('de', 'rotoscoping').slice(0, 3).includes('fal.video_segment'));
  assert.ok(first('de', 'person freistellen').slice(0, 3).includes('fal.video_segment'));
  assert.equal(first('en', 'segment video')[0], 'fal.video_segment');
  assert.ok(first('en', 'rotoscope').slice(0, 3).includes('fal.video_segment'));
  assert.ok(first('en', 'matte').slice(0, 3).includes('fal.video_segment'));
  assert.ok(first('en', 'sam 3').slice(0, 3).includes('fal.video_segment'));
  assert.equal(first('es', 'segmentar vídeo')[0], 'fal.video_segment');
  assert.ok(first('es', 'rotoscopia').slice(0, 3).includes('fal.video_segment'));
  // the image cutout keeps its words: "remove background" does not lead to the video node
  assert.equal(first('de', 'hintergrund entfernen')[0], 'fal.remove_background');
  const background = first('en', 'remove background');
  assert.ok(background.includes('fal.remove_background') && (!background.includes('fal.video_segment') || background.indexOf('fal.video_segment') > background.indexOf('fal.remove_background')));
  // open to everyone, like the other fal nodes
  const entry = search('de', 'participant', 'video segmentieren').find((item) => item.type === 'fal.video_segment');
  assert.ok(entry && !entry.def.restricted);
}

function testVideoEditSynonyms() {
  // editing a video with reference images (WP40): the words of the task lead to it, in the three languages
  const first = (lang, query) => search(lang, 'participant', query).map((entry) => entry.type);
  assert.equal(first('de', 'person ersetzen')[0], 'fal.video_edit');
  assert.equal(first('de', 'personen im video ersetzen')[0], 'fal.video_edit');
  assert.ok(first('de', 'video bearbeiten').slice(0, 3).includes('fal.video_edit'));
  assert.ok(first('de', 'video mit referenzen').slice(0, 2).includes('fal.video_edit'));
  assert.equal(first('en', 'replace person')[0], 'fal.video_edit');
  assert.ok(first('en', 'edit video').slice(0, 3).includes('fal.video_edit'));
  assert.ok(first('en', 'swap person').slice(0, 2).includes('fal.video_edit'));
  assert.equal(first('es', 'reemplazar persona')[0], 'fal.video_edit');
  assert.ok(first('es', 'editar vídeo').slice(0, 3).includes('fal.video_edit'));
  // open to everyone, like the other fal nodes
  const entry = search('de', 'participant', 'person ersetzen').find((item) => item.type === 'fal.video_edit');
  assert.ok(entry && !entry.def.restricted && entry.def.available === true);
}

function testSearchTextNormalization() {
  // a text of only separators is no search (the palette uses the same test for its group headings)
  assert.equal(graphLib.normalizeSearch('-'), '');
  assert.equal(graphLib.normalizeSearch('  . '), '');
  const browse = search('de', 'participant', '-');
  assert.equal(browse.length, search('de', 'participant', '').length, 'a "-" shows the plain list');
}

const tests = [
  testGoldenQueries,
  testAllVideoNodesSurviveManyModels,
  testQuickPickFromImage,
  testNoiseAndTypos,
  testTieOrderAndAvailability,
  testExactNameIsFirst,
  testNodesBeforeModelsOnTies,
  testImageEditingSynonyms,
  testVideoGridSynonyms,
  testVideoSegmentSynonyms,
  testVideoEditSynonyms,
  testSearchTextNormalization,
  testZoomNodeRename,
  testOldWorkflowsStillLoad,
  testUnavailableReasons,
  testRegistryWatcher,
  testRegistryWatcherIsWired
];

(async () => {
  for (const test of tests) {
    await test();
    console.log(`ok ${test.name}`);
  }
  console.log(`search ok: ${tests.length} Gruppen, ${GOLDEN.length + 1} Golden Queries`);
  console.log('test-nodes-search.js: ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
