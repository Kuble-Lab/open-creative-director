'use strict';

// Declarative node registry (SPEC §8). Node modules export registerAll(registry);
// this file loads them into the default registry at the bottom.

const typesLib = require('./types');

const REGISTRY_VERSION = 1;

const CATEGORIES = Object.freeze([
  'input',
  'llm',
  'text',
  'image',
  'video',
  'audio',
  'edit-image',
  'edit-video',
  'edit-audio',
  'higgsfield',
  'fal',
  'utility',
  'output'
]);

const PARAM_KINDS = Object.freeze([
  'text',
  'textarea',
  'code',
  'number',
  'integer',
  'slider',
  'boolean',
  'select',
  'color',
  'asset',
  'assets',
  'tags'
]);

const TYPE_ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const PORT_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

function invalid(type, message) {
  return new Error(`Invalid node definition ${type || '?'}: ${message}`);
}

function validatePorts(type, ports, direction) {
  if (ports === undefined) return [];
  if (!Array.isArray(ports)) throw invalid(type, `${direction} must be an array`);
  const seen = new Set();
  return ports.map((port) => {
    if (!port || typeof port !== 'object') throw invalid(type, `${direction} entry must be an object`);
    if (!PORT_ID_PATTERN.test(String(port.id || ''))) throw invalid(type, `bad ${direction} port id ${port.id}`);
    if (seen.has(port.id)) throw invalid(type, `duplicate ${direction} port ${port.id}`);
    seen.add(port.id);
    if (!typesLib.isValidType(port.type)) throw invalid(type, `${direction} port ${port.id} has unknown type ${port.type}`);
    // `suggest` (inputs only): the node type the editor puts in front of this input when it is missing ("insert with
    // inputs", the fix button of an incomplete card). Whether that type exists and fits is checked by the tests, since
    // the type may be registered later.
    if (port.suggest !== undefined && (direction !== 'inputs' || typeof port.suggest !== 'string' || !TYPE_ID_PATTERN.test(port.suggest))) {
      throw invalid(type, `${direction} port ${port.id} has a bad suggest hint`);
    }
    // `min` (multiple inputs only): how many connections the node needs at run time; "insert with inputs" supplies
    // that many sources instead of one.
    if (port.min !== undefined && (direction !== 'inputs' || port.multiple !== true || !Number.isInteger(port.min) || port.min < 1 || port.min > (port.max || Infinity))) {
      throw invalid(type, `${direction} port ${port.id} has a bad min`);
    }
    // `limitBy` (multiple inputs only): the number of connections the input takes depends on a param. { param, capability }
    // names the param (the model) and what to read from it ('references', 'audio'); the node's `limitsFor(params)` gives
    // the value on the server, the client reads the same from the capabilities of the chosen option.
    if (port.limitBy !== undefined) {
      const by = port.limitBy;
      if (direction !== 'inputs' || port.multiple !== true || !by || typeof by !== 'object' || !PORT_ID_PATTERN.test(String(by.param || '')) || !PORT_ID_PATTERN.test(String(by.capability || ''))) {
        throw invalid(type, `${direction} port ${port.id} has a bad limitBy`);
      }
    }
    return { ...port };
  });
}

function validateParams(type, params) {
  if (params === undefined) return [];
  if (!Array.isArray(params)) throw invalid(type, 'params must be an array');
  const seen = new Set();
  return params.map((param) => {
    if (!param || typeof param !== 'object') throw invalid(type, 'param entry must be an object');
    if (!PORT_ID_PATTERN.test(String(param.id || ''))) throw invalid(type, `bad param id ${param.id}`);
    if (seen.has(param.id)) throw invalid(type, `duplicate param ${param.id}`);
    seen.add(param.id);
    if (!PARAM_KINDS.includes(param.kind)) throw invalid(type, `param ${param.id} has unknown kind ${param.kind}`);
    // `cacheOmitDefault` (a param added after nodes of the type were saved): left out of the cache key while it holds its default (lib/nodes/engine.js)
    if (param.cacheOmitDefault !== undefined && param.cacheOmitDefault !== true) throw invalid(type, `param ${param.id} has a bad cacheOmitDefault`);
    return { ...param };
  });
}

// portVariants: { param, values: { <value>: { inputs?, outputs? } } } switches ports by a param value
// (e.g. input.media_list changes its output type with `kind`). Declarative so the client can mirror it.
function validatePortVariants(type, portVariants, paramIds) {
  if (portVariants === undefined) return undefined;
  if (!portVariants || typeof portVariants !== 'object' || !paramIds.has(portVariants.param)) {
    throw invalid(type, 'portVariants.param must name a param');
  }
  const values = {};
  for (const [value, ports] of Object.entries(portVariants.values || {})) {
    values[value] = {};
    if (ports.inputs !== undefined) values[value].inputs = validatePorts(type, ports.inputs, 'inputs');
    if (ports.outputs !== undefined) values[value].outputs = validatePorts(type, ports.outputs, 'outputs');
  }
  return { param: portVariants.param, values };
}

function normaliseDefinition(def) {
  if (!def || typeof def !== 'object') throw invalid(null, 'definition must be an object');
  const type = def.type;
  if (typeof type !== 'string' || !TYPE_ID_PATTERN.test(type)) throw invalid(type, 'bad type id');
  if (!CATEGORIES.includes(def.category)) throw invalid(type, `unknown category ${def.category}`);
  if (typeof def.execute !== 'function') throw invalid(type, 'execute must be a function');
  const params = validateParams(type, def.params);
  const paramIds = new Set(params.map((param) => param.id));
  const inputs = validatePorts(type, def.inputs, 'inputs');
  for (const input of inputs) {
    if (input.param !== undefined && !paramIds.has(input.param)) {
      throw invalid(type, `input ${input.id} references unknown param ${input.param}`);
    }
    if (input.limitBy !== undefined && !paramIds.has(input.limitBy.param)) {
      throw invalid(type, `input ${input.id} has a limitBy that names an unknown param ${input.limitBy.param}`);
    }
  }
  if (inputs.some((input) => input.limitBy !== undefined) && typeof def.limitsFor !== 'function') {
    throw invalid(type, 'inputs with limitBy need a limitsFor(params) function');
  }
  if (def.prepare !== undefined && typeof def.prepare !== 'function') throw invalid(type, 'prepare must be a function');
  // the state of the app the node reads besides its parameters and inputs, for its cache key (lib/nodes/engine.js, resolveStamp)
  if (def.cacheStamp !== undefined && typeof def.cacheStamp !== 'function') throw invalid(type, 'cacheStamp must be a function');
  if (def.cacheStampAdopts !== undefined && def.cacheStampAdopts !== true && typeof def.cacheStampAdopts !== 'function') throw invalid(type, 'cacheStampAdopts must be true or a function');
  if (def.cacheStampOutputs !== undefined && typeof def.cacheStampOutputs !== 'function') throw invalid(type, 'cacheStampOutputs must be a function');
  if (def.cacheStampOutputs !== undefined && typeof def.cacheStamp !== 'function') throw invalid(type, 'cacheStampOutputs needs a cacheStamp function');
  if (def.cacheStampAdopts !== undefined && typeof def.cacheStamp !== 'function') throw invalid(type, 'cacheStampAdopts needs a cacheStamp function');
  return {
    ...def,
    type,
    version: Number.isInteger(def.version) && def.version > 0 ? def.version : 1,
    label: typeof def.label === 'string' && def.label ? def.label : type,
    keywords: Array.isArray(def.keywords) ? def.keywords.map(String) : [],
    inputs,
    outputs: validatePorts(type, def.outputs, 'outputs'),
    params,
    portVariants: validatePortVariants(type, def.portVariants, paramIds),
    paid: def.paid === true,
    cost: {
      // 'local' runs on this machine, 'free' calls a provider without a charge (the plan of the music nodes).
      unit: def.cost?.unit === 'credits' ? 'credits' : def.cost?.unit === 'usd' ? 'usd' : def.cost?.unit === 'free' ? 'free' : 'local',
      estimate: typeof def.cost?.estimate === 'function' ? def.cost.estimate : null,
      // false: the plan never guesses the price from the last result of this node type (see computePlan)
      history: def.cost?.history !== false
    }
  };
}

// Participants and guests (lib/access.js) may not use Higgsfield nodes (credits of the operator). The one rule behind
// the registry endpoint, the engine and the starter templates; takes a definition or its public descriptor.
function isRestricted(def) {
  return Boolean(def) && (def.category === 'higgsfield' || def.cost?.unit === 'credits');
}

// The service that bills a node, as the key of the starter-template requirements (openrouter, higgsfield, fal,
// elevenlabs), for the help texts: the `provider` of the definition, else derived from the category and cost unit of
// a paid node. null for what runs locally. 'llm' is a language model node: OpenRouter, or the ChatGPT subscription.
function providerOf(def) {
  if (typeof def.provider === 'string' && def.provider) return def.provider;
  if (def.cost?.unit === 'credits' || def.category === 'higgsfield') return 'higgsfield';
  if (def.category === 'fal') return 'fal';
  if (def.category === 'llm') return def.paid ? 'llm' : null;
  return def.paid ? 'openrouter' : null;
}

function paramDefaults(def) {
  const defaults = {};
  for (const param of def.params) {
    if (param.default !== undefined) defaults[param.id] = clone(param.default);
    else if (param.kind === 'boolean') defaults[param.id] = false;
    else if (['number', 'integer', 'slider'].includes(param.kind)) defaults[param.id] = param.optional ? null : 0;
    else if (['text', 'textarea', 'code', 'select', 'color'].includes(param.kind)) defaults[param.id] = '';
    else if (param.kind === 'tags' || param.kind === 'assets') defaults[param.id] = [];
    else defaults[param.id] = null;
  }
  return defaults;
}

// The params of a NEW node from the palette: the defaults, where a param may say `initial` for what a new node starts with. `default`
// is what a saved node that lacks the param is run with, and changing it would change old workflows (their result, their cache key);
// `initial` changes only what is written into nodes that are added from now on (public/nodes/graph.js mirrors this). The server creates
// no nodes itself today, so this function is the reference the tests compare graph.js with, not a call path of the server.
function initialParams(def) {
  const params = paramDefaults(def);
  for (const param of def.params) if (param.initial !== undefined) params[param.id] = clone(param.initial);
  return params;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

// Coerces saved/override values to the declared kinds and applies defaults.
// Blank numbers of an `optional` param become null; everything not coercible falls back to the default.
// Numbers are clamped to min/max; membership of select options is reported by checkParams(),
// not silently rewritten.
function normalizeParams(def, raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const defaults = paramDefaults(def);
  const out = { ...source };
  for (const param of def.params) {
    const fallback = defaults[param.id];
    let value = Object.prototype.hasOwnProperty.call(source, param.id) ? source[param.id] : fallback;
    if (value === undefined) value = fallback;
    if (param.kind === 'number' || param.kind === 'integer' || param.kind === 'slider') {
      if (isBlank(value)) {
        value = param.optional ? null : fallback;
      } else {
        let number = Number(value);
        if (!Number.isFinite(number)) {
          number = fallback === null || fallback === undefined ? null : Number(fallback);
        }
        if (number !== null) {
          if (param.kind === 'integer') number = Math.round(number);
          if (Number.isFinite(param.min) && number < param.min) number = param.min;
          if (Number.isFinite(param.max) && number > param.max) number = param.max;
        }
        value = number;
      }
    } else if (param.kind === 'boolean') {
      if (typeof value === 'string') value = value === 'true' || value === '1';
      else value = Boolean(value);
    } else if (['text', 'textarea', 'code', 'select', 'color'].includes(param.kind)) {
      value = value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value);
    } else if (param.kind === 'tags') {
      value = Array.isArray(value) ? value.map(String) : [];
    } else if (param.kind === 'assets') {
      value = Array.isArray(value) ? value : [];
    }
    out[param.id] = value;
  }
  return out;
}

// Static option values of a select param (strings or { value, label } objects).
function staticOptionValues(param) {
  if (!Array.isArray(param.options)) return null;
  return param.options.map((option) => (option && typeof option === 'object' ? option.value : option));
}

// Reports invalid select values of the params as issue strings.
function checkParams(def, params) {
  const issues = [];
  for (const param of def.params) {
    const value = params[param.id];
    if (param.kind === 'select' && !param.optionsSource && value !== '' && value !== null && value !== undefined) {
      const options = staticOptionValues(param);
      if (options && !options.some((option) => String(option) === String(value))) {
        issues.push(`param ${param.id}: "${value}" is not a valid option`);
      }
    }
  }
  return issues;
}

/* ---------- registry instance ---------- */

function createRegistry() {
  const defs = new Map();

  function register(definition) {
    const def = normaliseDefinition(definition);
    if (defs.has(def.type)) throw invalid(def.type, 'already registered');
    defs.set(def.type, Object.freeze(def));
    return def;
  }

  function unregister(type) {
    return defs.delete(type);
  }

  function get(type) {
    return defs.get(type) || null;
  }

  function list() {
    return [...defs.values()];
  }

  // Ports of a node given its (normalised or raw) params, honouring portVariants and limitsFor. An input with `limitBy`
  // gets a `limit`: { known: true, max, roles, required, subject } while the node's limitsFor(params) can say what the
  // chosen model takes (`max` is then the smaller of that and the fixed maximum of the port), { known: false } while it
  // cannot (the fixed maximum stays the ceiling).
  function portsFor(def, params) {
    let { inputs, outputs } = def;
    if (def.portVariants) {
      const raw = params && Object.prototype.hasOwnProperty.call(params, def.portVariants.param)
        ? params[def.portVariants.param]
        : paramDefaults(def)[def.portVariants.param];
      const variant = def.portVariants.values[String(raw)];
      if (variant?.inputs) inputs = variant.inputs;
      if (variant?.outputs) outputs = variant.outputs;
    }
    if (typeof def.limitsFor === 'function' && inputs.some((port) => port.limitBy)) {
      let limits = {};
      try {
        limits = def.limitsFor(params && typeof params === 'object' ? params : {}) || {};
      } catch (_) {
        limits = {};
      }
      inputs = inputs.map((port) => {
        if (!port.limitBy) return port;
        const limit = limits[port.id];
        if (!limit || !Number.isFinite(limit.max)) return { ...port, limit: { known: false } };
        const max = Number.isFinite(port.max) ? Math.min(port.max, limit.max) : limit.max;
        return { ...port, max, limit: { known: true, max, roles: Array.isArray(limit.roles) ? limit.roles : [], required: limit.required === true, subject: String(limit.subject || '') } };
      });
    }
    return { inputs, outputs };
  }

  // true when usable, otherwise the human-readable reason.
  function availability(def) {
    if (typeof def.available !== 'function') return true;
    try {
      const result = def.available();
      if (result === true || result === undefined) return true;
      return typeof result === 'string' && result ? result : 'unavailable';
    } catch (err) {
      return `availability check failed: ${err.message}`;
    }
  }

  function publicDescriptor(def) {
    const descriptor = {
      type: def.type,
      version: def.version,
      category: def.category,
      label: def.label,
      keywords: def.keywords.slice(),
      inputs: clone(def.inputs),
      outputs: clone(def.outputs),
      params: def.params.map((param) => {
        const out = {};
        for (const [key, value] of Object.entries(param)) {
          if (typeof value !== 'function') out[key] = clone(value);
        }
        return out;
      }),
      paid: def.paid,
      cost: { unit: def.cost.unit, hasEstimate: Boolean(def.cost.estimate) },
      available: availability(def)
    };
    if (def.portVariants) descriptor.portVariants = clone(def.portVariants);
    const provider = providerOf(def);
    if (provider) descriptor.provider = provider;
    if (def.experimental) descriptor.experimental = true;
    if (def.description) descriptor.description = String(def.description);
    return descriptor;
  }

  // Payload of GET /api/nodes/registry (SPEC §11.1).
  function publicRegistry() {
    return {
      version: REGISTRY_VERSION,
      ...typesLib.describe(),
      categories: CATEGORIES.slice(),
      nodeTypes: list().map(publicDescriptor)
    };
  }

  return {
    register,
    unregister,
    get,
    list,
    portsFor,
    availability,
    publicDescriptor,
    publicRegistry,
    paramDefaults,
    initialParams,
    normalizeParams,
    checkParams
  };
}

const defaultRegistry = createRegistry();

// Node modules of later packages add themselves here.
require('./nodes-basic').registerAll(defaultRegistry);
require('./nodes-generate').registerAll(defaultRegistry);
require('./nodes-fal').registerAll(defaultRegistry);
require('./nodes-edit').registerAll(defaultRegistry);
require('./nodes-music-video').registerAll(defaultRegistry);
require('./nodes-music-video-hud').registerAll(defaultRegistry);
require('./nodes-documents').registerAll(defaultRegistry);
require('./nodes-explainer').registerAll(defaultRegistry);
require('./nodes-explainer-video').registerAll(defaultRegistry);

module.exports = {
  REGISTRY_VERSION,
  CATEGORIES,
  PARAM_KINDS,
  createRegistry,
  registry: defaultRegistry,
  register: defaultRegistry.register,
  unregister: defaultRegistry.unregister,
  get: defaultRegistry.get,
  list: defaultRegistry.list,
  portsFor: defaultRegistry.portsFor,
  availability: defaultRegistry.availability,
  publicDescriptor: defaultRegistry.publicDescriptor,
  publicRegistry: defaultRegistry.publicRegistry,
  isRestricted,
  providerOf,
  paramDefaults,
  initialParams,
  normalizeParams,
  checkParams
};
