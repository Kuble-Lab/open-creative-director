'use strict';

// Assistant of the node view, the panel (WP25, part 2: public/nodes/assistant-ui.js).
//
//   P   the pure part: the canvas as data, the history, the proposal -> a sub graph, the notes about adjusted values, the
//       cost of the inserted nodes from the engine plan, the texts of failures (in three languages)
//   G   the proposal goes into the real graph model as ONE insertion; what was there stays; wrong links are skipped
//   C   the controller on a small fake DOM: opening, asking, answering, the links to the node help, the card with undo and
//       cost, the conversation per workflow, errors with and without "ask again", the keys
//   W   static checks of the wiring: script order, no HTML from strings, every CSS class has a rule, every text exists in
//       German, English and Spanish

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const assistant = require('../public/nodes/assistant-ui');
const graphLib = require('../public/nodes/graph');
const runLib = require('../public/nodes/run');
const historyLib = require('../public/nodes/history');
const registryModule = require('../lib/nodes/registry');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const reg = graphLib.indexRegistry(JSON.parse(JSON.stringify(registryModule.publicRegistry())));

function loadDictionary(lang) {
  const window = { document: { documentElement: { lang: '' }, querySelectorAll: () => [] }, navigator: { language: lang }, localStorage: { getItem: (key) => (key === 'vcd-lang' ? lang : null), setItem: () => {} } };
  vm.runInNewContext(read('public/i18n.js'), { window }, { filename: 'public/i18n.js' });
  vm.runInNewContext(read('public/nodes/i18n-nodes.js'), { window }, { filename: 'public/nodes/i18n-nodes.js' });
  return window;
}
const dictionaries = Object.fromEntries(['de', 'en', 'es'].map((lang) => [lang, loadDictionary(lang)]));
const textOf = (lang) => (key, vars) => dictionaries[lang].t(key, vars);

/* ---------- P: pure part ---------- */

function testSummarizeCanvas() {
  const graph = {
    nodes: [
      { id: 'n1', type: 'input.prompt', title: '  Idee  ', x: 1, y: 2, params: { prompt: 'Ein Fuchs', empty: '   ', count: 3, on: true, asset: { sessionId: 's', assetId: 'a', url: '/assets/secret.png' }, list: ['a'], nothing: null } },
      { id: 'n2', type: 'video.generate', title: '', x: 0, y: 0, params: { prompt: 'x'.repeat(900) } },
      { id: 'n3', type: 'output.result', params: {} }
    ],
    edges: [
      { id: 'e1', from: { node: 'n1', port: 'prompt' }, to: { node: 'n2', port: 'prompt' } },
      { id: 'e2', from: { node: 'n2', port: 'video' }, to: { node: 'gone', port: 'inputs' } },
      { id: 'e3', from: { node: 'n2', port: 'video' }, to: { node: 'n3', port: 'inputs' } }
    ]
  };
  const summary = assistant.summarizeCanvas(graph, {
    selected: ['n2', 'nope'],
    warnings: [{ node: 'n2', message: 'input prompt is not connected' }, { node: 'unknown', message: 'y'.repeat(400) }, { message: '   ' }, null, { node: 3, message: 'no node id' }]
  });
  assert.deepEqual(summary.nodes[0], { id: 'n1', type: 'input.prompt', title: 'Idee', params: { prompt: 'Ein Fuchs', count: 3, on: true } }, 'plain values only: no media object, no list, no empty text');
  assert.equal(JSON.stringify(summary).includes('secret'), false, 'no media reference leaves the page');
  assert.equal(summary.nodes[1].params.prompt.length <= assistant.LIMITS.paramText + 1, true, 'long texts are cut');
  assert.equal('title' in summary.nodes[1], false);
  assert.equal('params' in summary.nodes[2], false);
  assert.deepEqual(summary.edges.map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`), ['n1.prompt>n2.prompt', 'n2.video>n3.inputs'], 'a connection to a node that is not there is left out');
  assert.deepEqual(summary.edges[0], { from: { node: 'n1', port: 'prompt' }, to: { node: 'n2', port: 'prompt' } }, 'no edge ids');
  assert.deepEqual(summary.selected, ['n2']);
  assert.equal(summary.warnings.length, 3);
  assert.deepEqual(summary.warnings[0], { node: 'n2', message: 'input prompt is not connected' });
  assert.equal('node' in summary.warnings[1], false, 'a warning about an unknown node keeps only its text');
  assert.ok(summary.warnings[1].message.length <= assistant.LIMITS.warningText + 1);
  assert.deepEqual(assistant.summarizeCanvas(null), { nodes: [], edges: [] });
  assert.deepEqual(assistant.summarizeCanvas({ nodes: [], edges: [] }, { selected: ['x'] }), { nodes: [], edges: [] }, 'nothing selected, nothing to report');

  const many = { nodes: Array.from({ length: 700 }, (_unused, index) => ({ id: `n${index}`, type: 'input.text', params: {} })), edges: [] };
  assert.equal(assistant.summarizeCanvas(many).nodes.length, 500, 'the most the endpoint takes');
  const crowded = { nodes: Array.from({ length: 30 }, (_unused, index) => ({ id: `n${index}`, type: 'input.text', params: Object.fromEntries(Array.from({ length: 50 }, (_x, k) => [`p${k}`, k])) })), edges: [] };
  assert.equal(Object.keys(assistant.summarizeCanvas(crowded).nodes[0].params).length, assistant.LIMITS.paramsPerNode);
}

function testRequestHistory() {
  const messages = [];
  for (let index = 1; index <= 10; index += 1) messages.push({ role: index % 2 ? 'user' : 'assistant', text: `Beitrag ${index}` });
  messages.splice(3, 0, { role: 'assistant', pending: true, text: '' }, { role: 'assistant', error: { kind: 'error', text: 'Fehler' }, text: '' }, { role: 'assistant', text: '   ' });
  const turns = assistant.requestHistory(messages);
  assert.equal(turns.length, 6, 'the last six turns');
  assert.deepEqual(turns.map((turn) => turn.text), ['Beitrag 5', 'Beitrag 6', 'Beitrag 7', 'Beitrag 8', 'Beitrag 9', 'Beitrag 10']);
  assert.deepEqual(turns[0], { role: 'user', text: 'Beitrag 5' });
  assert.equal(turns.every((turn) => turn.role === 'user' || turn.role === 'assistant'), true);
  assert.equal(assistant.requestHistory([{ role: 'user', text: 'z'.repeat(5000) }])[0].text.length <= assistant.LIMITS.historyText + 1, true);
  assert.deepEqual(assistant.requestHistory(null), []);
}

const INSERT = {
  nodes: [
    { ref: 'p', type: 'input.prompt', label: 'Titelidee', params: { prompt: 'Ein Titel' } },
    { ref: 'g', type: 'image.generate', params: { prompt: 'Ein Titel', count: 1 } },
    { ref: 'e', type: 'image.generate', params: { prompt: 'Ende' } }
  ],
  edges: [
    { from: { ref: 'p', port: 'prompt' }, to: { ref: 'g', port: 'prompt' } },
    { from: { ref: 'g', port: 'image' }, to: { node: 'n2', port: 'first_frame' } },
    { from: { node: 'n1', port: 'prompt' }, to: { ref: 'e', port: 'prompt' } }
  ]
};

function testBuildSubgraph() {
  const built = assistant.buildSubgraph(INSERT, { labelOf: (type) => `<${type}>` });
  assert.deepEqual(built.sub.nodes.map((node) => node.id), ['a1', 'a2', 'a3']);
  assert.deepEqual(built.sub.nodes.map((node) => node.type), ['input.prompt', 'image.generate', 'image.generate']);
  assert.equal(built.sub.nodes[0].title, 'Titelidee');
  assert.equal('title' in built.sub.nodes[1], false, 'no label: the node keeps the name of its type');
  assert.deepEqual(built.sub.nodes[0].params, { prompt: 'Ein Titel' });
  assert.deepEqual(built.sub.links, [
    { from: { node: 'a1', port: 'prompt' }, to: { node: 'a2', port: 'prompt' } },
    { from: { node: 'a2', port: 'image' }, to: { node: 'n2', port: 'first_frame', existing: true } },
    { from: { node: 'n1', port: 'prompt', existing: true }, to: { node: 'a3', port: 'prompt' } }
  ]);
  assert.equal(built.existingLinks, 2);
  assert.equal(built.skipped, 0);
  assert.deepEqual(built.names, [{ id: 'a1', type: 'input.prompt', label: 'Titelidee' }, { id: 'a2', type: 'image.generate', label: '<image.generate>' }, { id: 'a3', type: 'image.generate', label: '<image.generate>' }]);
  // layout: a column per step of the flow, a row per node in a step
  const where = Object.fromEntries(built.sub.nodes.map((node) => [node.id, [node.x, node.y]]));
  assert.deepEqual(where.a1, [0, 0]);
  assert.deepEqual(where.a2, [assistant.COLUMN, 0], 'behind the node that feeds it');
  assert.deepEqual(where.a3, [0, assistant.ROW], 'fed only by an existing node: the first column, the next row');
  // the proposal is not changed and the sub graph shares nothing with it
  built.sub.nodes[0].params.prompt = 'geändert';
  assert.equal(INSERT.nodes[0].params.prompt, 'Ein Titel');

  // a ref nobody defined, a ref defined twice, ports missing, junk
  const odd = assistant.buildSubgraph({
    nodes: [{ ref: 'a', type: 'input.text' }, { ref: 'a', type: 'input.number' }, { ref: 7, type: 'input.text' }, { type: 'input.text' }, null, { ref: 'b', type: 'constructor' }],
    edges: [
      { from: { ref: 'a', port: 'text' }, to: { ref: 'ghost', port: 'x' } },
      { from: { ref: 'a', port: 'text' }, to: { node: '', port: 'x' } },
      { from: { ref: 'a' }, to: { ref: 'b', port: 'x' } },
      { from: { ref: 'constructor', port: 'x' }, to: { ref: 'a', port: 'x' } },
      null,
      { from: { ref: 'a', port: 'text' }, to: { ref: 'b', port: 'value' } }
    ]
  });
  assert.deepEqual(odd.sub.nodes.map((node) => node.type), ['input.text', 'constructor'], 'the first definition of a ref counts; entries without ref or type are dropped');
  assert.equal(odd.sub.links.length, 1);
  assert.equal(odd.skipped, 5);
  assert.deepEqual(assistant.buildSubgraph(null).sub, { nodes: [], links: [] });
  // a loop among the proposal does not hang the layout
  const loop = assistant.buildSubgraph({ nodes: [{ ref: 'x', type: 'llm.chat' }, { ref: 'y', type: 'llm.chat' }], edges: [{ from: { ref: 'x', port: 'text' }, to: { ref: 'y', port: 'prompt' } }, { from: { ref: 'y', port: 'text' }, to: { ref: 'x', port: 'prompt' } }] });
  assert.equal(loop.sub.nodes.length, 2);
  assert.ok(loop.sub.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)));
}

function testAdjustedLines() {
  const adjusted = [
    { ref: 'g', param: 'bogus', reason: 'unknown_param' },
    { ref: 'g', param: 'count', reason: 'clamped' },
    { ref: 'p', param: 'prompt', reason: 'clipped' },
    { ref: 'g', param: 'asset', reason: 'media_param' },
    { ref: 'g', param: 'model', reason: 'unverifiable' },
    { ref: 'g', param: 'seed', reason: 'not_a_number' },
    { ref: 'g', param: 'other', reason: 'something_new' },
    { ref: 'x', param: 'count', reason: 'clamped' },
    { param: 'bad' },
    null
  ];
  const names = new Map([['g', 'Bild erzeugen'], ['p', 'Titelidee']]);
  for (const lang of ['de', 'en', 'es']) {
    const T = textOf(lang);
    const lines = assistant.adjustedLines(adjusted, names, T, (id) => id.toUpperCase());
    assert.equal(lines.length, 9, `${lang}: one line each, junk dropped`);
    assert.ok(lines[0].includes('BOGUS') && lines[0].includes('Bild erzeugen'), `${lang}: ${lines[0]}`);
    assert.ok(lines.every((line) => !line.includes('{') && !line.includes('nodes.assistant')), `${lang}: every placeholder filled`);
    assert.equal(new Set(lines.slice(0, 7)).size, 7, `${lang}: every reason has its own wording`);
    assert.equal(lines.some((line) => line.includes('ß')), false);
  }
  assert.match(assistant.adjustedLines(adjusted, names, textOf('de'), (id) => id)[1], /ausserhalb des erlaubten Bereichs/);
  assert.match(assistant.adjustedLines(adjusted, names, textOf('en'), (id) => id)[3], /needs a file/);
  assert.match(assistant.adjustedLines(adjusted, names, textOf('es'), (id) => id)[2], /demasiado largo/);
  assert.deepEqual(assistant.adjustedLines(undefined, names, textOf('de')), []);
}

function testCostOfInserted() {
  const paid = new Set(['image.generate', 'video.generate']);
  const isPaid = (type) => paid.has(type);
  const nodes = [{ id: 'a', type: 'input.prompt' }, { id: 'b', type: 'image.generate' }, { id: 'c', type: 'video.generate' }];
  const plan = (entries) => ({ nodes: entries });
  // free nodes are not counted, a known price is summed over the executions
  let cost = assistant.costOfInserted(nodes, plan({ a: { status: 'stale', executions: 1 }, b: { status: 'stale', executions: 2, estimate: { usd: 0.1 } }, c: { status: 'stale', executions: 1, estimate: { usd: 0.5, credits: 4 } } }), isPaid);
  assert.deepEqual(cost, { paid: 2, unknown: 0, usd: 0.7, credits: 4 });
  // no estimate, no plan entry, an invalid node, a count that is not known yet: unknown, never counted as 0
  cost = assistant.costOfInserted(nodes, plan({ b: { status: 'stale', executions: 1, estimate: null }, c: { status: 'invalid', executions: 0, estimate: null } }), isPaid);
  assert.deepEqual(cost, { paid: 2, unknown: 2, usd: 0, credits: 0 });
  cost = assistant.costOfInserted(nodes, null, isPaid);
  assert.deepEqual(cost, { paid: 2, unknown: 2, usd: 0, credits: 0 }, 'no plan at all');
  cost = assistant.costOfInserted(nodes, plan({ b: { status: 'stale', executions: null, estimate: { usd: 1 } }, c: { status: 'cached', executions: 1, estimate: { usd: 1 } } }), isPaid);
  assert.equal(cost.unknown, 2, 'a list of unknown length, or a node that will not run');
  cost = assistant.costOfInserted(nodes, plan({ b: { status: 'forced', executions: 1, estimate: { usd: 0.25 } }, c: { status: 'stale', executions: 1, estimate: { usd: 0.25 } } }), isPaid);
  assert.equal(cost.usd, 0.5);
  assert.equal(assistant.costOfInserted([{ id: 'constructor', type: 'image.generate' }], plan({}), isPaid).unknown, 1, 'an id named like an Object property is not found in the plan');
  assert.deepEqual(assistant.costOfInserted([], plan({}), isPaid), { paid: 0, unknown: 0, usd: 0, credits: 0 });
}

function testFailure() {
  for (const lang of ['de', 'en', 'es']) {
    const T = textOf(lang);
    assert.deepEqual(assistant.failure({ status: 402, code: 'BUDGET_EXHAUSTED', message: 'Satz.' }, T), { kind: 'budget', text: 'Satz.', retry: false });
    assert.equal(assistant.failure({ status: 402, code: 'BUDGET_INSUFFICIENT', message: 'Satz.' }, T).kind, 'budget');
    assert.deepEqual(assistant.failure({ status: 429, code: 'RATE_LIMITED', message: 'Zu viele.' }, T), { kind: 'limit', text: 'Zu viele.', retry: false });
    const network = assistant.failure(Object.assign(new Error('Failed to fetch'), { status: 0 }), T);
    assert.equal(network.kind, 'error');
    assert.equal(network.retry, true);
    assert.equal(network.text, T('nodes.assistant.error.network'));
    assert.equal(assistant.failure(new TypeError('Failed to fetch'), T).text, T('nodes.assistant.error.network'), 'a failed fetch has no status');
    assert.deepEqual(assistant.failure({ status: 503, code: 'ASSISTANT_UNAVAILABLE', message: 'Nicht verfügbar.' }, T), { kind: 'error', text: 'Nicht verfügbar.', retry: true });
    assert.equal(assistant.failure({ status: 502, code: 'ASSISTANT_BAD_ANSWER', message: 'Unlesbar.' }, T).retry, true);
    assert.equal(assistant.failure({ status: 400, code: 'INVALID_REQUEST', message: 'zu lang' }, T).retry, false, 'the same request fails the same way');
    assert.equal(assistant.failure({ status: 404, code: 'WORKFLOW_NOT_FOUND', message: 'Weg.' }, T).retry, false);
    const proxy = assistant.failure(Object.assign(new Error('HTTP 502'), { status: 502 }), T);
    assert.equal(proxy.text, T('nodes.assistant.error.generic', { error: 'HTTP 502' }), 'no code: the generic sentence with the message');
    assert.equal(proxy.retry, true);
  }
}

/* ---------- G: the proposal in the real graph ---------- */

function testInsertIntoGraph() {
  let graph = graphLib.emptyGraph();
  const add = (type, x, y, params) => {
    const out = graphLib.addNode(reg, graph, type, { x, y, params });
    graph = out.graph;
    return out.node.id;
  };
  const prompt = add('input.prompt', 40, 40, { prompt: 'Ein Fuchs' });
  const video = add('video.generate', 400, 40);
  const result = add('output.result', 800, 40);
  graph = graphLib.connect(reg, graph, { node: prompt, port: 'prompt' }, { node: video, port: 'prompt' }).graph;
  graph = graphLib.connect(reg, graph, { node: video, port: 'video' }, { node: result, port: 'inputs' }).graph;
  const before = JSON.stringify(graph);

  const built = assistant.buildSubgraph(
    {
      nodes: [{ ref: 'p', type: 'input.prompt', label: 'Titelidee', params: { prompt: 'Titel' } }, { ref: 'g', type: 'image.generate', params: { prompt: 'Titel' } }],
      edges: [
        { from: { ref: 'p', port: 'prompt' }, to: { ref: 'g', port: 'prompt' } },
        { from: { ref: 'g', port: 'image' }, to: { node: video, port: 'first_frame' } },
        { from: { ref: 'g', port: 'image' }, to: { node: video, port: 'prompt' } }, // wrong type and taken: skipped
        { from: { ref: 'g', port: 'image' }, to: { node: 'weg', port: 'first_frame' } } // the node was deleted meanwhile: skipped
      ]
    },
    { labelOf: (type) => type }
  );
  const done = graphLib.insertSubgraph(graph, built.sub, { reg, center: { x: 0, y: 0 } });
  assert.equal(done.error, undefined);
  assert.equal(JSON.stringify(graph), before, 'the graph that went in is not touched');
  assert.equal(done.graph.nodes.length, 5);
  assert.equal(done.graph.edges.length, 4);
  assert.deepEqual(done.skippedLinks.map((item) => item.index), [2, 3]);
  assert.equal(done.ids.edges.length, 2);
  assert.deepEqual(graphLib.validate(reg, done.graph), []);
  const titled = done.graph.nodes.find((node) => node.id === done.idMap.a1);
  assert.equal(titled.title, 'Titelidee');
  graph.nodes.forEach((node, index) => assert.equal(done.graph.nodes[index], node, 'existing nodes are the same objects'));
  graph.edges.forEach((edge, index) => assert.equal(done.graph.edges[index], edge, 'existing connections are the same objects'));
  assert.ok(done.bounds.x >= graphLib.boundsOf(graph).x + graphLib.boundsOf(graph).w, 'beside the existing content');
}

/* ---------- C: the controller on a small fake DOM ---------- */

class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.nodeType = 1;
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.classes = new Set();
    this.parent = null;
    this.style = {};
    this.value = '';
    this.disabled = false;
    this.title = '';
    this.dataset = {};
    this.scrollTop = 0;
    this.scrollHeight = 100;
    this.clientHeight = 100;
    this.offsetTop = 0;
    this.offsetHeight = 40;
    this.isConnected = true;
    this._text = '';
    const self = this;
    this.classList = {
      toggle(name, force) {
        const on = force === undefined ? !self.classes.has(name) : Boolean(force);
        if (on) self.classes.add(name);
        else self.classes.delete(name);
        return on;
      },
      add: (name) => self.classes.add(name),
      remove: (name) => self.classes.delete(name),
      contains: (name) => self.classes.has(name)
    };
  }

  set className(value) {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get className() {
    return [...this.classes].join(' ');
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }

  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null;
  }

  append(...kids) {
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      const node = typeof kid === 'object' ? kid : FakeNode.text(String(kid));
      node.parent = this;
      this.children.push(node);
    }
  }

  static text(value) {
    const node = new FakeNode('#text');
    node.nodeType = 3;
    node._text = value;
    return node;
  }

  set textContent(value) {
    for (const kid of this.children) kid.parent = null;
    this.children = [];
    this._text = String(value);
  }

  get textContent() {
    return this._text + this.children.map((kid) => kid.textContent).join('');
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  fire(type, event = {}) {
    const record = { defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...event };
    for (const fn of this.listeners[type] || []) fn(record);
    return record;
  }

  walk(visit) {
    for (const kid of this.children) {
      visit(kid);
      kid.walk(visit);
    }
  }

  all(selector) {
    // '.a', '.a.b' (all classes) or a tag name
    const wanted = selector.startsWith('.') ? selector.slice(1).split('.') : null;
    const found = [];
    this.walk((node) => {
      if (wanted ? wanted.every((name) => node.classes.has(name)) : node.tag === selector) found.push(node);
    });
    return found;
  }

  querySelector(selector) {
    return this.all(selector)[0] || null;
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((kid) => kid !== this);
    this.parent = null;
    this.isConnected = false;
  }

  replaceWith(other) {
    const parent = this.parent;
    if (!parent) return;
    other.parent = parent;
    parent.children = parent.children.map((kid) => (kid === this ? other : kid));
    this.parent = null;
    this.isConnected = false;
  }

  focus() {
    FakeNode.focused = this;
  }
}

function fakeUi(T) {
  const el = (tag, attrs, ...children) => {
    const node = new FakeNode(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'disabled') node.disabled = Boolean(value);
      else if (key === 'title') node.title = String(value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    node.append(...children);
    return node;
  };
  const toasts = [];
  return {
    el,
    icon: (name) => el('svg', { class: `icon-${name}` }),
    categoryIcon: (name) => el('svg', { class: `cat-${name}` }),
    T,
    typeLabel: (def) => {
      const key = `nodes.type.${def.type}.label`;
      const text = T(key);
      return text && text !== key ? text : def.label || def.type;
    },
    paramLabel: (id) => id,
    toast: (message) => toasts.push(message),
    toasts
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness(lang = 'de', options = {}) {
  const T = textOf(lang);
  const ui = fakeUi(T);
  const listeners = {};
  const bus = { on: (name, fn) => (listeners[name] = listeners[name] || []).push(fn), emit: (name, payload) => (listeners[name] || []).forEach((fn) => fn(payload)) };
  const calls = { ask: [], insert: [], undo: 0, flush: 0, plan: 0, help: [], show: [], toggles: [] };
  const queue = [];
  const api = {
    assistant: (id, body) => {
      calls.ask.push({ id, body });
      return new Promise((resolve, reject) => queue.push({ resolve, reject }));
    }
  };
  const state = {
    workflowId: 'wf-1',
    graph: (() => {
      let graph = graphLib.emptyGraph();
      graph = graphLib.addNode(reg, graph, 'input.prompt', { x: 0, y: 0, params: { prompt: 'Fuchs' } }).graph;
      graph = graphLib.addNode(reg, graph, 'video.generate', { x: 400, y: 0 }).graph;
      return graph;
    })(),
    selection: ['n2'],
    revision: 3,
    canInsert: true,
    plan: { nodes: {} },
    insertResult: null
  };
  const history = historyLib.createHistory();
  const host = new FakeNode('aside');
  const OCD = { ui, api, graph: graphLib, run: runLib, bus };
  const reg2 = { types: new Map([...reg.types]) };
  const panel = assistant.createAssistant({
    OCD,
    host,
    help: { openPopover: (type, anchor) => calls.help.push({ type, anchor }) },
    getWorkflowId: () => state.workflowId,
    getGraph: () => state.graph,
    getReg: () => reg2,
    getSelection: () => state.selection,
    getWarnings: () => [{ node: 'n2', message: 'input prompt is not connected' }],
    canInsert: () => state.canInsert,
    insert: (sub, opts) => {
      calls.insert.push({ sub, opts });
      return state.insertResult;
    },
    historyRevision: () => state.revision,
    undo: () => {
      calls.undo += 1;
      state.revision += 1;
      state.graph = graphLib.removeNodes(state.graph, state.addedNodes || []);
      bus.emit('graph', state.graph);
    },
    flushSave: async () => {
      calls.flush += 1;
    },
    plan: async () => {
      calls.plan += 1;
      if (state.planError) throw new Error('plan failed');
      return state.plan;
    },
    showNodes: (ids) => calls.show.push(ids),
    getLang: () => lang,
    onToggle: (open, opts) => calls.toggles.push([open, Boolean(opts && opts.focus)])
  });
  // the access object of the page is absent here: a person without restrictions
  void history;
  const view = {
    input: () => host.querySelector('.nv-asst-input'),
    list: () => host.querySelector('.nv-asst-scroll'),
    messages: () => host.all('.nv-asst-msg'),
    bots: () => host.all('.is-bot').filter((node) => node.classes.has('nv-asst-msg')),
    send: () => host.querySelector('.nv-asst-send'),
    form: () => host.querySelector('form')
  };
  const answerWith = async (value, index = 0) => {
    queue[index].resolve(value);
    await tick();
    await tick();
  };
  const failWith = async (error, index = 0) => {
    queue[index].reject(error);
    await tick();
    await tick();
  };
  const type = (text) => {
    view.input().value = text;
    view.input().fire('input');
  };
  return { T, ui, host, panel, calls, queue, state, view, answerWith, failWith, type, bus, reg: reg2 };
}

async function testControllerBasics() {
  const h = harness('de');
  // closed at first; opening focuses the input; a workflow is required
  assert.equal(h.panel.isOpen(), false);
  assert.equal(h.host.classes.has('is-open'), false);
  h.panel.open();
  assert.equal(h.panel.isOpen(), true);
  assert.equal(h.host.classes.has('is-open'), true);
  assert.equal(FakeNode.focused, h.view.input(), 'the input has the focus');
  assert.deepEqual(h.calls.toggles, [[true, false]]);
  assert.equal(h.host.getAttribute('aria-label'), null);
  // the empty conversation: an intro and three examples
  const chips = h.host.all('.nv-asst-chip');
  assert.deepEqual(chips.map((chip) => chip.textContent), [h.T('nodes.assistant.suggest.1'), h.T('nodes.assistant.suggest.2'), h.T('nodes.assistant.suggest.3')]);
  assert.match(h.host.querySelector('.nv-asst-intro').textContent, /Frag mich/);
  assert.equal(h.view.send().disabled, true, 'nothing to send yet');
  h.type('   ');
  assert.equal(h.view.send().disabled, true);
  h.type('Was macht der Node?');
  assert.equal(h.view.send().disabled, false);

  // Enter sends, Shift+Enter does not, a composition (IME) does not
  const shift = h.view.input().fire('keydown', { key: 'Enter', shiftKey: true });
  assert.equal(shift.defaultPrevented, false);
  h.view.input().fire('keydown', { key: 'Enter', isComposing: true });
  assert.equal(h.calls.ask.length, 0);
  const enter = h.view.input().fire('keydown', { key: 'Enter' });
  assert.equal(enter.defaultPrevented, true);
  assert.equal(h.calls.ask.length, 1);
  const request = h.calls.ask[0];
  assert.equal(request.id, 'wf-1');
  assert.equal(request.body.question, 'Was macht der Node?');
  assert.equal(request.body.lang, 'de');
  assert.deepEqual(request.body.history, []);
  assert.deepEqual(request.body.canvas.nodes.map((node) => node.id), ['n1', 'n2']);
  assert.deepEqual(request.body.canvas.selected, ['n2']);
  assert.deepEqual(request.body.canvas.warnings, [{ node: 'n2', message: 'input prompt is not connected' }]);
  assert.equal(h.view.input().value, '', 'the field is empty after sending');
  assert.equal(h.host.all('.nv-asst-chip').length, 0, 'the examples are gone');
  assert.equal(h.view.messages().length, 2, 'the question and the waiting message');
  assert.ok(h.host.querySelector('.is-pending'), 'the assistant is thinking');
  assert.equal(h.view.send().disabled, true, 'one question at a time');
  // a second question while the first is open is not sent
  h.type('Noch eine Frage');
  h.view.form().fire('submit');
  assert.equal(h.calls.ask.length, 1);
  assert.equal(h.view.send().disabled, true);

  // the answer: plain text paragraphs, only links to node types that exist, never HTML
  await h.answerWith({ answer: 'Erster Absatz.\n\nZweiter <b>Absatz</b> mit <script>x</script>.', mentions: ['video.generate', 'nope.nothing', 'video.generate', 7], usage: { model: 'm', billing: 'subscription', usd: 0, calls: 1, replaced: false }, quota: { remaining: 29, max: 30, windowSeconds: 600 }, budget: null });
  assert.equal(h.host.querySelector('.is-pending'), null);
  const paragraphs = h.host.all('.nv-asst-text');
  assert.deepEqual(paragraphs.map((p) => p.textContent), ['Erster Absatz.', 'Zweiter <b>Absatz</b> mit <script>x</script>.'], 'text stays text');
  const mentions = h.host.all('.nv-asst-mention');
  assert.equal(mentions.length, 1, 'a type that does not exist and a duplicate get no link');
  assert.match(mentions[0].textContent, /^Hilfe zu «.+» öffnen$/);
  mentions[0].fire('click');
  assert.equal(h.calls.help.length, 1);
  assert.equal(h.calls.help[0].type, 'video.generate');
  assert.equal(h.calls.help[0].anchor, mentions[0], 'the popover opens at the link');
  assert.equal(h.host.all('.nv-asst-meta').length, 0, 'no cost line for the subscription');
  assert.equal(h.view.input().value, 'Noch eine Frage', 'what was typed while waiting stays in the field');
  assert.equal(h.view.send().disabled, false, 'and can be sent now');

  // the next question carries the conversation
  h.type('Und dann?');
  h.view.form().fire('submit');
  assert.equal(h.calls.ask.length, 2);
  assert.deepEqual(h.calls.ask[1].body.history, [{ role: 'user', text: 'Was macht der Node?' }, { role: 'assistant', text: 'Erster Absatz.\n\nZweiter <b>Absatz</b> mit <script>x</script>.' }]);
  await h.answerWith({ answer: 'Fertig.', mentions: [], usage: { billing: 'usd', usd: 0.0123, calls: 1, replaced: false }, quota: { remaining: 3, max: 30, windowSeconds: 600 } }, 1);
  const meta = h.host.all('.nv-asst-meta').map((node) => node.textContent);
  assert.equal(meta.length, 1);
  assert.match(meta[0], /Kosten dieser Frage: \$0\.0123/);
  assert.match(meta[0], /Noch 3 Fragen in den nächsten 10 Minuten/);

  // unknown cost is said so, a replacement for the subscription is noted (with its price, or without)
  h.type('Drittens');
  h.view.form().fire('submit');
  await h.answerWith({ answer: 'Über OpenRouter.', mentions: [], usage: { billing: 'usd', usd: 0.02, replaced: true }, quota: { remaining: 20, max: 30, windowSeconds: 600 } }, 2);
  assert.match(h.host.all('.nv-asst-note').map((node) => node.textContent).join('|'), /kostete \$0\.0200/);
  h.type('Viertens');
  h.view.form().fire('submit');
  await h.answerWith({ answer: 'Noch einmal.', mentions: [], usage: { billing: 'usd', usd: null, replaced: true } }, 3);
  assert.match(h.host.all('.nv-asst-note').map((node) => node.textContent).join('|'), /Kosten sind unbekannt/);
  h.type('Fünftens');
  h.view.form().fire('submit');
  await h.answerWith({ answer: 'Teilnehmende.', mentions: [], usage: { billing: 'usd', usd: null, replaced: false } }, 4);
  assert.ok(h.host.all('.nv-asst-meta').some((node) => node.textContent === h.T('nodes.assistant.questionCostUnknown')), 'unknown is never shown as 0');

  // a new conversation empties it
  h.host.all('.nv-asst-new')[0].fire('click');
  assert.equal(h.view.messages().length, 0);
  assert.equal(h.host.all('.nv-asst-chip').length, 3);
  // a chip asks its sentence
  h.host.all('.nv-asst-chip')[1].fire('click');
  assert.equal(h.calls.ask.at(-1).body.question, h.T('nodes.assistant.suggest.2'));
  assert.deepEqual(h.calls.ask.at(-1).body.history, [], 'the cleared conversation is not sent again');
}

async function testEscapeAndKeys() {
  const h = harness('en');
  h.panel.open();
  // the keys of the panel never reach the shortcuts of the canvas; Escape closes it and gives the focus back
  const letter = h.host.fire('keydown', { key: 'Delete' });
  assert.equal(letter.stopped, true, 'Delete in the panel does not delete nodes');
  assert.equal(h.panel.isOpen(), true);
  const escape = h.host.fire('keydown', { key: 'Escape' });
  assert.equal(escape.stopped, true);
  assert.equal(h.panel.isOpen(), false);
  assert.equal(h.host.classes.has('is-open'), false);
  assert.deepEqual(h.calls.toggles.at(-1), [false, true], 'closing with the keyboard asks for the focus on the button');
  assert.equal(h.host.fire('keyup', { key: ' ' }).stopped, true);
  // toggle and the close button
  h.panel.toggle();
  assert.equal(h.panel.isOpen(), true);
  h.host.all('.nv-asst-close')[0].fire('click');
  assert.equal(h.panel.isOpen(), false);
  // without a workflow it does not open
  h.state.workflowId = null;
  h.panel.open();
  assert.equal(h.panel.isOpen(), false);
  // the labels follow the language
  const de = harness('de');
  de.panel.open();
  assert.equal(de.host.querySelector('.nv-asst-input').attrs.placeholder, de.T('nodes.assistant.input'));
  assert.equal(h.host.all('.nv-asst-hint')[0].textContent, h.T('nodes.assistant.hint'));
}

function insertResultFor(h, nodeIds, edgeIds, skipped = []) {
  const idMap = {};
  nodeIds.forEach((id, index) => (idMap[`a${index + 1}`] = id));
  h.state.addedNodes = nodeIds;
  let graph = h.state.graph;
  for (const id of nodeIds) graph = graphLib.addNode(reg, graph, 'image.generate', { id, x: 900, y: 0 }).graph;
  h.state.graph = graph;
  return { ids: { nodes: nodeIds, notes: [], groups: [], edges: edgeIds }, idMap, skippedLinks: skipped, bounds: { x: 900, y: 0, w: 300, h: 200 } };
}

async function testInsertCard() {
  const h = harness('de');
  h.panel.open();
  h.state.plan = { nodes: { n3: { status: 'stale', executions: 1, estimate: { usd: 0.134 } }, n4: { status: 'stale', executions: 1, estimate: null } } };
  h.type('Füge ein Titelbild hinzu');
  h.view.form().fire('submit');
  h.state.insertResult = insertResultFor(h, ['n3', 'n4'], ['e5', 'e6'], [{ index: 2, code: 'incompatible' }]);
  h.state.revision = 4;
  await h.answerWith({
    answer: 'Ich füge ein Titelbild hinzu.',
    mentions: ['image.generate'],
    insert: { nodes: [{ ref: 'p', type: 'input.prompt', label: 'Titelidee', params: {} }, { ref: 'g', type: 'image.generate', params: { count: 9 } }], edges: [{ from: { ref: 'p', port: 'prompt' }, to: { ref: 'g', port: 'prompt' } }, { from: { ref: 'g', port: 'image' }, to: { node: 'n2', port: 'first_frame' } }, { from: { ref: 'g', port: 'image' }, to: { node: 'n2', port: 'prompt' } }] },
    adjusted: [{ ref: 'g', param: 'count', reason: 'clamped' }],
    usage: { billing: 'subscription', usd: 0, calls: 1, replaced: false },
    quota: { remaining: 29, max: 30, windowSeconds: 600 }
  });
  // one insertion, with the sub graph built from the proposal
  assert.equal(h.calls.insert.length, 1);
  assert.equal(h.calls.insert[0].opts.history, 'insert-assistant');
  assert.deepEqual(h.calls.insert[0].sub.nodes.map((node) => node.type), ['input.prompt', 'image.generate']);
  assert.equal(h.calls.insert[0].sub.links.length, 3);
  // the toast and the card
  assert.equal(h.ui.toasts.length, 1);
  assert.equal(h.ui.toasts[0], '2 Nodes eingefügt. Nichts wurde gestartet.');
  const card = h.host.querySelector('.nv-asst-card');
  assert.ok(card);
  assert.equal(card.querySelector('.nv-asst-card-title').textContent, '2 Nodes eingefügt');
  assert.deepEqual(card.all('.nv-asst-name').map((node) => node.textContent), ['Titelidee', 'Bild erzeugen'], 'the names of the nodes: the label, else the name of the type');
  assert.equal(card.textContent.includes('image.generate'), false, 'names, not type ids');
  assert.match(card.textContent, /Verbindungen: 2, davon 1 zu bestehenden Nodes/, 'the refused link is not counted');
  assert.match(card.textContent, /Verbindungen, die nicht gesetzt werden konnten: 1/);
  assert.match(card.textContent, /Es wurde nichts gestartet\. Zum Starten klickst du oben auf «Alles ausführen» oder «Auswahl ausführen»\./);
  // the cost comes from the engine plan after the save: a price and one node without
  assert.equal(h.calls.flush, 1, 'saved first, the plan reads the saved workflow');
  assert.equal(h.calls.plan, 1);
  const cost = h.host.querySelector('.nv-asst-cost');
  assert.match(cost.textContent, /^Geschätzte Kosten pro Lauf: \$0\.13 · bezahlte Nodes ohne Schätzung: 1$/);
  // the notes about adjusted values
  assert.match(h.host.querySelector('.nv-asst-adjusted').textContent, /«Bild erzeugen»: «count» lag ausserhalb des erlaubten Bereichs/);
  // undo only while nothing was done after the insertion
  const undo = h.host.querySelector('.nv-asst-undo');
  assert.equal(undo.disabled, false);
  h.state.revision = 5;
  h.bus.emit('graph', h.state.graph);
  const later = h.host.querySelector('.nv-asst-undo');
  assert.equal(later.disabled, true, 'edited since: the step by step undo of the top bar remains');
  assert.equal(later.title, h.T('nodes.assistant.undoLater'));
  h.state.revision = 6;
  h.bus.emit('graph', h.state.graph);
  assert.equal(h.host.querySelector('.nv-asst-undo').disabled, true, 'the counter never goes back: not possible again by chance');
  h.state.revision = 4;
  h.bus.emit('graph', h.state.graph);
  assert.equal(h.host.querySelector('.nv-asst-undo').disabled, false, 'the same revision as at the insertion: possible');
  h.host.querySelector('.nv-asst-show').fire('click');
  assert.deepEqual(h.calls.show, [['n3', 'n4']]);
  h.host.querySelector('.nv-asst-undo').fire('click');
  assert.equal(h.calls.undo, 1);
  assert.equal(h.host.querySelector('.nv-asst-undo'), null, 'nothing left to undo');
  assert.equal(h.host.querySelector('.nv-asst-undone').textContent, 'Rückgängig gemacht');
  assert.ok(h.host.querySelector('.is-gone'));

  // nothing to ask the plan about when no node is paid: "free"
  const free = harness('en');
  free.panel.open();
  free.type('add a prompt');
  free.view.form().fire('submit');
  free.state.insertResult = (() => {
    const result = insertResultFor(free, ['n3'], []);
    free.state.graph = { ...free.state.graph, nodes: free.state.graph.nodes.map((node) => (node.id === 'n3' ? { ...node, type: 'input.prompt' } : node)) };
    return result;
  })();
  await free.answerWith({ answer: 'Added.', mentions: [], insert: { nodes: [{ ref: 'p', type: 'input.prompt', params: {} }], edges: [] }, usage: { billing: 'subscription', usd: 0, calls: 1 } });
  assert.equal(free.host.querySelector('.nv-asst-card-title').textContent, '1 node inserted');
  assert.equal(free.host.querySelector('.nv-asst-cost').textContent, free.T('nodes.assistant.cost.none'));
  assert.match(free.host.querySelector('.nv-asst-card').textContent, /Connections|No connections/);

  // no plan: the cost says so instead of showing 0
  const broken = harness('es');
  broken.panel.open();
  broken.panel.ask('añade una imagen');
  broken.state.insertResult = insertResultFor(broken, ['n3'], ['e9']);
  broken.state.plan = null;
  await broken.answerWith({ answer: 'Hecho.', mentions: [], insert: { nodes: [{ ref: 'g', type: 'image.generate', params: {} }], edges: [] }, usage: { billing: 'subscription', usd: 0, calls: 1 } });
  assert.match(broken.host.querySelector('.nv-asst-cost').textContent, /Coste aún desconocido \(nodos de pago sin estimación: 1\)/);
  const failedPlan = harness('en');
  failedPlan.panel.open();
  failedPlan.panel.ask('add an image');
  failedPlan.state.insertResult = insertResultFor(failedPlan, ['n3'], ['e9']);
  failedPlan.state.planError = true;
  await failedPlan.answerWith({ answer: 'Done.', mentions: [], insert: { nodes: [{ ref: 'g', type: 'image.generate', params: {} }], edges: [] }, usage: { billing: 'subscription', usd: 0, calls: 1 } });
  assert.equal(failedPlan.host.querySelector('.nv-asst-cost').textContent, failedPlan.T('nodes.assistant.cost.failed'), 'the plan failed: said so, no amount');
  assert.match(failedPlan.host.querySelector('.nv-asst-card').textContent, /Undo/, 'the insertion itself stands');

  // connections only (no new node): "1 connection made", no "Show", the selection is left alone
  const only = harness('en');
  only.panel.open();
  only.panel.ask('connect them');
  only.state.insertResult = { ids: { nodes: [], notes: [], groups: [], edges: ['e7'] }, idMap: {}, skippedLinks: [], bounds: null };
  only.state.graph = { ...only.state.graph, edges: [{ id: 'e7', from: { node: 'n1', port: 'prompt' }, to: { node: 'n2', port: 'prompt' } }] };
  await only.answerWith({ answer: 'Connected.', mentions: [], insert: { nodes: [], edges: [{ from: { node: 'n1', port: 'prompt' }, to: { node: 'n2', port: 'prompt' } }] }, usage: { billing: 'subscription', usd: 0, calls: 1 } });
  assert.equal(only.host.querySelector('.nv-asst-card-title').textContent, '1 connection made');
  assert.equal(only.host.querySelector('.nv-asst-show'), null);
  assert.equal(only.host.querySelector('.nv-asst-cost'), null, 'a connection costs nothing: no cost line');
  assert.equal(only.calls.plan, 0);
  assert.equal(only.ui.toasts[0], '1 connection made. Nothing was started.');

  // insertSubgraph refused it (the model sent junk): a note, no card, nothing claimed
  const refused = harness('de');
  refused.panel.open();
  refused.panel.ask('fügt etwas ein');
  refused.state.insertResult = null;
  await refused.answerWith({ answer: 'Vorschlag.', mentions: [], insert: { nodes: [{ ref: 'g', type: 'image.generate', params: {} }], edges: [] }, usage: { billing: 'subscription', usd: 0, calls: 1 } });
  assert.equal(refused.host.querySelector('.nv-asst-card'), null);
  assert.match(refused.host.all('.nv-asst-note').map((node) => node.textContent).join('|'), /liess sich hier nicht einfügen/);
  assert.equal(refused.ui.toasts.length, 0);
  // every connection was skipped and no node came in: also nothing to claim
  const nothing = harness('de');
  nothing.panel.open();
  nothing.panel.ask('verbinde');
  nothing.state.insertResult = { ids: { nodes: [], notes: [], groups: [], edges: [] }, idMap: {}, skippedLinks: [{ index: 0, code: 'input_taken' }], bounds: null };
  await nothing.answerWith({ answer: 'Verbunden.', mentions: [], insert: { nodes: [], edges: [{ from: { node: 'n1', port: 'prompt' }, to: { node: 'n2', port: 'prompt' } }] }, usage: { billing: 'subscription', usd: 0, calls: 1 } });
  assert.equal(nothing.host.querySelector('.nv-asst-card'), null);
  // the server rejected its own proposal twice: the answer and a note, no insertion at all
  const rejected = harness('de');
  rejected.panel.open();
  rejected.panel.ask('mach was');
  await rejected.answerWith({ answer: 'Geht nicht.', mentions: [], insertRejected: true, usage: { billing: 'subscription', usd: 0, calls: 2 } });
  assert.equal(rejected.calls.insert.length, 0);
  assert.match(rejected.host.all('.nv-asst-note')[0].textContent, /Es wurde nichts eingefügt/);
}

async function testWorkflowsAndErrors() {
  // the conversation belongs to the workflow; an answer for a workflow that is no longer open inserts nothing
  const h = harness('de');
  h.panel.open();
  h.panel.ask('Frage in A');
  h.state.workflowId = 'wf-2';
  h.panel.workflowChanged();
  assert.equal(h.view.messages().length, 0, 'workflow B starts empty');
  h.state.insertResult = insertResultFor(h, ['n3'], []);
  await h.answerWith({ answer: 'Antwort für A.', mentions: [], insert: { nodes: [{ ref: 'g', type: 'image.generate', params: {} }], edges: [] }, usage: { billing: 'subscription', usd: 0, calls: 1 } });
  assert.equal(h.calls.insert.length, 0, 'nothing is inserted into another workflow');
  assert.equal(h.view.messages().length, 0, 'and nothing appears in the panel of B');
  h.panel.ask('Frage in B');
  assert.equal(h.calls.ask.at(-1).id, 'wf-2');
  assert.deepEqual(h.calls.ask.at(-1).body.history, []);
  h.state.workflowId = 'wf-1';
  h.panel.workflowChanged();
  const texts = h.view.messages().map((node) => node.textContent);
  assert.equal(texts.length, 2);
  assert.ok(texts[1].includes('Antwort für A.') && texts[1].includes('Nicht eingefügt, weil inzwischen ein anderer Workflow offen ist.'), 'A shows what happened');
  // closing the workflow closes the panel
  h.state.workflowId = null;
  h.panel.workflowChanged();
  assert.equal(h.panel.isOpen(), false);

  // a workflow that cannot take nodes now (still loading): the answer is shown, nothing is inserted
  const blocked = harness('en');
  blocked.panel.open();
  blocked.state.canInsert = false;
  blocked.panel.ask('add a node');
  await blocked.answerWith({ answer: 'Here.', mentions: [], insert: { nodes: [{ ref: 'g', type: 'image.generate', params: {} }], edges: [] }, usage: { billing: 'subscription', usd: 0, calls: 1 } });
  assert.equal(blocked.calls.insert.length, 0);
  assert.match(blocked.host.all('.nv-asst-note')[0].textContent, /Not inserted/);

  // errors: the sentence of the server, the budget line, "ask again" only where it can help
  const budget = harness('de');
  budget.panel.open();
  budget.panel.ask('Frage');
  await budget.failWith(Object.assign(new Error('Dein Budget ist aufgebraucht.'), { status: 402, code: 'BUDGET_EXHAUSTED', body: { budget: { limitUsd: 5, spentUsd: 5, reservedUsd: 0, remainingUsd: 0 } } }));
  assert.ok(budget.host.querySelector('.nv-asst-bubble.is-budget'));
  assert.equal(budget.host.querySelector('.nv-asst-bubble.is-budget').textContent, 'Dein Budget ist aufgebraucht.');
  assert.equal(budget.host.querySelector('.nv-asst-retry'), null, 'asking again does not help without budget');
  assert.equal(budget.host.querySelector('.nv-asst-send').disabled, true);
  budget.type('Weiter');
  assert.equal(budget.host.querySelector('.nv-asst-send').disabled, false, 'the field works again after an error');

  const net = harness('en');
  net.panel.open();
  net.panel.ask('First question');
  await net.answerWith({ answer: 'First answer.', mentions: [], usage: { billing: 'subscription', usd: 0, calls: 1 } });
  net.panel.ask('Second question');
  assert.equal(net.calls.ask.length, 2);
  await net.failWith(Object.assign(new Error('Failed to fetch'), { status: 0 }), 1);
  assert.equal(net.host.querySelector('.nv-asst-bubble.is-error').textContent, net.T('nodes.assistant.error.network'));
  const retry = net.host.querySelector('.nv-asst-retry');
  assert.ok(retry, 'a lost connection: ask again');
  retry.fire('click');
  assert.equal(net.calls.ask.length, 3);
  assert.equal(net.calls.ask[2].body.question, 'Second question', 'the same question');
  assert.deepEqual(net.calls.ask[2].body.history, [{ role: 'user', text: 'First question' }, { role: 'assistant', text: 'First answer.' }], 'the failed try is not part of the history');
  assert.equal(net.view.messages().filter((node) => node.classes.has('is-user')).length, 2, 'the question is not shown twice');
  await net.answerWith({ answer: 'Second answer.', mentions: [], usage: { billing: 'subscription', usd: 0, calls: 1 } }, 2);
  assert.equal(net.host.querySelector('.nv-asst-bubble.is-error'), null);
  assert.equal(net.host.all('.nv-asst-text').at(-1).textContent, 'Second answer.');

  const limit = harness('es');
  limit.panel.open();
  limit.panel.ask('Pregunta');
  await limit.failWith(Object.assign(new Error('Demasiadas preguntas.'), { status: 429, code: 'RATE_LIMITED' }));
  assert.ok(limit.host.querySelector('.nv-asst-bubble.is-limit'));
  assert.equal(limit.host.querySelector('.nv-asst-retry'), null);
}

// The card knows "nothing happened since" by the revision counter of the real history, not by the position in the stack.
async function testCardWithRealHistory() {
  const insertCard = async (hist) => {
    const h = harness('de');
    Object.defineProperty(h.state, 'revision', { get: () => hist.revision, set() {}, configurable: true });
    h.panel.open();
    h.type('Füge ein Titelbild hinzu');
    h.view.form().fire('submit');
    h.state.insertResult = insertResultFor(h, ['n3'], ['e5']);
    hist.commit({ n: 'assistant insert' }); // main.js insertSubgraph: ONE step
    await h.answerWith({
      answer: 'Ich füge ein Titelbild hinzu.',
      mentions: [],
      insert: { nodes: [{ ref: 'g', type: 'image.generate', params: {} }], edges: [{ from: { ref: 'g', port: 'image' }, to: { node: 'n2', port: 'first_frame' } }] },
      adjusted: [],
      usage: { billing: 'subscription', usd: 0, calls: 1, replaced: false }
    });
    return h;
  };
  const undoOf = (h) => h.host.querySelector('.nv-asst-undo');

  // a full stack: the index stays at the last place, the card must still notice the own edit
  const full = historyLib.createHistory({ coalesceMs: 0 });
  full.reset({ n: 0 });
  for (let i = 1; i < 120; i += 1) full.commit({ n: i });
  assert.equal(full.size, historyLib.DEFAULT_LIMIT);
  const a = await insertCard(full);
  assert.equal(undoOf(a).disabled, false, 'ready right after the insertion');
  const before = full.position;
  full.commit({ n: 'own edit' });
  assert.equal(full.position, before, 'on a full stack the position does not move any more');
  a.bus.emit('graph', a.state.graph);
  assert.equal(undoOf(a).disabled, true, 'the own edit is seen although the position is the same');
  assert.equal(a.calls.undo, 0);
  full.undo();
  a.bus.emit('graph', a.state.graph);
  assert.equal(undoOf(a).disabled, true, 'undo of the top bar does not make the card ready again');

  // the workflow is closed and opened again (clear, reset), then a few edits: the conversation and the card stay
  const reopened = historyLib.createHistory({ coalesceMs: 0 });
  reopened.reset({ n: 0 });
  const b = await insertCard(reopened);
  assert.equal(undoOf(b).disabled, false);
  reopened.clear();
  reopened.reset({ n: 'loaded' });
  b.bus.emit('graph', b.state.graph);
  assert.equal(undoOf(b).disabled, true, 'a history that was reset: the card is "later"');
  for (let i = 1; i <= 3; i += 1) {
    reopened.commit({ n: `own edit ${i}` });
    b.bus.emit('graph', b.state.graph);
    assert.equal(undoOf(b).disabled, true, `after ${i} own edits`);
  }
  assert.equal(b.calls.undo, 0, 'nothing of the person was undone');
  assert.equal(undoOf(b).title, b.T('nodes.assistant.undoLater'));
}

async function testLongConversation() {
  const h = harness('en');
  h.panel.open();
  for (let index = 1; index <= 45; index += 1) {
    h.panel.ask(`Question ${index}`);
    await h.answerWith({ answer: `Answer ${index}`, mentions: [], usage: { billing: 'subscription', usd: 0, calls: 1 } }, index - 1);
  }
  assert.ok(h.view.messages().length <= assistant.LIMITS.keptMessages + 1, 'the oldest messages go');
  assert.equal(h.view.messages().at(-1).textContent.includes('Answer 45'), true);
  assert.equal(h.view.messages().some((node) => node.textContent.includes('Question 1 ') || node.textContent === 'YouQuestion 1'), false);
  const last = h.calls.ask.at(-1).body.history;
  assert.equal(last.length, 6, 'six turns go along');
  assert.equal(last.at(-1).text, 'Answer 44');
}

/* ---------- W: wiring ---------- */

function testWiring() {
  const html = read('public/index.html');
  const at = (file) => html.indexOf(`<script src="nodes/${file}"></script>`);
  assert.ok(at('assistant-ui.js') > at('run.js') && at('assistant-ui.js') > at('node-help.js') && at('assistant-ui.js') < at('main.js'), 'assistant-ui.js loads after run.js and node-help.js, before main.js');

  const source = read('public/nodes/assistant-ui.js');
  const main = read('public/nodes/main.js');
  for (const [file, code] of [['assistant-ui.js', source], ['main.js', main]]) {
    assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|outerHTML/, `${file}: no HTML from strings`);
    assert.doesNotMatch(code, /\b(?:alert|confirm|prompt)\(/, `${file}: no native dialogs`);
    assert.doesNotMatch(code, /document\.write|eval\(/, file);
  }
  assert.doesNotMatch(source, /localStorage|sessionStorage/, 'the conversation is not stored anywhere');
  assert.doesNotMatch(source, /\.startRun|runAll|bus\.emit\(.run/, 'the assistant never starts a run');

  // every class has a rule
  const css = read('public/nodes/nodes.css');
  const classes = new Set();
  for (const match of source.matchAll(/'([^'\n]*\bnv-[a-z0-9-]+[^'\n]*)'/g)) for (const name of match[1].match(/nv-[a-z0-9-]+/g)) classes.add(name);
  for (const match of source.matchAll(/`([^`\n]*\bnv-[a-z0-9-]+[^`\n]*)`/g)) for (const name of match[1].match(/nv-[a-z0-9-]+/g)) classes.add(name);
  for (const match of main.matchAll(/'([^'\n]*\bnv-assistant[^'\n]*)'/g)) for (const name of match[1].match(/nv-[a-z0-9-]+/g)) classes.add(name);
  assert.ok(classes.has('nv-asst-card') && classes.has('nv-asst-mention') && classes.has('nv-assistant'), 'the classes were found');
  const missing = [...classes].filter((name) => !name.endsWith('-')).filter((name) => !new RegExp(`\\.${name}(?![a-z0-9-])`).test(css));
  assert.deepEqual(missing, [], `CSS classes without a rule: ${missing.join(', ')}`);
  // phone: a sheet; wide: the column of the inspector; the toast leaves the input free
  assert.match(css, /@media \(max-width: 700px\) \{\s*\.nv-assistant \{[^}]*position: fixed/);
  assert.match(css, /@media \(min-width: 701px\) \{\s*\.nv-body\.assistant-open/);
  assert.match(css, /\.nv-body\.assistant-open \.nv-inspector \{\s*display: none/);
  assert.match(css, /\.nv-assistant:not\(\.is-open\)|\.nv-assistant \{\s*display: none/);

  // main.js: the button, the panel next to the inspector, one insertion with the links, the plan for the cost
  assert.match(main, /OCD\.assistant\.createAssistant\(/);
  assert.match(main, /insert: \(sub, options\) => insertSubgraph\(sub, options\)/);
  assert.match(main, /plan: \(\) => api\.plan\(state\.workflow\.id/);
  assert.match(main, /historyRevision: \(\) => state\.history\.revision/);
  assert.match(main, /for \(const id of result\.ids\.edges \|\| \[\]\) reserveId\(id\)/, 'the new connections are reserved as well');
  const insertBody = main.slice(main.indexOf('function insertSubgraph(sub, options = {}) {'), main.indexOf('function revealBounds'));
  assert.equal((insertBody.match(/applyGraph\(/g) || []).length, 1, 'ONE step in the history');
  assert.doesNotMatch(insertBody, /startRun|bus\.emit\('run/, 'inserting never runs anything');
  assert.match(read('public/nodes/api.js'), /assistant: \(id, body\) => request\('POST', `\/api\/workflows\/\$\{enc\(id\)\}\/assistant`, body\)/);

  // every text exists in all three languages: the literal keys, the ones built at run time, no sharp s, same placeholders
  const keys = new Set();
  for (const code of [source, main]) for (const match of code.matchAll(/'(nodes\.assistant\.[A-Za-z0-9_.]+)'/g)) keys.add(match[1]);
  for (const reason of assistant.ADJUST_REASONS) keys.add(`nodes.assistant.adjusted.${reason}`);
  for (const key of ['nodes.assistant.adjusted.other', 'nodes.assistant.suggest.1', 'nodes.assistant.suggest.2', 'nodes.assistant.suggest.3', 'nodes.assistant.inserted.one', 'nodes.assistant.inserted.many', 'nodes.assistant.connected.one', 'nodes.assistant.connected.many', 'nodes.assistant.toastNotStarted', 'nodes.connect.input_taken']) keys.add(key);
  assert.ok(keys.size > 40, `expected many keys, found ${keys.size}`);
  const placeholders = (text) => (text.match(/\{[a-zA-Z]+\}/g) || []).sort().join(',');
  for (const key of keys) {
    for (const lang of ['de', 'en', 'es']) {
      const text = dictionaries[lang].I18N[lang][key];
      assert.ok(text, `${lang}: ${key}`);
      assert.equal(text.includes('ß'), false, `${lang}: ${key} has a sharp s`);
      assert.equal(placeholders(text), placeholders(dictionaries.de.I18N.de[key]), `${lang}: ${key} placeholders`);
    }
  }
  // texts that must be said: nothing is started, the run buttons are named by their labels
  assert.match(dictionaries.de.I18N.de['nodes.assistant.notStarted'], /nichts gestartet/);
  assert.match(dictionaries.en.I18N.en['nodes.assistant.notStarted'], /Nothing was started/);
  assert.match(dictionaries.es.I18N.es['nodes.assistant.notStarted'], /No se ha iniciado nada/);
}

(async () => {
  testSummarizeCanvas();
  testRequestHistory();
  testBuildSubgraph();
  testAdjustedLines();
  testCostOfInserted();
  testFailure();
  testInsertIntoGraph();
  await testControllerBasics();
  await testEscapeAndKeys();
  await testInsertCard();
  await testCardWithRealHistory();
  await testWorkflowsAndErrors();
  await testLongConversation();
  testWiring();
  console.log('Assistent (Oberfläche): Leinwand als Daten, Vorschlag als Teilgraph, Kosten aus dem Plan, Panel, Karte, Rückgängig, Fehler, Texte in drei Sprachen.');
  console.log('test-nodes-assistant-ui.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
