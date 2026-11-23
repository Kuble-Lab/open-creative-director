'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listTopics, readTopic } = require('../lib/agent-guide');
const { createGuideTools } = require('../lib/mcp/guide-tools');
const { createProtocol } = require('../lib/mcp/protocol');

// Fixed contract includes the parallel workflow and influencer tool packages.
const TOOL_NAMES = new Set([
  'get_guide', 'list_templates', 'list_workflows', 'get_workflow', 'list_node_types',
  'estimate_run', 'get_run', 'upload_asset', 'create_from_template', 'create_workflow',
  'edit_workflow', 'run_workflow', 'cancel_run', 'suno_status', 'suno_library', 'suno_audio',
  'resume_run', 'get_workflow_results', 'get_workflow_costs', 'delete_result_entry', 'duplicate_workflow',
  'list_influencers', 'get_influencer', 'create_influencer', 'update_influencer', 'add_influencer_image',
  'get_influencer_site', 'update_influencer_site', 'add_influencer_site_item',
  'remove_influencer_site_item', 'publish_influencer_site'
]);

async function main() {
  const topics = listTopics();
  assert.deepEqual(topics.map((topic) => topic.id), ['workflow-basics', 'hud-music-video', 'guest-character', 'costs', 'influencers']);
  assert.deepEqual(listTopics(), topics, 'stable order');
  for (const topic of topics) {
    assert.ok(topic.title && topic.summary);
    assert.deepEqual(Object.keys(topic).sort(), ['id', 'summary', 'title']);
    const full = readTopic(topic.id);
    assert.equal(full.title, topic.title);
    assert.equal(full.summary, topic.summary);
    assert.ok(full.text.startsWith(`# ${topic.title}\n${topic.summary}\n`));
    assert.ok(full.text.length > 200);
    assert.ok(!full.text.includes('\u00df'), 'Swiss spelling');
    for (const [, word] of full.text.matchAll(/`([a-z]+_[a-z_]+)`/g)) {
      assert.ok(TOOL_NAMES.has(word), `${topic.id}: unknown tool ${word}`);
    }
  }
  for (const id of ['../x', '', 'a'.repeat(81), 'missing', '/etc/passwd', 'workflow-basics.md', 'WORKFLOW-BASICS', null, undefined, {}]) assert.equal(readTopic(id), null);
  const source = fs.readFileSync(path.join(__dirname, '../lib/mcp/index.js'), 'utf8');
  const instructions = source.slice(source.indexOf('const INSTRUCTIONS ='), source.indexOf('// service:'));
  assert.match(instructions, /get_guide/);
  assert.match(instructions, /workflow-basics/);
  assert.match(source, /toolList = tools \|\| \[\.\.\.createGuideTools\(\)/, 'guide is first');
  const protocol = createProtocol({ tools: createGuideTools() });
  const request = async (method, params = {}) => {
    const answer = await protocol.handle({ message: { jsonrpc: '2.0', id: 1, method, params }, context: { key: { right: 'read' } } });
    assert.equal(answer.status, 200);
    assert.ok(!answer.json.error, JSON.stringify(answer.json));
    return answer.json.result;
  };
  const listed = await request('tools/list');
  assert.equal(listed.tools[0].name, 'get_guide');
  const call = (args) => request('tools/call', { name: 'get_guide', ...(args === undefined ? {} : { arguments: args }) });
  const list = await call();
  assert.ok(!list.isError);
  const listData = JSON.parse(list.content[0].text);
  assert.deepEqual(listData.topics, topics);
  assert.match(listData.next, /topic/);
  const result = await call({ topic: 'workflow-basics' });
  assert.ok(!result.isError);
  assert.deepEqual(JSON.parse(result.content[0].text), readTopic('workflow-basics'));
  for (const topic of ['unknown', '../x', '', 'a'.repeat(81)]) {
    const failed = await call({ topic });
    assert.equal(failed.isError, true);
    for (const valid of topics) assert.ok(failed.content[0].text.includes(valid.id));
  }
  console.log('test-agent-guide.js: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
