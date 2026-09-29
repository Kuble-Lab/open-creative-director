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
// Display order in the template dialog (unknown ids follow alphabetically).
const ORDER = Object.freeze(['hero-variants', 'image-to-ad', 'series-shots', 'frame-chain', 'motion-title', 'masked-edit', 'dub-clip', 'talking-portrait']);
const REQUIREMENTS = Object.freeze(['openrouter', 'ffmpeg', 'elevenlabs', 'rendernode', 'higgsfield', 'fal']);

// Checks of the requirement keys. Each returns true or a short reason. Required lazily so the
// module can be loaded in tests without touching provider configuration.
const REQUIREMENT_CHECKS = {
  openrouter: () => (require('../openrouter').hasKey() ? true : 'OPENROUTER_API_KEY is not set'),
  ffmpeg: () => (require('../ffmpeg').binaries().available ? true : 'ffmpeg/ffprobe not found'),
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

// Public summary for GET /api/workflow-templates.
function listTemplates({ lang = 'en', dir, checks } = {}) {
  return loadTemplates({ dir }).map((template) => {
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
      batch: nodes.some((node) => node.type === 'input.text_list' || node.type === 'input.media_list'),
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
  REQUIREMENTS,
  REQUIREMENT_CHECKS,
  loadTemplates,
  localizeTemplate,
  requirementStatus,
  listTemplates,
  resolveTemplate,
  validateTemplate,
  pickLang
};
