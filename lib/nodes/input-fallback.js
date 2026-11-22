'use strict';

const { parseType, textValue, numberValue } = require('./types');

// Use exactly the same scalar value with no wire and with a wire whose output is empty.
// Lists and multi-input ports keep their collection and mapping rules.
function paramFallback(port, params) {
  const type = parseType(port.type);
  const value = params[port.param];
  if (!port.param || port.multiple || !type || type.list || !['text', 'number'].includes(type.base) ||
      value === null || value === undefined || (typeof value === 'string' && !value.trim())) return undefined;
  return type.base === 'number' ? numberValue(value) : textValue(value);
}

// A wired input whose source output stays empty falls back to its field only where the port asks for it
// (`emptyFallback: true`): elsewhere a hidden field would suddenly count in workflows that exist already.
function emptyFallback(port, params) {
  return port && port.emptyFallback === true ? paramFallback(port, params) : undefined;
}

module.exports = { paramFallback, emptyFallback };
