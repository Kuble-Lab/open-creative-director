'use strict';

// The tools of the agent access (WP27, part 3: lib/mcp/workflow-tools.js) with a JSON-RPC client over real HTTP against an
// isolated copy of the app (temp data folders, ephemeral port). The nodes are doubles in a private registry (no provider is
// contacted, nothing is paid); a fetch guard refuses everything except localhost.
//
//   R  rights: a read key sees and can use only the reading tools, a start key all of them; visibility is the person's
//   L  limits of run_workflow: max_usd, limit per run, month (booked + reserved), unknown cost, Higgsfield, two runs at a
//      time (also when asked at once), the budget error of the service as a sentence
//   U  upload_asset: base64 up to 15 MB, one-time link (once, expired, too large, wrong type, revoked key), SVG becomes a PNG
//   F  result links: valid, expired, another file, changed token, no login needed
//   J  cost journal: runs of a key book on the person with keyId and keyName (never the key), month usage per key
//   E  editing: list_node_types, create_workflow, edit_workflow (add, connect, replace, remove, params, inputs; all or none; the rules
//      of the editor; Higgsfield, strangers and read keys refused), a draft from a template with inputs missing, the address of a workflow
//   W  the whole way: upload, create_from_template, estimate_run, run_workflow, get_run, links; cancel_run

const assert = require('assert/strict');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');

const express = require('express');

const { createIsolatedApp } = require('./support/isolated-app');

const ADMIN = 'admin@example.com';
const STAFF1 = 'one@staff.example.com';
const STAFF2 = 'two@staff.example.com';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function guardFetch() {
  const original = global.fetch;
  const attempts = [];
  global.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
      attempts.push(url);
      return Promise.reject(new Error(`network access refused in the test: ${url}`));
    }
    return original(input, init);
  };
  return { attempts, restore() { global.fetch = original; } };
}

async function waitFor(predicate, label, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Timeout waiting for ${label}`);
    await sleep(20);
  }
}

const node = (id, type, params = {}, x = 0, y = 0) => ({ id, type, typeVersion: 1, x, y, params });
const edge = (id, from, fromPort, to, toPort) => ({ id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });

async function main() {
  const guard = guardFetch();
  const iso = await createIsolatedApp({
    env: {
      ADMIN_EMAILS: ADMIN,
      SUPERADMIN_EMAILS: '',
      INTERNAL_EMAIL_DOMAINS: 'staff.example.com',
      PUBLIC_BASE_URL: 'https://creator.example.com/studio',
      OPENROUTER_API_KEY: '',
      FAL_KEY: '',
      ELEVENLABS_API_KEY: ''
    }
  });
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  const holder = { server: null };
  try {
    await run(iso, holder);
  } finally {
    guard.restore();
    if (holder.server) await new Promise((resolve) => { holder.server.closeAllConnections?.(); holder.server.close(resolve); });
    await iso.cleanup();
  }
  assert.deepEqual(guard.attempts, [], 'no network access outside localhost');
  console.log('MCP-Werkzeuge: Rechte, Limits (Lauf, Monat, unbekannte Kosten, Higgsfield, zwei Läufe), Upload, Ergebnis-Links, Kostenjournal, Bearbeiten (Nodes, Verbindungen, Parameter, Entwurf) und Workflow-Links sind korrekt.');
  console.log('test-mcp-tools.js: ok');
}

async function run(iso, holder) {
  const api = iso.request;
  const access = iso.load('lib/access');
  const costs = iso.load('lib/costs');
  const budgetLib = iso.load('lib/budget');
  const types = iso.load('lib/nodes/types');
  const nodesBasic = iso.load('lib/nodes/nodes-basic');
  const jobs = iso.load('lib/nodes/jobs');
  const templatesLib = iso.load('lib/nodes/templates');
  const { createRegistry } = iso.load('lib/nodes/registry');
  const { createEventBus } = iso.load('lib/nodes/events');
  const { createWorkflowsStore } = iso.load('lib/nodes/workflows-store');
  const { createEngine } = iso.load('lib/nodes/engine');
  const runServiceLib = iso.load('lib/nodes/run-service');
  const keysLib = iso.load('lib/mcp/keys');
  const linksLib = iso.load('lib/mcp/links');
  const { createMcp } = iso.load('lib/mcp');
  const { textValue } = types;
  const keys = keysLib.defaultStore;

  /* ---------- doubles: nodes without a provider ---------- */

  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  const gate = { current: null };
  const openGate = () => {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    gate.current = { promise, release };
    return gate.current;
  };
  const waitGate = (signal) =>
    new Promise((resolve, reject) => {
      if (!gate.current) return resolve();
      if (signal?.aborted) return reject(jobs.abortError());
      signal?.addEventListener('abort', () => reject(jobs.abortError()), { once: true });
      gate.current.promise.then(resolve);
    });
  const calls = { paid: 0, hf: 0, unknown: 0 };
  registry.register({
    type: 't.upper',
    category: 'text',
    inputs: [{ id: 'in', type: 'text', required: true }],
    outputs: [{ id: 'out', type: 'text' }],
    execute: async (_ctx, inputs) => ({ variants: [{ out: textValue(String(inputs.in.value).toUpperCase()) }] })
  });
  // a paid node: estimate 0.5, the run costs 0.4, and it books that in the cost journal like the real nodes do
  registry.register({
    type: 't.paid',
    category: 'text',
    paid: true,
    cost: { unit: 'usd', estimate: () => ({ usd: 0.5 }) },
    inputs: [{ id: 'in', type: 'text' }],
    outputs: [{ id: 'out', type: 'text' }],
    execute: async (ctx, inputs) => {
      calls.paid += 1;
      await waitGate(ctx.signal);
      await costs.recordCost({ ts: new Date().toISOString(), sessionId: ctx.sessionId, type: 'brain', model: 'double', cost: 0.4, user: ctx.user });
      return { variants: [{ out: textValue(`paid:${inputs.in ? inputs.in.value : ''}`) }], cost: { usd: 0.4 } };
    }
  });
  registry.register({
    type: 't.paid_unknown',
    category: 'text',
    paid: true,
    cost: { unit: 'usd' },
    inputs: [{ id: 'in', type: 'text' }],
    outputs: [{ id: 'out', type: 'text' }],
    execute: async () => {
      calls.unknown += 1;
      return { variants: [{ out: textValue('unknown') }], cost: { usd: 0.1 } };
    }
  });
  registry.register({
    type: 't.hf',
    category: 'higgsfield',
    paid: true,
    cost: { unit: 'credits', estimate: () => ({ credits: 2 }) },
    inputs: [{ id: 'in', type: 'text' }],
    outputs: [{ id: 'out', type: 'text' }],
    execute: async () => {
      calls.hf += 1;
      return { variants: [{ out: textValue('hf') }], cost: { credits: 2 } };
    }
  });
  registry.register({
    type: 't.imgpaid',
    category: 'image',
    paid: true,
    cost: { unit: 'usd', estimate: () => ({ usd: 0.5 }) },
    inputs: [{ id: 'image', type: 'image', required: true }, { id: 'prompt', type: 'text' }],
    outputs: [{ id: 'image', type: 'image' }],
    execute: async (ctx, inputs) => {
      calls.paid += 1;
      await costs.recordCost({ ts: new Date().toISOString(), sessionId: ctx.sessionId, type: 'brain', model: 'double', cost: 0.4, user: ctx.user });
      return { variants: [{ image: inputs.image }], cost: { usd: 0.4 } };
    }
  });

  const dataDir = path.join(iso.root, 'data');
  const bus = createEventBus();
  const wfStore = createWorkflowsStore({ dir: path.join(dataDir, 'workflows-doubles'), registry, events: bus });
  const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => ({}) });

  const templateDir = path.join(iso.root, 'doubles-templates');
  await fsp.mkdir(templateDir, { recursive: true });
  const writeTemplate = (id, doc) =>
    fsp.writeFile(path.join(templateDir, `${id}.json`), JSON.stringify({ id, requires: [], format: 'ocd.workflow', version: 1, description: `Template ${id}`, ...doc }, null, 2));
  await writeTemplate('free-text', {
    name: 'Free text',
    graph: {
      nodes: [node('n1', 'input.prompt', { prompt: '' }, 0, 0), node('n2', 't.upper', {}, 200, 0), node('n3', 'output.result', { label: 'Result' }, 400, 0)],
      edges: [edge('e1', 'n1', 'prompt', 'n2', 'in'), edge('e2', 'n2', 'out', 'n3', 'inputs')]
    },
    app: { enabled: true, title: 'Free text', inputs: [{ node: 'n1', param: 'prompt', label: 'Idea' }], outputs: [{ node: 'n3', label: 'Result' }] },
    i18n: { de: { name: 'Freier Text' } }
  });
  await writeTemplate('paid-image', {
    name: 'Paid image',
    graph: {
      nodes: [
        node('n1', 'input.image', {}, 0, 0),
        node('n2', 'input.prompt', { prompt: 'warm light' }, 0, 100),
        node('n3', 't.imgpaid', {}, 200, 0),
        node('n4', 'output.result', { label: 'Picture' }, 400, 0)
      ],
      edges: [edge('e1', 'n1', 'image', 'n3', 'image'), edge('e2', 'n2', 'prompt', 'n3', 'prompt'), edge('e3', 'n3', 'image', 'n4', 'inputs')]
    },
    app: {
      enabled: true,
      title: 'Paid image',
      inputs: [{ node: 'n1', param: 'asset', label: 'Photo' }, { node: 'n2', param: 'prompt', label: 'Wish' }],
      outputs: [{ node: 'n4', label: 'Picture' }]
    }
  });
  await writeTemplate('paid-unknown', {
    name: 'Paid unknown',
    graph: {
      nodes: [node('n1', 'input.prompt', { prompt: 'hello' }), node('n2', 't.paid_unknown', {}, 200, 0), node('n3', 'output.result', {}, 400, 0)],
      edges: [edge('e1', 'n1', 'prompt', 'n2', 'in'), edge('e2', 'n2', 'out', 'n3', 'inputs')]
    },
    app: { enabled: true, inputs: [{ node: 'n1', param: 'prompt', label: 'Text' }], outputs: [{ node: 'n3', label: 'Answer' }] }
  });
  await writeTemplate('hf-flow', {
    name: 'Higgsfield flow',
    graph: {
      nodes: [node('n1', 'input.prompt', { prompt: 'x' }), node('n2', 't.hf', {}, 200, 0), node('n3', 'output.result', {}, 400, 0)],
      edges: [edge('e1', 'n1', 'prompt', 'n2', 'in'), edge('e2', 'n2', 'out', 'n3', 'inputs')]
    },
    app: { enabled: true, inputs: [{ node: 'n1', param: 'prompt', label: 'Text' }], outputs: [{ node: 'n3', label: 'Answer' }] }
  });

  const baseService = runServiceLib.createRunService({
    engine,
    store: wfStore,
    registry,
    templates: {
      list: (options) => templatesLib.listTemplates({ ...options, dir: templateDir, checks: {} }),
      resolve: (id, options) => templatesLib.resolveTemplate(id, { ...options, dir: templateDir })
    }
  });
  // the service the tools get: a start can be made to fail with the budget error of a person (see the test of the sentence)
  const failNextStart = { error: null };
  const service = Object.create(baseService);
  service.start = async (...args) => {
    if (failNextStart.error) {
      const err = failNextStart.error;
      failNextStart.error = null;
      throw err;
    }
    return baseService.start(...args);
  };

  /* ---------- people and workflows ---------- */

  await api('/api/me', { as: STAFF1 }); // the first sight records a person on the team list
  await api('/api/me', { as: STAFF2 });
  const mk = async (owner, name, graph, { share } = {}) => {
    const created = await wfStore.createWorkflow({ name, graph, owner, user: owner || 'lokal' });
    if (share) await wfStore.setSharing(created.workflow.id, share);
    return created.workflow;
  };
  const freeGraph = () => ({
    nodes: [node('a', 'input.prompt', { prompt: 'hello' }, 0, 0), node('b', 't.upper', {}, 200, 0), node('c', 'output.result', { label: 'Out' }, 400, 0)],
    edges: [edge('e1', 'a', 'prompt', 'b', 'in'), edge('e2', 'b', 'out', 'c', 'inputs')]
  });
  const paidGraph = () => ({
    nodes: [node('a', 'input.prompt', { prompt: 'hello' }, 0, 0), node('b', 't.paid', {}, 200, 0), node('c', 'output.result', { label: 'Out' }, 400, 0)],
    edges: [edge('e1', 'a', 'prompt', 'b', 'in'), edge('e2', 'b', 'out', 'c', 'inputs')]
  });
  const hfGraph = { nodes: [node('a', 'input.prompt', { prompt: 'x' }), node('b', 't.hf', {}, 200, 0), node('c', 'output.result', {}, 400, 0)], edges: [edge('e1', 'a', 'prompt', 'b', 'in'), edge('e2', 'b', 'out', 'c', 'inputs')] };
  const free = await mk(STAFF1, 'Mein freier Ablauf', freeGraph());
  const payA = await mk(STAFF1, 'Bezahlt A', paidGraph());
  const payB = await mk(STAFF1, 'Bezahlt B', paidGraph());
  const payC = await mk(STAFF1, 'Bezahlt C', paidGraph());
  const payD = await mk(STAFF1, 'Bezahlt D', paidGraph());
  // a run caches its steps: every scenario that runs gets a workflow of its own
  let freshCount = 0;
  const fresh = () => mk(STAFF1, `Frisch ${(freshCount += 1)}`, paidGraph());
  const hfOwn = await mk(STAFF1, 'Higgsfield intern', hfGraph);
  const sharedWithAll = await mk(STAFF2, 'Team-Ablauf', freeGraph(), { share: { shareMode: 'team' } });
  const foreignPrivate = await mk(STAFF2, 'Fremd und privat', freeGraph());

  /* ---------- the endpoint: this test's own copy of the app's router with the doubles ---------- */

  const clock = { t: Date.now() };
  const mcp = createMcp({
    keys,
    service,
    env: { PUBLIC_BASE_URL: 'https://creator.example.com/studio' },
    fileLinks: linksLib.createFileLinks({ now: () => clock.t }),
    uploadLinks: linksLib.createUploadLinks({ now: () => clock.t }),
    limiter: { take: () => ({ allowed: true }), reset() {} }
  });
  const app = express();
  mcp.mount(app);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  holder.server = server;
  const port = server.address().port;
  assert.notEqual(port, 3111);
  const base = `http://127.0.0.1:${port}`;
  const everything = []; // every answer and journal line, searched for the secrets at the end

  let rpcId = 100;
  async function rpc(secret, method, params, { headers = {} } = {}) {
    rpcId += 1;
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, ...(params === undefined ? {} : { params }) })
    });
    const text = await response.text();
    everything.push(text);
    return { status: response.status, json: text ? JSON.parse(text) : null, text };
  }
  // A tool call: { isError, text, data } (data: the structured result)
  async function tool(secret, name, args = {}) {
    const response = await rpc(secret, 'tools/call', { name, arguments: args });
    assert.equal(response.status, 200, response.text);
    assert.ok(response.json.result, `no result for ${name}: ${response.text}`);
    const result = response.json.result;
    assert.ok(Array.isArray(result.content) && result.content[0].type === 'text');
    return { isError: result.isError === true, text: result.content[0].text, data: result.structuredContent, raw: result };
  }
  const ok = async (secret, name, args) => {
    const result = await tool(secret, name, args);
    assert.equal(result.isError, false, `${name}: ${result.text}`);
    return result.data;
  };
  const refused = async (secret, name, args, pattern) => {
    const result = await tool(secret, name, args);
    assert.equal(result.isError, true, `${name} should have been refused: ${result.text}`);
    assert.match(result.text, pattern);
    return result.text;
  };
  const makeKey = (options) => {
    const created = keys.create({ owner: STAFF1, createdBy: STAFF1, ...options });
    return { ...created.key, secret: created.secret };
  };
  const pathOf = (url) => new URL(url).pathname.replace(/^\/studio/, '');
  const runIds = [];
  const finish = async (secret, runId) => {
    const done = await waitFor(async () => {
      const run = await ok(secret, 'get_run', { run_id: runId });
      return run.finished ? run : null;
    }, `run ${runId}`);
    return done;
  };

  const reader = makeKey({ name: 'Leser', right: 'read' });
  const starter = makeKey({ name: 'Starter', right: 'start', maxRunUsd: 2, maxMonthUsd: 20 });
  const secrets = [reader.secret, starter.secret];

  /* ============ R: rights and visibility ============ */

  const readNames = ['estimate_run', 'get_guide', 'get_influencer', 'get_influencer_site', 'get_run', 'get_workflow', 'get_workflow_costs', 'get_workflow_results', 'list_influencers', 'list_node_types', 'list_templates', 'list_workflows', 'suno_audio', 'suno_library', 'suno_status'];
  const startNames = ['add_influencer_image', 'add_influencer_site_item', 'cancel_run', 'create_from_template', 'create_influencer', 'create_workflow', 'delete_result_entry', 'duplicate_workflow', 'edit_workflow', 'publish_influencer_site', 'remove_influencer_site_item', 'resume_run', 'run_workflow', 'update_influencer', 'update_influencer_site', 'upload_asset'];
  const readList = (await rpc(reader.secret, 'tools/list')).json.result.tools;
  assert.deepEqual(readList.map((item) => item.name), readNames, 'a read key lists the reading tools only');
  assert.ok(readList.every((item) => item.annotations.readOnlyHint === true));
  const startList = (await rpc(starter.secret, 'tools/list')).json.result.tools;
  assert.deepEqual(startList.map((item) => item.name), [...readNames, ...startNames].sort(), 'a start key lists workflow tools and personal Suno reads');
  for (const item of startList) {
    assert.equal(item.inputSchema.type, 'object');
    assert.ok(item.description.length > 40, `${item.name} describes itself`);
  }
  assert.equal(startList.find((item) => item.name === 'run_workflow').inputSchema.required.includes('max_usd'), true);
  for (const name of ['create_from_template', 'run_workflow']) assert.deepEqual(startList.find((item) => item.name === name).inputSchema.properties.file_marks.additionalProperties.enum, ['never', 'always', 'auto', null]);
  // a read key cannot start anything, although it calls the tool
  await refused(reader.secret, 'run_workflow', { workflow_id: free.id, max_usd: 0 }, /may only read/);
  await refused(reader.secret, 'upload_asset', { filename: 'a.png', data_base64: PNG.toString('base64') }, /may only read/);
  await refused(reader.secret, 'create_from_template', { template_id: 'free-text' }, /may only read/);
  await refused(reader.secret, 'cancel_run', { run_id: 'x' }, /may only read/);
  assert.equal(calls.paid, 0);
  assert.equal((await wfStore.listWorkflows()).length, 8, 'a read key made nothing');

  // templates
  const templates = await ok(reader.secret, 'list_templates', {});
  assert.deepEqual(templates.templates.map((item) => item.id).sort(), ['free-text', 'hf-flow', 'paid-image', 'paid-unknown']);
  const freeTemplate = templates.templates.find((item) => item.id === 'free-text');
  assert.deepEqual(freeTemplate.cost, { kind: 'free', paid: false, estimate_usd: 0 });
  assert.deepEqual(freeTemplate.inputs.map((item) => [item.id, item.label, item.type, item.required]), [['n1.prompt', 'Idea', 'text', true]]);
  assert.deepEqual(freeTemplate.outputs, ['Result']);
  assert.equal(templates.templates.find((item) => item.id === 'paid-image').cost.estimate_usd, 0.5);
  assert.equal(templates.templates.find((item) => item.id === 'paid-unknown').cost.estimate_usd, null);
  assert.equal(templates.templates.find((item) => item.id === 'paid-unknown').cost.kind, 'unknown');
  assert.equal(templates.templates.find((item) => item.id === 'hf-flow').cost.runnable_by_agent, false);
  assert.equal((await ok(reader.secret, 'list_templates', { language: 'de' })).templates.find((item) => item.id === 'free-text').name, 'Freier Text');
  assert.equal((await ok(reader.secret, 'list_templates', { query: 'higgs' })).count, 1);

  // workflows: the person's own and the shared ones, nothing else
  const workflows = await ok(reader.secret, 'list_workflows', {});
  const workflowIds = workflows.workflows.map((item) => item.id);
  assert.ok(workflowIds.includes(free.id) && workflowIds.includes(sharedWithAll.id));
  assert.ok(!workflowIds.includes(foreignPrivate.id), 'a foreign private workflow is not listed');
  assert.equal(workflows.workflows.find((item) => item.id === free.id).origin, 'own');
  assert.equal(workflows.workflows.find((item) => item.id === sharedWithAll.id).origin, 'shared');
  assert.equal((await ok(reader.secret, 'list_workflows', { limit: 2 })).workflows.length, 2);
  await refused(reader.secret, 'get_workflow', { workflow_id: foreignPrivate.id }, /Not found/);
  await refused(reader.secret, 'estimate_run', { workflow_id: foreignPrivate.id }, /Not found/);
  await refused(reader.secret, 'get_workflow', { workflow_id: 'wf-does-not-exist' }, /Not found/);
  await refused(reader.secret, 'get_workflow', { workflow_id: '../../etc' }, /not valid/);
  const described = await ok(reader.secret, 'get_workflow', { workflow_id: free.id });
  assert.equal(described.name, 'Mein freier Ablauf');
  assert.deepEqual(described.steps.map((item) => item.type), ['input.prompt', 't.upper', 'output.result']);
  assert.deepEqual(described.latest_results, []);
  assert.equal(described.run_in_progress, false);
  // the admin sees what the service shows the admin, a key of someone else does not see this person's workflows
  const adminKey = makeKey({ name: 'Admin', right: 'read', owner: ADMIN });
  secrets.push(adminKey.secret);
  assert.ok(!(await ok(adminKey.secret, 'list_workflows', {})).workflows.some((item) => item.id === free.id), 'a key sees the workflows of its own person only');

  // estimate_run
  const estimate = await ok(reader.secret, 'estimate_run', { workflow_id: payA.id });
  assert.equal(estimate.estimate_usd, 0.5);
  assert.equal(estimate.paid, true);
  assert.deepEqual(estimate.paid_steps.map((step) => [step.type, step.estimate_usd]), [['t.paid', 0.5]]);
  assert.equal(estimate.agent.can_start, false, 'a read key cannot start, estimate or not');
  assert.equal(estimate.agent.max_run_usd, 2);
  assert.equal(estimate.agent.suggested_max_usd, 0.5);
  const startEstimate = await ok(starter.secret, 'estimate_run', { workflow_id: payA.id, max_usd: 0.3 });
  assert.equal(startEstimate.agent.can_start, false);
  assert.match(startEstimate.agent.problems[0], /more than the max_usd/);
  assert.equal((await ok(starter.secret, 'estimate_run', { workflow_id: payA.id, max_usd: 0.5 })).agent.can_start, true);
  assert.equal((await ok(starter.secret, 'estimate_run', { workflow_id: free.id })).estimate_usd, 0);
  // bad arguments are told, not run
  await refused(starter.secret, 'run_workflow', { workflow_id: free.id }, /max_usd is required/);
  await refused(starter.secret, 'run_workflow', { workflow_id: free.id, max_usd: 'a lot' }, /max_usd must be number/);
  await refused(starter.secret, 'run_workflow', { workflow_id: free.id, max_usd: -1 }, /at least 0/);
  await refused(starter.secret, 'run_workflow', { workflow_id: free.id, max_usd: 1, extra: true }, /not a known property/);

  /* ============ L: limits of run_workflow ============ */

  // a free run starts at once; max_usd is required but 0 is fine
  const freeRun = await ok(starter.secret, 'run_workflow', { workflow_id: free.id, max_usd: 0 });
  assert.equal(freeRun.paid, false);
  assert.equal(freeRun.status, 'running');
  const freeDone = await finish(starter.secret, freeRun.run_id);
  assert.equal(freeDone.status, 'completed');
  assert.equal(freeDone.cost_usd, 0);
  assert.deepEqual(freeDone.results.map((group) => [group.label, group.items.map((item) => [item.type, item.text])]), [['Out', [['text', 'HELLO']]]]);
  // a foreign workflow, a missing one
  await refused(starter.secret, 'run_workflow', { workflow_id: foreignPrivate.id, max_usd: 5 }, /Not found/);

  // the estimate is above max_usd / above the limit of the key per run
  const paidBefore = calls.paid;
  const over = await refused(starter.secret, 'run_workflow', { workflow_id: payA.id, max_usd: 0.3 }, /more than the max_usd of \$0\.30/);
  assert.match(over, /Nothing was charged/);
  const tight = makeKey({ name: 'Eng', right: 'start', maxRunUsd: 0.3, maxMonthUsd: 20 });
  secrets.push(tight.secret);
  await refused(tight.secret, 'run_workflow', { workflow_id: payA.id, max_usd: 5 }, /limit of \$0\.30 per run/);
  // several reasons are told together
  const both = await refused(tight.secret, 'run_workflow', { workflow_id: payA.id, max_usd: 0.1 }, /max_usd/);
  assert.match(both, /per run/);

  // unknown costs, Higgsfield
  const unknownCopy = await ok(starter.secret, 'create_from_template', { template_id: 'paid-unknown', inputs: { Text: 'hi' } });
  assert.equal(unknownCopy.estimate.estimate_complete, false);
  assert.equal(unknownCopy.agent.can_start, false);
  await refused(starter.secret, 'run_workflow', { workflow_id: unknownCopy.workflow_id, max_usd: 50 }, /no known price/);
  const hfCopy = await ok(starter.secret, 'create_from_template', { template_id: 'hf-flow' });
  assert.equal(hfCopy.agent.can_start, false);
  await refused(starter.secret, 'run_workflow', { workflow_id: hfCopy.workflow_id, max_usd: 50 }, /Higgsfield/);
  await refused(starter.secret, 'run_workflow', { workflow_id: hfOwn.id, max_usd: 50 }, /Higgsfield/);
  assert.equal((await ok(starter.secret, 'estimate_run', { workflow_id: hfOwn.id })).agent.can_start, false);
  assert.equal(calls.paid, paidBefore);
  assert.equal(calls.hf, 0);
  assert.equal(calls.unknown, 0);

  // With a USD rate per Higgsfield credit, agent access prices the credits in USD and starts the run within the limits
  {
    const settingsLib = iso.load('lib/settings');
    const realAllowed = access.agentHiggsfieldAllowed;
    const realPref = settingsLib.getPreference;
    access.agentHiggsfieldAllowed = () => true;
    settingsLib.getPreference = (name) => (name === 'higgsfieldUsdPerCredit' ? 0.05 : realPref.call(settingsLib, name));
    try {
      const hfPriced = await mk(STAFF1, 'Higgsfield mit Kurs', hfGraph);
      const estimate = await ok(starter.secret, 'estimate_run', { workflow_id: hfPriced.id });
      assert.equal(estimate.estimate_usd, 0.1, '2 credits at 0.05 USD');
      assert.equal(estimate.agent.can_start, true);
      await refused(starter.secret, 'run_workflow', { workflow_id: hfPriced.id, max_usd: 0.05 }, /more than the max_usd/);
      const started = await ok(starter.secret, 'run_workflow', { workflow_id: hfPriced.id, max_usd: 0.1 });
      assert.equal(started.estimate_usd, 0.1);
      await ok(starter.secret, 'get_run', { run_id: started.run_id, wait_seconds: 5 });
      assert.equal(calls.hf, 1);
    } finally {
      access.agentHiggsfieldAllowed = realAllowed;
      settingsLib.getPreference = realPref;
    }
    calls.hf = 0;
  }

  // two runs at a time, also when three are asked for at once
  const roomy = makeKey({ name: 'Geräumig', right: 'start', maxRunUsd: 5, maxMonthUsd: 100 });
  secrets.push(roomy.secret);
  openGate();
  const tripleSet = [await fresh(), await fresh(), await fresh()];
  const triple = await Promise.all(tripleSet.map((workflow) => tool(roomy.secret, 'run_workflow', { workflow_id: workflow.id, max_usd: 0.5 })));
  const started = triple.filter((result) => !result.isError);
  const stopped = triple.filter((result) => result.isError);
  assert.equal(started.length, 2, `exactly two of three start: ${triple.map((result) => result.text).join(' | ')}`);
  assert.equal(stopped.length, 1);
  assert.match(stopped[0].text, /already has 2 runs in progress/);
  assert.equal(mcp.accounting.activeCount(roomy.id), 2);
  const [runOne, runTwo] = started.map((result) => result.data.run_id);
  runIds.push(runOne, runTwo);
  // a third, later, is refused too; the key of another person is not affected
  const later = (tripleSet.find((workflow) => !started.some((result) => result.data.workflow_id === workflow.id)));
  await refused(roomy.secret, 'run_workflow', { workflow_id: later.id, max_usd: 0.5 }, /2 runs in progress/);
  // month: reserved (the two runs in progress hold 0.5 each)
  const monthKey = makeKey({ name: 'Monat', right: 'start', maxRunUsd: 5, maxMonthUsd: 0.8 });
  secrets.push(monthKey.secret);
  assert.equal((await ok(monthKey.secret, 'estimate_run', { workflow_id: payD.id })).agent.can_start, true);
  const usageNow = await mcp.accounting.monthUsage(roomy.id);
  assert.equal(usageNow.reservedUsd, 1, 'the runs in progress reserve their estimate');
  // cancel: only a run of the key itself; the run goes, the reservation shrinks
  await refused(starter.secret, 'cancel_run', { run_id: runOne }, /not started with this key/);
  const cancelled = await ok(roomy.secret, 'cancel_run', { run_id: runOne });
  assert.equal(cancelled.cancel_requested, true);
  const cancelledRun = await finish(roomy.secret, runOne);
  assert.equal(cancelledRun.status, 'cancelled');
  gate.current.release();
  const completedRun = await finish(roomy.secret, runTwo);
  assert.equal(completedRun.status, 'completed');
  await waitFor(() => mcp.accounting.activeCount(roomy.id) === 0, 'runs of the key ended');
  assert.equal((await ok(roomy.secret, 'cancel_run', { run_id: runTwo })).cancel_requested, false, 'a finished run is not active any more');
  gate.current = null;

  // month: the booked costs of the key (0.4 for the run that completed) plus the estimate of the next run
  const booked = await budgetLib.spentByKey(roomy.id);
  assert.ok(booked >= 0.4 - 1e-9, `booked ${booked}`);
  const monthly = makeKey({ name: 'Monatslimit', right: 'start', maxRunUsd: 5, maxMonthUsd: 0.7 });
  secrets.push(monthly.secret);
  const m1 = await ok(monthly.secret, 'run_workflow', { workflow_id: (await fresh()).id, max_usd: 0.5 });
  const m1done = await finish(monthly.secret, m1.run_id);
  assert.equal(m1done.status, 'completed');
  assert.ok(Math.abs(m1done.cost_usd - 0.4) < 1e-9);
  await waitFor(async () => (await budgetLib.spentByKey(monthly.id)) > 0.39, 'the cost of the key in the journal');
  await waitFor(() => mcp.accounting.reservedUsd(monthly.id) === 0, 'the reservation of the finished run to end');
  const monthText = await refused(monthly.secret, 'run_workflow', { workflow_id: (await fresh()).id, max_usd: 0.5 }, /per month/);
  assert.match(monthText, /\$0\.40 booked this month/);
  assert.match(monthText, /would exceed the limit of \$0\.70/);
  // booked costs and reservations together: a free run is not blocked by the month
  assert.equal((await ok(monthly.secret, 'run_workflow', { workflow_id: free.id, max_usd: 0 })).status, 'running');
  // with a run in progress its reservation counts: limit 0.8, 0 booked on this key, one run holds 0.5 -> a second 0.5 does not fit
  const reservedKey = makeKey({ name: 'Reservierung', right: 'start', maxRunUsd: 5, maxMonthUsd: 0.8 });
  secrets.push(reservedKey.secret);
  openGate();
  const r1 = await ok(reservedKey.secret, 'run_workflow', { workflow_id: (await fresh()).id, max_usd: 0.5 });
  const reservedText = await refused(reservedKey.secret, 'run_workflow', { workflow_id: (await fresh()).id, max_usd: 0.5 }, /per month/);
  assert.match(reservedText, /\$0\.50 reserved for runs in progress/);
  gate.current.release();
  await finish(reservedKey.secret, r1.run_id);
  gate.current = null;

  // the budget error of the service is told as a sentence (the budget of a person is checked by the service)
  const BudgetError = budgetLib.BudgetError;
  const payE = await fresh();
  failNextStart.error = new BudgetError('BUDGET_INSUFFICIENT', 'This run is estimated at $0.50 but only $0.10 of the budget is left.', 'de', { estimateUsd: 0.5 });
  const budgetText = await refused(starter.secret, 'run_workflow', { workflow_id: payE.id, max_usd: 0.5 }, /budget of the person/);
  assert.match(budgetText, /\$0\.10 of the budget is left/);
  assert.match(budgetText, /Nothing was started/);
  failNextStart.error = Object.assign(new Error('boom with /Users/secret/path'), { code: 'SOMETHING_ELSE' });
  const generic = await refused(starter.secret, 'run_workflow', { workflow_id: payE.id, max_usd: 0.5 }, /failed unexpectedly/);
  assert.ok(!generic.includes('/Users'), 'an unknown error never shows its details');
  assert.equal((await wfStore.listRuns(payE.id)).length, 0, 'nothing was started');

  // a changed cost between estimate and start is refused by the service itself
  const costChanged = Object.assign(new Error('x'), { code: 'COST_CHANGED', estimateUsd: 0.9 });
  failNextStart.error = costChanged;
  await refused(starter.secret, 'run_workflow', { workflow_id: payE.id, max_usd: 0.5 }, /cost of the run changed/);

  /* ============ U: upload_asset ============ */

  const uploaded = await ok(starter.secret, 'upload_asset', { filename: 'photo.png', data_base64: PNG.toString('base64') });
  assert.equal(uploaded.mode, 'uploaded');
  assert.equal(uploaded.type, 'image');
  assert.equal(uploaded.bytes, PNG.length);
  assert.match(uploaded.asset_id, /^upload-\d+$/);
  // a data URL is taken too; the MIME type decides over the name
  const dataUrl = await ok(starter.secret, 'upload_asset', { filename: 'other', mime_type: 'image/png', data_base64: `data:image/png;base64,${PNG.toString('base64')}` });
  assert.equal(dataUrl.type, 'image');
  // an SVG becomes a PNG
  const svg = await ok(starter.secret, 'upload_asset', { filename: 'logo.svg', data_base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="#d8a25f"/></svg>').toString('base64') });
  assert.equal(svg.type, 'image');
  assert.match(svg.note, /PNG/);
  // documents: PDF and text go in, a ".pdf" that is no PDF is told what is wrong, a document has its own limit
  const pdfUpload = await ok(starter.secret, 'upload_asset', { filename: 'report.pdf', data_base64: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n').toString('base64') });
  assert.equal(pdfUpload.type, 'document');
  const textUpload = await ok(starter.secret, 'upload_asset', { filename: 'notes.md', data_base64: Buffer.from('# Notes\n\nHello').toString('base64') });
  assert.equal(textUpload.type, 'document');
  const fakePdf = await refused(starter.secret, 'upload_asset', { filename: 'fake.pdf', data_base64: Buffer.from('this is not a pdf').toString('base64') }, /cannot be used as a document: The file is not a PDF/);
  assert.doesNotMatch(fakePdf, /image, video or audio/);
  const docLink = await ok(starter.secret, 'upload_asset', { filename: 'big.pdf', size_bytes: 1000 });
  assert.equal(docLink.max_bytes, 50 * 1024 * 1024, 'a document is at most 50 MB');
  const uploadTool = startList.find((tool) => tool.name === 'upload_asset');
  assert.match(uploadTool.description, /pdf, txt, md/);
  assert.match(uploadTool.description, /50 MB/);
  // url: the app fetches the file itself; only public https addresses (the download itself: scripts/test-mcp-url-import.js)
  assert.match(uploadTool.description, /url: the app downloads the file itself/);
  await refused(starter.secret, 'upload_asset', { url: 'http://example.com/song.mp3' }, /Only https addresses/);
  await refused(starter.secret, 'upload_asset', { url: 'https://127.0.0.1/song.mp3' }, /private or local network/);
  await refused(starter.secret, 'upload_asset', { url: 'https://localhost/song.mp3' }, /private or local network|could not be found/);
  await refused(starter.secret, 'upload_asset', { url: 'https://[::1]/song.mp3' }, /private or local network/);
  await refused(starter.secret, 'upload_asset', { url: 'https://user:pw@example.com/song.mp3' }, /user name or password/);
  await refused(starter.secret, 'upload_asset', { url: 'https://example.com:8443/song.mp3' }, /port \(443\)/);
  await refused(starter.secret, 'upload_asset', { url: 'https://example.com/a.mp3', data_base64: 'AAAA' }, /only one of url, import_id and data_base64/);
  await refused(starter.secret, 'upload_asset', { import_id: 'imp_000000000000000000000000' }, /no download with this import_id/);
  await refused(starter.secret, 'upload_asset', {}, /filename is required/);
  // wrong type, not base64, empty, nothing known
  await refused(starter.secret, 'upload_asset', { filename: 'run.exe', data_base64: Buffer.from('MZ').toString('base64') }, /Unsupported file type/);
  await refused(starter.secret, 'upload_asset', { filename: 'doc.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, /Unsupported file type/); // a PDF is a document since WP37a
  await refused(starter.secret, 'upload_asset', { filename: 'a.png', data_base64: 'not base64 !!' }, /not valid base64/);
  await refused(starter.secret, 'upload_asset', { filename: 'a.png', data_base64: '' }, /empty/);
  await refused(starter.secret, 'upload_asset', { filename: 'a.png', data_base64: Buffer.from('<svg').toString('base64'), mime_type: 'image/svg+xml' }, /could not be rasterised|rasterised/);
  // the limit of 15 MB in the arguments: exactly 15 MB passes, one byte more is told to use the link
  const fifteen = Buffer.alloc(15 * 1024 * 1024);
  PNG.copy(fifteen);
  const exact = await ok(starter.secret, 'upload_asset', { filename: 'big.png', data_base64: fifteen.toString('base64') });
  assert.equal(exact.bytes, 15 * 1024 * 1024);
  const tooBig = await refused(starter.secret, 'upload_asset', { filename: 'big.png', data_base64: Buffer.alloc(15 * 1024 * 1024 + 1).toString('base64') }, /larger than 15 MB/);
  assert.match(tooBig, /upload link/);

  // the one-time link
  const linkInfo = await ok(starter.secret, 'upload_asset', { filename: 'clip.mp4', size_bytes: 1000 });
  assert.equal(linkInfo.mode, 'upload_link');
  assert.equal(linkInfo.method, 'PUT');
  assert.equal(linkInfo.single_use, true);
  assert.match(linkInfo.upload_url, /^https:\/\/creator\.example\.com\/studio\/mcp\/upload\/[A-Za-z0-9_-]{43}$/, 'with the public base address, also under a path');
  assert.equal(Date.parse(linkInfo.expires_at) - clock.t, 15 * 60 * 1000);
  assert.equal(linkInfo.max_bytes, 500 * 1024 * 1024);
  await refused(starter.secret, 'upload_asset', { filename: 'clip.mp4', size_bytes: 500 * 1024 * 1024 + 1 }, /larger than 500 MB/);
  const put = (url, body, { headers = {} } = {}) => fetch(`${base}${pathOf(url)}`, { method: 'PUT', headers, body });
  const wrongMethod = await fetch(`${base}${pathOf(linkInfo.upload_url)}`, { method: 'POST', body: 'x' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'PUT');
  const empty = await put(linkInfo.upload_url, '');
  assert.equal(empty.status, 400, 'an empty body');
  const link2 = await ok(starter.secret, 'upload_asset', { filename: 'clip.mp4' });
  const video = Buffer.concat([Buffer.from('....ftypmp42'), Buffer.alloc(2000, 1)]);
  const sent = await put(link2.upload_url, video, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const sentBody = await sent.json();
  everything.push(JSON.stringify(sentBody));
  assert.equal(sent.status, 201, JSON.stringify(sentBody));
  assert.equal(sentBody.type, 'video');
  assert.equal(sentBody.bytes, video.length);
  assert.match(sentBody.asset_id, /^upload-\d+$/);
  const again = await put(link2.upload_url, video);
  assert.equal(again.status, 410, 'the link works once');
  assert.equal((await again.json()).error, 'upload_link_used');
  // a document through the link: a PDF is taken, a ".pdf" with other content is refused with the reason
  const pdfLink = await ok(starter.secret, 'upload_asset', { filename: 'paper.pdf' });
  const pdfSent = await put(pdfLink.upload_url, Buffer.from('%PDF-1.4\n%%EOF\n'));
  assert.equal(pdfSent.status, 201);
  assert.equal((await pdfSent.json()).type, 'document');
  const badLink = await ok(starter.secret, 'upload_asset', { filename: 'paper2.pdf' });
  const badSent = await put(badLink.upload_url, Buffer.from('<html>no pdf</html>'));
  assert.equal(badSent.status, 415);
  const badBody = await badSent.json();
  assert.match(badBody.message, /cannot be used as a document: The file is not a PDF/);
  // expired, unknown
  const link3 = await ok(starter.secret, 'upload_asset', { filename: 'sound.mp3' });
  clock.t += 15 * 60 * 1000 + 1000;
  const expired = await put(link3.upload_url, Buffer.alloc(10, 1));
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).error, 'upload_link_expired');
  assert.equal((await put(`${base}/mcp/upload/${'A'.repeat(43)}`, 'x')).status, 404);
  assert.equal((await put(`${base}/mcp/upload/short`, 'x')).status, 404);
  clock.t -= 15 * 60 * 1000 + 1000;
  // too large: declared above 500 MB (refused before a byte is read), a file that is an SVG above 10 MB
  const link4 = await ok(starter.secret, 'upload_asset', { filename: 'huge.mp4' });
  // the length is declared in the header: refused before a byte is read
  const declaredPut = (url, length) =>
    new Promise((resolve, reject) => {
      const request = http.request(`${base}${pathOf(url)}`, { method: 'PUT', headers: { 'Content-Length': String(length) } }, (response) => {
        response.resume();
        resolve(response.statusCode);
        request.destroy();
      });
      request.on('error', (err) => (err.code === 'ECONNRESET' ? resolve('reset') : reject(err)));
      request.write(Buffer.alloc(1000, 1));
    });
  assert.equal(await declaredPut(link4.upload_url, 600 * 1024 * 1024), 413);
  const link5 = await ok(starter.secret, 'upload_asset', { filename: 'logo.svg' });
  assert.equal(await declaredPut(link5.upload_url, 10 * 1024 * 1024 + 1), 413, 'an SVG is read into memory: 10 MB at most');
  // a link ends with its key: revoked after the link was made
  const shortLived = makeKey({ name: 'Kurz', right: 'start' });
  secrets.push(shortLived.secret);
  const link6 = await ok(shortLived.secret, 'upload_asset', { filename: 'a.png' });
  keys.revoke(shortLived.id, STAFF1);
  const revokedPut = await put(link6.upload_url, PNG);
  assert.equal(revokedPut.status, 403);
  assert.equal((await revokedPut.json()).error, 'key_invalid');
  // at most 20 open links per key
  const linky = makeKey({ name: 'Viele Links', right: 'start' });
  secrets.push(linky.secret);
  for (let i = 0; i < 20; i += 1) await ok(linky.secret, 'upload_asset', { filename: `f${i}.png` });
  await refused(linky.secret, 'upload_asset', { filename: 'one-more.png' }, /too many upload links/);
  // the uploads sit in a hidden session of the person and not in the list of chats
  const uploadSession = mcp.uploads.peek(starter.id);
  assert.ok(uploadSession);
  const sessionsLib = iso.load('lib/store');
  assert.equal((await sessionsLib.readSession(uploadSession)).kind, 'agent');
  const personViewer = access.viewerOf({ kubleUser: STAFF1 });
  assert.ok(!(await sessionsLib.listSessions({ viewer: personViewer, limit: 100 })).sessions.some((entry) => entry.id === uploadSession), 'not in the chat list');
  assert.ok((await sessionsLib.listSessions({ viewer: personViewer, limit: 100, includeHidden: true })).sessions.some((entry) => entry.id === uploadSession), 'but it is there');
  assert.equal(mcp.uploads.peek(reader.id), null, 'a key that uploaded nothing has no session');

  /* ============ W + F + J: the whole way, result links, journal ============ */

  const journalPath = costs.COSTS_FILE;
  const journalBefore = (await fsp.readFile(journalPath, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  const copy = await ok(starter.secret, 'create_from_template', { template_id: 'paid-image', inputs: { Photo: uploaded.asset_id, Wish: 'moody' }, name: 'Agent Bild' });
  assert.equal(copy.name, 'Agent Bild');
  assert.ok(copy.rev >= 1);
  assert.equal(copy.estimate.estimate_usd, 0.5);
  assert.deepEqual(copy.inputs.map((input) => [input.id, input.set]), [['n1.asset', true], ['n2.prompt', true]]);
  assert.equal(copy.inputs[1].value, 'moody');
  assert.equal(copy.agent.can_start, true);
  assert.ok(!JSON.stringify(copy).includes(iso.root), 'no path of the server');
  const mineAfter = await ok(starter.secret, 'list_workflows', { query: 'Agent Bild' });
  assert.equal(mineAfter.workflows[0].id, copy.workflow_id);
  // a file the key never uploaded is not an input
  await refused(starter.secret, 'create_from_template', { template_id: 'paid-image', inputs: { Photo: 'upload-999' } }, /was not uploaded with this key/);
  const noUploads = makeKey({ name: 'Ohne Upload', right: 'start' });
  secrets.push(noUploads.secret);
  await refused(noUploads.secret, 'create_from_template', { template_id: 'paid-image', inputs: { Photo: 'upload-001' } }, /Call upload_asset first/);
  // a required input left out: the workflow is made as a draft that says what is missing; it does not start like that
  const draft = await ok(starter.secret, 'create_from_template', { template_id: 'paid-image', name: 'Entwurf Bild' });
  assert.equal(draft.draft, true);
  assert.deepEqual(draft.missing_inputs, [{ id: 'n1.asset', label: 'Photo', type: 'image' }]);
  assert.equal(draft.url, `https://creator.example.com/studio/#w=${draft.workflow_id}`);
  assert.match(draft.next, /draft/);
  await refused(starter.secret, 'run_workflow', { workflow_id: draft.workflow_id, max_usd: 1 }, /not valid|missing|cannot run/i);
  await refused(starter.secret, 'create_from_template', { template_id: 'nope' }, /Not found/);
  const countBefore = (await wfStore.listWorkflows()).length;
  await refused(starter.secret, 'create_from_template', { template_id: 'paid-image', inputs: { Nope: 'x' } }, /Unknown input/);
  assert.equal((await wfStore.listWorkflows()).length, countBefore, 'a refused copy leaves no workflow behind');

  const runInfo = await ok(starter.secret, 'run_workflow', { workflow_id: copy.workflow_id, max_usd: 0.6 });
  assert.equal(runInfo.paid, true);
  assert.equal(runInfo.estimate_usd, 0.5);
  const finished = await finish(starter.secret, runInfo.run_id);
  assert.equal(finished.status, 'completed');
  assert.ok(Math.abs(finished.cost_usd - 0.4) < 1e-9);
  assert.equal(finished.progress.done, finished.progress.total);
  const picture = finished.results[0];
  assert.equal(picture.label, 'Picture');
  const link = picture.items[0];
  assert.equal(link.type, 'image');
  assert.match(link.url, /^https:\/\/creator\.example\.com\/studio\/mcp\/files\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(Date.parse(link.expires_at) - clock.t, 24 * 60 * 60 * 1000);
  assert.ok(!JSON.stringify(finished).includes(iso.root));
  // wait_seconds on a finished run returns at once; on a run in progress it waits for the end
  const startedAt = Date.now();
  assert.equal((await ok(starter.secret, 'get_run', { run_id: runInfo.run_id, wait_seconds: 20 })).finished, true);
  assert.ok(Date.now() - startedAt < 3000);
  openGate();
  const waiter = await ok(roomy.secret, 'run_workflow', { workflow_id: (await fresh()).id, max_usd: 0.5 });
  const waitStarted = Date.now();
  const waiting = tool(roomy.secret, 'get_run', { run_id: waiter.run_id, wait_seconds: 10 });
  await sleep(300);
  gate.current.release();
  const waited = (await waiting).data;
  assert.equal(waited.finished, true, 'the call returned when the run had finished');
  assert.ok(Date.now() - waitStarted < 5000);
  gate.current = null;
  const stillRunning = await (async () => {
    openGate();
    const slow = await ok(roomy.secret, 'run_workflow', { workflow_id: (await fresh()).id, max_usd: 0.5 });
    const quick = await ok(roomy.secret, 'get_run', { run_id: slow.run_id, wait_seconds: 1 });
    gate.current.release();
    await finish(roomy.secret, slow.run_id);
    gate.current = null;
    return quick;
  })();
  assert.equal(stillRunning.finished, false, 'the wait ends after the time given');
  assert.equal(stillRunning.status, 'running');

  // F: the result link
  const fileUrl = `${base}${pathOf(link.url)}`;
  const served = await fetch(fileUrl); // no key, no cookie: the token is the permission
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG, 'it is the file of the run');
  assert.equal((await fetch(fileUrl, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(fileUrl, { method: 'POST' })).status, 405);
  const ranged = await fetch(fileUrl, { headers: { Range: 'bytes=0-7' } });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 8);
  // the links of the same file are all valid; links of the workflow show up in get_workflow too
  const latest = (await ok(starter.secret, 'get_workflow', { workflow_id: copy.workflow_id })).latest_results;
  assert.equal(latest[0].items[0].type, 'image');
  assert.equal((await fetch(`${base}${pathOf(latest[0].items[0].url)}`)).status, 200);
  // another file: a changed token does not verify (the file, the session, the expiry), a token with a file of another type neither
  const [payload, mac] = pathOf(link.url).split('/').pop().split('.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const forge = (change) => `${Buffer.from(JSON.stringify({ ...decoded, ...change }), 'utf8').toString('base64url')}.${mac}`;
  for (const change of [{ f: 'other-file.png' }, { f: '../ledger.json' }, { s: uploadSession }, { e: decoded.e + 86400000 }]) {
    assert.equal((await fetch(`${base}/mcp/files/${forge(change)}`)).status, 404, JSON.stringify(change));
  }
  assert.equal((await fetch(`${base}/mcp/files/${payload}.${'A'.repeat(22)}`)).status, 404);
  assert.equal((await fetch(`${base}/mcp/files/${payload}`)).status, 404);
  assert.equal((await fetch(`${base}/mcp/files/${mac}.${payload}`)).status, 404);
  assert.equal((await fetch(`${base}/mcp/files/${encodeURIComponent('../../etc/passwd')}`)).status, 404);
  // the files a link hands out are media only: a token the server never signed for a ledger or a script does not exist
  assert.equal(linksLib.createFileLinks({ now: () => clock.t }).sign({ sessionId: decoded.s, file: 'ledger.json' }), null);
  assert.equal(linksLib.createFileLinks({ now: () => clock.t }).sign({ sessionId: decoded.s, file: 'logo.svg' }), null);
  // expired after 24 hours
  clock.t += 24 * 60 * 60 * 1000 + 1000;
  const gone = await fetch(fileUrl);
  assert.equal(gone.status, 410);
  assert.equal((await gone.json()).error, 'link_expired');
  clock.t -= 24 * 60 * 60 * 1000 + 1000;
  assert.equal((await fetch(fileUrl)).status, 200, 'and valid again when the time is back (the link keeps no state)');
  // a link made by another secret is no link (the secret is of this installation)
  const foreign = linksLib.createFileLinks({ secretFile: path.join(iso.root, 'other-secret'), now: () => clock.t }).sign({ sessionId: decoded.s, file: decoded.f });
  assert.equal((await fetch(`${base}/mcp/files/${foreign.token}`)).status, 404);
  const secretFile = await fsp.stat(linksLib.SECRET_FILE);
  assert.equal(secretFile.mode & 0o077, 0, 'the secret of the links is for the owner only');

  // J: the cost journal
  const journalLines = (await fsp.readFile(journalPath, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const viaStarter = journalLines.filter((row) => row.keyId === starter.id);
  assert.ok(viaStarter.length >= 1, 'the run booked with the id of the key');
  for (const row of viaStarter) {
    assert.equal(row.keyName, 'Starter');
    assert.equal(row.user, STAFF1, 'on the person');
  }
  assert.ok(journalLines.length > journalBefore);
  const viaTight = journalLines.filter((row) => row.keyId === roomy.id);
  assert.ok(viaTight.length >= 1 && viaTight.every((row) => row.keyName === 'Geräumig' && row.user === STAFF1));
  assert.ok(journalLines.every((row) => !('hash' in row) && !('secret' in row)));
  const journalText = JSON.stringify(journalLines);
  for (const secret of secrets) {
    assert.ok(!journalText.includes(secret) && !journalText.includes(secret.slice(7)), 'no key in the journal');
  }
  // a run without a key books without key fields
  const directWorkflow = await fresh();
  const direct = await baseService.start(access.viewerOf({ kubleUser: STAFF1 }), directWorkflow.id, { maxUsd: 0.5 });
  await baseService.waitForRun(access.viewerOf({ kubleUser: STAFF1 }), direct.runId);
  const afterDirect = (await costs.readCosts()).filter((row) => row.sessionId === directWorkflow.sessionId && !row.keyId);
  assert.ok(afterDirect.length >= 1, 'a run from the app books on the person without a key');
  // the cost evaluation shows what an agent spent
  const summary = costs.summariseCosts(await costs.readCosts());
  const starterRow = summary.byKey.find((row) => row.keyId === starter.id);
  assert.equal(starterRow.keyName, 'Starter');
  assert.ok(starterRow.total >= 0.4 - 1e-9);
  assert.ok(summary.byUser.find((row) => row.user === STAFF1).total >= starterRow.total, 'the person carries it');
  // the origin travels with async work, and a key name is cleaned
  const via = await costs.withVia({ keyId: 'k0123456789abcdef', keyName: `Bot\n\u0007 ${'x'.repeat(200)}` }, async () => {
    await sleep(5);
    return new Promise((resolve) => setImmediate(() => resolve(costs.viaFields())));
  });
  assert.equal(via.keyId, 'k0123456789abcdef');
  assert.ok(via.keyName.startsWith('Bot ') && [...via.keyName].length <= 80 && !/[\u0000-\u001f]/.test(via.keyName));
  assert.deepEqual(costs.viaFields(), {}, 'outside of a run there is no origin');
  assert.deepEqual(costs.viaFields({ keyId: 'k0123456789abcdef', keyName: 'Job' }), { keyId: 'k0123456789abcdef', keyName: 'Job' }, 'a job carries it to the poller');
  assert.deepEqual(costs.viaFields({ keyId: 'not-a-key-id', keyName: 'x' }), {});
  // the month usage per key as the settings page asks for it
  const settingsPage = await api('/api/mcp/keys', { as: STAFF1 });
  assert.equal(settingsPage.status, 200);
  const starterShown = settingsPage.body.keys.find((entry) => entry.id === starter.id);
  assert.ok(starterShown.monthUsedUsd >= 0.4 - 1e-9, `month usage ${starterShown.monthUsedUsd}`);
  assert.equal(settingsPage.body.keys.find((entry) => entry.id === reader.id).monthUsedUsd, 0);

  /* ----- the real app: the tools are on its endpoint, a read key sees the five reading ones ----- */

  const live = await api('/api/mcp/keys', { method: 'POST', as: STAFF2, json: { name: 'App-Schlüssel', right: 'read' } });
  assert.equal(live.status, 201);
  secrets.push(live.body.secret);
  const liveList = await api('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${live.body.secret}` }, json: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.equal(liveList.status, 200, liveList.text);
  assert.deepEqual(liveList.body.result.tools.map((item) => item.name), readNames);
  const liveCall = await api('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${live.body.secret}` }, json: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_templates', arguments: {} } } });
  assert.equal(liveCall.status, 200);
  assert.equal(liveCall.body.result.isError, false, liveCall.text);
  assert.ok(liveCall.body.result.structuredContent.count > 3, 'the real templates are listed');
  everything.push(liveCall.text, liveList.text);

  // the whole way against the real app: a start key, a real free template (local image work), no provider is contacted
  const liveStart = await api('/api/mcp/keys', { method: 'POST', as: STAFF2, json: { name: 'App-Start', right: 'start' } });
  secrets.push(liveStart.body.secret);
  const live2 = async (name, args) => {
    const response = await api('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${liveStart.body.secret}` }, json: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } } });
    assert.equal(response.status, 200, response.text);
    everything.push(response.text);
    return { isError: response.body.result.isError, data: response.body.result.structuredContent, text: response.body.result.content[0].text };
  };
  const liveUpload = await live2('upload_asset', { filename: 'foto.png', data_base64: PNG.toString('base64') });
  assert.equal(liveUpload.isError, false, liveUpload.text);
  const formats = (await live2('list_templates', {})).data.templates.find((template) => template.id === 'image-formats');
  assert.equal(formats.cost.kind, 'free');
  const liveCopy = await live2('create_from_template', { template_id: 'image-formats', inputs: { [formats.inputs[0].id]: liveUpload.data.asset_id } });
  assert.equal(liveCopy.isError, false, liveCopy.text);
  assert.equal(liveCopy.data.agent.can_start, true);
  const liveRun = await live2('run_workflow', { workflow_id: liveCopy.data.workflow_id, max_usd: 0 });
  assert.equal(liveRun.isError, false, liveRun.text);
  const liveDone = await waitFor(async () => {
    const state = await live2('get_run', { run_id: liveRun.data.run_id, wait_seconds: 5 });
    assert.equal(state.isError, false, state.text);
    return state.data.finished ? state.data : null;
  }, 'the run in the real app', 30000);
  assert.equal(liveDone.status, 'completed', JSON.stringify(liveDone));
  assert.equal(liveDone.cost_usd, 0);
  const liveFiles = liveDone.results.flatMap((group) => group.items).filter((item) => item.url);
  assert.ok(liveFiles.length >= 1, 'the results are links');
  const liveFile = await fetch(`http://127.0.0.1:${iso.port}${pathOf(liveFiles[0].url)}`); // no key, no cookie
  assert.equal(liveFile.status, 200);
  assert.match(liveFile.headers.get('content-type'), /^image\//);
  assert.ok((await liveFile.arrayBuffer()).byteLength > 0);
  // a paid template whose steps are not available here is refused with a sentence, nothing is started
  const liveUnavailable = await live2('create_from_template', { template_id: 'photo-to-3d', inputs: { Photo: liveUpload.data.asset_id } });
  assert.equal(liveUnavailable.isError, true);
  assert.match(liveUnavailable.text, /cannot run|not available/);
  // the cost journal of the real app: the free run booked nothing, and the file link does not need a login
  assert.equal((await api(`/mcp/files/${pathOf(liveFiles[0].url).split('/').pop()}`)).status, 200);

  /* ----- participant keys use the same service, visibility and team budget as the app ----- */

  const P = 'learner@gmail.example';
  const course = (await api('/api/teams', { method: 'POST', as: ADMIN, json: { name: 'MCP-Kurs', budgetUsd: 0.6 } })).body.team;
  assert.equal((await api(`/api/teams/${course.id}/members`, { method: 'POST', as: ADMIN, json: { emails: [P] } })).status, 201);
  const participant = makeKey({ name: 'Teilnehmend', owner: P, right: 'start', maxRunUsd: 5, maxMonthUsd: 25 });
  secrets.push(participant.secret);
  const pViewer = access.viewerOf({ kubleUser: P });
  assert.equal(pViewer.kind, 'participant');
  const pOwn = await mk(P, 'Mein Kurslauf', freeGraph());
  const pPay = await mk(P, 'Bezahlt im Kurs', paidGraph());
  const pPay2 = await mk(P, 'Bezahlt im Kurs 2', paidGraph());
  const legacy = await mk(null, 'Alte interne Daten', freeGraph());
  const pShared = await mk(STAFF2, 'Kursfreigabe', freeGraph(), { share: { shareMode: 'teams', sharedTeams: [course.id] } });
  const pIds = (await ok(participant.secret, 'list_workflows')).workflows.map((item) => item.id);
  assert.ok(pIds.includes(pOwn.id) && pIds.includes(pShared.id));
  for (const hidden of [foreignPrivate, sharedWithAll, legacy, free]) {
    assert.ok(!pIds.includes(hidden.id));
    for (const name of ['get_workflow', 'estimate_run', 'run_workflow']) {
      await refused(participant.secret, name, { workflow_id: hidden.id, ...(name === 'run_workflow' ? { max_usd: 5 } : {}) }, /Not found/);
    }
  }
  const pTemplates = await ok(participant.secret, 'list_templates');
  assert.ok(!pTemplates.templates.some((item) => item.id === 'hf-flow'));
  assert.deepEqual(pTemplates.templates.map((item) => item.id), (await baseService.listRunnable(pViewer)).items.filter((item) => item.kind === 'template').map((item) => item.id), 'the template catalogue matches the UI service');
  const preparedForP = await ok(participant.secret, 'create_from_template', { template_id: 'free-text', inputs: { Idea: 'Kurs' } });
  const pStored = await wfStore.readWorkflow(preparedForP.workflow_id);
  assert.equal(pStored.owner, P);
  assert.equal(pStored.teamId, course.id);
  await refused(participant.secret, 'create_from_template', { template_id: 'hf-flow' }, /not available/);

  // Even if the UI grants USD-backed Higgsfield access, agent starts remain blocked.
  const accessHf = access.higgsfieldAllowed;
  access.higgsfieldAllowed = () => true;
  try {
    const pHf = await mk(P, 'Higgsfield im Kurs', hfGraph);
    await refused(participant.secret, 'run_workflow', { workflow_id: pHf.id, max_usd: 5 }, /Higgsfield.*not available through agent access/);
    assert.equal(calls.hf, 0);
  } finally { access.higgsfieldAllowed = accessHf; }

  const policy = iso.load('lib/mcp/policy').defaultStore;
  const initialPolicy = policy.get();
  policy.set({ participant: { ...initialPolicy.participant, defaultRunUsd: 0.1, maxRunUsd: 0.3 } });
  const limitedRun = await ok(participant.secret, 'estimate_run', { workflow_id: pPay.id });
  assert.equal(limitedRun.agent.max_run_usd, 0.3);
  assert.equal(limitedRun.agent.can_start, false);
  await refused(participant.secret, 'run_workflow', { workflow_id: pPay.id, max_usd: 5 }, /limit of \$0\.30 per run/);
  assert.equal(keys.get(participant.id).maxRunUsd, 5);
  policy.set({ participant: { ...initialPolicy.participant, defaultMonthUsd: 0.1, maxMonthUsd: 0.3 } });
  const limitedMonth = await ok(participant.secret, 'estimate_run', { workflow_id: pPay.id });
  assert.equal(limitedMonth.agent.month_limit_usd, 0.3);
  await refused(participant.secret, 'run_workflow', { workflow_id: pPay.id, max_usd: 5 }, /limit of \$0\.30 per month/);
  policy.set(initialPolicy);

  const pFirst = await ok(participant.secret, 'run_workflow', { workflow_id: pPay.id, max_usd: 5 });
  assert.equal((await finish(participant.secret, pFirst.run_id)).status, 'completed');
  const pBudget = await budgetLib.status(pViewer);
  assert.ok(Math.abs(pBudget.remainingUsd - 0.2) < 0.00001, JSON.stringify(pBudget));
  const pPlan = await ok(participant.secret, 'estimate_run', { workflow_id: pPay2.id });
  assert.equal(pPlan.agent.can_start, false);
  assert.match(pPlan.agent.problems.join(' '), /budget.*does not cover/);
  assert.ok(pPlan.agent.max_run_usd > pBudget.remainingUsd, 'a key limit cannot add team credit');
  const beforeBudgetRefusal = calls.paid;
  await refused(participant.secret, 'run_workflow', { workflow_id: pPay2.id, max_usd: 5 }, /budget.*does not cover/);
  await assert.rejects(baseService.start(pViewer, pPay2.id, { maxUsd: 5 }), (err) => err.code === 'BUDGET_INSUFFICIENT', 'the UI run service gives the same budget refusal');
  assert.equal(calls.paid, beforeBudgetRefusal);

  // Runtime guards receive the authenticated owner as ctx.user, including models and internal branding resources.
  const realRegistry = iso.load('lib/nodes/registry').registry;
  const toolNames = (await rpc(participant.secret, 'tools/list')).json.result.tools.map((item) => item.name);
  assert.ok(!toolNames.some((name) => /gts|branding|custom_template/.test(name)));
  const llm = iso.load('lib/nodes/llm');
  const authenticated = keys.authenticate(participant.secret);
  assert.equal(authenticated.viewer.email, P);
  await assert.rejects(llm.completeText({ user: authenticated.viewer.email, model: 'chatgpt/gpt-5.6-sol', prompt: 'x' }), (err) => err.code === 'FORBIDDEN_FOR_ROLE' && err.feature === 'chatgpt');
  await assert.rejects(llm.completeText({ user: authenticated.viewer.email, model: 'unlisted/model', restrictedModels: ['allowed/model'], prompt: 'x' }), (err) => err.code === 'FORBIDDEN_FOR_ROLE' && err.feature === 'models');
  await assert.rejects(realRegistry.get('input.branding').execute({ user: authenticated.viewer.email, log() {} }, {}, { branding: 'internal-brand' }), (err) => err.code === 'BRANDING_NOT_FOUND');
  assert.equal(iso.load('lib/mcp/workflow-tools').describeError({ code: 'FORBIDDEN_FOR_ROLE', feature: 'models', message: 'Model blocked' }).includes('models'), true);


  /* ============ E: editing a workflow ============ */

  const editor = makeKey({ name: 'Bauer', right: 'start', maxRunUsd: 2, maxMonthUsd: 20 });
  secrets.push(editor.secret);
  const urlOf = (id) => `https://creator.example.com/studio/#w=${id}`;

  // the catalogue: what the person can add; Higgsfield is not offered to an agent; params on request
  const catalogue = await ok(reader.secret, 'list_node_types', {});
  const typeIds = catalogue.node_types.map((item) => item.type);
  assert.ok(typeIds.includes('input.text') && typeIds.includes('t.upper') && typeIds.includes('output.result'));
  assert.ok(!typeIds.includes('t.hf'), 'Higgsfield types are not offered through agent access');
  assert.ok(catalogue.node_types.every((item) => item.params === undefined), 'the list has no params');
  const upperType = catalogue.node_types.find((item) => item.type === 't.upper');
  assert.deepEqual(upperType.inputs, [{ id: 'in', type: 'text', required: true }]);
  assert.deepEqual(upperType.outputs, [{ id: 'out', type: 'text' }]);
  const detail = await ok(reader.secret, 'list_node_types', { types: ['text.join', 'nope.type'] });
  assert.equal(detail.count, 1);
  assert.deepEqual(detail.unknown, ['nope.type']);
  assert.deepEqual(detail.node_types[0].params, [{ id: 'separator', kind: 'text', default: '\n' }]);
  assert.equal((await ok(reader.secret, 'list_node_types', { query: 'join' })).node_types.some((item) => item.type === 'text.join'), true);

  // a read key cannot edit or create
  const editTool = await rpc(reader.secret, 'tools/call', { name: 'edit_workflow', arguments: { workflow_id: free.id, operations: [{ op: 'remove_node', node: 'b' }] } });
  assert.ok(editTool.json.error || editTool.json.result.isError, 'a read key cannot edit');
  assert.equal((await wfStore.readWorkflow(free.id)).graph.nodes.length, 3);

  // a draft from a template whose required text is missing, then rewired: a new node takes the place of the input
  const textDraft = await ok(editor.secret, 'create_from_template', { template_id: 'free-text', name: 'Umgebaut' });
  assert.equal(textDraft.draft, true);
  assert.deepEqual(textDraft.missing_inputs.map((item) => item.id), ['n1.prompt']);
  assert.equal(textDraft.url, urlOf(textDraft.workflow_id));
  const before = await ok(editor.secret, 'get_workflow', { workflow_id: textDraft.workflow_id, include_graph: true });
  assert.equal(before.url, urlOf(textDraft.workflow_id));
  assert.deepEqual(before.graph.edges, [{ id: 'e1', from: 'n1.prompt', to: 'n2.in' }, { id: 'e2', from: 'n2.out', to: 'n3.inputs' }]);
  assert.deepEqual(before.graph.nodes.find((item) => item.id === 'n2').inputs, [{ id: 'in', type: 'text', required: true, from: ['n1.prompt'] }]);
  assert.deepEqual(before.graph.nodes.find((item) => item.id === 'n1').workflow_inputs, ['prompt']);
  assert.equal((await ok(editor.secret, 'get_workflow', { workflow_id: textDraft.workflow_id })).graph, undefined, 'the graph only on request');

  // an input that takes one connection is not rewired without replace; nothing is changed by a refused call
  await refused(editor.secret, 'edit_workflow', {
    workflow_id: textDraft.workflow_id,
    operations: [{ op: 'add_node', type: 'input.text', ref: 'src', params: { text: 'hallo welt' } }, { op: 'connect', from: { node: 'src', port: 'text' }, to: { node: 'n2', port: 'in' } }]
  }, /Operation 2 \(connect\).*takes one connection.*n1\.prompt.*replace/);
  const untouched = await wfStore.readWorkflow(textDraft.workflow_id);
  assert.equal(untouched.rev, before.rev, 'a refused edit saves nothing');
  assert.equal(untouched.graph.nodes.length, 3);

  const rebuilt = await ok(editor.secret, 'edit_workflow', {
    workflow_id: textDraft.workflow_id,
    rev: before.rev,
    operations: [
      { op: 'add_node', type: 'input.text', ref: 'src', params: { text: 'hallo welt' }, label: 'Quelle' },
      { op: 'connect', from: { node: 'src', port: 'text' }, to: { node: 'n2', port: 'in' }, replace: true },
      { op: 'remove_node', node: 'n1' }
    ]
  });
  assert.equal(rebuilt.url, urlOf(textDraft.workflow_id));
  assert.equal(rebuilt.changed, true);
  assert.equal(rebuilt.rev, before.rev + 1);
  assert.deepEqual(rebuilt.created_nodes, { src: 'n4' });
  assert.deepEqual(rebuilt.removed_nodes, ['n1']);
  assert.deepEqual(rebuilt.removed_edges, ['e1']);
  assert.equal(rebuilt.added_edges.length, 1);
  assert.equal(rebuilt.state.valid, true);
  assert.equal(rebuilt.state.can_start, true);
  const after = await ok(editor.secret, 'get_workflow', { workflow_id: textDraft.workflow_id, include_graph: true });
  assert.deepEqual(after.graph.nodes.map((item) => item.id), ['n2', 'n3', 'n4']);
  assert.equal(after.graph.nodes.find((item) => item.id === 'n4').label, 'Quelle');
  assert.equal(after.graph.nodes.find((item) => item.id === 'n4').params.text, 'hallo welt');
  assert.deepEqual(after.graph.nodes.find((item) => item.id === 'n2').inputs[0].from, ['n4.text']);
  assert.deepEqual(after.inputs.map((item) => item.id), ['n4.text'], 'the input of the removed node is gone; the new input node is the input now');
  const rebuiltRun = await ok(editor.secret, 'run_workflow', { workflow_id: textDraft.workflow_id, max_usd: 0 });
  assert.equal(rebuiltRun.url, urlOf(textDraft.workflow_id));
  const rebuiltDone = await finish(editor.secret, rebuiltRun.run_id);
  assert.equal(rebuiltDone.status, 'completed');
  assert.equal(rebuiltDone.workflow_url, urlOf(textDraft.workflow_id));
  assert.equal(rebuiltDone.results[0].items[0].text, 'HALLO WELT');

  // a stale rev is refused
  await refused(editor.secret, 'edit_workflow', { workflow_id: textDraft.workflow_id, rev: before.rev, operations: [{ op: 'set_label', node: 'n4', label: 'x' }] }, /changed in the meantime.*rev/);

  // an empty workflow, built from nothing; a param becomes an input of the workflow
  const blank = await ok(editor.secret, 'create_workflow', { name: 'Von Grund auf' });
  assert.equal(blank.url, urlOf(blank.workflow_id));
  assert.equal((await wfStore.readWorkflow(blank.workflow_id)).owner, STAFF1);
  const built = await ok(editor.secret, 'edit_workflow', {
    workflow_id: blank.workflow_id,
    operations: [
      { op: 'add_node', type: 'input.text', ref: 'a', params: { text: 'eins' } },
      { op: 'add_node', type: 'input.text', ref: 'b', params: { text: 'zwei' } },
      { op: 'add_node', type: 'text.join', ref: 'j', params: { separator: ' + ' } },
      { op: 'add_node', type: 't.upper', ref: 'u' },
      { op: 'add_node', type: 'output.result', ref: 'o', params: { label: 'Fertig' } },
      { op: 'connect', from: { node: 'a', port: 'text' }, to: { node: 'j', port: 'items' } },
      { op: 'connect', from: { node: 'b', port: 'text' }, to: { node: 'j', port: 'items' } },
      { op: 'connect', from: { node: 'j', port: 'text' }, to: { node: 'u', port: 'in' } },
      { op: 'connect', from: { node: 'u', port: 'out' }, to: { node: 'o', port: 'inputs' } },
      { op: 'expose_input', node: 'b', param: 'text', label: 'Zweites Wort' }
    ]
  });
  assert.deepEqual(built.created_nodes, { a: 'n1', b: 'n2', j: 'n3', u: 'n4', o: 'n5' });
  assert.equal(built.state.can_start, true);
  const builtView = await ok(editor.secret, 'get_workflow', { workflow_id: blank.workflow_id });
  assert.deepEqual(builtView.inputs.map((item) => item.label), ['Text input', 'Zweites Wort'], 'the input nodes stay inputs when one is added by hand');
  const builtRun = await ok(editor.secret, 'run_workflow', { workflow_id: blank.workflow_id, max_usd: 0, inputs: { 'Zweites Wort': 'drei' } });
  assert.equal((await finish(editor.secret, builtRun.run_id)).results[0].items[0].text, 'EINS + DREI');

  // the rules of the editor: every refusal names the operation and leaves the workflow as it was
  const builtRev = (await wfStore.readWorkflow(blank.workflow_id)).rev;
  const bad = (operations, pattern) => refused(editor.secret, 'edit_workflow', { workflow_id: blank.workflow_id, operations }, pattern);
  await bad([{ op: 'add_node', type: 'nope.type' }], /does not exist/);
  await bad([{ op: 'add_node', type: 't.hf' }], /not available for this account through agent access/);
  await bad([{ op: 'add_node', type: 'text.join', params: { nope: 1 } }], /has no param "nope"/);
  await bad([{ op: 'set_params', node: 'n1', params: { text: 5 === 5 ? ['x'] : '' } }], /must be a text/);
  await bad([{ op: 'connect', from: { node: 'n4', port: 'out' }, to: { node: 'n3', port: 'items' } }], /close a loop/);
  await bad([{ op: 'connect', from: { node: 'n1', port: 'text' }, to: { node: 'n3', port: 'items' } }], /exists already/);
  await bad([{ op: 'connect', from: { node: 'n1', port: 'nope' }, to: { node: 'n4', port: 'in' } }], /has no output "nope" \(it has: text:text\)/);
  await bad([{ op: 'connect', from: { node: 'n1', port: 'text' }, to: { node: 'n1', port: 'text' } }], /has no input|itself/);
  await bad([{ op: 'remove_node', node: 'zz' }], /there is no node "zz"/);
  await bad([{ op: 'disconnect', edge: 'e99' }], /no connection with the id/);
  await bad([{ op: 'set_label', node: 'n1', label: 'ok' }, { op: 'explode' }], /arguments|unknown "op"|must be one of/);
  await bad([{ op: 'add_node', type: 'input.media_list', params: { assets: ['upload-999'] } }], /No file has been uploaded with this key yet/);
  await bad([{ op: 'add_node', type: 'input.image', params: { asset: 5 } }], /takes the asset_id of a file uploaded with upload_asset/);
  assert.equal((await wfStore.readWorkflow(blank.workflow_id)).rev, builtRev, 'refused edits change nothing');

  // file params: an uploaded file goes into an input node (copied into the session of the workflow)
  const editorPng = await ok(editor.secret, 'upload_asset', { filename: 'cover.png', data_base64: PNG.toString('base64') });
  await bad([{ op: 'add_node', type: 'input.audio', params: { asset: editorPng.asset_id } }], /is image, this node takes audio/);
  await bad([{ op: 'add_node', type: 'input.image', params: { asset: 'upload-999' } }], /was not uploaded with this key/);
  assert.equal((await wfStore.readWorkflow(blank.workflow_id)).rev, builtRev, 'refused file edits change nothing');
  const withFile = await ok(editor.secret, 'edit_workflow', {
    workflow_id: blank.workflow_id,
    operations: [
      { op: 'add_node', type: 'input.image', ref: 'pic', params: { asset: editorPng.asset_id } },
      { op: 'add_node', type: 'input.media_list', ref: 'list', params: { assets: [editorPng.asset_id, editorPng.asset_id] } }
    ]
  });
  assert.match(withFile.notes.join(' '), /1 file put into the workflow/);
  const filed = await wfStore.readWorkflow(blank.workflow_id);
  const picNode = filed.graph.nodes.find((item) => item.id === withFile.created_nodes.pic);
  assert.equal(picNode.params.asset.sessionId, filed.sessionId, 'the file lives in the session of the workflow');
  assert.equal(picNode.params.asset.type, 'image');
  assert.notEqual(picNode.params.asset.assetId, undefined);
  await fsp.access(path.join(iso.load('lib/store').sessionAssetDir(filed.sessionId), picNode.params.asset.file));
  const listNode = filed.graph.nodes.find((item) => item.id === withFile.created_nodes.list);
  assert.equal(listNode.params.assets.length, 2);
  assert.equal(listNode.params.assets[0].assetId, picNode.params.asset.assetId, 'one file given twice is copied once');
  const shownFile = await ok(editor.secret, 'get_workflow', { workflow_id: blank.workflow_id, include_graph: true });
  assert.deepEqual(shownFile.graph.nodes.find((item) => item.id === picNode.id).params.asset, { file: picNode.params.asset.assetId, type: 'image' });
  const cleared = await ok(editor.secret, 'edit_workflow', { workflow_id: blank.workflow_id, operations: [{ op: 'remove_node', node: picNode.id }, { op: 'remove_node', node: listNode.id }] });
  assert.equal(cleared.removed_nodes.length, 2);

  // disconnect and unexpose; a workflow that lost a required connection says so and does not start
  const cut = await ok(editor.secret, 'edit_workflow', {
    workflow_id: blank.workflow_id,
    operations: [{ op: 'disconnect', to: { node: 'n4', port: 'in' } }, { op: 'unexpose_input', node: 'n2', param: 'text' }, { op: 'set_params', node: 'n3', params: { separator: ' - ' } }]
  });
  assert.equal(cut.removed_edges.length, 1);
  assert.equal(cut.state.valid, false);
  assert.equal(cut.state.can_start, false);
  assert.ok(cut.state.issues.length > 0);
  await refused(editor.secret, 'run_workflow', { workflow_id: blank.workflow_id, max_usd: 0 }, /cannot run|not valid/);

  // visibility: a stranger's private workflow does not exist, a shared one can be changed as in the app
  await refused(editor.secret, 'edit_workflow', { workflow_id: foreignPrivate.id, operations: [{ op: 'set_label', node: 'a', label: 'x' }] }, /Not found/);
  await refused(editor.secret, 'get_workflow', { workflow_id: foreignPrivate.id, include_graph: true }, /Not found/);
  const sharedEdit = await ok(editor.secret, 'edit_workflow', { workflow_id: sharedWithAll.id, operations: [{ op: 'set_label', node: 'b', label: 'Gross' }] });
  assert.equal(sharedEdit.changed, true);
  assert.equal((await wfStore.readWorkflow(sharedWithAll.id)).updatedBy, STAFF1);

  // the list carries the address too
  const listed = await ok(editor.secret, 'list_workflows', { query: 'Von Grund auf' });
  assert.equal(listed.workflows[0].url, urlOf(blank.workflow_id));

  /* ============ partial runs, approval, result history and duplication ============ */

  const partial = await mk(STAFF1, 'Partial branches', {
    nodes: [...paidGraph().nodes, node('other', 't.paid')], edges: paidGraph().edges
  });
  const wholePlan = await ok(starter.secret, 'estimate_run', { workflow_id: partial.id });
  const nodeArgs = { workflow_id: partial.id, mode: 'node', node_ids: ['b'] };
  const partialPlan = await ok(starter.secret, 'estimate_run', nodeArgs);
  assert.equal(partialPlan.mode, 'node');
  assert.deepEqual(partialPlan.node_ids, ['b']);
  assert.equal(partialPlan.estimate_usd, 0.5);
  assert.ok(partialPlan.steps_to_run < wholePlan.steps_to_run);
  assert.deepEqual(partialPlan.steps.map((step) => step.node_id), ['a', 'b']);
  const beforePartial = calls.paid;
  await refused(starter.secret, 'run_workflow', { ...nodeArgs, max_usd: 0.4 }, /more than the max_usd/);
  const tinyPartial = makeKey({ name: 'Partial limit', right: 'start', maxRunUsd: 0.2 });
  secrets.push(tinyPartial.secret);
  await refused(tinyPartial.secret, 'run_workflow', { ...nodeArgs, max_usd: 1 }, /per run/);
  await refused(starter.secret, 'run_workflow', { ...nodeArgs, node_ids: ['missing'], max_usd: 1 }, /unknown node missing/);
  await refused(reader.secret, 'estimate_run', { ...nodeArgs, node_ids: ['missing'] }, /unknown node missing/);
  assert.equal((await wfStore.listRuns(partial.id)).length, 0);
  const firstPartial = await ok(starter.secret, 'run_workflow', { ...nodeArgs, max_usd: 0.5, inputs: { 'a.prompt': 'partial input' } });
  assert.equal(firstPartial.mode, 'node');
  assert.deepEqual(firstPartial.node_ids, ['b']);
  await finish(starter.secret, firstPartial.run_id);
  assert.equal(calls.paid, beforePartial + 1, 'the unrelated paid branch did not run');
  const partialRecord = await wfStore.readRun(partial.id, firstPartial.run_id);
  assert.deepEqual(Object.keys(partialRecord.nodes).sort(), ['a', 'b']);
  const cachedPlan = await ok(reader.secret, 'estimate_run', nodeArgs);
  assert.equal(cachedPlan.steps_to_run, 0);
  assert.equal(cachedPlan.estimate_usd, 0);
  const forcedPlan = await ok(reader.secret, 'estimate_run', { ...nodeArgs, force: true });
  assert.equal(forcedPlan.estimate_usd, 0.5);
  const againPartial = await ok(starter.secret, 'run_workflow', { ...nodeArgs, max_usd: 0.5, force: true });
  await finish(starter.secret, againPartial.run_id);
  assert.equal(calls.paid, beforePartial + 2, 'force reruns the cached target');
  const selection = await ok(starter.secret, 'run_workflow', { workflow_id: partial.id, mode: 'selection', node_ids: ['other'], max_usd: 0.5 });
  await finish(starter.secret, selection.run_id);
  assert.equal(calls.paid, beforePartial + 3);

  // A list-producing double and a mapped node prove that items reaches the engine unchanged (including force's no-op).
  registry.register({ type: 't.list', category: 'text', inputs: [], outputs: [{ id: 'out', type: 'text[]' }],
    execute: async () => ({ variants: [{ out: types.listValue('text', [textValue('one'), textValue('two')]) }] }) });
  const itemsWorkflow = await mk(STAFF1, 'Items', { nodes: [node('list', 't.list'), node('mapped', 't.paid')], edges: [edge('listedge', 'list', 'out', 'mapped', 'in')] });
  const listOnly = await ok(starter.secret, 'run_workflow', { workflow_id: itemsWorkflow.id, mode: 'node', node_ids: ['list'], max_usd: 0 });
  await finish(starter.secret, listOnly.run_id);
  const initialItems = await ok(starter.secret, 'run_workflow', { workflow_id: itemsWorkflow.id, max_usd: 1 });
  await finish(starter.secret, initialItems.run_id);
  const itemsArgs = { workflow_id: itemsWorkflow.id, mode: 'items', node_id: 'mapped', items: [1], force: true };
  const itemsPlan = await ok(reader.secret, 'estimate_run', itemsArgs);
  assert.equal(itemsPlan.mode, 'items');
  assert.equal(itemsPlan.estimate_usd, 0.5);
  const beforeItems = calls.paid;
  const remadeItem = await ok(starter.secret, 'run_workflow', { ...itemsArgs, max_usd: 0.5 });
  await finish(starter.secret, remadeItem.run_id);
  assert.equal(calls.paid, beforeItems + 1, 'only the chosen list item reran');
  await refused(starter.secret, 'run_workflow', { ...itemsArgs, items: [10], max_usd: 0.5 }, /item|outside|range/);

  const history = await ok(reader.secret, 'get_workflow_results', { workflow_id: partial.id, node_id: 'b', text_chars: 3, history_limit: 1 });
  assert.equal(history.nodes.length, 1);
  assert.equal(history.nodes[0].node_id, 'b');
  assert.equal(history.nodes[0].history.length, 1);
  assert.equal(history.nodes[0].history[0].selected, true);
  assert.equal(history.nodes[0].history[0].entry_id, history.nodes[0].selected.entry_id);
  assert.equal(history.nodes[0].history[0].cost_usd, 0.4);
  assert.equal(history.nodes[0].history[0].variants[0].items[0].text, 'pai…');
  const mediaHistory = await ok(reader.secret, 'get_workflow_results', { workflow_id: runInfo.workflow_id, node_id: 'n4' });
  const mediaItem = mediaHistory.nodes[0].history[0].variants[0].items[0];
  assert.ok(mediaItem.asset_id);
  assert.equal((await fetch(`${base}${pathOf(mediaItem.url)}`)).status, 200);
  const totalCosts = await ok(reader.secret, 'get_workflow_costs', { workflow_id: partial.id });
  assert.equal(totalCosts.total_usd, 1.2);
  assert.equal(totalCosts.count, 3);
  assert.equal(totalCosts.by_type[0].type, 'brain');
  assert.equal(totalCosts.by_model[0].model, 'double');
  assert.ok(totalCosts.first_at && totalCosts.last_at);

  const entryToDelete = history.nodes[0].history[0].entry_id;
  const deleteArgs = { workflow_id: partial.id, node_id: 'b', entry_id: entryToDelete };
  await refused(starter.secret, 'delete_result_entry', deleteArgs, /Nothing was deleted.*person/);
  assert.ok((await wfStore.readResults(partial.id)).nodes.b.history.some((entry) => entry.id === entryToDelete));
  await refused(reader.secret, 'delete_result_entry', { ...deleteArgs, confirm: true }, /may only read/);
  openGate();
  const activePartial = await ok(starter.secret, 'run_workflow', { ...nodeArgs, max_usd: 0.5, force: true });
  await refused(starter.secret, 'delete_result_entry', { ...deleteArgs, confirm: true }, /already active/);
  gate.current.release();
  await finish(starter.secret, activePartial.run_id);
  gate.current = null;
  const deletedEntry = await ok(starter.secret, 'delete_result_entry', { ...deleteArgs, confirm: true });
  assert.deepEqual(deletedEntry.removed, [entryToDelete]);
  assert.ok(!(await wfStore.readResults(partial.id)).nodes.b.history.some((entry) => entry.id === entryToDelete));
  await refused(starter.secret, 'delete_result_entry', { ...deleteArgs, confirm: true }, /entry was not found/);

  const copyKey = makeKey({ name: 'Copies', right: 'start' });
  secrets.push(copyKey.secret);
  const copied = await ok(copyKey.secret, 'duplicate_workflow', { workflow_id: sharedWithAll.id, name: 'My own copy' });
  const copyStored = await wfStore.readWorkflow(copied.workflow_id);
  assert.equal(copyStored.owner, STAFF1);
  assert.equal(copied.name, 'My own copy');
  assert.equal(copied.rev, 1);
  assert.notEqual(copyStored.sessionId, sharedWithAll.sessionId);
  assert.equal(copied.url, urlOf(copied.workflow_id));
  assert.deepEqual((await wfStore.readResults(copied.workflow_id)).nodes, {});
  for (let i = 1; i < 30; i += 1) mcp.accounting.noteWorkflowCreated(copyKey.id);
  const copiesBefore = (await wfStore.listWorkflows()).length;
  await refused(copyKey.secret, 'duplicate_workflow', { workflow_id: partial.id }, /30 workflows/);
  await refused(copyKey.secret, 'create_workflow', {}, /30 workflows/);
  assert.equal((await wfStore.listWorkflows()).length, copiesBefore);
  await refused(reader.secret, 'duplicate_workflow', { workflow_id: partial.id }, /may only read/);

  // The first paid step books more than its estimate; the next step must wait for a higher total approval.
  const viaSeen = [];
  registry.register({ type: 't.overrun', category: 'text', paid: true, cost: { unit: 'usd', estimate: () => ({ usd: 0.25 }) },
    inputs: [{ id: 'in', type: 'text' }], outputs: [{ id: 'out', type: 'text' }], execute: async (ctx) => {
      viaSeen.push({ ...costs.currentVia() });
      if (ctx.nodeId === 'second') await waitGate(ctx.signal);
      const amount = ctx.nodeId === 'first' ? 0.8 : 0.25;
      await costs.recordCost({ ts: new Date().toISOString(), sessionId: ctx.sessionId, type: 'brain', model: 'overrun', cost: amount, user: ctx.user });
      return { variants: [{ out: textValue('price changed') }], cost: { usd: amount } };
    } });
  const approvalGraph = () => ({ nodes: [node('first', 't.overrun'), node('second', 't.overrun')], edges: [edge('sequence', 'first', 'out', 'second', 'in')] });
  const resumeKey = makeKey({ name: 'Approval', right: 'start', maxRunUsd: 1.5, maxMonthUsd: 2 });
  secrets.push(resumeKey.secret);
  const approvalFlow = await mk(STAFF1, 'Approval', approvalGraph());
  const pausedRun = await ok(resumeKey.secret, 'run_workflow', { workflow_id: approvalFlow.id, max_usd: 0.5 });
  const approvalRun = await waitFor(async () => {
    const value = await ok(resumeKey.secret, 'get_run', { run_id: pausedRun.run_id });
    assert.equal(value.finished, false, JSON.stringify(value));
    return value.status === 'awaiting_approval' && value.approval ? value : null;
  }, 'approval');
  assert.equal(approvalRun.approval.node, 'second');
  assert.equal(approvalRun.approval.required_usd, 1.05);
  assert.equal(approvalRun.approval.estimated_usd, 0.25);
  assert.equal(approvalRun.approval.max_usd, 0.5);
  assert.ok(approvalRun.approval.label);
  assert.match(approvalRun.next, /person.*resume_run/);
  await refused(resumeKey.secret, 'resume_run', { run_id: pausedRun.run_id, max_usd: 1 }, /at least \$1\.05/);
  await refused(resumeKey.secret, 'resume_run', { run_id: pausedRun.run_id, max_usd: 1.6 }, /per run/);
  await refused(starter.secret, 'resume_run', { run_id: pausedRun.run_id, max_usd: 1.1 }, /not started with this key/);
  await refused(reader.secret, 'resume_run', { run_id: pausedRun.run_id, max_usd: 1.1 }, /may only read/);
  assert.equal((await ok(resumeKey.secret, 'get_run', { run_id: pausedRun.run_id })).status, 'awaiting_approval');
  assert.equal((await mcp.accounting.monthUsage(resumeKey.id)).reservedUsd, 0.5);
  // 0.8 booked + 1.3 ceiling would exceed 2.0, while 0.8 + 1.1 fits when the old 0.5 hold is replaced.
  await refused(resumeKey.secret, 'resume_run', { run_id: pausedRun.run_id, max_usd: 1.3 }, /per month/);
  openGate();
  const resumedRun = await ok(resumeKey.secret, 'resume_run', { run_id: pausedRun.run_id, max_usd: 1.1 });
  assert.equal(resumedRun.status, 'running');
  await waitFor(() => viaSeen.length === 2, 'the resumed step');
  assert.equal(viaSeen[1].reservationId, viaSeen[0].reservationId);
  assert.equal(viaSeen[0].reservationUsd, 0.5);
  assert.equal(viaSeen[1].reservationUsd, 1.1, 'future provider jobs inherit the raised reservation from the original async context');
  assert.equal((await mcp.accounting.monthUsage(resumeKey.id)).reservedUsd, 1.1);
  await refused(resumeKey.secret, 'run_workflow', { workflow_id: (await fresh()).id, max_usd: 0.5 }, /per month/);
  await refused(resumeKey.secret, 'resume_run', { run_id: pausedRun.run_id, max_usd: 1.1 }, /not waiting for approval/);
  gate.current.release();
  assert.equal((await finish(resumeKey.secret, pausedRun.run_id)).status, 'completed');
  gate.current = null;
  await waitFor(async () => (await mcp.accounting.monthUsage(resumeKey.id)).reservedUsd === 0, 'resumed reservation released');
  assert.equal((await mcp.accounting.monthUsage(resumeKey.id)).spentUsd, 1.05);

  // The conservative boundary: persisted jobs with the old hold cannot safely be rewritten by this key queue.
  const fakeJobs = [{ keyId: resumeKey.id, mcpReservationId: 'persisted', mcpReservedUsd: 0.5 }];
  const conservative = iso.load('lib/mcp/accounting').createAccounting({ budget: { spentByKey: async () => 0 }, loadJobs: async () => fakeJobs });
  const originalVia = { reservationUsd: 0.5 };
  conservative.begin(resumeKey.id, 'waiting', 0.5, 'persisted', originalVia);
  await conservative.monthUsage(resumeKey.id);
  assert.equal(conservative.reservationFor('waiting').canRaise, false);
  assert.throws(() => conservative.raiseReservation('waiting', 1.1), /safely/);
  assert.equal(originalVia.reservationUsd, 0.5);
  assert.equal(conservative.reservedUsd(resumeKey.id), 0.5);

  for (const [name, args] of [
    ['get_workflow_results', {}], ['get_workflow_costs', {}], ['duplicate_workflow', {}],
    ['delete_result_entry', { node_id: 'b', entry_id: 'entry', confirm: true }]
  ]) await refused(starter.secret, name, { workflow_id: foreignPrivate.id, ...args }, /Not found/);
  const foreignRun = await baseService.start(runServiceLib.viewerForUser(STAFF2), foreignPrivate.id, { maxUsd: 0 });
  await baseService.waitForRun(runServiceLib.viewerForUser(STAFF2), foreignRun.runId);
  await refused(starter.secret, 'resume_run', { run_id: foreignRun.runId, max_usd: 1 }, /Not found/);

  // no key shows up in any answer
  const output = everything.join('\n');
  for (const secret of secrets) {
    assert.ok(!output.includes(secret) && !output.includes(secret.slice(7)), 'a key shows up in an answer');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
