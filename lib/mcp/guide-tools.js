'use strict';

const { defineTool, ToolError } = require('./tools');
const { listTopics, readTopic } = require('../agent-guide');

function createGuideTools() {
  return [defineTool({
    name: 'get_guide',
    description: 'Read the agent guide before building or starting workflows. Without topic, lists topics; start with workflow-basics.',
    right: 'read',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', description: 'Topic ID from the guide list.' } }, additionalProperties: false },
    handler: async ({ topic }) => {
      if (topic === undefined) return { topics: listTopics(), next: 'Call get_guide with topic to read its text; read workflow-basics before building or starting workflows.' };
      const found = readTopic(topic);
      if (!found) throw new ToolError(`Unknown guide topic. Valid IDs: ${listTopics().map((item) => item.id).join(', ')}.`);
      return found;
    }
  })];
}
module.exports = { createGuideTools };
