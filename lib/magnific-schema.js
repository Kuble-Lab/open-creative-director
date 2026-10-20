'use strict';

const { isDeepStrictEqual } = require('node:util');

// Validate the live MCP input schema before sending anything to the provider. References stay local;
// unsupported validation keywords fail closed rather than silently accepting an unchecked paid request.
function validate(value, schema, root = schema, at = '$', depth = 0) {
  const fail = () => { throw new Error(`Magnific arguments do not match inputSchema at ${at}.`); };
  if (depth > 60 || schema === false) return fail();
  if (schema === true) return;
  if (!schema || typeof schema !== 'object') return fail();
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/')) return fail();
    const target = schema.$ref.slice(2).split('/').reduce((s, k) => s?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], root);
    if (!target) return fail();
    validate(value, target, root, at, depth + 1);
  }
  const check = (s, v = value, p = at) => validate(v, s, root, p, depth + 1);
  const matches = (s) => { try { check(s); return true; } catch (_) { return false; } };
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (schema[key]) {
    const count = schema[key].filter(matches).length;
    if ((key === 'anyOf' && !count) || (key === 'oneOf' && count !== 1) || (key === 'allOf' && count !== schema[key].length)) fail();
  }
  if (schema.not && matches(schema.not)) fail();
  if (schema.if) check(matches(schema.if) ? (schema.then ?? true) : (schema.else ?? true));
  if (schema.enum && !schema.enum.some((v) => isDeepStrictEqual(v, value))) fail();
  if ('const' in schema && !isDeepStrictEqual(schema.const, value)) fail();
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.includes(type) && !(types.includes('integer') && Number.isInteger(value))) fail();
  if (type === 'number') {
    if (!Number.isFinite(value)) fail();
    for (const [key, bad] of [['minimum', value < schema.minimum], ['maximum', value > schema.maximum], ['exclusiveMinimum', value <= schema.exclusiveMinimum], ['exclusiveMaximum', value >= schema.exclusiveMaximum]]) if (typeof schema[key] === 'number' && bad) fail();
    if (schema.multipleOf && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-8) fail();
  }
  if (type === 'string') {
    if (value.length < (schema.minLength || 0) || value.length > (schema.maxLength ?? Infinity)) fail();
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) fail();
    if (['uri', 'url', 'uri-reference'].includes(schema.format)) { try { new URL(value); } catch (_) { fail(); } }
  }
  if (type === 'array') {
    if (value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? Infinity)) fail();
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) fail();
    value.forEach((v, i) => check(schema.prefixItems?.[i] ?? (Array.isArray(schema.items) ? schema.items[i] ?? schema.additionalItems ?? true : schema.items ?? true), v, `${at}[${i}]`));
    if (schema.contains) {
      const count = value.filter((v) => { try { check(schema.contains, v); return true; } catch (_) { return false; } }).length;
      if (count < (schema.minContains ?? 1) || count > (schema.maxContains ?? Infinity)) fail();
    }
  }
  if (type === 'object' && value) {
    const keys = Object.keys(value);
    if (keys.length < (schema.minProperties || 0) || keys.length > (schema.maxProperties ?? Infinity)) fail();
    for (const k of schema.required || []) if (!Object.hasOwn(value, k)) fail();
    for (const k of keys) {
      if (schema.propertyNames) check(schema.propertyNames, k);
      const rules = Object.entries(schema.patternProperties || {}).filter(([pattern]) => new RegExp(pattern, 'u').test(k)).map(([, s]) => s);
      if (Object.hasOwn(schema.properties || {}, k)) rules.push(schema.properties[k]);
      if (!rules.length && schema.additionalProperties !== undefined) rules.push(schema.additionalProperties);
      for (const rule of rules) check(rule, value[k], `${at}.${k}`);
      for (const required of schema.dependentRequired?.[k] || []) if (!Object.hasOwn(value, required)) fail();
      if (schema.dependentSchemas?.[k]) check(schema.dependentSchemas[k]);
    }
  }
  for (const key of ['unevaluatedProperties', 'unevaluatedItems', '$dynamicRef', 'dependencies']) if (key in schema) throw new Error(`Magnific inputSchema keyword ${key} is not supported.`);
}
module.exports = { validate };
