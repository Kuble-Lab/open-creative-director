'use strict';

// App adapters share construction and identity; handlers keep the service's permission and provider checks.
function createAppTools({ viewer, publicBase = '', signal, ...deps } = {}) {
  const { buildTools } = require('./mcp');
  return { tools: buildTools(deps), context: { key: null, app: true, viewer, publicBase, signal } };
}
module.exports = { createAppTools };
