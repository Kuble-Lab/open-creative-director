'use strict';
const { defineTool } = require('./tools');
const { definitions, executors } = require('../suno-agent');
// Existing agent keys retain read-only semantics: Suno credits cannot be spent through these tools.
module.exports.createSunoReadTools = () => definitions.filter(item => ['suno_status', 'suno_library', 'suno_audio'].includes(item.function.name)).map(({ function: def }) => defineTool({
  name: def.name, description: def.description, inputSchema: def.parameters, right: 'read',
  handler: async (args, { viewer }) => JSON.parse((await executors[def.name]({ viewer }, args)).toolResult)
}));
