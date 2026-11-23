'use strict';

const assert = require('assert/strict');
const { buildTools } = require('../lib/mcp');
const { POLICY, EXCEPTIONS, ASSISTANT_ONLY, assertParity, createAssistantTools } = require('../lib/nodes/assistant-tools');

async function main() {
  const list = buildTools(); // Construct definitions only: no service, key, provider or network needed.
  assert.equal(assertParity(list), true);
  const offered = createAssistantTools({ workflowId: 'open', viewer: { active: false }, rev: null }).tools;
  assert.deepEqual(offered.map((tool) => tool.name).sort(), Object.keys(POLICY).sort());
  assert.ok(Object.isFrozen(POLICY) && Object.isFrozen(EXCEPTIONS) && Object.isFrozen(ASSISTANT_ONLY));
  for (const tool of offered) {
    assert.ok(Object.isFrozen(POLICY[tool.name]));
    assert.ok(!(tool.right === 'start' && POLICY[tool.name].mode === 'read'));
    if (tool.annotations?.destructiveHint || tool.annotations?.openWorldHint) assert.equal(POLICY[tool.name].mode, 'confirm');
    const schema = tool.inputSchema;
    for (const name of ['confirm', 'consent', 'rev', 'max_usd', 'wait_seconds', 'workflow_id']) assert.ok(!Object.hasOwn(schema.properties, name), `${tool.name}: server owns ${name}`);
  }
  // The two effect adapters keep MCP's annotations intact: MCP really runs; the assistant only prepares.
  assert.equal(list.find((tool) => tool.name === 'run_workflow').annotations.openWorldHint, true);
  assert.equal(list.find((tool) => tool.name === 'edit_workflow').annotations.destructiveHint, true);
  assert.throws(() => assertParity([...list, { name: 'fantasy_tool', right: 'read' }]), /fantasy_tool: add it to POLICY or to EXCEPTIONS with a reason in lib\/nodes\/assistant-tools.js/);
  assert.throws(() => assertParity(list.map((tool) => tool.name === 'get_guide' ? { ...tool, right: 'start' } : tool)), /start tool cannot be read/);
  assert.throws(() => assertParity(list.map((tool) => tool.name === 'get_guide' ? { ...tool, annotations: { openWorldHint: true } } : tool)), /require confirm/);
  await assert.rejects(async () => list.find((tool) => tool.name === 'get_guide').handler({}, { viewer: { active: false } }), /key is required/);
  assert.match(ASSISTANT_ONLY.insert, /browser.*unsaved/);
  console.log('test-agent-parity.js: ok');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
