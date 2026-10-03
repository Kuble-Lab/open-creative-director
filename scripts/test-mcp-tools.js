'use strict';

// The tools of the agent access (WP27, part 3: lib/mcp/workflow-tools.js) with a JSON-RPC client over real HTTP against an
// isolated copy of the app (temp data folders, ephemeral port). The nodes are doubles in a private registry (no provider is
// contacted, nothing is paid); a fetch guard refuses everything except localhost.
//
//   R  rights: a read key sees and can use only the five reading tools, a start key all nine; visibility is the person's
//   L  limits of run_workflow: max_usd, limit per run, month (booked + reserved), unknown cost, Higgsfield, two runs at a
//      time (also when asked at once), the budget error of the service as a sentence
//   U  upload_asset: base64 up to 15 MB, one-time link (once, expired, too large, wrong type, revoked key), SVG becomes a PNG
//   F  result links: valid, expired, another file, changed token, no login needed
//   J  cost journal: runs of a key book on the person with keyId and keyName (never the key), month usage per key
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
  console.log('MCP-Werkzeuge: Rechte, Limits (Lauf, Monat, unbekannte Kosten, Higgsfield, zwei Läufe), Upload, Ergebnis-Links und Kostenjournal sind korrekt.');
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

  const readNames = ['estimate_run', 'get_run', 'get_workflow', 'list_templates', 'list_workflows'];
  const startNames = ['cancel_run', 'create_from_template', 'run_workflow', 'upload_asset'];
  const readList = (await rpc(reader.secret, 'tools/list')).json.result.tools;
  assert.deepEqual(readList.map((item) => item.name), readNames, 'a read key lists the reading tools only');
  assert.ok(readList.every((item) => item.annotations.readOnlyHint === true));
  const startList = (await rpc(starter.secret, 'tools/list')).json.result.tools;
  assert.deepEqual(startList.map((item) => item.name), [...readNames, ...startNames].sort(), 'a start key lists all nine');
  for (const item of startList) {
    assert.equal(item.inputSchema.type, 'object');
    assert.ok(item.description.length > 40, `${item.name} describes itself`);
  }
  assert.equal(startList.find((item) => item.name === 'run_workflow').inputSchema.required.includes('max_usd'), true);
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
  await refused(starter.secret, 'create_from_template', { template_id: 'paid-image' }, /Missing|missing/);
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
