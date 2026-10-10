'use strict';

// Limits of inputs that follow a param (WP31): the model of a Higgsfield node decides how many reference images and audio
// tracks its inputs take. Pure graph part (public/nodes/graph.js: ports with a limit, refused connections, "n/max",
// port description, a model change keeps the connections), the texts and helpers of public/nodes/node-ui.js (run in
// a vm without a DOM, with the real dictionaries in German, English and Spanish) and static checks of the wiring.
// Server side (validate codes, plan, option lists) is in test-nodes-generate.js.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const graphLib = require('../public/nodes/graph');
const registryModule = require('../lib/nodes/registry');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const payload = JSON.parse(JSON.stringify(registryModule.publicRegistry()));

// What the app knows about each model (the capabilities the client reads); a model that is not in the table is unknown.
const MODELS = {
  grok_like: { name: 'Grok Like 1.5', references: { max: 1, roles: ['start_image'], required: false }, audio: { max: 0 } },
  four_refs: { name: 'Four Refs', references: { max: 4, roles: ['image_references'], required: false }, audio: { max: 3 } },
  start_end: { name: 'Start End', references: { max: 2, roles: ['start_image', 'end_image'], required: false }, audio: { max: 0 } },
  text_only: { name: 'Text Only', references: { max: 0, roles: [], required: false }, audio: { max: 0 } },
  needs_ref: { name: 'Needs Ref', references: { max: 1, roles: ['start_image'], required: true }, audio: { max: 0 } },
  huge: { name: 'Huge', references: { max: 40, roles: [], required: false } }
};

function makeReg(models = MODELS) {
  return graphLib.indexRegistry(payload, {
    limitsFor: (node, def) => {
      const out = {};
      const model = models[(node.params || {}).model];
      if (!model) return out;
      for (const port of def.inputs) {
        const cap = port.limitBy && model[port.limitBy.capability];
        if (cap) out[port.id] = { max: cap.max, roles: cap.roles || [], required: cap.required === true, subject: model.name };
      }
      return out;
    }
  });
}
const reg = makeReg();

// A node of `type` with the model `model`, plus `images` image and `audios` audio sources (connect them with connectAll()).
function scene(model, { images = 0, type = 'video.higgsfield', audios = 0 } = {}) {
  let graph = graphLib.emptyGraph();
  const add = (nodeType, params) => {
    const out = graphLib.addNode(reg, graph, nodeType, { params });
    graph = out.graph;
    return out.node.id;
  };
  const target = add(type, { model });
  const sources = Array.from({ length: images }, () => add('input.image'));
  const sounds = Array.from({ length: audios }, () => add('input.audio'));
  const link = (from, fromPort, port) => {
    const result = graphLib.connect(reg, graph, { node: from, port: fromPort }, { node: target, port });
    assert.ok(!result.error, `${from} -> ${port}: ${result.error && result.error.code}`);
    graph = result.graph;
  };
  return {
    get graph() { return graph; },
    set graph(value) { graph = value; },
    target,
    sources,
    sounds,
    add,
    connectAll: () => {
      for (const id of sources) link(id, 'image', 'refs');
      for (const id of sounds) link(id, 'audio', 'audio');
    }
  };
}

/* ---------- ports with a limit ---------- */

function testPortsFor() {
  const known = graphLib.portsFor(reg, { type: 'video.higgsfield', params: { model: 'four_refs' } }).inputs.find((port) => port.id === 'refs');
  assert.deepEqual(known.limit, { known: true, max: 4, roles: ['image_references'], required: false, subject: 'Four Refs' });
  assert.equal(known.max, 4, 'the limit of the model replaces the fixed maximum');
  assert.equal(graphLib.portMax(known), 4);

  const unknown = graphLib.portsFor(reg, { type: 'video.higgsfield', params: { model: 'brand_new' } }).inputs.find((port) => port.id === 'refs');
  assert.deepEqual(unknown.limit, { known: false });
  assert.equal(unknown.max, 12, 'the fixed maximum stays the ceiling');
  assert.equal(graphLib.portMax(unknown), null, 'but it is not shown as the limit of the model');
  const unchosen = graphLib.portsFor(reg, { type: 'video.higgsfield', params: {} }).inputs.find((port) => port.id === 'refs');
  assert.deepEqual(unchosen.limit, { known: false });

  const zero = graphLib.portsFor(reg, { type: 'image.higgsfield', params: { model: 'text_only' } }).inputs.find((port) => port.id === 'refs');
  assert.equal(zero.max, 0);
  assert.equal(graphLib.portMax(zero), 0, 'none is a number, too');

  const huge = graphLib.portsFor(reg, { type: 'image.higgsfield', params: { model: 'huge' } }).inputs.find((port) => port.id === 'refs');
  assert.equal(huge.max, 12, 'never above the fixed maximum');

  const audio = graphLib.portsFor(reg, { type: 'video.higgsfield', params: { model: 'grok_like' } }).inputs.find((port) => port.id === 'audio');
  assert.equal(audio.max, 0);
  assert.equal(graphLib.findPort(reg, { type: 'video.higgsfield', params: { model: 'four_refs' } }, 'in', 'audio').max, 3);

  // other inputs are untouched, and without the resolver nothing changes
  const prompt = graphLib.portsFor(reg, { type: 'video.higgsfield', params: { model: 'grok_like' } }).inputs.find((port) => port.id === 'prompt');
  assert.equal(prompt.limit, undefined);
  const plain = graphLib.indexRegistry(payload);
  const bare = graphLib.portsFor(plain, { type: 'video.higgsfield', params: { model: 'grok_like' } }).inputs.find((port) => port.id === 'refs');
  assert.equal(bare.limit, undefined);
  assert.equal(bare.max, 12);
  // a resolver that throws does not break the ports
  const broken = graphLib.indexRegistry(payload, { limitsFor: () => { throw new Error('nope'); } });
  assert.deepEqual(graphLib.portsFor(broken, { type: 'video.higgsfield', params: { model: 'x' } }).inputs.find((port) => port.id === 'refs').limit, { known: false });
}

/* ---------- connecting ---------- */

function testCheckConnection() {
  // one reference image (Grok-like): the second is refused with the model and the limit
  let s = scene('grok_like', { images: 2 });
  assert.equal(graphLib.checkConnection(reg, s.graph, { node: s.sources[0], port: 'image' }, { node: s.target, port: 'refs' }), null);
  let result = graphLib.connect(reg, s.graph, { node: s.sources[0], port: 'image' }, { node: s.target, port: 'refs' });
  assert.ok(!result.error);
  s.graph = result.graph;
  const refused = graphLib.checkConnection(reg, s.graph, { node: s.sources[1], port: 'image' }, { node: s.target, port: 'refs' });
  assert.deepEqual(refused, { code: 'too_many', data: { port: 'refs', max: 1, count: 1, model: 'Grok Like 1.5' } });
  const again = graphLib.connect(reg, s.graph, { node: s.sources[1], port: 'image' }, { node: s.target, port: 'refs' });
  assert.equal(again.error.code, 'too_many');
  assert.equal(again.graph, s.graph, 'nothing changes on a refusal');

  // four
  s = scene('four_refs', { images: 5 });
  for (const id of s.sources.slice(0, 4)) {
    const done = graphLib.connect(reg, s.graph, { node: id, port: 'image' }, { node: s.target, port: 'refs' });
    assert.ok(!done.error);
    s.graph = done.graph;
  }
  assert.deepEqual(graphLib.checkConnection(reg, s.graph, { node: s.sources[4], port: 'image' }, { node: s.target, port: 'refs' }).data, { port: 'refs', max: 4, count: 4, model: 'Four Refs' });

  // none: even the first one is refused
  s = scene('text_only', { images: 1 });
  assert.deepEqual(graphLib.checkConnection(reg, s.graph, { node: s.sources[0], port: 'image' }, { node: s.target, port: 'refs' }), { code: 'too_many', data: { port: 'refs', max: 0, count: 0, model: 'Text Only' } });
  s = scene('grok_like', { audios: 1, images: 1 });
  assert.equal(graphLib.checkConnection(reg, s.graph, { node: s.sounds[0], port: 'audio' }, { node: s.target, port: 'audio' }).data.max, 0, 'no audio for a model without an audio input');

  // unknown limit: the fixed maximum of 12 is the ceiling, the refusal does not name a model
  s = scene('brand_new', { images: 13 });
  for (const id of s.sources.slice(0, 12)) {
    const done = graphLib.connect(reg, s.graph, { node: id, port: 'image' }, { node: s.target, port: 'refs' });
    assert.ok(!done.error);
    s.graph = done.graph;
  }
  assert.deepEqual(graphLib.checkConnection(reg, s.graph, { node: s.sources[12], port: 'image' }, { node: s.target, port: 'refs' }), { code: 'too_many', data: { port: 'refs', max: 12, count: 12 } });

  // an input of a fixed model keeps working as before
  let llm = graphLib.emptyGraph();
  const added = graphLib.addNode(reg, llm, 'llm.chat', {});
  llm = added.graph;
  const input = graphLib.addNode(reg, llm, 'input.image', {});
  llm = input.graph;
  assert.equal(graphLib.checkConnection(reg, llm, { node: input.node.id, port: 'image' }, { node: added.node.id, port: 'images' }), null);
}

/* ---------- a model change keeps the connections ---------- */

function testModelChangeKeepsConnections() {
  const s = scene('four_refs', { images: 2, audios: 1 });
  s.connectAll();
  assert.equal(graphLib.incomingEdges(s.graph, s.target).length, 3);
  assert.deepEqual(graphLib.overLimits(reg, s.graph, s.target), []);
  assert.deepEqual(graphLib.capabilityUsage(reg, s.graph, s.target), { references: 2, audio: 1 });

  // the model that takes one image and no audio: the edges stay, the node is over its limits
  let changed = graphLib.setParams(s.graph, s.target, { model: 'grok_like' });
  const pruned = graphLib.pruneEdges(reg, changed, [s.target]);
  assert.equal(pruned, changed, 'pruneEdges leaves the graph alone: connections beyond a limit are not removed');
  assert.equal(pruned.edges.length, 3);
  assert.deepEqual(graphLib.overLimits(reg, changed, s.target), [
    { port: 'refs', count: 2, max: 1, model: 'Grok Like 1.5' },
    { port: 'audio', count: 1, max: 0, model: 'Grok Like 1.5' }
  ]);
  // and nothing more can be added
  const extra = graphLib.addNode(reg, changed, 'input.image', {});
  assert.equal(graphLib.checkConnection(reg, extra.graph, { node: extra.node.id, port: 'image' }, { node: s.target, port: 'refs' }).code, 'too_many');

  // an unknown model: no verdict (the server judges when it knows the model)
  changed = graphLib.setParams(s.graph, s.target, { model: 'brand_new' });
  assert.deepEqual(graphLib.overLimits(reg, changed, s.target), []);
  assert.equal(graphLib.pruneEdges(reg, changed, [s.target]), changed);

  // a model with room again: the very same connections are fine
  changed = graphLib.setParams(changed, s.target, { model: 'four_refs' });
  assert.deepEqual(graphLib.overLimits(reg, changed, s.target), []);

  // a fixed list of models (portVariants): the input stays with its connection, it just takes none
  let speech = graphLib.emptyGraph();
  const node = graphLib.addNode(reg, speech, 'hf.speech', { params: {} });
  speech = node.graph;
  const voice = graphLib.addNode(reg, speech, 'input.audio', {});
  speech = voice.graph;
  const link = graphLib.connect(reg, speech, { node: voice.node.id, port: 'audio' }, { node: node.node.id, port: 'reference_audio' });
  assert.ok(!link.error, 'seed_audio takes reference audio');
  speech = graphLib.setParams(link.graph, node.node.id, { model: 'text2speech_v2' });
  assert.equal(graphLib.pruneEdges(reg, speech, [node.node.id]).edges.length, 1, 'the connection stays');
  const second = graphLib.addNode(reg, speech, 'input.audio', {});
  const refusedSpeech = graphLib.checkConnection(reg, second.graph, { node: second.node.id, port: 'audio' }, { node: node.node.id, port: 'reference_audio' });
  assert.deepEqual(refusedSpeech, { code: 'too_many', data: { port: 'reference_audio', max: 0, count: 1 } }, 'no model name: the list of models is fixed');
}

/* ---------- port description (tooltip) ---------- */

function testDescribePort() {
  const keys = (description) => description.facts.map((fact) => fact.key);
  let s = scene('grok_like', { images: 2 });
  s.graph = graphLib.connect(reg, s.graph, { node: s.sources[0], port: 'image' }, { node: s.target, port: 'refs' }).graph;
  let d = graphLib.describePort(reg, s.graph, s.target, 'in', 'refs');
  assert.equal(d.max, 1);
  assert.equal(d.count, 1);
  assert.equal(d.overLimit, false);
  assert.deepEqual(d.limit, { known: true, max: 1, roles: ['start_image'], required: false, subject: 'Grok Like 1.5' });
  assert.deepEqual(keys(d), ['nodes.porttip.fact.limit.one']);
  assert.deepEqual(d.facts[0].vars, { model: 'Grok Like 1.5', max: 1, count: 1 });

  // two connected to a model that takes one: marked as an error in the tooltip, too (the edge is made without the check)
  const over = { ...s.graph, edges: [...s.graph.edges, { id: 'e9', from: { node: s.sources[1], port: 'image' }, to: { node: s.target, port: 'refs' } }] };
  d = graphLib.describePort(reg, over, s.target, 'in', 'refs');
  assert.equal(d.overLimit, true);
  assert.deepEqual(keys(d), ['nodes.porttip.fact.limit.one', 'nodes.porttip.fact.limitOver']);
  assert.equal(d.facts[1].error, true);
  assert.deepEqual(d.facts[1].vars, { count: 2, max: 1 });

  // several, with roles and a list fact; none; required
  s = scene('start_end');
  d = graphLib.describePort(reg, s.graph, s.target, 'in', 'refs');
  assert.deepEqual(keys(d), ['nodes.porttip.fact.limit.many', 'nodes.porttip.fact.multiListMediaMax']);
  assert.deepEqual(d.limit.roles, ['start_image', 'end_image']);
  s = scene('text_only');
  assert.deepEqual(keys(graphLib.describePort(reg, s.graph, s.target, 'in', 'refs')), ['nodes.porttip.fact.limit.none']);
  s = scene('needs_ref');
  assert.deepEqual(keys(graphLib.describePort(reg, s.graph, s.target, 'in', 'refs')), ['nodes.porttip.fact.limit.one', 'nodes.porttip.fact.limitRequired']);

  // unknown: no number, no claim of a limit; "choose a model" while there is none
  s = scene('brand_new');
  d = graphLib.describePort(reg, s.graph, s.target, 'in', 'refs');
  assert.equal(d.max, null);
  assert.deepEqual(d.limit, { known: false, chosen: true });
  assert.deepEqual(keys(d), ['nodes.porttip.fact.limitUnknown', 'nodes.porttip.fact.multiListMedia']);
  s = scene('');
  d = graphLib.describePort(reg, s.graph, s.target, 'in', 'refs');
  assert.deepEqual(d.limit, { known: false, chosen: false });
  assert.equal(keys(d)[0], 'nodes.porttip.fact.limitChoose');

  // reading the model failed: the limit is unknown for good, and the tooltip says so instead of "still loading"
  const failing = graphLib.indexRegistry(payload, { limitsFor: (node, def) => Object.fromEntries(def.inputs.filter((port) => port.limitBy).map((port) => [port.id, { error: true }])) });
  s = scene('gone_model');
  s.graph = { ...s.graph };
  d = graphLib.describePort(failing, s.graph, s.target, 'in', 'refs');
  assert.deepEqual(d.limit, { known: false, error: true, chosen: true });
  assert.deepEqual(keys(d), ['nodes.porttip.fact.limitError', 'nodes.porttip.fact.multiListMedia']);
  assert.equal(d.max, null);
  assert.equal(graphLib.portsFor(failing, { type: 'video.higgsfield', params: { model: 'gone_model' } }).inputs.find((port) => port.id === 'refs').max, 12, 'the fixed ceiling stays');

  // a fixed maximum of 0 (hf.speech, text2speech_v2): one clear statement, and an error once something is connected
  let speech = graphLib.emptyGraph();
  const speaker = graphLib.addNode(reg, speech, 'hf.speech', { params: { model: 'text2speech_v2' } });
  speech = speaker.graph;
  d = graphLib.describePort(reg, speech, speaker.node.id, 'in', 'reference_audio');
  assert.equal(d.max, 0);
  assert.equal(d.overLimit, false);
  assert.deepEqual(keys(d), ['nodes.porttip.fact.takesNone']);
  for (let i = 0; i < 2; i += 1) {
    const voice = graphLib.addNode(reg, speech, 'input.audio', {});
    speech = { ...voice.graph, edges: [...voice.graph.edges, { id: `es${i}`, from: { node: voice.node.id, port: 'audio' }, to: { node: speaker.node.id, port: 'reference_audio' } }] };
  }
  d = graphLib.describePort(reg, speech, speaker.node.id, 'in', 'reference_audio');
  assert.equal(d.count, 2);
  assert.equal(d.overLimit, true, '2 connected to an input that takes 0 is an error, as the card shows it');
  assert.deepEqual(keys(d), ['nodes.porttip.fact.takesNone', 'nodes.porttip.fact.limitOver']);
  assert.equal(d.facts[1].error, true);
  assert.deepEqual(d.facts[1].vars, { count: 2, max: 0 });
  // the same input with a model that takes reference audio is described as before
  d = graphLib.describePort(reg, graphLib.setParams(speech, speaker.node.id, { model: 'seed_audio' }), speaker.node.id, 'in', 'reference_audio');
  assert.equal(d.overLimit, false);
  assert.equal(d.facts[0].key, 'nodes.porttip.fact.multi');

  // an input without such a limit is described as before
  const plain = graphLib.describePort(reg, scene('grok_like').graph, 'n1', 'in', 'prompt');
  assert.equal(plain.limit, null);
  assert.equal(plain.overLimit, false);
}

/* ---------- the registry descriptor and the help ---------- */

function testDescriptor() {
  for (const type of ['image.higgsfield', 'video.higgsfield']) {
    const refs = payload.nodeTypes.find((def) => def.type === type).inputs.find((port) => port.id === 'refs');
    assert.deepEqual(refs.limitBy, { param: 'model', capability: 'references' });
    assert.equal(refs.max, 12, 'the ceiling stays in the descriptor');
  }
  assert.deepEqual(payload.nodeTypes.find((def) => def.type === 'video.higgsfield').inputs.find((port) => port.id === 'audio').limitBy, { param: 'model', capability: 'audio' });
  const limited = payload.nodeTypes.filter((def) => def.inputs.some((port) => port.limitBy)).map((def) => def.type).sort();
  assert.deepEqual(limited, ['fal.image_to_3d', 'image.edit', 'image.generate', 'image.higgsfield', 'video.generate', 'video.higgsfield'], 'the only nodes whose limit follows a model (image.generate: its optional reference images, WP50)');
  // the help does not state 12 as if every model took that many
  const help = read('public/nodes/node-help.js');
  assert.ok(/!port\.limitBy/.test(help), 'node-help.js leaves out the fixed maximum of an input that follows the model');
}

/* ---------- texts and helpers of node-ui.js ---------- */

function loadUi(lang, options = {}) {
  const storage = new Map([['vcd-lang', lang]]);
  const window = {
    document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
    navigator: { language: 'de-CH' },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) },
    OCDNodes: { graph: graphLib, api: options.api || {} }
  };
  vm.runInNewContext(read('public/i18n.js'), { window }, { filename: 'public/i18n.js' });
  vm.runInNewContext(read('public/nodes/i18n-nodes.js'), { window }, { filename: 'public/nodes/i18n-nodes.js' });
  // options.clock = { offset } moves the time of the page (milliseconds) without waiting
  const clock = options.clock || { offset: 0 };
  const PageDate = class extends Date {
    static now() {
      return Date.now() + clock.offset;
    }
  };
  vm.runInNewContext(read('public/nodes/node-ui.js'), { window, document: window.document, setTimeout, clearTimeout, Date: PageDate }, { filename: 'public/nodes/node-ui.js' });
  return { ui: window.OCDNodes.ui, window };
}

function testCountText() {
  const { ui } = loadUi('de');
  const limited = (count, max, known = true) => ({ multiple: true, max, limit: known ? { known: true, max, subject: 'M' } : { known: false } });
  assert.equal(ui.portCountText(limited(0, 1), 0), '', 'nothing connected: no badge');
  assert.equal(ui.portCountText(limited(1, 1), 1), '1/1');
  assert.equal(ui.portCountText(limited(2, 1), 2), '2/1', 'more than the model takes shows the numbers as they are');
  assert.equal(ui.portCountText(limited(1, 0), 1), '1/0');
  assert.equal(ui.portCountText({ multiple: true, max: 12, limit: { known: false } }, 3), '3', 'unknown limit: only the number');
  assert.equal(ui.portCountText({ multiple: true, max: 9 }, 2), '2/9', 'a fixed maximum as before');
  assert.equal(ui.portCountText({ multiple: true }, 2), '2/∞');
  assert.equal(ui.portCountText({ multiple: false }, 1), '');

  assert.equal(ui.portOverLimit(limited(2, 1), 2), true);
  assert.equal(ui.portOverLimit(limited(1, 1), 1), false);
  assert.equal(ui.portOverLimit(limited(1, 0), 1), true);
  assert.equal(ui.portOverLimit({ multiple: true, max: 12, limit: { known: false } }, 5), false, 'unknown limit: no error');
  assert.equal(ui.portOverLimit({ multiple: true, max: 12, limit: { known: false } }, 13), true, 'but the fixed ceiling is a limit');
  // a fixed maximum is a limit like any other, 0 included (hf.speech with a model that takes no reference audio)
  assert.equal(ui.portOverLimit({ multiple: true, max: 2 }, 3), true);
  assert.equal(ui.portOverLimit({ multiple: true, max: 2 }, 2), false);
  assert.equal(ui.portOverLimit({ multiple: true, max: 0 }, 2), true);
  assert.equal(ui.portCountText({ multiple: true, max: 0 }, 2), '2/0');
  assert.equal(ui.portOverLimit({ multiple: true }, 99), false, 'no maximum, no error');
  assert.equal(ui.portOverLimit({ multiple: false, max: 0 }, 1), false);
}

const ALL = ['de', 'en', 'es'];
// objects made inside a vm have another Object prototype: compare them as JSON
const plain = (value) => JSON.parse(JSON.stringify(value));

function testConnectTexts() {
  for (const lang of ALL) {
    const { ui } = loadUi(lang);
    const text = (data) => ui.connectText({ code: 'too_many', data });
    const one = text({ port: 'refs', max: 1, count: 1, model: 'Grok Video 1.5' });
    const many = text({ port: 'refs', max: 4, count: 4, model: 'Four Refs' });
    const none = text({ port: 'refs', max: 0, count: 0, model: 'Text Only' });
    assert.ok(one.includes('Grok Video 1.5') && /\b1\b/.test(one), `${lang}: names the model and the limit: ${one}`);
    assert.ok(many.includes('Four Refs') && many.includes('4'), `${lang}: ${many}`);
    assert.ok(none.includes('Text Only') && !/\b0\b/.test(none), `${lang}: none is worded as none: ${none}`);
    assert.notEqual(one, many);
    assert.notEqual(many, none);
    const audio = text({ port: 'audio', max: 2, count: 2, model: 'M' });
    assert.notEqual(audio, text({ port: 'refs', max: 2, count: 2, model: 'M' }), `${lang}: audio has its own wording`);
    const generic = text({ port: 'items', max: 3, count: 3, model: 'M' });
    assert.ok(generic.includes('M') && generic.includes('3'), `${lang}: any other input still names model and limit: ${generic}`);
    // without a model: a fixed maximum says what it always said; none says that nothing is taken
    assert.equal(text({ port: 'x', max: 5, count: 5 }), ui.T('nodes.connect.too_many'));
    assert.equal(text({ port: 'reference_audio', max: 0, count: 0 }), ui.T('nodes.connect.too_many.none'));
    // plain codes and the old call with a string
    assert.equal(ui.connectText({ code: 'cycle' }), ui.T('nodes.connect.cycle'));
    assert.equal(ui.connectText('incompatible'), ui.T('nodes.connect.incompatible'));
    assert.equal(ui.connectText({ code: 'too_many' }), ui.T('nodes.connect.too_many'));
    for (const value of [one, many, none, audio, generic]) assert.ok(!/[{}]|ß/.test(value), `${lang}: complete text without ß: ${value}`);
  }
  // the example of the brief
  assert.equal(loadUi('de').ui.connectText({ code: 'too_many', data: { port: 'refs', max: 1, count: 1, model: 'Grok Video 1.5' } }), 'Grok Video 1.5 nimmt höchstens 1 Referenzbild an.');
}

function testIssueTexts() {
  for (const lang of ALL) {
    const { ui } = loadUi(lang);
    const issue = (code, data) => ui.issueText({ code, data, port: 'refs', message: 'raw' });
    const many = issue('too_many_refs', { model: 'Grok Like 1.5', max: 4, count: 6 });
    const one = issue('too_many_refs', { model: 'Grok Like 1.5', max: 1, count: 2 });
    const none = issue('too_many_refs', { model: 'Text Only', max: 0, count: 1 });
    assert.ok(many.includes('Grok Like 1.5') && many.includes('4') && many.includes('6'), `${lang}: ${many}`);
    assert.ok(/\b1\b/.test(one) && one.includes('2'), `${lang}: ${one}`);
    assert.ok(none.includes('Text Only') && !/\b0\b/.test(none), `${lang}: ${none}`);
    assert.ok(new Set([many, one, none]).size === 3);
    const audioMany = issue('too_many_audio', { model: 'Audio Model', max: 2, count: 3 });
    const audioOne = issue('too_many_audio', { model: 'Audio Model', max: 1, count: 2 });
    const audioNone = issue('too_many_audio', { model: 'Grok Like 1.5', max: 0, count: 2 });
    assert.ok(audioMany.includes('Audio Model') && audioMany.includes('2') && audioMany.includes('3'), `${lang}: ${audioMany}`);
    assert.ok(/\b1\b/.test(audioOne) && audioOne.includes('2'), `${lang}: ${audioOne}`);
    assert.ok(audioNone.includes('Grok Like 1.5') && !/\b0\b/.test(audioNone), `${lang}: ${audioNone}`);
    assert.ok(new Set([audioMany, audioOne, audioNone]).size === 3);
    assert.equal(ui.hasIssueText('too_many_audio'), true);
    for (const value of [audioMany, audioOne, audioNone]) assert.ok(!/[{}]|ß/.test(value) && value !== 'raw', `${lang}: ${value}`);
    const required = issue('refs_required', { model: 'Needs Ref' });
    assert.ok(required.includes('Needs Ref'), `${lang}: ${required}`);
    for (const value of [many, one, none, required]) {
      assert.ok(!/[{}]|ß/.test(value), `${lang}: complete text without ß: ${value}`);
      assert.ok(value !== 'raw', `${lang}: translated`);
    }
    assert.equal(ui.hasIssueText('too_many_refs'), true);
    assert.equal(ui.hasIssueText('refs_required'), true);
    // texts of other issues are unchanged by the wording for a number of connections
    assert.equal(ui.issueText({ code: 'invalid_param', data: { max: 1 }, message: 'x' }), ui.T('nodes.issue.invalid_param', { message: 'x', max: 1 }));
  }
  assert.ok(/Referenzbilder an, am Eingang «Referenzen» hängen aber 6/.test(loadUi('de').ui.issueText({ code: 'too_many_refs', port: 'refs', data: { model: 'M', max: 4, count: 6 } })));
}

function testCapabilityTexts() {
  const expected = {
    de: { one: '1 Bild', up: 'bis 4 Bilder', startEnd: 'Start- und Endbild', none: 'ohne Referenzbild', required: '1 Bild (Pflicht)', audio: 'Audio' },
    en: { one: '1 image', up: 'up to 4 images', startEnd: 'start and end image', none: 'no reference image', required: '1 image (required)', audio: 'audio' },
    es: { one: '1 imagen', up: 'hasta 4 imágenes', startEnd: 'imagen inicial y final', none: 'sin imagen de referencia', required: '1 imagen (obligatorio)', audio: 'audio' }
  };
  for (const lang of ALL) {
    const { ui } = loadUi(lang);
    const want = expected[lang];
    const text = (references, audio) => ui.capabilitiesText({ references, audio });
    assert.equal(text(MODELS.grok_like.references), want.one);
    assert.equal(text(MODELS.four_refs.references), want.up);
    assert.equal(text(MODELS.start_end.references), want.startEnd);
    assert.equal(text(MODELS.text_only.references), want.none);
    assert.equal(text(MODELS.needs_ref.references), want.required);
    assert.equal(text({ max: 2, roles: ['image'], required: false }), ui.T('nodes.cap.refs.upTo', { max: 2 }), 'two images without start and end roles');
    assert.equal(text(MODELS.four_refs.references, { max: 3 }), `${want.up}, ${ui.T('nodes.cap.audioUpTo', { max: 3 })}`);
    assert.equal(text(MODELS.four_refs.references, { max: 15 }), `${want.up}, ${want.audio}`);
    assert.equal(text(MODELS.grok_like.references, { max: 0 }), want.one, 'a model without audio says nothing about it');
    assert.equal(text(null, null), '', 'unknown: no text');
    assert.equal(ui.capabilitiesText(null), '');

    // models that do not fit the connections
    const miss = (caps, usage) => ui.misfitText(caps, usage);
    const grok = { references: MODELS.grok_like.references, audio: MODELS.grok_like.audio };
    assert.equal(miss(grok, { references: 1, audio: 0 }), '');
    assert.equal(miss(grok, { references: 0, audio: 0 }), '');
    assert.equal(miss(grok, null), '');
    assert.equal(miss(null, { references: 3 }), '');
    assert.equal(miss(grok, { references: 2, audio: 0 }), ui.T('nodes.cap.misfit.refs', { max: 1, count: 2 }));
    assert.equal(miss({ references: MODELS.text_only.references }, { references: 1 }), ui.T('nodes.cap.misfit.noRefs', { count: 1 }));
    assert.equal(miss(grok, { references: 1, audio: 2 }), ui.T('nodes.cap.misfit.noAudio', { count: 2 }));
    assert.equal(miss({ references: MODELS.four_refs.references, audio: { max: 1 } }, { references: 1, audio: 2 }), ui.T('nodes.cap.misfit.audio', { max: 1, count: 2 }));
    for (const value of [miss(grok, { references: 2 }), miss(grok, { audio: 2 }), miss({ references: MODELS.text_only.references }, { references: 1 })]) assert.ok(!/[{}]|ß/.test(value) && value.length > 5, `${lang}: ${value}`);

    // an entry of the model list: name, what it takes, and why it does not fit
    const fit = ui.modelOptionLabel({ value: 'grok_like', label: 'Grok Like 1.5', ...MODELS.grok_like }, { references: 1, audio: 0 });
    assert.deepEqual(plain(fit), { text: `Grok Like 1.5 · ${want.one}`, misfit: false });
    const unfit = ui.modelOptionLabel({ value: 'grok_like', label: 'Grok Like 1.5', ...MODELS.grok_like }, { references: 2, audio: 0 });
    assert.deepEqual(plain(unfit), { text: `Grok Like 1.5 · ${want.one} ${ui.T('nodes.cap.misfitShort.refs', { max: 1, count: 2 })}`, misfit: true });
    assert.ok(unfit.text.length < `Grok Like 1.5 · ${want.one} — ${ui.T('nodes.cap.misfit.refs', { max: 1, count: 2 })}`.length, `${lang}: the hint in the list is the short one`);
    assert.ok(unfit.text.length <= 44, `${lang}: fits a closed field: ${unfit.text}`);
    assert.equal(ui.misfitText(grok, { references: 2 }, { short: true }), ui.T('nodes.cap.misfitShort.refs', { max: 1, count: 2 }));
    assert.equal(ui.misfitText({ references: MODELS.text_only.references }, { references: 1 }, { short: true }), ui.T('nodes.cap.misfitShort.noRefs', { count: 1 }));
    assert.equal(ui.misfitText(grok, { audio: 2 }, { short: true }), ui.T('nodes.cap.misfitShort.noAudio', { count: 2 }));
    assert.equal(ui.misfitText({ references: MODELS.four_refs.references, audio: { max: 1 } }, { audio: 2 }, { short: true }), ui.T('nodes.cap.misfitShort.audio', { max: 1, count: 2 }));
    for (const value of [ui.T('nodes.cap.misfitShort.refs', { max: 1 }), ui.T('nodes.cap.misfitShort.noRefs', { count: 2 }), ui.T('nodes.cap.misfitShort.audio', { max: 1 }), ui.T('nodes.cap.misfitShort.noAudio', { count: 2 })]) assert.ok(!/[{}]|ß/.test(value), `${lang}: ${value}`);
  }
  // the German examples of the brief
  const de = loadUi('de').ui;
  assert.equal(de.modelOptionLabel({ label: 'Grok', ...MODELS.grok_like }, { references: 2 }).text, 'Grok · 1 Bild ⚠ nur 1');
  assert.equal(de.misfitText({ references: MODELS.grok_like.references }, { references: 2 }), 'nimmt nur 1, 2 verbunden', 'the inspector keeps the full reason');

  // roles of the slots are readable, also the ones nobody wrote a text for
  for (const lang of ALL) {
    const { ui, window } = loadUi(lang);
    for (const role of ['start_image', 'end_image', 'first_frame', 'last_frame', 'image', 'image_references', 'reference_image', 'input_image', 'subject']) {
      assert.ok(window.I18N[lang][`nodes.role.${role}`], `${lang}: ${role} has a label`);
      assert.ok(!/[_ß]/.test(ui.roleLabel(role)), `${lang}: ${ui.roleLabel(role)}`);
    }
    assert.equal(ui.roleLabel('some_new_role'), 'Some new role');
  }
  assert.equal(loadUi('de').ui.roleLabel('start_image'), 'Startbild');
  assert.equal(loadUi('de').ui.roleLabel('end_image'), 'Endbild');
}

function testOptionsKeepCapabilities() {
  const { ui } = loadUi('en');
  const options = ui.normalizeOptions({ options: [
    { value: 'a', label: 'A', references: { max: 1, roles: [], required: false }, audio: { max: 0 } },
    { value: 'b', label: 'B' },
    'plain'
  ] });
  assert.deepEqual(plain(options[0]), { value: 'a', label: 'A', references: { max: 1, roles: [], required: false }, audio: { max: 0 } });
  assert.deepEqual(plain(options[1]), { value: 'b', label: 'B' }, 'entries without capabilities stay as they were');
  assert.deepEqual(plain(options[2]), { value: 'plain', label: 'plain' });
}

// The model description is read once; the answer is a refresh of the limits. The option list answers without a request.
async function testCapabilityStore() {
  const calls = [];
  const answers = new Map();
  const api = {
    higgsfieldModel: (id) => {
      calls.push(id);
      return new Promise((resolve, reject) => answers.set(id, { resolve, reject }));
    },
    options: () => Promise.resolve({ options: [{ value: 'listed', label: 'Listed Model', references: { max: 3, roles: [], required: false }, audio: { max: 0 } }, { value: 'partial', label: 'Partial' }] })
  };
  const clock = { offset: 0 };
  const { ui } = loadUi('en', { api, clock });
  const def = payload.nodeTypes.find((item) => item.type === 'video.higgsfield');
  const node = (model) => ({ id: 'n1', type: 'video.higgsfield', params: { model } });
  const told = [];
  ui.onModelChange((id) => told.push(id));

  assert.deepEqual(plain(ui.limitsFor(node(''), def)), {}, 'no model: nothing to ask');
  assert.deepEqual(calls, []);

  // not in any list: the description is asked for once, the answer is "unknown" until it arrives
  assert.deepEqual(plain(ui.limitsFor(node('grok_like'), def)), {});
  assert.deepEqual(plain(ui.limitsFor(node('grok_like'), def)), {});
  assert.deepEqual(calls, ['grok_like'], 'asked once');
  answers.get('grok_like').resolve({ id: 'grok_like', name: 'Grok Like 1.5', references: MODELS.grok_like.references, audio: MODELS.grok_like.audio });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(told, ['grok_like'], 'the listeners are told');
  assert.deepEqual(plain(ui.limitsFor(node('grok_like'), def)), {
    refs: { max: 1, roles: ['start_image'], required: false, subject: 'Grok Like 1.5' },
    audio: { max: 0, roles: [], required: false, subject: 'Grok Like 1.5' }
  });
  assert.deepEqual(plain(ui.optionCapabilities('higgsfield-video-models', 'grok_like').references), MODELS.grok_like.references);
  assert.equal(ui.peekModelDetail('grok_like').state, 'ready');
  assert.equal(ui.peekModelDetail('other'), null);

  // a model whose description has no media list (unknown references) stays unknown
  ui.optionsFor({ optionsSource: 'higgsfield-video-models' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  calls.length = 0;
  assert.deepEqual(plain(ui.limitsFor(node('listed'), def).refs), { max: 3, roles: [], required: false, subject: 'Listed Model' }, 'the list answers without a request');
  assert.deepEqual(calls, []);
  assert.equal(ui.optionCapabilities('higgsfield-video-models', 'listed').name, 'Listed Model');
  ui.limitsFor(node('partial'), def);
  assert.deepEqual(calls, ['partial'], 'a list entry without capabilities is read as a description');
  answers.get('partial').resolve({ id: 'partial', name: 'Partial One', references: null });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(plain(ui.limitsFor(node('partial'), def)), {}, 'no media list: no limit');

  // a failed read is unknown, and asked again after a refresh
  ui.limitsFor(node('broken'), def);
  answers.get('broken').reject(new Error('503'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(ui.peekModelDetail('broken').state, 'error');
  calls.length = 0;
  assert.deepEqual(plain(ui.limitsFor(node('broken'), def)), { refs: { error: true }, audio: { error: true } }, 'unknown, and marked as failed');
  assert.deepEqual(calls, [], 'not asked again at once');
  ui.refreshModelDetails();
  assert.equal(ui.peekModelDetail('broken'), null);
  ui.limitsFor(node('broken'), def);
  assert.deepEqual(calls, ['broken']);
  assert.equal(ui.peekModelDetail('grok_like').state, 'ready', 'good descriptions are kept');

  // the unknown limit of a model that could not be read is marked as such (not "still loading")
  assert.deepEqual(plain(ui.optionCapabilities('higgsfield-video-models', 'broken')).error, false, 'asked again: loading, not an error');
  answers.get('broken').reject(new Error('404'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(ui.optionCapabilities('higgsfield-video-models', 'broken').error, true);
  assert.deepEqual(plain(ui.limitsFor(node('broken'), def)), { refs: { error: true }, audio: { error: true } });
  const errorReg = graphLib.indexRegistry(payload, { limitsFor: ui.limitsFor });
  assert.deepEqual(graphLib.portsFor(errorReg, node('broken')).inputs.find((item) => item.id === 'refs').limit, { known: false, error: true });
  assert.equal(ui.optionCapabilities('higgsfield-video-models', 'grok_like').error, false);

  // a description is not kept for good: after the time to live it is read again, the old one stays in use meanwhile
  calls.length = 0;
  try {
    clock.offset = 21 * 60 * 1000;
    const stale = plain(ui.limitsFor(node('grok_like'), def));
    assert.equal(stale.refs.max, 1, 'the old description answers meanwhile');
    assert.deepEqual(calls, ['grok_like'], 'and a new one is asked for');
    ui.limitsFor(node('grok_like'), def);
    ui.refreshStaleModelDetails();
    assert.deepEqual(calls.filter((id) => id === 'grok_like'), ['grok_like'], 'once');
    assert.ok(calls.includes('partial'), 'the other descriptions that are out of date are read again, too');
    told.length = 0;
    answers.get('grok_like').resolve({ id: 'grok_like', name: 'Grok Like 1.5', references: { max: 2, roles: ['start_image', 'end_image'], required: false }, audio: { max: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(told, ['grok_like'], 'the cards are told');
    assert.equal(plain(ui.limitsFor(node('grok_like'), def)).refs.max, 2, 'the new description is in use');
    calls.length = 0;
    ui.limitsFor(node('grok_like'), def);
    assert.deepEqual(calls, [], 'fresh again');
    // a refresh that fails keeps what was known
    clock.offset = 60 * 60 * 1000;
    ui.refreshStaleModelDetails();
    assert.deepEqual(calls.filter((id) => id === 'grok_like'), ['grok_like']);
    answers.get('grok_like').reject(new Error('503'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(ui.peekModelDetail('grok_like').state, 'ready');
    assert.equal(plain(ui.limitsFor(node('grok_like'), def)).refs.max, 2);
  } finally {
    clock.offset = 0;
  }

  // the registry of the app with this resolver: the port of a card follows the model
  const appReg = graphLib.indexRegistry(payload, { limitsFor: ui.limitsFor });
  const port = graphLib.portsFor(appReg, node('grok_like')).inputs.find((item) => item.id === 'refs');
  assert.equal(port.max, 2, 'the description that was read last');
  assert.equal(port.limit.subject, 'Grok Like 1.5');
}

/* ---------- wiring ---------- */

function testWiring() {
  const main = read('public/nodes/main.js');
  assert.equal((main.match(/indexRegistry\(payload, \{ limitsFor: ui\.limitsFor \}\)/g) || []).length, 2, 'both places that index the registry pass the limits');
  assert.ok(/ui\.onModelChange\(onModelCapabilities\)/.test(main), 'a model description refreshes cards and plan');
  assert.ok(/canvas\.refreshLimits\(\)/.test(main) && /runController\.refreshPlan\(\)/.test(main));
  assert.ok(/ui\.connectText\(/.test(main) && !/nodes\.connect\.\$\{/.test(main), 'refused connections are worded by ui.connectText');
  assert.ok(/noticeModelLimits\(nodeId\)/.test(main), 'a model change gives a notice once');
  const canvas = read('public/nodes/canvas.js');
  assert.ok(/incomingEdges\(\(drag && drag\.baseGraph\) \|\| graph, nodeId, portId\)/.test(canvas), 'the target marks of a drag count the connections without the one being moved');
  assert.ok(/ui\.refreshStaleModelDetails\(\)/.test(read('public/nodes/run.js')), 'a run starts with fresh model descriptions');
  assert.ok(/onConnectRefused\(error\)/.test(canvas), 'the canvas hands over the whole error');
  assert.ok(/refreshLimits,/.test(canvas));
  const inspector = read('public/nodes/inspector.js');
  assert.ok(/ui\.modelDetail\(modelId\)/.test(inspector) && !/modelCache/.test(inspector), 'the inspector shares the model descriptions');
  assert.ok(/usage: param\.optionsSource/.test(inspector), 'the model list gets the connections of the node');
  const graphSource = read('public/nodes/graph.js');
  assert.ok(!/require\('\.\/(node-ui|api)/.test(graphSource) && !/\bfetch\(|document\./.test(graphSource), 'graph.js stays pure');
  for (const file of ['node-ui.js', 'inspector.js', 'port-tip.js', 'main.js', 'canvas.js']) {
    assert.ok(!/innerHTML/.test(read(`public/nodes/${file}`).replace(/\/\/.*$/gm, '')), `${file}: no innerHTML`);
  }
  const css = read('public/nodes/nodes.css');
  for (const rule of ['.nv-port-count.is-over', '.nv-porttip-facts li.is-error', '.nv-select option[data-misfit]', '.nv-model-misfit', '.nv-model-takes']) assert.ok(css.includes(rule), `CSS rule ${rule}`);
  assert.ok(/data-misfit|misfit: '1'/.test(read('public/nodes/node-ui.js')));
}

async function main() {
  const sync = [testPortsFor, testCheckConnection, testModelChangeKeepsConnections, testDescribePort, testDescriptor, testCountText, testConnectTexts, testIssueTexts, testCapabilityTexts, testOptionsKeepCapabilities, testWiring];
  for (const test of sync) {
    test();
    console.log(`ok ${test.name}`);
  }
  await testCapabilityStore();
  console.log('ok testCapabilityStore');
  console.log('test-nodes-limits.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
