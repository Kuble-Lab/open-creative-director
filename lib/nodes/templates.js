'use strict';

// Starter workflows of the node view (SPEC §15). Every template is a JSON file in lib/nodes/templates/
// in the export format (`ocd.workflow`) plus `id`, `requires` and an optional `i18n` block with
// translated visible texts. loadTemplates() reads them once, validateTemplate() checks them against
// the node registry (the test does this for all of them), and resolveTemplate() returns a localized
// document that POST /api/workflows accepts as `document`.

const fs = require('fs');
const path = require('path');

const nodeRegistry = require('./registry');
const { validateDocument, FORMAT, VERSION } = require('./workflows-store');
const { isPlainObject } = require('./types');

const TEMPLATE_DIR = path.join(__dirname, 'templates');
const LANGUAGES = Object.freeze(['en', 'de', 'es']);
// Display order in the template dialog, the most useful first: simple ones that work with one provider, then the
// longer chains, the special ones last (unknown ids follow alphabetically).
const ORDER = Object.freeze([
  'image-to-video',
  'hero-variants',
  'image-to-ad',
  'video-to-post',
  'text-on-video',
  'video-cutout-overlay',
  'video-with-music',
  'song-from-idea',
  'motion-title',
  'storyboard-clips',
  'explainer-video',
  'explainer-video-topic',
  'explainer-video-presenter',
  'explainer-script',
  'explainer-script-topic',
  'typography-video',
  'typography-video-text',
  'image-formats',
  'photo-slideshow',
  'photo-to-3d',
  'series-shots',
  'frame-chain',
  'masked-edit',
  'talking-portrait',
  'music-video',
  'music-video-stills',
  'dub-clip'
]);
// Inputs that hold a list the rest of the graph runs once per entry (the "Batch" mark). A text.split with a fixed
// maximum is no batch: the person enters one thing, the list is made inside (see costSummary).
const LIST_SOURCES = Object.freeze(['input.text_list', 'input.media_list']);
const REQUIREMENTS = Object.freeze(['openrouter', 'ffmpeg', 'poppler', 'elevenlabs', 'rendernode', 'higgsfield', 'fal']);
// Requirements that bill the operator per use (named next to the price of a template).
const PAID_PROVIDERS = Object.freeze(['openrouter', 'elevenlabs', 'higgsfield', 'fal']);

// Checks of the requirement keys. Each returns true or a short reason. Required lazily so the
// module can be loaded in tests without touching provider configuration.
const REQUIREMENT_CHECKS = {
  openrouter: () => (require('../openrouter').hasKey() ? true : 'OPENROUTER_API_KEY is not set'),
  ffmpeg: () => (require('../ffmpeg').binaries().available ? true : 'ffmpeg/ffprobe not found'),
  poppler: () => require('../documents').available(),
  elevenlabs: () => (require('../elevenlabs').hasKey() ? true : 'ELEVENLABS_API_KEY is not set'),
  rendernode: () => (require('../rendernode').enabled() ? true : 'No render node configured'),
  higgsfield: () => (require('../higgsfield').status().connected ? true : 'Higgsfield is not connected'),
  fal: () => (require('../fal').hasKey() ? true : 'FAL_KEY is not set')
};

let cache = null;

function templateError(message) {
  return new Error(`Invalid template: ${message}`);
}

function readTemplateFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch (_) {
    return [];
  }
  return names.map((name) => {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    if (!isPlainObject(doc)) throw templateError(`${name} is not an object`);
    if (doc.id !== name.replace(/\.json$/, '')) throw templateError(`${name}: id must match the file name`);
    return doc;
  });
}

function orderRank(id) {
  const index = ORDER.indexOf(id);
  return index < 0 ? ORDER.length : index;
}

function loadTemplates({ dir = TEMPLATE_DIR, refresh = false } = {}) {
  if (dir === TEMPLATE_DIR && cache && !refresh) return cache;
  const list = readTemplateFiles(dir).sort((a, b) => orderRank(a.id) - orderRank(b.id) || a.id.localeCompare(b.id));
  if (dir === TEMPLATE_DIR) cache = list;
  return list;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function pickLang(lang) {
  const clean = String(lang || '').toLowerCase().slice(0, 2);
  return LANGUAGES.includes(clean) ? clean : 'en';
}

// Applies the translated strings of `lang` onto a copy of the template document.
// Keys of the i18n block: name, description, app.title, app.description, app.input.<node>.<param>,
// app.output.<node>, node.<id> (title), note.<id> (text), group.<id> (title), param.<node>.<param> (value).
function localizeTemplate(template, lang) {
  const doc = cloneJson(template);
  const strings = (doc.i18n && doc.i18n[pickLang(lang)]) || null;
  delete doc.i18n;
  if (!strings) return doc;
  const pick = (key) => (typeof strings[key] === 'string' && strings[key] ? strings[key] : null);
  if (pick('name')) doc.name = pick('name');
  if (pick('description')) doc.description = pick('description');
  const graph = doc.graph || {};
  for (const node of graph.nodes || []) {
    if (pick(`node.${node.id}`)) node.title = pick(`node.${node.id}`);
    for (const paramId of Object.keys(node.params || {})) {
      const value = pick(`param.${node.id}.${paramId}`);
      if (value !== null) node.params[paramId] = value;
    }
  }
  for (const note of graph.notes || []) if (pick(`note.${note.id}`)) note.text = pick(`note.${note.id}`);
  for (const group of graph.groups || []) if (pick(`group.${group.id}`)) group.title = pick(`group.${group.id}`);
  if (doc.app) {
    if (pick('app.title')) doc.app.title = pick('app.title');
    if (pick('app.description')) doc.app.description = pick('app.description');
    for (const entry of doc.app.inputs || []) {
      const label = pick(`app.input.${entry.node}.${entry.param}`);
      if (label) entry.label = label;
    }
    for (const entry of doc.app.outputs || []) {
      const label = pick(`app.output.${entry.node}`);
      if (label) entry.label = label;
    }
  }
  return doc;
}

function requirementStatus(requires, checks = REQUIREMENT_CHECKS) {
  const missing = [];
  for (const key of requires || []) {
    const check = checks[key];
    const result = check ? check() : `Unknown requirement ${key}`;
    if (result !== true) missing.push({ key, reason: String(result) });
  }
  return { available: missing.length === 0, missing };
}

// Node types of a graph, each once, in the order they first appear.
function nodeTypesOf(graph) {
  return [...new Set(((graph && graph.nodes) || []).map((node) => node.type))];
}

// Participants and guests may not use Higgsfield nodes (nodeRegistry.isRestricted, the rule of the registry endpoint
// and the engine): a template with one of them is not for them. Takes a graph or a template document.
function usesRestrictedNodes(graph, { registry = nodeRegistry.registry } = {}) {
  const source = graph && graph.graph ? graph.graph : graph;
  return nodeTypesOf(source).some((type) => nodeRegistry.isRestricted(registry.get(type)));
}

function isInputType(type) {
  return String(type).startsWith('input.');
}

// Reading order of a graph for the gallery: node types by distance from the inputs (longest path), nodes of one
// step side by side, equal types counted. [[{ type, count }]]. Inputs (input.*) all stand in the first step, so the line
// reads "what you give → what happens → result"; another node without a predecessor moves up to just before its first
// consumer.
function flowOf(graph) {
  const nodes = (graph && graph.nodes) || [];
  const edges = (graph && graph.edges) || [];
  const level = new Map(nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      const next = level.get(edge.from.node) + 1;
      if (level.get(edge.to.node) < next) {
        level.set(edge.to.node, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const node of nodes) {
    const consumers = edges.filter((edge) => edge.from.node === node.id).map((edge) => level.get(edge.to.node));
    if (isInputType(node.type) || edges.some((edge) => edge.to.node === node.id)) continue;
    if (consumers.length) level.set(node.id, Math.min(...consumers) - 1);
  }
  const steps = [];
  for (const node of nodes) {
    const index = level.get(node.id);
    steps[index] = steps[index] || [];
    const entry = steps[index].find((item) => item.type === node.type);
    if (entry) entry.count += 1;
    else steps[index].push({ type: node.type, count: 1 });
  }
  return steps.filter(Boolean);
}

// How often a node runs per run when a text.split in front of it makes the list: the largest maximum of the splits
// upstream (an upper bound, a model may write fewer parts). null without one: another node makes the list (the plan of a
// music video) and its length is only known once that node has run. Lists of a Batch template count one entry.
function splitRuns(graph, nodeId) {
  const nodes = new Map(((graph && graph.nodes) || []).map((node) => [node.id, node]));
  const seen = new Set();
  const queue = [nodeId];
  let runs = null;
  while (queue.length) {
    const current = queue.pop();
    for (const edge of (graph.edges || []).filter((item) => item.to.node === current)) {
      const from = nodes.get(edge.from.node);
      if (!from || seen.has(from.id)) continue;
      seen.add(from.id);
      if (from.type === 'text.split') runs = Math.max(runs || 1, Number.isInteger(from.params && from.params.max) ? from.params.max : 50);
      queue.push(from.id);
    }
  }
  return runs;
}

// What one run of a template costs, from its nodes (engine.estimateGraph, no prices of its own):
//   free      no paid node
//   estimate  every paid node has an estimate                   usd / credits = the sum
//   partial   some have one, the rest depends on model and length   usd / credits = what is known ("from")
//   unknown   none has one
// `providers` are the paid services (from `requires`) when something is paid. A list input counts one item; a node behind a list
// that another node makes has no price (how many times it runs is not known before the run).
function costSummary(template, { registry = nodeRegistry.registry } = {}) {
  const hasInputList = nodeTypesOf(template.graph).some((type) => LIST_SOURCES.includes(type));
  // a node behind a split of fixed size runs once per part: a run pays for all of them
  const runs = (nodeId, entry) => (!hasInputList && entry.executions === null ? splitRuns(template.graph, nodeId) : 1);
  const found = require('./engine').estimateGraph(template.graph, { registry, runs });
  let kind = 'free';
  if (found.paidNodes) kind = found.unknownNodes === 0 ? 'estimate' : found.unknownNodes < found.paidNodes ? 'partial' : 'unknown';
  const round = (value) => Math.round(value * 10000) / 10000;
  return {
    kind,
    usd: kind === 'estimate' || kind === 'partial' ? round(found.usd) : 0,
    credits: kind === 'estimate' || kind === 'partial' ? round(found.credits) : 0,
    paidNodes: found.paidNodes,
    providers: found.paidNodes ? (template.requires || []).filter((key) => PAID_PROVIDERS.includes(key)) : []
  };
}

// Public summary for GET /api/workflow-templates. `hideRestricted` (participants, guests) leaves out the templates they
// may not use. nodeTypes (every type once, to find the templates of a node type), flow (see flowOf) and cost come from
// the graph.
function listTemplates({ lang = 'en', dir, checks, registry = nodeRegistry.registry, hideRestricted = false } = {}) {
  return loadTemplates({ dir })
    .filter((template) => !hideRestricted || !usesRestrictedNodes(template.graph, { registry }))
    .map((template) => {
      const doc = localizeTemplate(template, lang);
      const status = requirementStatus(template.requires, checks);
      const nodes = (doc.graph && doc.graph.nodes) || [];
      return {
        id: template.id,
        name: doc.name,
        description: doc.description || '',
        requires: (template.requires || []).slice(),
        available: status.available,
        missing: status.missing,
        nodeCount: nodes.length,
        nodeTypes: nodeTypesOf(doc.graph),
        flow: flowOf(doc.graph),
        cost: costSummary(template, { registry }),
        batch: nodes.some((node) => LIST_SOURCES.includes(node.type)),
        app: Boolean(doc.app && doc.app.enabled)
      };
    });
}

// Localized `ocd.workflow` document of a template, or null for an unknown id.
function resolveTemplate(id, { lang = 'en', dir } = {}) {
  const template = loadTemplates({ dir }).find((item) => item.id === id);
  if (!template) return null;
  const doc = localizeTemplate(template, lang);
  return { format: FORMAT, version: VERSION, name: doc.name, description: doc.description || '', graph: doc.graph, app: doc.app };
}

// Throws when a template does not load: known node types and ports, compatible edges, no cycles,
// valid app section (exposed params exist, outputs are output.result nodes), `requires` complete.
function validateTemplate(template, { registry = nodeRegistry.registry } = {}) {
  if (!isPlainObject(template)) throw templateError('not an object');
  if (typeof template.id !== 'string' || !/^[a-z0-9-]{3,40}$/.test(template.id)) throw templateError('bad id');
  if (!Array.isArray(template.requires) || template.requires.some((key) => !REQUIREMENTS.includes(key))) {
    throw templateError(`${template.id}: requires must list ${REQUIREMENTS.join(', ')}`);
  }
  const doc = resolveDocumentFor(template);
  const result = validateDocument(doc, { registry });
  const nodeById = new Map(result.graph.nodes.map((node) => [node.id, node]));
  for (const node of result.graph.nodes) {
    if (!registry.get(node.type)) throw templateError(`${template.id}: unknown node type ${node.type}`);
  }
  // every edge must connect compatible port types (validateDocument checks that the ports exist)
  const types = require('./types');
  for (const edge of result.graph.edges) {
    const from = nodeById.get(edge.from.node);
    const to = nodeById.get(edge.to.node);
    const fromDef = registry.get(from.type);
    const toDef = registry.get(to.type);
    const fromPort = registry.portsFor(fromDef, registry.normalizeParams(fromDef, from.params)).outputs.find((port) => port.id === edge.from.port);
    const toPort = registry.portsFor(toDef, registry.normalizeParams(toDef, to.params)).inputs.find((port) => port.id === edge.to.port);
    if (!types.canConnect(fromPort.type, toPort.type)) {
      throw templateError(`${template.id}: edge ${edge.id} connects ${fromPort.type} to ${toPort.type}`);
    }
  }
  if (!result.app.enabled || !result.app.inputs.length || !result.app.outputs.length) {
    throw templateError(`${template.id}: templates ship with an enabled Design App (inputs and outputs)`);
  }
  return result;
}

function resolveDocumentFor(template) {
  return { format: FORMAT, version: VERSION, name: template.name, description: template.description || '', graph: template.graph, app: template.app };
}

module.exports = {
  TEMPLATE_DIR,
  LANGUAGES,
  ORDER,
  REQUIREMENTS,
  REQUIREMENT_CHECKS,
  loadTemplates,
  localizeTemplate,
  requirementStatus,
  listTemplates,
  resolveTemplate,
  validateTemplate,
  usesRestrictedNodes,
  nodeTypesOf,
  flowOf,
  costSummary,
  PAID_PROVIDERS,
  pickLang
};
