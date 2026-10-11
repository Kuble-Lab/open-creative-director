'use strict';

// Per-file marks are validated before mutation and follow copied asset ids. No disk, ports or providers.
const assert = require('assert/strict');
const { createRunService } = require('../lib/nodes/run-service');
const { createWorkflowTools } = require('../lib/mcp/workflow-tools');
const templates = require('../lib/nodes/templates');
const clone = (value) => JSON.parse(JSON.stringify(value));

async function main() {
  const document = templates.resolveTemplate('event-video');
  let workflow = { ...clone(document), id: 'workflow-1', sessionId: 'workflow-session', rev: 1 };
  workflow.graph.nodes.find((node) => node.id === 'n3').params.prompt = 'An event with talks and music.';
  const photoNode = () => workflow.graph.nodes.find((node) => node.id === 'n2');
  const planNode = () => workflow.graph.nodes.find((node) => node.id === 'n10');
  photoNode().params.assets = [{ assetId: 'upload-001', sessionId: workflow.sessionId, type: 'image' }];
  let saves = 0;
  const store = {
    readWorkflow: async () => clone(workflow),
    saveGraph: async (_id, { graph }) => { saves++; workflow.graph = clone(graph); workflow.rev++; return clone(workflow); }
  };
  const service = createRunService({
    store,
    engine: { activeRun: () => null },
    sessions: {
      isValidId: () => true,
      readSessionAccess: async () => ({}),
      readLedger: async () => [{ id: 'source-photo', file: 'photo.png', kind: 'image' }]
    },
    assets: {
      typeFromLedgerEntry: () => 'image',
      copyAsset: async () => ({ assetId: 'upload-002', sessionId: workflow.sessionId, type: 'image', file: 'photo.png' })
    }
  });
  const viewer = { active: false };
  await service.prepare(viewer, { workflowId: workflow.id, fileMarks: { 'wf/upload-001': 'never' } });
  assert.deepEqual(planNode().params.ai_marks, { 'upload-001': 'never' });
  await service.prepare(viewer, { workflowId: workflow.id, sourceSessionId: 'chat-session', inputs: { 'n2.assets': ['source-photo'] }, fileMarks: { 'chat-session/source-photo': 'always' } });
  assert.equal(photoNode().params.assets[0].assetId, 'upload-002');
  assert.equal(planNode().params.ai_marks['upload-002'], 'always', 'mark uses the copied id');
  const before = saves;
  for (const [fileMarks, message] of [[{ 'upload-002': 'auto' }, /expected never or always/], [{ 'upload-002': 'maybe' }, /expected never or always/], [{ unknown: 'never' }, /Unknown file/], [[], /must be an object/]]) {
    await assert.rejects(service.prepare(viewer, { workflowId: workflow.id, fileMarks }), message);
  }
  assert.equal(saves, before, 'bad marks do not mutate a workflow');
  await service.prepare(viewer, { workflowId: workflow.id, fileMarks: {} });
  assert.equal(planNode().params.ai_marks['upload-002'], 'always', 'omitting a mark leaves existing input values');
  const tools = createWorkflowTools({ service: () => service });
  for (const name of ['create_from_template', 'run_workflow']) {
    const tool = tools.find((tool) => tool.name === name);
    assert.deepEqual(tool.inputSchema.properties.file_marks.additionalProperties.enum, ['never', 'always']);
    assert.match(tool.inputSchema.properties.file_marks.description, /Unknown files/);
  }
  const requests = [];
  const view = { workflowId: 'workflow-1', name: 'App', rev: 1, paid: false, valid: true, steps: [], blockers: [], totals: { usd: 0, credits: 0, unknownNodes: 0 } };
  const forwarded = createWorkflowTools({
    service: {
      prepare: async (_viewer, request) => { requests.push(request); return { workflowId: view.workflowId, name: view.name, rev: view.rev, inputs: [], outputs: [], plan: view }; },
      estimate: async () => { throw new Error('marks-only calls must prepare'); },
      start: async () => ({ ...view, runId: 'run-1' }),
      waitForRun: async () => ({ status: 'completed' })
    },
    accounting: { mayCreateWorkflow: () => true, noteWorkflowCreated() {}, monthUsage: async () => ({ spentUsd: 0, reservedUsd: 0 }), activeCount: () => 0, serialize: (_id, fn) => fn(), begin() {}, end() {} },
    uploads: { peek: () => 'chat-session' },
    costs: { withVia: (_via, fn) => fn() }
  });
  const context = { key: { id: 'key-1', right: 'start', maxRunUsd: 1, maxMonthUsd: 10 }, viewer };
  const marks = { 'upload-001': 'never' };
  await forwarded.find((tool) => tool.name === 'create_from_template').handler({ template_id: 'event-video', file_marks: marks }, context);
  assert.deepEqual(requests.at(-1).fileMarks, marks, 'MCP template creation forwards marks');
  await forwarded.find((tool) => tool.name === 'run_workflow').handler({ workflow_id: 'workflow-1', max_usd: 0, file_marks: marks }, context);
  assert.deepEqual(requests.at(-1).fileMarks, marks, 'MCP runs forward marks even without new input files');
  console.log('test-nodes-run-service-marks.js: ok');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
