'use strict';

// Tool registry of the agent access (MCP). The tools themselves come with the next work package; this file holds what
// every tool needs: the definition shape, the check of the arguments against the input schema and the error type for a
// message that goes back to the agent as a tool result (isError).
//
// tool  {
//   name         1 to 128 characters: letters, digits, _ - .
//   title        optional, for display
//   description  what the tool does, for the model
//   inputSchema  JSON Schema (an object); the arguments are checked against it before the handler runs
//   right        'read' (every key) | 'start' (keys with the right "read and start")
//   handler      async (args, context) => string | { content, structuredContent?, isError? }
// }
// context  { key, viewer } : the key as the API shows it (never the secret) and the person it acts as (lib/access.js).

const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const TOOL_RIGHTS = Object.freeze(['read', 'start']);

// A message for the agent: the tool did not do its job, and says why in words the model can act on.
class ToolError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'ToolError';
    this.details = details;
  }
}

function defineTool(tool) {
  if (!tool || typeof tool !== 'object') throw new TypeError('A tool must be an object');
  if (typeof tool.name !== 'string' || !NAME_PATTERN.test(tool.name)) throw new TypeError(`Invalid tool name: ${tool && tool.name}`);
  if (typeof tool.description !== 'string' || !tool.description.trim()) throw new TypeError(`Tool ${tool.name} needs a description`);
  if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || tool.inputSchema.type !== 'object') {
    throw new TypeError(`Tool ${tool.name} needs an inputSchema of type object`);
  }
  if (!TOOL_RIGHTS.includes(tool.right)) throw new TypeError(`Tool ${tool.name} needs a right (read or start)`);
  if (typeof tool.handler !== 'function') throw new TypeError(`Tool ${tool.name} needs a handler`);
  return Object.freeze({ ...tool });
}

// A key with the right "read and start" may use every tool, a key with "read" only the tools that read.
function rightAllows(keyRight, toolRight) {
  return toolRight === 'read' || keyRight === 'start';
}

/* ---------- arguments against the input schema ---------- */

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function typeMatches(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return isObject(value);
    case 'null': return value === null;
    default: return true;
  }
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// The subset of JSON Schema the tools use: type, enum, required, properties, additionalProperties: false, items,
// minLength, maxLength, minimum, maximum, maxItems, minItems, pattern. Returns a list of problems (empty = valid).
function validateArguments(schema, value, at = 'arguments', problems = [], depth = 0) {
  if (!isObject(schema) || depth > 8) return problems;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(type, value))) {
      problems.push(`${at} must be ${types.join(' or ')}, not ${describeType(value)}`);
      return problems;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    problems.push(`${at} must be one of: ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (Number.isInteger(schema.minLength) && length < schema.minLength) problems.push(`${at} must have at least ${schema.minLength} characters`);
    if (Number.isInteger(schema.maxLength) && length > schema.maxLength) problems.push(`${at} must have at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === 'string') {
      let ok = true;
      try {
        ok = new RegExp(schema.pattern, 'u').test(value);
      } catch (_) {
        ok = true;
      }
      if (!ok) problems.push(`${at} has an invalid format`);
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) problems.push(`${at} must be at least ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) problems.push(`${at} must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) problems.push(`${at} must have at least ${schema.minItems} items`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) problems.push(`${at} must have at most ${schema.maxItems} items`);
    if (isObject(schema.items)) value.forEach((item, index) => validateArguments(schema.items, item, `${at}[${index}]`, problems, depth + 1));
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (!(name in value) || value[name] === undefined) problems.push(`${at}.${name} is required`);
    }
    for (const [name, entry] of Object.entries(value)) {
      if (name in properties) validateArguments(properties[name], entry, `${at}.${name}`, problems, depth + 1);
      else if (schema.additionalProperties === false) problems.push(`${at}.${name} is not a known property`);
    }
  }
  return problems.slice(0, 10);
}

module.exports = { NAME_PATTERN, TOOL_RIGHTS, ToolError, defineTool, rightAllows, validateArguments };
