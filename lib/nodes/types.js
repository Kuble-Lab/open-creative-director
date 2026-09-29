'use strict';

// Port types, compatibility rules and value helpers of the node view (SPEC §6).
// Pure module: no I/O, shared by registry, engine and (via the registry endpoint) the client.

const crypto = require('crypto');

const LIST_SUFFIX = '[]';

// Base port types. `color` names the CSS token the client uses for the port.
const PORT_TYPES = Object.freeze({
  text: Object.freeze({ label: 'Text', color: '--nv-port-text', media: false }),
  number: Object.freeze({ label: 'Number', color: '--nv-port-number', media: false }),
  image: Object.freeze({ label: 'Image', color: '--nv-port-image', media: true }),
  video: Object.freeze({ label: 'Video', color: '--nv-port-video', media: true }),
  audio: Object.freeze({ label: 'Audio', color: '--nv-port-audio', media: true }),
  any: Object.freeze({ label: 'Any', color: '--nv-port-any', media: false })
});

const BASE_TYPES = Object.freeze(Object.keys(PORT_TYPES));
const MEDIA_TYPES = Object.freeze(BASE_TYPES.filter((type) => PORT_TYPES[type].media));

/* ---------- type strings ---------- */

// 'image[]' -> { base: 'image', list: true }; invalid strings -> null.
function parseType(type) {
  if (typeof type !== 'string') return null;
  const list = type.endsWith(LIST_SUFFIX);
  const base = list ? type.slice(0, -LIST_SUFFIX.length) : type;
  if (!Object.prototype.hasOwnProperty.call(PORT_TYPES, base)) return null;
  return { base, list };
}

function isValidType(type) {
  return parseType(type) !== null;
}

function listOf(base) {
  return `${base}${LIST_SUFFIX}`;
}

function isMediaType(type) {
  const parsed = parseType(type);
  return Boolean(parsed && PORT_TYPES[parsed.base].media);
}

/* ---------- compatibility (SPEC §6.2) ---------- */

// Compatibility of two base types: same, `any` on either side, or number -> text.
function baseCompatible(fromBase, toBase) {
  if (!Object.prototype.hasOwnProperty.call(PORT_TYPES, fromBase)) return false;
  if (!Object.prototype.hasOwnProperty.call(PORT_TYPES, toBase)) return false;
  if (fromBase === toBase) return true;
  if (fromBase === 'any' || toBase === 'any') return true;
  return fromBase === 'number' && toBase === 'text';
}

// Rules 1-7: list-ness never blocks a connection (T[] -> T maps, T -> T[] wraps);
// only the base types must be compatible. Cycles and edge multiplicity are graph concerns.
function canConnect(fromType, toType) {
  const from = parseType(fromType);
  const to = parseType(toType);
  if (!from || !to) return false;
  return baseCompatible(from.base, to.base);
}

// Matrix over base types for the client: compat[from][to] === canConnect(from, to).
function compatMatrix() {
  const matrix = {};
  for (const from of BASE_TYPES) {
    matrix[from] = {};
    for (const to of BASE_TYPES) matrix[from][to] = baseCompatible(from, to);
  }
  return matrix;
}

// What GET /api/nodes/registry serves as portTypes + compat.
function describe() {
  const portTypes = {};
  for (const type of BASE_TYPES) portTypes[type] = { ...PORT_TYPES[type] };
  return { portTypes, compat: compatMatrix(), listSuffix: LIST_SUFFIX };
}

/* ---------- values (SPEC §6.1) ---------- */

function textValue(value) {
  return { type: 'text', value: String(value) };
}

function numberValue(value) {
  return { type: 'number', value: Number(value) };
}

function listValue(of, items) {
  return { type: 'list', of, items: Array.isArray(items) ? items : [] };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isListValue(value) {
  return isPlainObject(value) && value.type === 'list' && Array.isArray(value.items);
}

function isValue(value) {
  if (!isPlainObject(value)) return false;
  if (value.type === 'text') return typeof value.value === 'string';
  if (value.type === 'number') return Number.isFinite(value.value);
  if (value.type === 'list') return isValidType(value.of) && !value.of.endsWith(LIST_SUFFIX) && Array.isArray(value.items);
  if (MEDIA_TYPES.includes(value.type)) {
    return typeof value.sessionId === 'string' && typeof value.assetId === 'string';
  }
  return false;
}

// Type string of a value: 'text', 'image', 'image[]' ...
function valueType(value) {
  if (!isPlainObject(value)) return null;
  if (value.type === 'list') return listOf(value.of || 'any');
  return typeof value.type === 'string' ? value.type : null;
}

/* ---------- canonical JSON and fingerprints (SPEC §9.3) ---------- */

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// JSON with recursively sorted object keys; undefined properties are dropped.
function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  }
  return `{${parts.join(',')}}`;
}

// Fingerprint used inside cache keys: text -> hash, number -> number, media -> '<session>/<asset>'
// (assets are immutable), list -> array of item fingerprints.
function fingerprint(value) {
  if (!isPlainObject(value)) return sha256Hex(canonicalJson(value));
  if (value.type === 'text') return `t:${sha256Hex(String(value.value))}`;
  if (value.type === 'number') return value.value;
  if (value.type === 'list') return (value.items || []).map((item) => fingerprint(item));
  if (MEDIA_TYPES.includes(value.type)) return `${value.sessionId}/${value.assetId}`;
  return sha256Hex(canonicalJson(value));
}

/* ---------- adapting values to ports ---------- */

// Adapts one scalar value to a base port type. Returns { value } or { error }.
function adaptScalar(value, portBase) {
  if (!isPlainObject(value) || typeof value.type !== 'string' || value.type === 'list') {
    return { error: `expected ${portBase} but got ${valueType(value) || 'nothing'}` };
  }
  if (portBase === 'any' || value.type === portBase) return { value };
  if (value.type === 'number' && portBase === 'text') return { value: textValue(String(value.value)) };
  return { error: `expected ${portBase} but got ${value.type}` };
}

// Adapts a value (scalar or list) to a port type (SPEC §6.2 rules 3-6).
//   scalar value -> scalar port  : coerced value
//   scalar value -> list port    : wrapped into a one-item list
//   list value   -> list port    : items coerced
//   list value   -> scalar port  : { map: true } with the coerced list (implicit map over the items)
// Returns { value, map } or { error }.
function adaptValue(value, portType) {
  const port = parseType(portType);
  if (!port) return { error: `unknown port type ${portType}` };
  if (isListValue(value)) {
    const items = [];
    for (const item of value.items) {
      const adapted = adaptScalar(item, port.base);
      if (adapted.error) return adapted;
      items.push(adapted.value);
    }
    const of = port.base === 'any' ? value.of || 'any' : port.base;
    return { value: listValue(of, items), map: !port.list };
  }
  const adapted = adaptScalar(value, port.base);
  if (adapted.error) return adapted;
  if (port.list) return { value: listValue(port.base, [adapted.value]), map: false };
  return { value: adapted.value, map: false };
}

module.exports = {
  PORT_TYPES,
  BASE_TYPES,
  MEDIA_TYPES,
  LIST_SUFFIX,
  parseType,
  isValidType,
  listOf,
  isMediaType,
  baseCompatible,
  canConnect,
  compatMatrix,
  describe,
  textValue,
  numberValue,
  listValue,
  isPlainObject,
  isListValue,
  isValue,
  valueType,
  sha256Hex,
  canonicalJson,
  fingerprint,
  adaptScalar,
  adaptValue
};
