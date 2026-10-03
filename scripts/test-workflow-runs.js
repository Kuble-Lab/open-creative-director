'use strict';

// Workflow runs of the Director (WP26, parts 2 and 3: lib/workflow-runs.js, the tools list_workflows and run_workflow, the
// card of the chat). A private copy of the app runs in a temp directory (own data folders, ephemeral port, whoami stub). The
// Director model is a scripted double, the nodes are doubles in a private registry (no provider is contacted, nothing is
// paid), and a fetch guard refuses everything except localhost.
//
//   A  the tools are offered (also to participants), the descriptions and the tool list of the prompt tell the rules
//   B  list_workflows: templates, own, shared, foreign; no amounts; the filter for participants
//   C  a run without paid steps starts at once (no card to click), the result comes into the chat, no further Director turn
//   D  a paid run: card, halt, nothing started; one click starts exactly one run; progress; the result with the effective
//      cost in the chat; the Director reads it in the history
//   E  the price or the workflow changed since the card: refused, new estimate on the card, the next click starts
//   F  cancel (a waiting card, a running run), rights, a second click after cancel
//   G  at most 20 waiting cards per chat, nothing is created for the 21st
//   H  participants: budget line, Higgsfield refused, the click is refused over the budget, reservation by the plan
//   I  a run that finished while nobody watched is taken into the chat once (restart, parallel readers)
//   J  3D models stay in the node editor, a failed run, invalid inputs create nothing, an existing workflow
//   K  the client: wording in DE/EN/ES, no innerHTML for data, endpoints
//   L  review fixes: credits are never "free", the click carries what the card showed (a stale card is refused), inputs of
//      an existing workflow, a refused direct start leaves no workflow, a start whose write failed is not started twice,
//      thumbnails at their address in the chat, the cost of a file is that of its own step

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { createIsolatedApp } = require('./support/isolated-app');
const { cubeGlb } = require('./support/glb');

const ADMIN = 'admin@example.com';
const STAFF1 = 'one@staff.example.com';
const STAFF2 = 'two@staff.example.com';
const P1 = 'p1@gmail.example';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const SEEDANCE = 'bytedance/seedance-2.5';

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

// The scripted Director: each call of chatStream takes the next round (text and tool calls) and records the request.
function scriptedDirector(or) {
  const rounds = [];
  const requests = [];
  or.chatStream = async (payload) => {
    requests.push(payload);
    const round = rounds.shift() || { text: 'Okay.' };
    const lines = [];
    if (round.text) lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: round.text } }] })}`, '');
    (round.tools || []).forEach((call, index) => {
      lines.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: `call-${requests.length}-${index}`, function: { name: call.name, arguments: JSON.stringify(call.args || {}) } }] } }] })}`, '');
    });
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: round.tools ? 'tool_calls' : 'stop' }] })}`, '', 'data: [DONE]', '');
    return new Response(lines.join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { rounds, requests, say: (round) => rounds.push(round) };
}

function parseEvents(text) {
  return text.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5).trim()));
}

const node = (id, type, params = {}, x = 0, y = 0) => ({ id, type, typeVersion: 1, x, y, params });
const edge = (id, from, fromPort, to, toPort) => ({ id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
const enc = encodeURIComponent;

async function main() {
  const guard = guardFetch();
  const iso = await createIsolatedApp({
    env: {
      ADMIN_EMAILS: ADMIN,
      SUPERADMIN_EMAILS: '',
      INTERNAL_EMAIL_DOMAINS: 'staff.example.com',
      OPENROUTER_API_KEY: 'sk-or-v1-test-key-with-enough-length',
      PUBLIC_BASE_URL: '',
      ACCESS_ALLOWLIST_FILE: '',
      ACCESS_ALLOWLIST_ROUTE: '',
      ELEVENLABS_API_KEY: '',
      FAL_KEY: '',
      GTS_API_TOKEN: ''
    }
  });
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  try {
    await run(iso);
  } finally {
    await iso.cleanup();
    guard.restore();
  }
  assert.deepEqual(guard.attempts, [], 'no request left the machine');
  console.log('Workflow-Läufe im Chat: Werkzeuge, Liste, kostenloser Direktstart, Karte mit Klick (ein Lauf pro Klick), Preis- und Versionswechsel, Abbruch, Grenze, Budget, verpasstes Ende, 3D, Fehler, Eingaben und Oberfläche sind korrekt.');
  console.log('test-workflow-runs.js: ok');
}

async function run(iso) {
  const api = iso.request;
  const access = iso.load('lib/access');
  const store = iso.load('lib/store');
  const or = iso.load('lib/openrouter');
  const discovery = iso.load('lib/discovery');
  const tools = iso.load('lib/tools');
  const budgetLib = iso.load('lib/budget');
  const costsLib = iso.load('lib/costs');
  const workflowRuns = iso.load('lib/workflow-runs');
  const runServiceLib = iso.load('lib/nodes/run-service');
  const types = iso.load('lib/nodes/types');
  const nodesBasic = iso.load('lib/nodes/nodes-basic');
  const jobs = iso.load('lib/nodes/jobs');
  const assetsLib = iso.load('lib/nodes/assets');
  const templatesLib = iso.load('lib/nodes/templates');
  const { createRegistry } = iso.load('lib/nodes/registry');
  const { createEventBus } = iso.load('lib/nodes/events');
  const { createWorkflowsStore } = iso.load('lib/nodes/workflows-store');
  const { createEngine } = iso.load('lib/nodes/engine');
  const { textValue } = types;

  discovery.brainSupportsImages = async () => true;
  or.listVideoModels = async () => ({
    data: [{ id: SEEDANCE, name: 'ByteDance: Seedance 2.5', pricing_skus: { video_tokens: '0.0000107' }, supported_resolutions: ['480p', '720p'], supported_aspect_ratios: ['16:9'], supported_durations: [4, 5, 6], supported_frame_images: ['first_frame'] }]
  });
  const director = scriptedDirector(or);

  /* ---------- doubles: nodes without a provider ---------- */

  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  const gate = { current: null, started: 0 };
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
  const calls = { paid: 0, hf: 0 };
  const price = { current: 0.5 };
  registry.register({
    type: 't.upper',
    category: 'text',
    inputs: [{ id: 'in', type: 'text', required: true }],
    outputs: [{ id: 'out', type: 'text' }],
    execute: async (_ctx, inputs) => ({ variants: [{ out: textValue(String(inputs.in.value).toUpperCase()) }] })
  });
  registry.register({
    type: 't.paid',
    category: 'text',
    paid: true,
    cost: { unit: 'usd', estimate: () => ({ usd: price.current }) },
    inputs: [{ id: 'in', type: 'text' }],
    outputs: [{ id: 'out', type: 'text' }],
    execute: async (ctx, inputs) => {
      calls.paid += 1;
      gate.started += 1;
      await waitGate(ctx.signal);
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
    execute: async (ctx, inputs) => {
      calls.paid += 1;
      await waitGate(ctx.signal);
      return { variants: [{ out: textValue(`unknown:${inputs.in ? inputs.in.value : ''}`) }], cost: { usd: 0.1 } };
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
    cost: { unit: 'usd', estimate: () => ({ usd: price.current }) },
    inputs: [{ id: 'image', type: 'image', required: true }, { id: 'prompt', type: 'text' }],
    outputs: [{ id: 'image', type: 'image' }],
    execute: async (ctx, inputs) => {
      calls.paid += 1;
      gate.started += 1;
      await waitGate(ctx.signal);
      // a paid step makes a new file (it does not hand the input on)
      const made = await store.saveAsset(ctx.sessionId, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'made by a paid step' });
      const entries = await store.readLedger(ctx.sessionId);
      return { variants: [{ image: assetsLib.valueFromLedgerEntry(ctx.sessionId, entries.find((item) => item.id === made.id)) }], cost: { usd: 0.4 } };
    }
  });
  // a paid step that makes two files for one price, and a cheap one that makes one (the cost of a file is its own step's)
  registry.register({
    type: 't.twoimg',
    category: 'image',
    paid: true,
    cost: { unit: 'usd', estimate: () => ({ usd: 0.04 }) },
    inputs: [],
    outputs: [{ id: 'a', type: 'image' }, { id: 'b', type: 'image' }],
    execute: async (ctx) => {
      const one = await store.saveAsset(ctx.sessionId, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'two a' });
      const two = await store.saveAsset(ctx.sessionId, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'two b' });
      const entries = await store.readLedger(ctx.sessionId);
      const value = (id) => assetsLib.valueFromLedgerEntry(ctx.sessionId, entries.find((item) => item.id === id));
      return { variants: [{ a: value(one.id), b: value(two.id) }], cost: { usd: 0.04 } };
    }
  });
  // a free node that makes a 3D model and its preview image in the session of the workflow
  registry.register({
    type: 't.mesh',
    category: 'image',
    inputs: [],
    outputs: [{ id: 'model', type: 'model3d' }, { id: 'preview', type: 'image' }],
    execute: async (ctx) => {
      const glb = await store.saveAsset(ctx.sessionId, { kind: 'model3d', buffer: cubeGlb(), ext: '.glb', prompt: 'cube' });
      const png = await store.saveAsset(ctx.sessionId, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'cube preview' });
      const entries = await store.readLedger(ctx.sessionId);
      return {
        variants: [{
          model: assetsLib.valueFromLedgerEntry(ctx.sessionId, entries.find((item) => item.id === glb.id)),
          preview: assetsLib.valueFromLedgerEntry(ctx.sessionId, entries.find((item) => item.id === png.id))
        }]
      };
    }
  });
  registry.register({
    type: 't.boom',
    category: 'text',
    inputs: [{ id: 'in', type: 'text' }],
    outputs: [{ id: 'out', type: 'text' }],
    execute: async () => {
      throw new Error('the model said no');
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
    i18n: { de: { name: 'Freier Text', 'app.input.n1.prompt': 'Idee' } }
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
  await writeTemplate('paid-text', {
    name: 'Paid text',
    graph: {
      nodes: [node('n1', 'input.prompt', { prompt: '' }, 0, 0), node('n2', 't.paid', {}, 200, 0), node('n3', 'output.result', { label: 'Answer' }, 400, 0)],
      edges: [edge('e1', 'n1', 'prompt', 'n2', 'in'), edge('e2', 'n2', 'out', 'n3', 'inputs')]
    },
    app: { enabled: true, inputs: [{ node: 'n1', param: 'prompt', label: 'Question' }], outputs: [{ node: 'n3', label: 'Answer' }] }
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
  await writeTemplate('mesh-flow', {
    name: 'Mesh flow',
    graph: {
      nodes: [node('n1', 't.mesh', {}, 0, 0), node('n2', 'output.result', { label: 'Model' }, 300, 0)],
      edges: [edge('e1', 'n1', 'model', 'n2', 'inputs'), edge('e2', 'n1', 'preview', 'n2', 'inputs')]
    },
    app: { enabled: true, inputs: [], outputs: [{ node: 'n2', label: 'Model' }] }
  });
  await writeTemplate('boom-flow', {
    name: 'Boom flow',
    graph: {
      nodes: [node('n1', 'input.prompt', { prompt: 'x' }), node('n2', 't.boom', {}, 200, 0), node('n3', 'output.result', {}, 400, 0)],
      edges: [edge('e1', 'n1', 'prompt', 'n2', 'in'), edge('e2', 'n2', 'out', 'n3', 'inputs')]
    },
    app: { enabled: true, inputs: [{ node: 'n1', param: 'prompt', label: 'Text' }], outputs: [{ node: 'n3', label: 'Answer' }] }
  });
  await writeTemplate('mixed-cost', {
    name: 'Mixed cost',
    graph: {
      nodes: [
        node('n1', 'input.prompt', { prompt: 'story' }, 0, 0),
        node('n2', 't.paid', {}, 200, 0),
        node('n3', 't.twoimg', {}, 200, 150),
        node('n4', 'output.result', { label: 'Board' }, 400, 0)
      ],
      edges: [edge('e1', 'n1', 'prompt', 'n2', 'in'), edge('e2', 'n2', 'out', 'n4', 'inputs'), edge('e3', 'n3', 'a', 'n4', 'inputs'), edge('e4', 'n3', 'b', 'n4', 'inputs')]
    },
    app: { enabled: true, inputs: [{ node: 'n1', param: 'prompt', label: 'Story' }], outputs: [{ node: 'n4', label: 'Board' }] }
  });
  const templateDeps = {
    list: (options) => templatesLib.listTemplates({ ...options, dir: templateDir, checks: {} }),
    resolve: (id, options) => templatesLib.resolveTemplate(id, { ...options, dir: templateDir })
  };
  const service = runServiceLib.createRunService({ engine, store: wfStore, registry, templates: templateDeps });
  runServiceLib.installRunService(service);

  const team = (await api('/api/teams', { method: 'POST', as: ADMIN, json: { name: 'Kurs', budgetUsd: 1 } })).body.team;
  assert.equal((await api(`/api/teams/${team.id}/members`, { method: 'POST', as: ADMIN, json: { emails: [P1] } })).status, 201);

  const newChat = async (email) => (await api('/api/sessions', { method: 'POST', as: email, json: {} })).body.session;
  const detail = async (id, email) => (await api(`/api/sessions/${id}`, { as: email })).body;
  const runCard = async (id, email, index = -1) => (await detail(id, email)).session.messages.filter((m) => m.workflowRun).at(index)?.workflowRun;
  const send = async (id, email, text) => {
    const response = await api(`/api/sessions/${id}/message`, { method: 'POST', as: email, json: { text, brainModel: 'brain-test' } });
    return { status: response.status, events: response.status === 200 ? parseEvents(response.text) : [], body: response.body };
  };
  // The click of the client: it says what the card showed (by default what the request has stored, i.e. an up-to-date card).
  const click = async (id, requestId, email, seen) => {
    let body = seen;
    if (body === undefined) {
      body = {};
      try {
        const stored = (await store.readSession(id)).workflowRunRequests.find((item) => item.id === requestId);
        if (stored && stored.plan.paid) body = { maxUsd: stored.plan.totals.usd, maxCredits: stored.plan.totals.credits, maxUnknownNodes: stored.plan.totals.unknownNodes, rev: stored.rev };
      } catch (_) {
        body = {};
      }
    }
    return api(`/api/sessions/${id}/workflow-runs/${requestId}`, { method: 'POST', as: email, json: body });
  };
  const cancel = (id, requestId, email) => api(`/api/sessions/${id}/workflow-runs/${requestId}/cancel`, { method: 'POST', as: email, json: {} });
  const poll = (id, requestId, email) => api(`/api/sessions/${id}/workflow-runs/${requestId}`, { as: email });
  const requestOf = async (id, requestId) => (await store.readSession(id)).workflowRunRequests.find((item) => item.id === requestId);
  const config = { imageModel: 'test/image', videoModel: SEEDANCE };
  const call = (sessionId, email, name, args, extra = {}) => {
    const events = [];
    return tools.executeTool({ sessionId, config, emit: (event) => events.push(event), user: email, pickVideoModel: true, ...extra }, name, args)
      .then((outcome) => Object.assign(outcome, { events }));
  };
  // The tool message of a card made by a direct call (a Director turn stores it itself).
  const attach = (id, requestId) => store.mutateSession(id, (s) => {
    s.messages.push({ role: 'tool', tool_call_id: `c-${requestId}`, name: 'run_workflow', content: 'x', workflowRunId: requestId, ts: new Date().toISOString() });
  });
  const workflowCount = async () => (await wfStore.listWorkflows()).length;
  const completed = (id, requestId) => waitFor(async () => {
    const request = await requestOf(id, requestId);
    return request && ['completed', 'failed', 'cancelled'].includes(request.status) ? request : null;
  }, `the run of ${requestId} to end`);
  const toolMessageOf = async (id, requestId) => (await store.readSession(id)).messages.find((m) => m.workflowRunId === requestId);
  const markerOf = async (id, requestId) => (await store.readSession(id)).messages.find((m) => m.workflowRunRequestId === requestId);

  /* ============ A: the tools are offered ============ */

  const names = (viewer) => tools.toolDefinitions(viewer).map((definition) => definition.function.name);
  for (const viewer of [null, access.viewerOf({ kubleUser: STAFF1 }), access.viewerOf({ kubleUser: P1 })]) {
    assert.ok(names(viewer).includes('list_workflows') && names(viewer).includes('run_workflow'), 'offered to everybody, participants included');
  }
  const definition = (name) => tools.toolDefinitions().find((item) => item.function.name === name).function;
  assert.match(definition('run_workflow').description, /waits for the user's click on the card and ends your turn/);
  assert.match(definition('run_workflow').description, /do not ask in text whether to start/);
  assert.match(definition('run_workflow').description, /never name amounts/);
  assert.match(definition('run_workflow').description, /Media come from THIS chat/);
  assert.match(definition('list_workflows').description, /Never name prices/);
  assert.deepEqual(Object.keys(definition('run_workflow').parameters.properties).sort(), ['inputs', 'language', 'name', 'template_id', 'workflow_id']);
  assert.equal(definition('run_workflow').parameters.required, undefined, 'either template_id or workflow_id: checked by the tool');
  const hello = await newChat(STAFF1);
  director.say({ text: 'Hallo.' });
  await send(hello.id, STAFF1, 'Hallo');
  assert.ok(director.requests.at(-1).tools.some((item) => item.function.name === 'run_workflow'), 'the model gets the tool');
  const prompt = director.requests.at(-1).messages[0].content;
  assert.match(prompt, /`list_workflows` \/ `run_workflow` - list the workflow templates/);
  assert.match(prompt, /a run with paid steps starts only after the user's click and ends your turn/);
  assert.ok(!/SystemPrompt/.test(prompt), 'the base prompt file is untouched');
  assert.equal((await store.readSession(hello.id)).workflowRunRequests, undefined, 'a chat without a run has no requests');

  /* ============ B: list_workflows ============ */

  const mk = async (owner, name, graph, { app, share, teamId } = {}) => {
    const created = await wfStore.createWorkflow({ name, graph, app, owner, teamId: teamId || null, user: owner || 'lokal' });
    if (share) await wfStore.setSharing(created.workflow.id, share);
    return created.workflow;
  };
  const freeGraph = () => ({
    nodes: [node('a', 'input.prompt', { prompt: 'hello' }, 0, 0), node('b', 't.upper', {}, 200, 0), node('c', 'output.result', { label: 'Out' }, 400, 0)],
    edges: [edge('e1', 'a', 'prompt', 'b', 'in'), edge('e2', 'b', 'out', 'c', 'inputs')]
  });
  const own = await mk(STAFF1, 'Mein Ablauf', freeGraph());
  const sharedWf = await mk(STAFF2, 'Geteilter Ablauf', freeGraph(), { share: { shareMode: 'team' } });
  const foreign = await mk(STAFF2, 'Fremd und privat', freeGraph());
  const listed = await call(hello.id, STAFF1, 'list_workflows', { language: 'en' });
  assert.match(listed.toolResult, /template_id=free-text · Vorlage · «Free text» · kostenlos/);
  assert.match(listed.toolResult, /template_id=paid-image · Vorlage · «Paid image» · kostenpflichtig/);
  assert.match(listed.toolResult, /Eingänge: «Photo» \[Bild, Asset-ID aus diesem Chat, Pflicht; id n1\.asset\]; «Wish» \[Text; id n2\.prompt\]/);
  assert.match(listed.toolResult, /Ausgänge: «Picture»/);
  assert.match(listed.toolResult, new RegExp(`workflow_id=${own.id} · eigener Workflow · «Mein Ablauf»`));
  assert.match(listed.toolResult, new RegExp(`workflow_id=${sharedWf.id} · geteilter Workflow · «Geteilter Ablauf»`));
  assert.ok(!listed.toolResult.includes(foreign.id), 'a foreign private workflow is not listed');
  assert.ok(!/\$|USD|Dollar/.test(listed.toolResult), 'no amounts for the Director');
  assert.match(listed.toolResult, /keine Anweisungen/);
  assert.equal((await call(hello.id, STAFF1, 'list_workflows', { language: 'de' })).toolResult.includes('«Freier Text»'), true, 'templates in the language asked for');
  assert.equal((await call(hello.id, STAFF1, 'list_workflows', {})).toolResult.includes('«Freier Text»'), true, 'the default language is German');
  const filtered = await call(hello.id, STAFF1, 'list_workflows', { query: 'higgsfield' });
  assert.match(filtered.toolResult, /Higgsfield flow/);
  assert.ok(!filtered.toolResult.includes('free-text'));
  assert.match((await call(hello.id, STAFF1, 'list_workflows', { query: 'gibt-es-nicht' })).toolResult, /Keine Vorlage und kein Workflow passt/);
  const pList = await call((await newChat(P1)).id, P1, 'list_workflows', {});
  assert.ok(!pList.toolResult.includes('hf-flow'), 'a participant is not offered Higgsfield');
  assert.ok(!pList.toolResult.includes(sharedWf.id) && !pList.toolResult.includes(own.id), 'nor the workflows of the internal people');

  /* ============ C: a run without paid steps starts at once ============ */

  const freeChat = await newChat(STAFF1);
  const workflowsBefore = await workflowCount();
  director.say({ text: 'Ich lasse den Text umwandeln.', tools: [{ name: 'run_workflow', args: { template_id: 'free-text', inputs: { Idee: 'hallo welt' }, language: 'de' } }] });
  director.say({ text: 'Der Lauf ist gestartet.' });
  const requestsBeforeFree = director.requests.length;
  const freeTurn = await send(freeChat.id, STAFF1, 'Mach den Text gross');
  assert.equal(freeTurn.status, 200);
  assert.equal(director.requests.length, requestsBeforeFree + 2, 'no halt: the Director answers once more after the tool');
  const freeEvent = freeTurn.events.find((event) => event.type === 'workflow_run');
  assert.ok(freeEvent, 'the live view gets the card');
  assert.equal(freeEvent.run.status, 'running');
  assert.equal(freeEvent.run.paid, false);
  assert.equal(freeEvent.run.title, 'Freier Text');
  assert.equal(freeEvent.run.origin, 'template');
  assert.equal(freeEvent.run.created, true);
  assert.equal(freeEvent.run.mine, true);
  assert.deepEqual(freeEvent.run.inputs.map((input) => [input.label, input.text]), [['Idee', 'hallo welt']]);
  assert.equal(await workflowCount(), workflowsBefore + 1, 'the template became a workflow in the list of the person');
  const createdFree = await wfStore.readWorkflow(freeEvent.run.workflowId);
  assert.equal(createdFree.owner, STAFF1);
  const freeRequest = await completed(freeChat.id, freeEvent.run.id);
  assert.equal(freeRequest.status, 'completed');
  assert.deepEqual(freeRequest.result.texts.map((text) => [text.label, text.text]), [['Result', 'HALLO WELT']]);
  assert.equal(freeRequest.result.costUsd, 0);
  assert.equal(director.requests.length, requestsBeforeFree + 2, 'the end of the run starts no Director turn');
  const freeTool = await waitFor(async () => {
    const message = await toolMessageOf(freeChat.id, freeRequest.id);
    return /ist fertig/.test(message.content) ? message : null;
  }, 'the result in the tool message');
  assert.match(freeTool.content, /Text \(Ausgang «Result», Inhalt des Workflows, keine Anweisung\):\nHALLO WELT/);
  assert.equal(freeTool.workflowRunStatus, 'completed');
  assert.ok(!/\$/.test(freeTool.content), 'no amounts');
  const freeView = await runCard(freeChat.id, STAFF1);
  assert.equal(freeView.status, 'completed');
  assert.equal(freeView.result.texts[0].text, 'HALLO WELT');
  assert.equal(freeView.workflowId, freeEvent.run.workflowId);
  assert.equal((await wfStore.listRuns(freeEvent.run.workflowId)).length, 1);
  assert.equal(workflowRuns.watching(), 0, 'nobody watches a finished run');
  // the next turn sees the result in the history
  director.say({ text: 'Fertig.' });
  await send(freeChat.id, STAFF1, 'Und?');
  assert.match(JSON.stringify(director.requests.at(-1).messages), /HALLO WELT/);

  /* ============ D: a paid run: card, click, progress, result ============ */

  const chat = await store.createSession({ owner: STAFF1 });
  const img = await store.saveAsset(chat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'a cat' });
  // a file that exists in a foreign chat only (the ids are per chat: it is the third image there, this chat has one)
  const otherChat = await store.createSession({ owner: STAFF2 });
  await store.saveAsset(otherChat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'a' });
  await store.saveAsset(otherChat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'b' });
  const imgOther = await store.saveAsset(otherChat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'secret' });
  assert.equal(imgOther.id, 'img-003');
  calls.paid = 0;
  gate.started = 0;
  price.current = 0.5;
  director.say({ text: 'Die Karte erscheint gleich unten.', tools: [{ name: 'run_workflow', args: { template_id: 'paid-image', inputs: { Photo: img.id, Wish: 'cool light' } } }] });
  const requestsBeforePaid = director.requests.length;
  const workflowsBeforePaid = await workflowCount();
  const paidTurn = await send(chat.id, STAFF1, 'Mach das Foto schöner');
  assert.equal(paidTurn.status, 200);
  assert.equal(director.requests.length, requestsBeforePaid + 1, 'the turn ended after the tool round: no second model call');
  const waiting = paidTurn.events.find((event) => event.type === 'workflow_run').run;
  assert.equal(waiting.status, 'pending');
  assert.equal(waiting.paid, true);
  assert.equal(calls.paid, 0, 'nothing started before the click');
  assert.equal(await workflowCount(), workflowsBeforePaid + 1);
  assert.deepEqual(await wfStore.listRuns(waiting.workflowId), [], 'no run before the click');
  assert.deepEqual(waiting.paidSteps, [{ label: 't.imgpaid', usd: 0.5, credits: null }]);
  assert.equal(waiting.localSteps, 3);
  assert.deepEqual(waiting.totals, { usd: 0.5, usdKnown: true, credits: 0, unknownNodes: 0, paidNodes: 1 });
  assert.deepEqual(waiting.inputs.map((input) => [input.label, input.type, input.text || input.media?.length]), [['Photo', 'image', 1], ['Wish', 'text', 'cool light']]);
  assert.ok(waiting.inputs[0].media[0].url.startsWith(`/assets/${chat.id}/`), 'the thumbnail is at its address in the chat');
  assert.ok(!JSON.stringify(waiting.inputs).includes((await wfStore.readWorkflow(waiting.workflowId)).sessionId), 'the id of the session behind the workflow is not on the card');
  assert.equal(waiting.budget, null, 'no budget line for an internal person');
  assert.equal(waiting.blocked, null);
  const saved = await store.readSession(chat.id);
  const pendingTool = saved.messages.find((m) => m.role === 'tool' && m.name === 'run_workflow');
  assert.equal(pendingTool.workflowRunId, waiting.id);
  assert.match(pendingTool.content, /wartet auf den User\. Es wurde noch nichts gestartet und nichts berechnet/);
  assert.match(pendingTool.content, /Rufe run_workflow nicht erneut auf, solange die Karte wartet, frage nicht zusätzlich im Text nach und nenne keine Beträge/);
  assert.ok(!/\$|0\.5/.test(pendingTool.content), 'the Director is told no amounts');
  assert.match((await markerOf(chat.id, waiting.id)).content, /^\[System\] Warte auf den Start des Workflow-Laufs/);
  assert.equal((await markerOf(chat.id, waiting.id)).hidden, true);
  // the card survives a reload and shows the same
  let view = await runCard(chat.id, STAFF1);
  assert.equal(view.id, waiting.id);
  assert.equal(view.status, 'pending');
  assert.equal(view.workflowId, waiting.workflowId);
  // the Director sees the waiting state in the next turn
  director.say({ text: 'Ich warte auf deinen Klick.' });
  await send(chat.id, STAFF1, 'Und?');
  assert.match(JSON.stringify(director.requests.at(-1).messages), /Warte auf den Start des Workflow-Laufs/);
  // rights and validation
  assert.equal((await click(chat.id, waiting.id, STAFF2)).status, 404, 'a foreign chat answers 404');
  assert.equal((await click(chat.id, waiting.id, null)).status, 401, 'an unconfirmed caller is refused');
  assert.equal((await click(chat.id, 'wfr-doesnotexist', STAFF1)).status, 404);
  assert.equal((await click(chat.id, 'a%2Fb', STAFF1)).status, 400);
  assert.equal((await poll(chat.id, 'wfr-doesnotexist', STAFF1)).status, 404);
  assert.equal(calls.paid, 0);
  assert.equal((await requestOf(chat.id, waiting.id)).status, 'pending', 'rejected clicks change nothing');
  // another person of the chat sees the card without a way to start it
  const asOther = workflowRuns.publicRun(await requestOf(chat.id, waiting.id), { viewer: access.viewerOf({ kubleUser: STAFF2 }) });
  assert.equal(asOther.mine, false);
  assert.equal(asOther.workflowId, null, 'the id of the workflow stays on the server');
  await assert.rejects(workflowRuns.startRequest({ sessionId: chat.id, requestId: waiting.id, viewer: access.viewerOf({ kubleUser: STAFF2 }) }), (error) => error.status === 403 && error.code === 'NOT_REQUESTER');
  await assert.rejects(workflowRuns.cancelRequest({ sessionId: chat.id, requestId: waiting.id, viewer: access.viewerOf({ kubleUser: STAFF2 }) }), (error) => error.status === 403);
  assert.equal((await requestOf(chat.id, waiting.id)).status, 'pending');
  // three clicks at once: one run
  const held = openGate();
  const clicks = await Promise.all([click(chat.id, waiting.id, STAFF1), click(chat.id, waiting.id, STAFF1), click(chat.id, waiting.id, STAFF1)]);
  assert.deepEqual(clicks.map((response) => response.status).sort(), [201, 409, 409], 'only one click wins');
  const winner = clicks.find((response) => response.status === 201);
  assert.equal(winner.body.run.status, 'running');
  assert.equal(winner.body.run.run.step.total, 4);
  await waitFor(() => gate.started >= 1, 'the paid step');
  assert.equal(calls.paid, 1, 'exactly one paid step');
  assert.equal((await wfStore.listRuns(waiting.workflowId)).length, 1, 'exactly one run');
  assert.equal(workflowRuns.watching(), 1);
  // progress: the card of the chat and the poll answer say the same
  view = await runCard(chat.id, STAFF1);
  assert.equal(view.status, 'running');
  assert.deepEqual(view.run.running, ['t.imgpaid']);
  assert.ok(view.run.step.done >= 1 && view.run.step.done < view.run.step.total);
  const polled = (await poll(chat.id, waiting.id, STAFF1)).body.run;
  assert.equal(polled.status, 'running');
  assert.equal((await poll(chat.id, waiting.id, STAFF2)).status, 404);
  const runningTool = await toolMessageOf(chat.id, waiting.id);
  assert.match(runningTool.content, /läuft \(Lauf wfr-/);
  assert.match((await markerOf(chat.id, waiting.id)).content, /läuft\. Das Ergebnis erscheint automatisch im Chat/);
  assert.equal((await click(chat.id, waiting.id, STAFF1)).status, 409, 'a started run cannot be started again');
  assert.equal((await cancel(chat.id, waiting.id, STAFF2)).status, 404);
  // the end: the result is in the chat with the effective cost, no Director turn
  const requestsBeforeEnd = director.requests.length;
  held.release();
  gate.current = null;
  const done = await completed(chat.id, waiting.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.result.assets.length, 1);
  assert.equal(done.result.costUsd, 0.4, 'the effective cost, not the estimate');
  const resultAsset = done.result.assets[0];
  assert.deepEqual([resultAsset.label, resultAsset.kind], ['Picture', 'image']);
  const ledger = await store.readLedger(chat.id);
  const copied = ledger.find((item) => item.id === resultAsset.id);
  assert.ok(copied && !copied.pending, 'the file is in the ledger of the chat');
  assert.equal(copied.cost, 0.4, 'the asset carries the effective cost');
  assert.equal(ledger.filter((item) => item.prompt === 'a cat').length, 1, 'the input image of the chat is untouched');
  assert.equal(ledger.filter((item) => item.prompt === 'made by a paid step').length, 1, 'the result file was added, nothing else');
  assert.equal(director.requests.length, requestsBeforeEnd, 'no automatic Director turn');
  const endTool = await waitFor(async () => {
    const message = await toolMessageOf(chat.id, waiting.id);
    return /ist fertig/.test(message.content) ? message : null;
  }, 'the tool message of the result');
  assert.deepEqual(endTool.assets, [{ id: resultAsset.id, kind: 'image' }]);
  assert.match(endTool.content, new RegExp(`Im Chat gespeichert als Asset ${resultAsset.id} \\(Ausgang «Picture»: ${resultAsset.id}\\)`));
  assert.ok(!/\$|0\.4/.test(endTool.content), 'no amounts for the Director');
  assert.match((await markerOf(chat.id, waiting.id)).content, /ist fertig\. Das Ergebnis steht im Chat/);
  const body = await detail(chat.id, STAFF1);
  const shown = body.session.messages.find((m) => m.workflowRun);
  assert.equal(shown.workflowRun.status, 'completed');
  assert.equal(shown.workflowRun.result.costUsd, 0.4);
  assert.deepEqual(shown.assets, [{ id: resultAsset.id, kind: 'image' }]);
  assert.equal(body.assets.find((asset) => asset.id === resultAsset.id).cost, 0.4);
  // a second turn reads the result
  director.say({ text: 'Das Bild ist da.' });
  await send(chat.id, STAFF1, 'Danke');
  assert.match(JSON.stringify(director.requests.at(-1).messages), new RegExp(resultAsset.id));
  // the Director may not use another chat's media
  const stranger = await call(chat.id, STAFF1, 'run_workflow', { template_id: 'paid-image', inputs: { Photo: imgOther.id } }).catch((error) => error);
  assert.match(String(stranger.message), /does not exist in this chat|asset_not_found|Ungültige Eingabe/);

  /* ============ E: the price or the workflow changed after the card ============ */

  const changeChat = await store.createSession({ owner: STAFF1 });
  const changeImg = await store.saveAsset(changeChat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'x' });
  const card = (await call(changeChat.id, STAFF1, 'run_workflow', { template_id: 'paid-image', inputs: { Photo: changeImg.id } })).events.find((event) => event.type === 'workflow_run').run;
  assert.equal(card.totals.usd, 0.5);
  await attach(changeChat.id, card.id);
  const paidBeforeChange = calls.paid;
  price.current = 0.9;
  const refused = await click(changeChat.id, card.id, STAFF1);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'COST_CHANGED');
  assert.equal(calls.paid, paidBeforeChange, 'nothing ran at the old amount');
  assert.deepEqual(await wfStore.listRuns(card.workflowId), []);
  let reopened = await requestOf(changeChat.id, card.id);
  assert.equal(reopened.status, 'pending');
  assert.equal(reopened.plan.totals.usd, 0.9, 'the card shows the new estimate');
  assert.equal(reopened.note, 'plan_changed');
  assert.equal(reopened.lastErrorCode, 'COST_CHANGED');
  assert.equal((await runCard(changeChat.id, STAFF1)).lastErrorCode, 'COST_CHANGED');
  // the workflow was edited in the meantime
  const current = await wfStore.readWorkflow(card.workflowId);
  await wfStore.saveGraph(card.workflowId, { baseRev: current.rev, graph: { ...current.graph, nodes: current.graph.nodes.map((item) => (item.id === 'n2' ? { ...item, params: { prompt: 'edited' } } : item)) } });
  const revRefused = await click(changeChat.id, card.id, STAFF1);
  assert.equal(revRefused.status, 409);
  assert.equal(revRefused.body.code, 'REV_CONFLICT');
  reopened = await requestOf(changeChat.id, card.id);
  assert.equal(reopened.rev, (await wfStore.readWorkflow(card.workflowId)).rev, 'the card follows the new version');
  assert.equal(calls.paid, paidBeforeChange);
  // the next click accepts what the card shows now
  gate.current = null;
  assert.equal((await click(changeChat.id, card.id, STAFF1)).status, 201);
  const changed = await completed(changeChat.id, card.id);
  assert.equal(changed.status, 'completed');
  assert.equal(calls.paid, paidBeforeChange + 1);
  price.current = 0.5;

  /* ============ F: cancel ============ */

  const cancelChat = await store.createSession({ owner: STAFF1 });
  const cancelCard = (await call(cancelChat.id, STAFF1, 'run_workflow', { template_id: 'paid-text', inputs: { Question: 'wie?' } })).events.find((event) => event.type === 'workflow_run').run;
  await attach(cancelChat.id, cancelCard.id);
  const paidBeforeCancel = calls.paid;
  assert.equal((await cancel(cancelChat.id, cancelCard.id, STAFF2)).status, 404);
  const cancelled = await cancel(cancelChat.id, cancelCard.id, STAFF1);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.run.status, 'cancelled');
  assert.equal((await cancel(cancelChat.id, cancelCard.id, STAFF1)).status, 200, 'cancelling twice is harmless');
  assert.equal((await click(cancelChat.id, cancelCard.id, STAFF1)).status, 409, 'a cancelled card cannot be started');
  assert.equal(calls.paid, paidBeforeCancel);
  assert.deepEqual(await wfStore.listRuns(cancelCard.workflowId), []);
  assert.ok((await wfStore.listWorkflows()).some((item) => item.id === cancelCard.workflowId), 'the workflow stays in the list');
  assert.match((await toolMessageOf(cancelChat.id, cancelCard.id)).content, /abgebrochen\. Es wurde nichts gestartet und nichts berechnet/);
  // a running run is stopped
  const stopCard = (await call(cancelChat.id, STAFF1, 'run_workflow', { template_id: 'paid-text', inputs: { Question: 'langsam' } })).events.find((event) => event.type === 'workflow_run').run;
  await attach(cancelChat.id, stopCard.id);
  const heldRun = openGate();
  const startedBefore = gate.started;
  assert.equal((await click(cancelChat.id, stopCard.id, STAFF1)).status, 201);
  await waitFor(() => gate.started > startedBefore, 'the paid step to start');
  const stopping = await cancel(cancelChat.id, stopCard.id, STAFF1);
  assert.equal(stopping.status, 200);
  const stopped = await completed(cancelChat.id, stopCard.id);
  assert.equal(stopped.status, 'cancelled');
  assert.ok(stopped.runId);
  assert.equal(stopped.result.assets.length, 0);
  heldRun.release();
  gate.current = null;
  assert.match((await toolMessageOf(cancelChat.id, stopCard.id)).content, /wurde abgebrochen\. Es gibt kein Ergebnis/);
  assert.equal((await runCard(cancelChat.id, STAFF1)).status, 'cancelled');

  /* ============ G: at most 20 waiting cards per chat ============ */

  const crowded = await store.createSession({ owner: STAFF1 });
  assert.equal(workflowRuns.MAX_PENDING_PER_SESSION, 20);
  for (let i = 0; i < 20; i += 1) {
    const response = await call(crowded.id, STAFF1, 'run_workflow', { template_id: 'paid-unknown', inputs: { Text: `n${i}` } });
    assert.equal(response.halt, true);
  }
  const workflowsBeforeLimit = await workflowCount();
  await assert.rejects(call(crowded.id, STAFF1, 'run_workflow', { template_id: 'paid-unknown', inputs: { Text: 'one too many' } }), /warten schon 20 Workflow-Läufe/);
  assert.equal(await workflowCount(), workflowsBeforeLimit, 'a refusal creates no workflow');
  const firstWaiting = (await store.readSession(crowded.id)).workflowRunRequests[0].id;
  assert.equal((await cancel(crowded.id, firstWaiting, STAFF1)).status, 200);
  assert.equal((await call(crowded.id, STAFF1, 'run_workflow', { template_id: 'paid-unknown', inputs: { Text: 'fits again' } })).halt, true);
  // a card with an unknown price: never 0
  const unknownCard = workflowRuns.publicRun((await store.readSession(crowded.id)).workflowRunRequests.at(-1), { viewer: access.viewerOf({ kubleUser: STAFF1 }) });
  assert.equal(unknownCard.totals.unknownNodes, 1);
  assert.equal(unknownCard.totals.usdKnown, false);
  assert.deepEqual(unknownCard.paidSteps, [{ label: 't.paid_unknown', usd: null, credits: null }]);

  /* ============ H: participants ============ */

  const pChat = await store.createSession({ owner: P1 });
  const pImg = await store.saveAsset(pChat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'mine' });
  const workflowsBeforeP = await workflowCount();
  await assert.rejects(call(pChat.id, P1, 'run_workflow', { template_id: 'hf-flow' }), /Higgsfield|nicht verfügbar/);
  assert.equal(calls.hf, 0);
  assert.equal(await workflowCount(), workflowsBeforeP, 'a refused template creates no workflow');
  await assert.rejects(call(pChat.id, P1, 'run_workflow', { workflow_id: own.id }), /nicht gefunden/, 'a workflow of an internal person does not exist for a participant');
  const pCard = (await call(pChat.id, P1, 'run_workflow', { template_id: 'paid-image', inputs: { Photo: pImg.id } })).events.find((event) => event.type === 'workflow_run').run;
  assert.deepEqual(pCard.budget, { limitUsd: 1, remainingUsd: 1, reservedUsd: 0 });
  assert.equal(pCard.blocked, null);
  await attach(pChat.id, pCard.id);
  assert.equal(budgetLib.defaultBudget.reservationCount(), 0, 'a card reserves nothing');
  const pOwned = await wfStore.readWorkflow(pCard.workflowId);
  assert.equal(pOwned.owner, P1);
  assert.equal(pOwned.teamId, team.id, 'a new workflow belongs to the team of the participant');
  assert.equal((await click(pChat.id, pCard.id, STAFF1)).status, 404);
  // the reservation by the plan while the run runs
  const heldP = openGate();
  const startedP = gate.started;
  assert.equal((await click(pChat.id, pCard.id, P1)).status, 201);
  await waitFor(() => gate.started > startedP, 'the paid step of the participant');
  assert.equal((await budgetLib.statusOfEmail(P1)).reservedUsd, 0.5, 'the plan is reserved');
  assert.equal((await runCard(pChat.id, P1)).budget.reservedUsd, 0.5);
  heldP.release();
  gate.current = null;
  const pDone = await completed(pChat.id, pCard.id);
  assert.equal(pDone.status, 'completed');
  await waitFor(() => budgetLib.defaultBudget.reservationCount() === 0, 'the reservation to end');
  // what is left no longer covers the plan: the card says so, the server refuses
  await costsLib.recordCost({ ts: new Date().toISOString(), sessionId: pChat.id, type: 'image', model: 'x', cost: 0.6, user: P1 });
  const pCard2 = (await call(pChat.id, P1, 'run_workflow', { template_id: 'paid-image', inputs: { Photo: pImg.id } })).events.find((event) => event.type === 'workflow_run').run;
  await attach(pChat.id, pCard2.id);
  assert.equal(pCard2.blocked.reason, 'budget');
  assert.equal(pCard2.blocked.needUsd, 0.5);
  assert.ok(Math.abs(pCard2.blocked.remainingUsd - 0.4) < 1e-9);
  const paidBeforeP = calls.paid;
  const pRefused = await click(pChat.id, pCard2.id, P1);
  assert.equal(pRefused.status, 402);
  assert.equal(pRefused.body.code, 'BUDGET_INSUFFICIENT');
  assert.equal(calls.paid, paidBeforeP, 'nothing was paid');
  assert.deepEqual(await wfStore.listRuns(pCard2.workflowId), []);
  const pReopened = await requestOf(pChat.id, pCard2.id);
  assert.equal(pReopened.status, 'pending');
  assert.equal(pReopened.lastErrorCode, 'BUDGET_INSUFFICIENT');
  assert.equal((await runCard(pChat.id, P1)).blocked.reason, 'budget');
  // a used-up budget: no run at all
  await costsLib.recordCost({ ts: new Date().toISOString(), sessionId: pChat.id, type: 'image', model: 'x', cost: 50, user: P1 });
  assert.equal((await runCard(pChat.id, P1)).blocked.reason, 'exhausted');
  assert.equal((await click(pChat.id, pCard2.id, P1)).status, 402);

  /* ============ I: a run that ended while nobody watched ============ */

  const lateChat = await store.createSession({ owner: STAFF1 });
  const lateImg = await store.saveAsset(lateChat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'late' });
  const lateCard = (await call(lateChat.id, STAFF1, 'run_workflow', { template_id: 'paid-image', inputs: { Photo: lateImg.id } })).events.find((event) => event.type === 'workflow_run').run;
  await attach(lateChat.id, lateCard.id);
  gate.current = null;
  const lateRun = await service.start(access.viewerOf({ kubleUser: STAFF1 }), lateCard.workflowId, { maxUsd: 0.5 });
  await engine.whenFinished(lateCard.workflowId, lateRun.runId);
  // the server did not know: the request still says "waiting"; now it is running as after a restart
  await store.mutateSession(lateChat.id, (s) => {
    const request = s.workflowRunRequests.find((item) => item.id === lateCard.id);
    request.status = 'running';
    request.runId = lateRun.runId;
  });
  const lateAssetsBefore = (await store.readLedger(lateChat.id)).length;
  const readers = await Promise.all([1, 2, 3, 4].map(() => detail(lateChat.id, STAFF1)));
  assert.ok(readers.every((reader) => reader.session.messages.some((m) => m.workflowRun)));
  assert.equal((await requestOf(lateChat.id, lateCard.id)).status, 'completed', 'the read of the chat took the result in');
  assert.equal((await store.readLedger(lateChat.id)).length, lateAssetsBefore + 1, 'copied exactly once, also for parallel readers');
  await Promise.all([1, 2, 3].map(() => workflowRuns.syncRequest({ sessionId: lateChat.id, requestId: lateCard.id })));
  assert.equal((await store.readLedger(lateChat.id)).length, lateAssetsBefore + 1);
  assert.match((await toolMessageOf(lateChat.id, lateCard.id)).content, /ist fertig/);
  // an interrupted run (the server stopped during it): failed, said in plain words
  const brokenChat = await store.createSession({ owner: STAFF1 });
  const brokenCard = (await call(brokenChat.id, STAFF1, 'run_workflow', { template_id: 'paid-text', inputs: { Question: 'q' } })).events.find((event) => event.type === 'workflow_run').run;
  const brokenRun = await service.start(access.viewerOf({ kubleUser: STAFF1 }), brokenCard.workflowId, { maxUsd: 0.5 });
  await engine.whenFinished(brokenCard.workflowId, brokenRun.runId);
  const record = await wfStore.readRun(brokenCard.workflowId, brokenRun.runId);
  await wfStore.writeRun(brokenCard.workflowId, { ...record, status: 'interrupted', error: 'Server restarted during the run' });
  await store.mutateSession(brokenChat.id, (s) => {
    const request = s.workflowRunRequests.find((item) => item.id === brokenCard.id);
    request.status = 'running';
    request.runId = brokenRun.runId;
  });
  await detail(brokenChat.id, STAFF1);
  const broken = await requestOf(brokenChat.id, brokenCard.id);
  assert.equal(broken.status, 'failed');
  assert.match(broken.error, /Server restarted/);

  /* ============ J: 3D, a failed run, invalid inputs, an existing workflow ============ */

  const meshChat = await store.createSession({ owner: STAFF1 });
  const meshOutcome = await call(meshChat.id, STAFF1, 'run_workflow', { template_id: 'mesh-flow' });
  await attach(meshChat.id, meshOutcome.workflowRunId); // stored after the run ended: the watcher writes the result into it
  const meshRequest = await completed(meshChat.id, meshOutcome.workflowRunId);
  assert.equal(meshRequest.status, 'completed');
  assert.equal(meshRequest.result.assets.length, 1, 'only the preview image goes into the chat');
  assert.equal(meshRequest.result.assets[0].kind, 'image');
  assert.deepEqual(meshRequest.result.model3d, [{ label: 'Model' }]);
  assert.ok(!(await store.readLedger(meshChat.id)).some((item) => item.kind === 'model3d'), 'no 3D model in the chat');
  const meshText = await waitFor(async () => {
    const message = await toolMessageOf(meshChat.id, meshRequest.id);
    return /ist fertig/.test(message.content) ? message.content : null;
  }, 'the 3D result text');
  assert.match(meshText, /3D-Modell \(«Model»\): Der Chat nimmt kein 3D\. Das Modell liegt im Node-Editor/);

  const boomChat = await store.createSession({ owner: STAFF1 });
  const boom = await call(boomChat.id, STAFF1, 'run_workflow', { template_id: 'boom-flow' });
  await attach(boomChat.id, boom.workflowRunId);
  const boomRequest = await completed(boomChat.id, boom.workflowRunId);
  assert.equal(boomRequest.status, 'failed');
  assert.match(boomRequest.error, /the model said no/);
  assert.equal(boomRequest.failures[0].message, 'the model said no');
  assert.equal(boomRequest.result.assets.length, 0);
  const boomTool = await waitFor(async () => {
    const message = await toolMessageOf(boomChat.id, boomRequest.id);
    return /fehlgeschlagen/.test(message.content) ? message.content : null;
  }, 'the failure text');
  assert.match(boomTool, /Nichts wurde in den Chat übernommen/);

  const inputChat = await store.createSession({ owner: STAFF1 });
  const inputImg = await store.saveAsset(inputChat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'in' });
  const beforeInvalid = await workflowCount();
  const reject = async (args, pattern) => {
    await assert.rejects(call(inputChat.id, STAFF1, 'run_workflow', args), pattern);
    assert.equal(await workflowCount(), beforeInvalid, `nothing created for ${JSON.stringify(args)}`);
  };
  await reject({}, /entweder template_id oder workflow_id/);
  await reject({ template_id: 'free-text', workflow_id: own.id }, /entweder template_id oder workflow_id/);
  await reject({ template_id: 'free-text', inputs: [] }, /inputs muss ein Objekt sein/);
  await reject({ template_id: 'no-such-template' }, /nicht gefunden/);
  await reject({ template_id: 'free-text', inputs: { Nope: 'x' } }, /Unknown input "Nope"/);
  await reject({ template_id: 'free-text' }, /Pflichteingaben fehlen: «Idee»/);
  await reject({ template_id: 'paid-image', inputs: { Photo: 'img-999' } }, /does not exist in this chat/);
  await reject({ template_id: 'paid-image', inputs: { Photo: imgOther.id } }, /does not exist in this chat/);
  await reject({ template_id: 'paid-image', inputs: { Photo: 'a/../b' } }, /asset ids from the chat are expected/);
  await reject({ workflow_id: foreign.id }, /nicht gefunden/);
  assert.equal((await store.readSession(inputChat.id)).workflowRunRequests, undefined, 'no request for any refusal');

  // an existing workflow of the person is used as it is
  const ownChat = await store.createSession({ owner: STAFF1 });
  const beforeOwn = await workflowCount();
  const ownRun = await call(ownChat.id, STAFF1, 'run_workflow', { workflow_id: own.id, inputs: { Prompt: 'meiner' } });
  assert.equal(await workflowCount(), beforeOwn, 'no new workflow');
  assert.equal(ownRun.events.find((event) => event.type === 'workflow_run').run.created, false);
  assert.equal((await completed(ownChat.id, ownRun.workflowRunId)).result.texts[0].text, 'MEINER');
  // a shared workflow runs for the colleague, a second use of the same one while it runs is refused
  const sharedRun = await call(ownChat.id, STAFF1, 'run_workflow', { workflow_id: sharedWf.id });
  assert.equal((await completed(ownChat.id, sharedRun.workflowRunId)).status, 'completed');
  assert.equal(sharedRun.events.find((event) => event.type === 'workflow_run').run.origin, 'workflow');

  /* ============ L: the fixes of the review ============ */

  const staff = access.viewerOf({ kubleUser: STAFF1 });
  const hfFlowGraph = () => ({
    nodes: [node('a', 'input.prompt', { prompt: 'x' }), node('b', 't.hf', {}, 200, 0), node('c', 'output.result', {}, 400, 0)],
    edges: [edge('e1', 'a', 'prompt', 'b', 'in'), edge('e2', 'b', 'out', 'c', 'inputs')]
  });
  const textFlowGraph = (type) => ({
    nodes: [node('a', 'input.prompt', { prompt: 'alt' }), node('b', type, {}, 200, 0), node('c', 'output.result', { label: 'Out' }, 400, 0)],
    edges: [edge('e1', 'a', 'prompt', 'b', 'in'), edge('e2', 'b', 'out', 'c', 'inputs')]
  });
  const seenOf = (card) => ({ maxUsd: card.totals.usd, maxCredits: card.totals.credits, maxUnknownNodes: card.totals.unknownNodes, rev: card.rev });
  const startCard = async (chatId, args) => {
    const outcome = await call(chatId, STAFF1, 'run_workflow', args);
    await attach(chatId, outcome.workflowRunId);
    return outcome.events.find((event) => event.type === 'workflow_run').run;
  };

  // L1 credits: a price in credits is never "free". The start without a click refuses it; the click needs the credits
  const creditChat = await store.createSession({ owner: STAFF1 });
  const creditFlow = await mk(STAFF1, 'Credits-Ablauf', hfFlowGraph());
  const creditPrepared = await service.prepare(staff, { workflowId: creditFlow.id });
  const creditEstimate = await service.estimate(staff, creditFlow.id);
  assert.deepEqual([creditEstimate.paid, creditEstimate.totals.usd, creditEstimate.totals.credits], [true, 0, 2]);
  const staleFree = await workflowRuns.createRequest({
    sessionId: creditChat.id,
    prepared: creditPrepared,
    plan: { ...creditEstimate, paid: false, totals: { ...creditEstimate.totals, paidNodes: 0, usd: 0, credits: 0 }, steps: [] },
    user: STAFF1
  });
  await attach(creditChat.id, staleFree.id);
  await assert.rejects(workflowRuns.startRequest({ sessionId: creditChat.id, requestId: staleFree.id, viewer: staff }), (error) => error.code === 'COST_CHANGED', 'a card that said "free" does not start a run that costs credits');
  assert.equal(calls.hf, 0, 'no credits were spent');
  assert.deepEqual(await wfStore.listRuns(creditFlow.id), []);
  let creditRequest = await requestOf(creditChat.id, staleFree.id);
  assert.equal(creditRequest.status, 'pending');
  assert.equal(creditRequest.plan.paid, true, 'the card now shows the credits');
  assert.equal(creditRequest.plan.totals.credits, 2);
  // the click: credits that were not shown are refused, the credits shown start the run
  assert.equal((await click(creditChat.id, staleFree.id, STAFF1, { maxUsd: 0, maxCredits: 0, maxUnknownNodes: 0, rev: creditRequest.rev })).body.code, 'CARD_OUTDATED');
  assert.equal(calls.hf, 0);
  const creditStart = await click(creditChat.id, staleFree.id, STAFF1);
  assert.equal(creditStart.status, 201);
  assert.equal((await completed(creditChat.id, staleFree.id)).status, 'completed');
  assert.equal(calls.hf, 1, 'exactly one run, after the click');
  assert.equal((await requestOf(creditChat.id, staleFree.id)).result.credits, 2);
  // the card of a credits workflow: an amount in credits on the button, no dollar sign
  const creditCard = await startCard((await store.createSession({ owner: STAFF1 })).id, { workflow_id: (await mk(STAFF1, 'Credits zwei', hfFlowGraph())).id });
  assert.deepEqual([creditCard.paid, creditCard.totals.usd, creditCard.totals.credits, creditCard.status], [true, 0, 2, 'pending']);

  // L2 a card that is out of date: another tab, or a quick second click, cannot accept a price it never showed
  const staleChat = await store.createSession({ owner: STAFF1 });
  const staleImg = await store.saveAsset(staleChat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'stale' });
  price.current = 0.5;
  const staleCard = await startCard(staleChat.id, { template_id: 'paid-image', inputs: { Photo: staleImg.id } });
  assert.equal(staleCard.totals.usd, 0.5);
  assert.ok(Number.isInteger(staleCard.rev), 'the card carries the version of the workflow');
  const tabOne = seenOf(staleCard);
  const paidBeforeStale = calls.paid;
  price.current = 0.9;
  const firstTry = await click(staleChat.id, staleCard.id, STAFF1, tabOne);
  assert.deepEqual([firstTry.status, firstTry.body.code], [409, 'COST_CHANGED']);
  assert.equal((await requestOf(staleChat.id, staleCard.id)).plan.totals.usd, 0.9, 'the card shows the new price');
  const secondTab = await click(staleChat.id, staleCard.id, STAFF1, tabOne);
  assert.deepEqual([secondTab.status, secondTab.body.code], [409, 'CARD_OUTDATED'], 'the second tab still shows $0.50: refused');
  assert.equal(calls.paid, paidBeforeStale, 'nothing ran at a price that was never shown');
  assert.deepEqual(await wfStore.listRuns(staleCard.workflowId), []);
  const staleStored = await requestOf(staleChat.id, staleCard.id);
  assert.deepEqual([staleStored.status, staleStored.lastErrorCode, staleStored.note], ['pending', 'CARD_OUTDATED', 'plan_changed']);
  assert.equal((await runCard(staleChat.id, STAFF1)).totals.usd, 0.9, 'the chat shows the new price after the refusal');
  assert.equal((await runCard(staleChat.id, STAFF1)).lastErrorCode, 'CARD_OUTDATED');
  // a click without the amounts, with broken ones, with a card that shows more, or another version: nothing starts
  const fresh = seenOf(await runCard(staleChat.id, STAFF1));
  for (const [label, body, status, code] of [
    ['no amounts', {}, 400, 'CONFIRMATION_REQUIRED'],
    ['negative', { ...fresh, maxUsd: -1 }, 400, 'INVALID_REQUEST'],
    ['text', { ...fresh, maxUsd: '0.9' }, 400, 'INVALID_REQUEST'],
    ['no version', { maxUsd: 0.9, maxCredits: 0, maxUnknownNodes: 0 }, 400, 'INVALID_REQUEST'],
    ['a card that shows more', { ...fresh, maxUsd: 5 }, 409, 'CARD_OUTDATED'],
    ['credits that were shown', { ...fresh, maxCredits: 3 }, 409, 'CARD_OUTDATED'],
    ['a price that was not shown', { ...fresh, maxUnknownNodes: 1 }, 409, 'CARD_OUTDATED'],
    ['another version', { ...fresh, rev: fresh.rev + 1 }, 409, 'CARD_OUTDATED']
  ]) {
    const response = await click(staleChat.id, staleCard.id, STAFF1, body);
    assert.deepEqual([response.status, response.body.code], [status, code], label);
  }
  assert.equal(calls.paid, paidBeforeStale);
  assert.deepEqual(await wfStore.listRuns(staleCard.workflowId), []);
  gate.current = null;
  assert.equal((await click(staleChat.id, staleCard.id, STAFF1, fresh)).status, 201, 'the card as it is now starts the run');
  assert.equal((await completed(staleChat.id, staleCard.id)).status, 'completed');
  assert.equal(calls.paid, paidBeforeStale + 1);
  price.current = 0.5;

  // L3 an existing workflow: the inputs are in it already, and the card says so
  const keepChat = await store.createSession({ owner: STAFF1 });
  const keepFlow = await mk(STAFF1, 'Bezahlt vorhanden', textFlowGraph('t.paid'));
  const keptCard = await startCard(keepChat.id, { workflow_id: keepFlow.id, inputs: { 'a.prompt': 'neu vom Director' } });
  assert.deepEqual([keptCard.created, keptCard.inputsKept, keptCard.status], [false, true, 'pending']);
  assert.equal((await cancel(keepChat.id, keptCard.id, STAFF1)).status, 200);
  assert.equal((await wfStore.readWorkflow(keepFlow.id)).graph.nodes.find((item) => item.id === 'a').params.prompt, 'neu vom Director', 'what the card said: the inputs stay in the workflow');
  const noInputs = await startCard(keepChat.id, { workflow_id: keepFlow.id });
  assert.equal(noInputs.inputsKept, false, 'nothing was set, nothing to say');
  const madeCard = await startCard(keepChat.id, { template_id: 'paid-text', inputs: { Question: 'q' } });
  assert.deepEqual([madeCard.created, madeCard.inputsKept], [true, false], 'a workflow made for the card is not "kept"');
  // a refused start takes the inputs of an existing workflow back
  const gone = await mk(STAFF1, 'Nicht verfügbar', textFlowGraph('t.nope'));
  await assert.rejects(call(keepChat.id, STAFF1, 'run_workflow', { workflow_id: gone.id, inputs: { 'a.prompt': 'darf nicht bleiben' } }));
  assert.equal((await wfStore.readWorkflow(gone.id)).graph.nodes.find((item) => item.id === 'a').params.prompt, 'alt', 'the Director\'s input is not left in a workflow that could not start');

  // L4 a direct start that is refused leaves nothing behind (no request, no workflow, however often it is tried)
  const refusedChat = await store.createSession({ owner: STAFF1 });
  const realStart = service.start;
  service.start = async () => {
    throw Object.assign(new Error('too many runs'), { code: 'RUN_LIMIT' });
  };
  const workflowsBeforeRefused = await workflowCount();
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(call(refusedChat.id, STAFF1, 'run_workflow', { template_id: 'free-text', inputs: { Idee: `versuch ${attempt}` } }), /too many runs/);
    }
    await assert.rejects(call(refusedChat.id, STAFF1, 'run_workflow', { workflow_id: own.id, inputs: { Prompt: 'bleibt' } }), /too many runs/);
  } finally {
    service.start = realStart;
  }
  assert.equal(await workflowCount(), workflowsBeforeRefused, 'the workflows made for the refused tries are gone, the existing one stays');
  assert.deepEqual((await store.readSession(refusedChat.id)).workflowRunRequests, []);
  assert.ok((await wfStore.listWorkflows()).some((item) => item.id === own.id));

  // L5 the start is written down late: the run is not started a second time, and its result still reaches the chat
  const realMutate = store.mutateSession;
  let failMarks = false;
  const realWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  store.mutateSession = (sessionId, fn, options) =>
    failMarks && String(fn).includes("request.status = 'running'") ? Promise.reject(new Error('disk full')) : realMutate(sessionId, fn, options);
  try {
    // a) the write works again soon: the card catches up by itself
    const lateChat = await store.createSession({ owner: STAFF1 });
    const lateCard = await startCard(lateChat.id, { template_id: 'paid-text', inputs: { Question: 'spät' } });
    failMarks = true;
    const paidBeforeLate = calls.paid;
    const lateClick = await click(lateChat.id, lateCard.id, STAFF1);
    assert.equal(lateClick.status, 201);
    assert.equal(lateClick.body.run.status, 'processing', 'the card says "starting" while the run id is not stored');
    await waitFor(async () => (await wfStore.listRuns(lateCard.workflowId)).length === 1, 'the run');
    failMarks = false;
    const caughtUp = await completed(lateChat.id, lateCard.id);
    assert.equal(caughtUp.status, 'completed', 'the result came into the chat although the first write failed');
    assert.ok(caughtUp.runId);
    assert.equal(calls.paid, paidBeforeLate + 1);

    // b) the write keeps failing and the request grows stale: a second click does not start a second run
    const stuckChat = await store.createSession({ owner: STAFF1 });
    const stuckCard = await startCard(stuckChat.id, { template_id: 'paid-text', inputs: { Question: 'hängt' } });
    failMarks = true;
    const paidBeforeStuck = calls.paid;
    assert.equal((await click(stuckChat.id, stuckCard.id, STAFF1)).status, 201);
    await waitFor(async () => (await wfStore.listRuns(stuckCard.workflowId)).some((item) => item.status !== 'running'), 'the run to end');
    await realMutate(stuckChat.id, (session) => {
      const request = session.workflowRunRequests.find((item) => item.id === stuckCard.id);
      request.processingAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    }, { touchUpdatedAt: false });
    const again = await click(stuckChat.id, stuckCard.id, STAFF1);
    assert.deepEqual([again.status, again.body.code], [409, 'RUN_ACTIVE'], 'the run exists: no second one');
    assert.equal((await requestOf(stuckChat.id, stuckCard.id)).status, 'processing');
    failMarks = false;
    const third = await click(stuckChat.id, stuckCard.id, STAFF1);
    assert.equal(third.status, 409);
    const adopted = await completed(stuckChat.id, stuckCard.id);
    assert.equal(adopted.status, 'completed', 'the run was taken over and its result delivered');
    assert.equal((await wfStore.listRuns(stuckCard.workflowId)).length, 1, 'exactly one run');
    assert.equal(calls.paid, paidBeforeStuck + 1, 'exactly one paid step');
  } finally {
    store.mutateSession = realMutate;
    console.warn = realWarn;
  }
  assert.ok(warnings.some((line) => /Der Start wurde nicht gespeichert/.test(line)), 'the failed write was reported');

  // L6 thumbnails of the inputs are at their address in the chat; a file that was in the workflow has none to show
  const thumbChat = await store.createSession({ owner: STAFF1 });
  const thumbImg = await store.saveAsset(thumbChat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'thumb' });
  const thumbCard = await startCard(thumbChat.id, { template_id: 'paid-image', inputs: { Photo: thumbImg.id } });
  const thumbWorkflow = await wfStore.readWorkflow(thumbCard.workflowId);
  assert.ok(thumbCard.inputs[0].media[0].url.startsWith(`/assets/${thumbChat.id}/`));
  assert.ok(!JSON.stringify(thumbCard).includes(thumbWorkflow.sessionId), 'the session behind the workflow is not in the card');
  const sharedChat = await store.createSession({ owner: STAFF1 });
  const sharedImg = await store.saveAsset(sharedChat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'shared thumb' });
  await store.updateSessionSharing(sharedChat.id, { shareMode: 'team' });
  const sharedCard = await startCard(sharedChat.id, { template_id: 'paid-image', inputs: { Photo: sharedImg.id } });
  const sharedImage = await api(sharedCard.inputs[0].media[0].url, { as: STAFF2 });
  const ownImage = await api(sharedCard.inputs[0].media[0].url, { as: STAFF1 });
  assert.equal(ownImage.status, 200);
  assert.equal(sharedImage.status, 200, 'a colleague in the shared chat sees the picture on the card');
  const behindWorkflow = (await wfStore.readWorkflow(sharedCard.workflowId)).sessionId;
  assert.equal((await api(`/assets/${behindWorkflow}/${(await store.readLedger(behindWorkflow)).find((item) => item.file).file}`, { as: STAFF2 })).status, 404, 'the session behind the workflow stays closed to the colleague (so it must not be linked)');
  const reusedWorkflow = await mk(STAFF1, 'Mit Bild', {
    nodes: [node('a', 'input.image', { asset: assetsLib.valueFromLedgerEntry(thumbChat.id, (await store.readLedger(thumbChat.id)).find((item) => item.id === thumbImg.id)) }), node('b', 't.imgpaid', {}, 200, 0), node('c', 'output.result', {}, 400, 0)],
    edges: [edge('e1', 'a', 'image', 'b', 'image'), edge('e2', 'b', 'image', 'c', 'inputs')]
  });
  const reusedCard = await startCard(thumbChat.id, { workflow_id: reusedWorkflow.id });
  assert.equal(reusedCard.inputs[0].media[0].url, null, 'no address into the session behind the workflow');
  assert.ok(!JSON.stringify(reusedCard).includes(reusedWorkflow.sessionId));

  // L7 the cost of a file is that of its own step: the text step costs more, the image does not carry it
  const costChat = await store.createSession({ owner: STAFF1 });
  const costCard = await startCard(costChat.id, { template_id: 'mixed-cost', inputs: { Story: 'ein Bild' } });
  gate.current = null;
  assert.equal((await click(costChat.id, costCard.id, STAFF1)).status, 201);
  const costDone = await completed(costChat.id, costCard.id);
  assert.equal(costDone.status, 'completed');
  assert.equal(costDone.result.costUsd, 0.44, 'the run cost: 0.40 for the text step, 0.04 for the two pictures');
  assert.equal(costDone.result.assets.length, 2);
  const costLedger = await store.readLedger(costChat.id);
  for (const asset of costDone.result.assets) {
    assert.equal(costLedger.find((item) => item.id === asset.id).cost, 0.02, 'a picture carries its share of its own step, not of the whole run');
  }
  assert.equal(costDone.result.texts.length, 1);
  assert.ok(costDone.result.assets.every((asset) => asset.costUsd === undefined), 'no helper field in the stored result');

  /* ============ K: the client ============ */

  const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const i18nSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.js'), 'utf8');
  const cardSource = appSource.slice(appSource.indexOf('/* ---------- Workflow runs (card of the Director'), appSource.indexOf('function chip(label, spinning, isError)'));
  assert.ok(cardSource.length > 4000, 'the card code is there');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(cardSource), 'foreign data never goes in as HTML');
  assert.match(cardSource, /\/workflow-runs\/\$\{encodeURIComponent\(run\.id\)\}`, \{ method: 'POST'/);
  assert.match(cardSource, /\/workflow-runs\/\$\{encodeURIComponent\(run\.id\)\}\/cancel/);
  assert.match(cardSource, /href = `#w=\$\{encodeURIComponent\(run\.workflowId\)\}`/);
  assert.match(cardSource, /WORKFLOW_RUN_POLL_MS = 4000/, 'no tight polling');
  // the click says what the card showed, and the buttons stay locked until the card is drawn again
  assert.match(cardSource, /maxUsd: totals\.usd \|\| 0, maxCredits: totals\.credits \|\| 0, maxUnknownNodes: totals\.unknownNodes \|\| 0, rev: run\.rev/);
  assert.match(cardSource, /body: JSON\.stringify\(seen\)/);
  const catchBlock = cardSource.slice(cardSource.indexOf('async function startWorkflowRun'), cardSource.indexOf('async function cancelWorkflowRun'));
  assert.ok(catchBlock.indexOf('await refreshDetail()') > 0 && catchBlock.indexOf('await refreshDetail()') < catchBlock.indexOf('button.disabled = false'), 'the buttons are released only after the card was drawn again');
  assert.match(catchBlock, /if \(card\.isConnected\)/);
  assert.match(appSource, /event\.type === 'workflow_run'/);
  // every wording key the card uses exists in German, English and Spanish
  const dictionaries = {};
  for (const lang of ['de', 'en', 'es']) {
    const sandbox = { window: { navigator: { language: lang }, localStorage: { getItem: () => lang, setItem() {} }, document: { documentElement: {}, querySelectorAll: () => [] } } };
    require('vm').runInNewContext(i18nSource, sandbox, { filename: 'public/i18n.js' });
    dictionaries[lang] = sandbox.window.I18N[lang];
  }
  const used = new Set([...cardSource.matchAll(/t\(\s*'(workflowRun\.[A-Za-z0-9_.]+)'/g)].map((match) => match[1]));
  for (const status of ['pending', 'processing', 'running', 'completed', 'failed', 'cancelled']) {
    used.add(`workflowRun.state.${status}`);
    used.add(`tools.workflow.${status}`);
  }
  used.add('workflowRun.inputsKept');
  used.add('workflowRun.fileInWorkflow');
  for (const code of ['CARD_OUTDATED', 'COST_CHANGED', 'REV_CONFLICT', 'RUN_ACTIVE', 'RUN_LIMIT', 'NODE_UNAVAILABLE', 'INVALID_GRAPH', 'WORKFLOW_NOT_FOUND']) used.add(`workflowRun.error.${code}`);
  used.add('tools.workflowsListed');
  assert.ok(used.size > 50);
  for (const lang of ['de', 'en', 'es']) {
    for (const key of used) assert.ok(typeof dictionaries[lang][key] === 'string' && dictionaries[lang][key].length > 0, `${lang} lacks ${key}`);
  }
  assert.equal(dictionaries.de['workflowRun.startPrice'], 'Starten · ca. {amount}');
  assert.equal(dictionaries.de['workflowRun.open'], 'Im Node-Editor öffnen');
  assert.equal(dictionaries.de['workflowRun.localMany'], '{count} weitere Schritte laufen lokal, kostenlos.');
  assert.equal(dictionaries.de['workflowRun.listNote'], 'Erscheint in deiner Workflow-Liste.');
  for (const lang of ['de', 'en', 'es']) {
    for (const [key, value] of Object.entries(dictionaries[lang])) {
      if (key.startsWith('workflowRun.') || key.startsWith('tools.workflow')) assert.ok(!value.includes('ß'), `${lang}.${key} has no sharp s`);
    }
  }
  // no internal names in the new files of the open-source repository
  for (const file of ['lib/workflow-runs.js', 'lib/nodes/run-service.js', 'lib/tools.js', 'public/app.js', 'public/i18n.js', 'public/styles.css']) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.ok(!/maniak|kuble\.com|gsalami/i.test(text.replace(/Kuble-Lab\/open-creative-director/g, '')), `${file} has no internal names`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
