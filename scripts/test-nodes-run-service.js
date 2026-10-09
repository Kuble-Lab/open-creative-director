'use strict';

// Run service (WP26, part 1: lib/nodes/run-service.js): the one place outside the node view that prepares and starts runs.
//
//   L   listRunnable: templates, own / shared / foreign workflows, the filter for participants, cost figures, inputs and outputs
//   P   prepare: a template becomes a new workflow (owner, team), inputs by label or id, media copied from the chat only,
//       foreign chats and workflows refused, invalid inputs refused before anything is created
//   E   estimate: steps, paid steps, total, unknown prices never 0, what blocks a start, the budget line of participants
//   S   start: a free run starts, a paid one only with the accepted amount, the plan and the budget are checked again,
//       two starts at the same time start one run, Higgsfield refused for participants, the budget is reserved
//   R   status and cancel: progress, outputs with cost, strangers see nothing, cancel stops the run
//
// A private copy of the app runs in a temp directory (own data folders, ephemeral port). The nodes are doubles registered in a
// private registry (no provider is contacted, nothing is paid); a fetch guard refuses everything except localhost.

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { createIsolatedApp } = require('./support/isolated-app');

const ADMIN = 'admin@example.com';
const STAFF1 = 'one@staff.example.com';
const STAFF2 = 'two@staff.example.com';
const P1 = 'p1@gmail.example';
const P2 = 'p2@gmail.example';
const P3 = 'p3@gmail.example';
const P4 = 'p4@gmail.example';
const GUEST = 'guest@gmail.example';
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

async function waitFor(predicate, label, timeoutMs = 6000) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Timeout waiting for ${label}`);
    await sleep(15);
  }
}

async function rejects(promise, code, extra) {
  try {
    await promise;
  } catch (err) {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    if (extra) extra(err);
    return err;
  }
  assert.fail(`expected the error ${code}`);
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
      OPENROUTER_API_KEY: '',
      FAL_KEY: '',
      ELEVENLABS_API_KEY: ''
    }
  });
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  try {
    await run(iso);
  } finally {
    guard.restore();
    await iso.cleanup();
  }
  assert.deepEqual(guard.attempts, [], 'no network access outside localhost');
  console.log('Lauf-Dienst: Liste, Vorbereiten, Schätzen, Starten (Bestätigung, Budget, Doppelstart), Status, Abbrechen und Rechte sind korrekt.');
  console.log('test-nodes-run-service.js: ok');
}

async function run(iso) {
  const api = iso.request;
  const access = iso.load('lib/access');
  const sessions = iso.load('lib/store');
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
  const { textValue } = types;

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
    cost: { unit: 'usd', estimate: () => ({ usd: 0.5 }) },
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
    type: 't.unavail',
    category: 'text',
    available: () => 'no key configured',
    inputs: [{ id: 'in', type: 'text' }],
    outputs: [{ id: 'out', type: 'text' }],
    execute: async () => ({ variants: [{ out: textValue('never') }] })
  });
  registry.register({
    type: 't.imgpaid',
    category: 'image',
    paid: true,
    cost: { unit: 'usd', estimate: () => ({ usd: 0.5 }) },
    inputs: [{ id: 'image', type: 'image', required: true }, { id: 'prompt', type: 'text' }],
    outputs: [{ id: 'image', type: 'image' }],
    params: [
      { id: 'seconds', kind: 'integer', default: 5, min: 1, max: 10 },
      { id: 'style', kind: 'select', options: ['soft', 'hard'], default: 'soft' },
      { id: 'loud', kind: 'boolean', default: false }
    ],
    execute: async (ctx, inputs) => {
      calls.paid += 1;
      await waitGate(ctx.signal);
      return { variants: [{ image: inputs.image }], cost: { usd: 0.4 } };
    }
  });

  const dataDir = path.join(iso.root, 'data');
  const bus = createEventBus();
  const wfStore = createWorkflowsStore({ dir: path.join(dataDir, 'workflows-doubles'), registry, events: bus });
  const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => ({}) });

  /* ---------- templates (files in a temp folder) ---------- */

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
    i18n: { de: { name: 'Freier Text', 'app.input.n1.prompt': 'Idee' }, es: { name: 'Texto libre' } }
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
      inputs: [
        { node: 'n1', param: 'asset', label: 'Photo' },
        { node: 'n2', param: 'prompt', label: 'Wish' },
        { node: 'n3', param: 'seconds', label: 'Seconds' },
        { node: 'n3', param: 'style', label: 'Style' },
        { node: 'n3', param: 'loud', label: 'Loud' }
      ],
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
  await writeTemplate('twin', {
    name: 'Twin labels',
    graph: {
      nodes: [node('n1', 'input.prompt', { prompt: 'a' }, 0, 0), node('n2', 'input.prompt', { prompt: 'b' }, 0, 100), node('n3', 'text.join', {}, 200, 0), node('n4', 'output.result', {}, 400, 0)],
      edges: [edge('e1', 'n1', 'prompt', 'n3', 'items'), edge('e2', 'n2', 'prompt', 'n3', 'items'), edge('e3', 'n3', 'text', 'n4', 'inputs')]
    },
    app: { enabled: true, inputs: [{ node: 'n1', param: 'prompt', label: 'Same' }, { node: 'n2', param: 'prompt', label: 'Same' }], outputs: [{ node: 'n4', label: 'Joined' }] }
  });

  const templateDeps = {
    list: (options) => templatesLib.listTemplates({ ...options, dir: templateDir, checks: {} }),
    resolve: (id, options) => templatesLib.resolveTemplate(id, { ...options, dir: templateDir })
  };
  const service = runServiceLib.createRunService({ engine, store: wfStore, registry, templates: templateDeps });

  /* ---------- people ---------- */

  const team = (await api('/api/teams', { method: 'POST', as: ADMIN, json: { name: 'Kurs', budgetUsd: 5 } })).body.team;
  assert.equal((await api(`/api/teams/${team.id}/members`, { method: 'POST', as: ADMIN, json: { emails: [P1, P2] } })).status, 201);
  const otherTeam = (await api('/api/teams', { method: 'POST', as: ADMIN, json: { name: 'Anders', budgetUsd: 5 } })).body.team;
  assert.equal((await api(`/api/teams/${otherTeam.id}/members`, { method: 'POST', as: ADMIN, json: { emails: [P3] } })).status, 201);
  const smallTeam = (await api('/api/teams', { method: 'POST', as: ADMIN, json: { name: 'Klein', budgetUsd: 0.6 } })).body.team;
  assert.equal((await api(`/api/teams/${smallTeam.id}/members`, { method: 'POST', as: ADMIN, json: { emails: [P4] } })).status, 201);
  const viewerOf = (email) => access.viewerOf({ kubleUser: email });
  const v = { admin: viewerOf(ADMIN), s1: viewerOf(STAFF1), s2: viewerOf(STAFF2), p1: viewerOf(P1), p2: viewerOf(P2), p3: viewerOf(P3), p4: viewerOf(P4), guest: viewerOf(GUEST), anon: viewerOf(null), local: access.viewerOf({}, {}) };
  assert.equal(v.p1.kind, 'participant');
  assert.equal(v.s1.kind, 'internal');
  assert.equal(v.guest.kind, 'guest');
  assert.equal(v.local.active, false);
  assert.equal(runServiceLib.viewerForUser(P1).kind, 'participant');

  /* ---------- workflows ---------- */

  const freeGraph = () => ({
    nodes: [node('a', 'input.prompt', { prompt: 'hello' }, 0, 0), node('b', 't.upper', {}, 200, 0), node('c', 'output.result', { label: 'Out' }, 400, 0)],
    edges: [edge('e1', 'a', 'prompt', 'b', 'in'), edge('e2', 'b', 'out', 'c', 'inputs')]
  });
  const paidGraph = () => ({
    nodes: [node('a', 'input.prompt', { prompt: 'hello' }, 0, 0), node('b', 't.paid', {}, 200, 0), node('c', 'output.result', { label: 'Out' }, 400, 0)],
    edges: [edge('e1', 'a', 'prompt', 'b', 'in'), edge('e2', 'b', 'out', 'c', 'inputs')]
  });
  const mk = async (owner, name, graph, { app, share, teamId } = {}) => {
    const created = await wfStore.createWorkflow({ name, graph, app, owner, teamId: teamId || null, user: owner || 'lokal' });
    if (share) await wfStore.setSharing(created.workflow.id, share);
    return created.workflow;
  };

  const own = await mk(STAFF1, 'Mein Ablauf', freeGraph());
  const sharedTeam = await mk(STAFF2, 'Team-Ablauf', freeGraph(), { share: { shareMode: 'team' } });
  const sharedSpecific = await mk(STAFF2, 'Direkt geteilt', paidGraph(), { share: { shareMode: 'specific', sharedWith: [STAFF1] } });
  const foreignPrivate = await mk(STAFF2, 'Fremd und privat', freeGraph());
  const hfGraph = { nodes: [node('a', 'input.prompt', { prompt: 'x' }), node('b', 't.hf', {}, 200, 0), node('c', 'output.result', {}, 400, 0)], edges: [edge('e1', 'a', 'prompt', 'b', 'in'), edge('e2', 'b', 'out', 'c', 'inputs')] };
  const hfOwn = await mk(STAFF1, 'Higgsfield intern', hfGraph);
  const p1Own = await mk(P1, 'P1 Ablauf', freeGraph(), { teamId: team.id });
  const p1Hf = await mk(P1, 'P1 Higgsfield', hfGraph, { teamId: team.id });
  const p2Shared = await mk(P2, 'P2 fürs Team', freeGraph(), { teamId: team.id, share: { shareMode: 'teams', sharedTeams: [team.id] } });
  const p3Private = await mk(P3, 'P3 privat', freeGraph());
  const guestOwn = await mk(GUEST, 'Gast Ablauf', freeGraph());
  const noApp = await mk(STAFF1, 'Ohne App', {
    nodes: [
      node('t1', 'input.prompt', { prompt: '' }, 0, 200),
      node('i1', 'input.image', {}, 0, 0),
      node('num', 'input.number', { value: 3 }, 0, 100),
      node('o', 'output.result', {}, 300, 0)
    ],
    edges: []
  });
  const countWorkflows = async () => (await wfStore.listWorkflows()).length;

  /* ============ L: listRunnable ============ */

  let list = await service.listRunnable(v.s1, { lang: 'de' });
  const byId = (items, id) => items.find((item) => item.id === id);
  assert.deepEqual(list.items.filter((item) => item.kind === 'template').map((item) => item.id).sort(), ['free-text', 'hf-flow', 'paid-image', 'paid-unknown', 'twin']);
  assert.equal(byId(list.items, 'free-text').name, 'Freier Text', 'templates come in the language asked for');
  assert.equal(byId(list.items, 'free-text').inputs[0].label, 'Idee');
  assert.equal((await service.listRunnable(v.s1, { lang: 'es' })).items.find((item) => item.id === 'free-text').name, 'Texto libre');
  const workflowIds = list.items.filter((item) => item.kind === 'workflow').map((item) => item.id);
  assert.ok(workflowIds.includes(own.id), 'own');
  assert.ok(workflowIds.includes(sharedTeam.id), 'shared with everybody internal');
  assert.ok(workflowIds.includes(sharedSpecific.id), 'shared with the person');
  assert.ok(!workflowIds.includes(foreignPrivate.id), 'a foreign private workflow is not listed');
  assert.ok(!workflowIds.includes(p1Own.id) && !workflowIds.includes(guestOwn.id), 'workflows of others are not listed');
  assert.equal(byId(list.items, own.id).origin, 'own');
  assert.equal(byId(list.items, sharedTeam.id).origin, 'shared');
  assert.equal(byId(list.items, sharedSpecific.id).origin, 'shared');
  assert.equal(list.truncated, false);
  // cost: free, estimate, unknown (never 0)
  assert.deepEqual(byId(list.items, 'free-text').cost, { kind: 'free', paid: false, usd: 0 });
  assert.equal(byId(list.items, 'free-text').paid, false);
  assert.deepEqual(byId(list.items, 'paid-image').cost, { kind: 'estimate', paid: true, usd: 0.5 });
  assert.equal(byId(list.items, 'paid-image').paid, true);
  assert.deepEqual(byId(list.items, 'paid-unknown').cost, { kind: 'unknown', paid: true, usd: null });
  assert.deepEqual(byId(list.items, sharedSpecific.id).cost, { kind: 'estimate', paid: true, usd: 0.5 });
  assert.equal(byId(list.items, 'hf-flow').cost.paid, true);
  assert.equal(byId(list.items, 'hf-flow').cost.usd, null, 'credits are not dollars');
  assert.equal(byId(list.items, 'hf-flow').cost.credits, 2);
  // inputs and outputs of a template
  const imageInputs = byId(list.items, 'paid-image').inputs;
  assert.deepEqual(imageInputs.map((item) => [item.id, item.label, item.type, item.required]), [
    ['n1.asset', 'Photo', 'image', true],
    ['n2.prompt', 'Wish', 'text', false],
    ['n3.seconds', 'Seconds', 'number', false],
    ['n3.style', 'Style', 'select', false],
    ['n3.loud', 'Loud', 'boolean', false]
  ]);
  assert.equal(imageInputs[2].min, 1);
  assert.equal(imageInputs[2].max, 10);
  assert.deepEqual(imageInputs[3].options, ['soft', 'hard']);
  assert.deepEqual(byId(list.items, 'paid-image').outputs, [{ node: 'n4', label: 'Picture' }]);
  assert.equal(byId(list.items, 'free-text').inputs[0].required, true, 'a blank text on an input node is missing');
  assert.ok(!JSON.stringify(list).includes('_paramKind'), 'internal fields stay inside');
  // derived inputs: the input nodes in canvas order, outputs: the result nodes
  const derived = byId((await service.listRunnable(v.s1, { query: 'Ohne App' })).items, noApp.id);
  assert.deepEqual(derived.inputs.map((item) => [item.id, item.type, item.required, item.derived]), [
    ['i1.asset', 'image', true, true],
    ['num.value', 'number', false, true],
    ['t1.prompt', 'text', true, true]
  ]);
  assert.deepEqual(derived.outputs.map((item) => item.node), ['o']);
  // search and limit
  const found = await service.listRunnable(v.s1, { query: 'higgsfield' });
  assert.deepEqual(found.items.map((item) => item.id).sort(), ['hf-flow', hfOwn.id].sort());
  const limited = await service.listRunnable(v.s1, { limit: 7 });
  assert.equal(limited.items.length, 7);
  assert.equal(limited.truncated, true);
  assert.equal(limited.templates, 5);
  assert.equal((await service.listRunnable(v.s1, { limit: 3 })).items.length, 3, 'the limit also holds for the templates');
  // the admin sees the templates, their own workflows and what is shared with everybody internal, not the private ones of others
  list = await service.listRunnable(v.admin, {});
  assert.deepEqual(list.items.filter((item) => item.kind === 'workflow').map((item) => item.id), [sharedTeam.id]);
  assert.equal(list.templates, 5);
  // local mode: everything
  list = await service.listRunnable(v.local, {});
  assert.ok(list.items.some((item) => item.id === foreignPrivate.id) && list.items.some((item) => item.id === guestOwn.id));
  // participants: own and what is shared with their team; no Higgsfield (templates and workflows); other teams' and internal ones not
  list = await service.listRunnable(v.p1, {});
  assert.deepEqual(list.items.filter((item) => item.kind === 'template').map((item) => item.id).sort(), ['free-text', 'paid-image', 'paid-unknown', 'twin']);
  assert.deepEqual(list.items.filter((item) => item.kind === 'workflow').map((item) => item.id).sort(), [p1Own.id, p2Shared.id].sort());
  assert.ok(!list.items.some((item) => item.id === p1Hf.id), 'own Higgsfield workflow is not offered to a participant');
  assert.deepEqual(list.items.filter((item) => item.kind === 'workflow').map((item) => item.origin).sort(), ['own', 'shared']);
  assert.deepEqual((await service.listRunnable(v.p3, {})).items.filter((item) => item.kind === 'workflow').map((item) => item.id), [p3Private.id]);
  assert.deepEqual((await service.listRunnable(v.guest, {})).items.filter((item) => item.kind === 'workflow').map((item) => item.id), [guestOwn.id]);
  assert.ok(!(await service.listRunnable(v.guest, {})).items.some((item) => item.id === 'hf-flow'));
  // an unconfirmed caller (login not confirmed while participants exist) gets nothing
  await rejects(service.listRunnable(v.anon, {}), 'LOGIN_UNCONFIRMED');
  await assert.rejects(() => service.listRunnable(null, {}), TypeError);
  // the real templates with the real node definitions: inputs and costs for all of them, no Higgsfield for participants
  const realService = runServiceLib.createRunService({ engine, store: wfStore });
  const real = await realService.listRunnable(v.s1, { lang: 'de' });
  const realTemplates = real.items.filter((item) => item.kind === 'template');
  assert.ok(realTemplates.length >= 17, `all ${realTemplates.length} real templates are listed`);
  for (const item of realTemplates) {
    assert.ok(item.inputs.length > 0 && item.outputs.length > 0, `${item.id} has inputs and outputs`);
    assert.ok(item.inputs.every((input) => input.label && input.type), `${item.id}: every input is named and typed`);
    assert.ok(['free', 'estimate', 'partial', 'unknown'].includes(item.cost.kind));
    assert.equal(item.cost.paid, item.paid);
    if (item.cost.kind === 'unknown') assert.equal(item.cost.usd, null, 'an unknown price is never 0');
  }
  const realForParticipant = await realService.listRunnable(v.p1, {});
  assert.ok(real.items.some((item) => item.id === 'dub-clip') && !realForParticipant.items.some((item) => item.id === 'dub-clip'));
  assert.ok(realTemplates.some((item) => item.cost.kind === 'free') && realTemplates.some((item) => item.cost.paid));
  // the music video (WP34): what the Director has to ask for (the song, the photo and the idea; a blank idea is missing although it
  // is a param of the planning node), the other inputs are optional; the words people search with find it, also several words in any order
  const music = realTemplates.find((item) => item.id === 'music-video');
  assert.deepEqual(music.inputs.map((input) => [input.id, input.type, input.required]), [
    ['n1.asset', 'audio', true],
    ['n2.asset', 'image', true],
    ['n5.brief', 'text', true],
    ['n4.lyrics', 'text', false],
    ['n5.characters', 'text', false],
    ['n5.shots_per_minute', 'number', false],
    ['n5.performance_share', 'number', false],
    ['n12.transition', 'select', false],
    ['n12.captions', 'select', false]
  ]);
  assert.deepEqual(music.inputs.find((input) => input.id === 'n5.shots_per_minute'), { id: 'n5.shots_per_minute', node: 'n5', param: 'shots_per_minute', label: 'Szenen pro Minute', list: false, hasValue: true, derived: false, type: 'number', required: false, integer: false, min: 6, max: 30 });
  assert.deepEqual(music.inputs.find((input) => input.id === 'n12.transition').options, ['cut', 'crossfade', 'flash']);
  assert.deepEqual(music.inputs.find((input) => input.id === 'n12.captions').options, ['off', 'karaoke', 'words', 'lines'], 'the person can switch the captions on');
  assert.equal(music.inputs.find((input) => input.id === 'n12.captions').label, 'Untertitel (Songtext im Bild)');
  assert.deepEqual(music.outputs, [{ node: 'n13', label: 'Musikvideo' }]);
  assert.equal(music.paid, true);
  assert.equal(music.cost.kind, 'unknown', 'the scenes come from the plan: no price before the run');
  for (const [query, lang] of [['Musikvideo', 'de'], ['musikvideo', 'de'], ['Music Video', 'de'], ['music video', 'en'], ['video song', 'de'], ['Song Video', 'de'], ['Videoclip', 'es']]) {
    const hits = (await realService.listRunnable(v.s1, { query, lang })).items.filter((item) => item.kind === 'template').map((item) => item.id);
    assert.ok(hits.includes('music-video'), `"${query}" (${lang}) finds the music video: ${hits}`);
  }
  // WP44: the three films in the HUD style carry the word in their names, and the description of the Suno pack names the one it leads to
  assert.deepEqual((await realService.listRunnable(v.s1, { query: 'musikvideo', lang: 'de' })).items.filter((item) => item.kind === 'template').map((item) => item.id), ['music-video', 'music-video-stills', 'music-video-hud', 'music-video-hud-elevenlabs', 'music-video-hud-suno', 'suno-song-pack'], 'a search narrows the list down');
  // the variant with moving images (WP35): the same inputs, no clips to pay for, found by the words of its name and of its price
  const stills = realTemplates.find((item) => item.id === 'music-video-stills');
  assert.deepEqual(stills.inputs.map((input) => input.id), [...music.inputs.map((input) => input.id), 'n14.enabled', 'n10.zoom'], 'the person is asked for the same things, plus the switch for the depth maps and the motion of the scenes');
  assert.equal(stills.inputs.find((input) => input.id === 'n14.enabled').type, 'boolean');
  assert.equal(stills.inputs.find((input) => input.id === 'n14.enabled').value, undefined, 'a switch holds no value in the list');
  assert.ok(stills.inputs.find((input) => input.id === 'n10.zoom').options.includes('parallax_in'));
  assert.equal(stills.name, 'Musikvideo aus Song (bewegte Bilder)');
  assert.deepEqual(stills.outputs, [{ node: 'n13', label: 'Musikvideo' }]);
  assert.equal(stills.paid, true);
  assert.equal(stills.cost.kind, 'unknown', 'the scenes come from the plan here too');
  for (const [query, lang] of [['bewegte Bilder', 'de'], ['Musikvideo günstig', 'de'], ['moving images', 'en'], ['music video cheap', 'en'], ['imágenes en movimiento', 'es']]) {
    const hits = (await realService.listRunnable(v.s1, { query, lang })).items.filter((item) => item.kind === 'template').map((item) => item.id);
    assert.deepEqual(hits, ['music-video-stills'], `"${query}" (${lang}) finds only the variant with moving images: ${hits}`);
  }
  assert.ok((await realService.listRunnable(v.s1, { query: 'günstig', lang: 'de' })).items.some((item) => item.id === 'music-video-stills'), '"günstig" alone finds it among others');

  // the films in the HUD style (WP44): the Director asks for the song (or only the idea) and the idea; the figure (Claudia), the style, the lyrics and the
  // karaoke line (off) have their values, and so have the beat effects (WP45, strong). Nothing is priced before the run: the units come from the plan.
  // With your own song the idea is optional since WP48 (an empty field: the model writes the brief from the lyrics), and the brief is shown in step 1
  const hudFilm = realTemplates.find((item) => item.id === 'music-video-hud');
  assert.deepEqual(hudFilm.inputs.map((input) => [input.id, input.type, input.required]), [
    ['n1.asset', 'audio', true],
    ['n4.brief', 'text', false],
    ['n4.figure', 'text', false],
    ['n4.theme', 'select', false],
    ['n3.lyrics', 'text', false],
    ['n17.karaoke', 'boolean', false],
    ['n17.effects', 'select', false],
    ['n4.hud_language', 'select', false]
  ]);
  assert.deepEqual(hudFilm.inputs.find((input) => input.id === 'n4.theme').options, ['hud', 'kuble']);
  assert.equal(hudFilm.inputs.find((input) => input.id === 'n4.theme').label, 'Stil');
  assert.equal(hudFilm.inputs.find((input) => input.id === 'n17.karaoke').label, 'Untertitel (Karaoke-Zeile)');
  assert.equal(hudFilm.inputs.find((input) => input.id === 'n17.karaoke').value, undefined, 'a switch holds no value in the list');
  assert.deepEqual(['options', 'label', 'hasValue'].map((key) => hudFilm.inputs.find((input) => input.id === 'n17.effects')[key]), [['off', 'subtle', 'strong'], 'Effekte', true]);
  assert.equal(hudFilm.inputs.find((input) => input.id === 'n4.figure').hasValue, true, 'the figure is Claudia unless the person writes another');
  assert.deepEqual(hudFilm.outputs.map((output) => output.node), ['n18', 'n19', 'n30', 'n20', 'n21', 'n22', 'n23', 'n24'], 'the film first, then the sheet and what is shown for the approval (the brief first)');
  assert.equal(hudFilm.outputs.find((output) => output.node === 'n30').label, 'Briefing');
  assert.deepEqual([hudFilm.name, hudFilm.paid, hudFilm.cost.kind], ['Musikvideo im HUD-Stil (eigener Song)', true, 'unknown']);
  const hudSong = realTemplates.find((item) => item.id === 'music-video-hud-elevenlabs');
  assert.deepEqual(hudSong.inputs.map((input) => [input.id, input.type, input.required]), [
    ['n25.prompt', 'text', true],
    ['n28.length', 'number', false],
    ['n26.text', 'text', false],
    ['n4.figure', 'text', false],
    ['n4.theme', 'select', false],
    ['n17.karaoke', 'boolean', false],
    ['n17.effects', 'select', false],
    ['n4.hud_language', 'select', false]
  ]);
  assert.deepEqual([hudSong.name, hudSong.paid, hudSong.cost.kind], ['Musikvideo im HUD-Stil (Song von ElevenLabs)', true, 'unknown']);
  const sunoPack = realTemplates.find((item) => item.id === 'suno-song-pack');
  assert.deepEqual(sunoPack.inputs.map((input) => [input.id, input.type, input.required]), [['n1.prompt', 'text', true], ['n2.text', 'text', false]]);
  assert.deepEqual([sunoPack.name, sunoPack.paid, sunoPack.outputs.map((output) => output.node)], ['Suno-Songpaket', true, ['n5']]);
  // the film with the song by Suno makes the same pack in its step 1: a search for the pack finds both, the film first (the order of the gallery)
  const hudSuno = realTemplates.find((item) => item.id === 'music-video-hud-suno');
  assert.deepEqual(hudSuno.inputs.map((input) => [input.id, input.type, input.required]), [
    ['n25.prompt', 'text', true],
    ['n26.text', 'text', false],
    ['n1.asset', 'audio', true],
    ['n4.figure', 'text', false],
    ['n4.theme', 'select', false],
    ['n3.lyrics', 'text', false],
    ['n17.karaoke', 'boolean', false],
    ['n17.effects', 'select', false],
    ['n4.hud_language', 'select', false]
  ]);
  assert.deepEqual(hudSuno.outputs.map((output) => output.node), ['n18', 'n19', 'n29', 'n20', 'n21', 'n22', 'n23', 'n24']);
  assert.deepEqual([hudSuno.name, hudSuno.paid, hudSuno.cost.kind], ['Musikvideo im HUD-Stil (Song von Suno)', true, 'unknown']);
  for (const [query, lang, expected] of [['Suno', 'de', ['music-video-hud-suno', 'suno-song-pack']], ['Songpaket', 'de', ['music-video-hud-suno', 'suno-song-pack']], ['Suno song pack', 'en', ['music-video-hud-suno', 'suno-song-pack']], ['paquete de canción', 'es', ['music-video-hud-suno', 'suno-song-pack']]]) {
    const hits = (await realService.listRunnable(v.s1, { query, lang })).items.filter((item) => item.kind === 'template').map((item) => item.id);
    assert.deepEqual(hits, expected, `"${query}" (${lang}) finds the song pack: ${hits}`);
  }
  for (const [query, lang] of [['HUD-Stil', 'de'], ['HUD style', 'en'], ['estilo HUD', 'es'], ['Karaoke', 'de']]) {
    const hits = (await realService.listRunnable(v.s1, { query, lang })).items.filter((item) => item.kind === 'template').map((item) => item.id);
    assert.ok(hits.includes('music-video-hud') && hits.includes('music-video-hud-elevenlabs') && hits.includes('music-video-hud-suno'), `"${query}" (${lang}) finds the films in the HUD style: ${hits}`);
  }
  assert.deepEqual((await realService.listRunnable(v.s1, { query: 'video nichts-dergleichen', lang: 'de' })).items.filter((item) => item.kind === 'template'), [], 'all words have to appear');
  assert.deepEqual((await realService.listRunnable(v.s1, { query: 'ab' })).items.filter((item) => item.kind === 'template').length > 0, true, 'a short word is searched as typed');

  /* ============ P: prepare ============ */

  const chat = await sessions.createSession({ owner: STAFF1 });
  const chatP1 = await sessions.createSession({ owner: P1 });
  const chatOther = await sessions.createSession({ owner: STAFF2 });
  const img = await sessions.saveAsset(chat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'a cat' });
  const img2 = await sessions.saveAsset(chat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'a dog' });
  const audio = await sessions.saveAsset(chat.id, { kind: 'audio', buffer: Buffer.from('abc'), ext: '.mp3', prompt: 'tune' });
  const pending = await sessions.reserveAsset(chat.id, { kind: 'image', ext: '.png', prompt: 'later' });
  const imgP1 = await sessions.saveAsset(chatP1.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'p1' });
  const imgOther = await sessions.saveAsset(chatOther.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'secret' });

  // a template becomes a new workflow of the person: owner, team, private, own backing session
  let before = await countWorkflows();
  let prepared = await service.prepare(v.s1, { templateId: 'free-text', inputs: { idea: 'a sunrise' }, lang: 'en' });
  assert.equal(prepared.created, true);
  assert.equal(prepared.origin, 'template');
  assert.equal(prepared.templateId, 'free-text');
  assert.equal(await countWorkflows(), before + 1);
  let stored = await wfStore.readWorkflow(prepared.workflowId);
  assert.equal(stored.owner, STAFF1);
  assert.equal(stored.shareMode, 'private');
  assert.deepEqual(stored.sharedWith, []);
  assert.equal(stored.name, 'Free text');
  assert.equal(stored.graph.nodes.find((item) => item.id === 'n1').params.prompt, 'a sunrise', 'the input is set (label, any case)');
  assert.equal(prepared.rev, stored.rev);
  assert.equal(prepared.sessionId, stored.sessionId);
  assert.equal((await sessions.readSessionAccess(stored.sessionId)).owner, STAFF1, 'the backing session has the owner as well');
  assert.deepEqual(prepared.inputs.map((item) => [item.id, item.applied, item.value]), [['n1.prompt', true, { text: 'a sunrise', length: 9 }]]);
  assert.deepEqual(prepared.outputs, [{ node: 'n3', label: 'Result' }]);
  assert.equal(stored.teamId, undefined, 'internal people have no team');
  // participants: the new workflow carries their team, and it appears in their list
  prepared = await service.prepare(v.p1, { templateId: 'free-text', inputs: { 'n1.prompt': 'fog' }, name: 'Mein Nebel' });
  stored = await wfStore.readWorkflow(prepared.workflowId);
  assert.equal(stored.name, 'Mein Nebel');
  assert.equal(stored.owner, P1);
  assert.equal(stored.teamId, team.id);
  assert.ok((await service.listRunnable(v.p1, {})).items.some((item) => item.id === prepared.workflowId && item.origin === 'own'));
  assert.ok(!(await service.listRunnable(v.p2, {})).items.some((item) => item.id === prepared.workflowId), 'private to the participant');
  // the name by language
  prepared = await service.prepare(v.s1, { templateId: 'free-text', inputs: { Idee: 'Nebel' }, lang: 'de' });
  assert.equal(prepared.name, 'Freier Text');
  // local mode: no owner, no team
  prepared = await service.prepare(v.local, { templateId: 'free-text', inputs: { idea: 'local' } });
  stored = await wfStore.readWorkflow(prepared.workflowId);
  assert.equal(stored.owner, undefined);
  assert.equal(stored.teamId, undefined);
  assert.ok(stored.createdBy === 'lokal');
  // WP38d: "auto" (same as input) is an option of the language inputs of the explainer templates like en, de and es, for the Director and
  // the MCP tools as well; anything else is refused before a workflow is made
  prepared = await realService.prepare(v.s1, { templateId: 'explainer-script-topic', inputs: { 'n1.prompt': 'Wie funktioniert Git und GitHub', 'n6.prompt': 'Für Einsteiger', 'n3.language': 'auto', 'n2.language': 'es' }, lang: 'de' });
  stored = await wfStore.readWorkflow(prepared.workflowId);
  assert.equal(stored.graph.nodes.find((item) => item.id === 'n3').params.language, 'auto');
  assert.equal(stored.graph.nodes.find((item) => item.id === 'n2').params.language, 'es');
  assert.deepEqual(prepared.inputs.filter((item) => item.param === 'language').map((item) => [item.id, item.options]), [['n3.language', ['auto', 'en', 'de', 'es']], ['n2.language', ['auto', 'en', 'de', 'es']]]);
  before = await countWorkflows();
  await rejects(realService.prepare(v.s1, { templateId: 'explainer-script-topic', inputs: { 'n1.prompt': 'x', 'n6.prompt': 'y', 'n3.language': 'fr' } }), 'INVALID_INPUT', (err) => {
    assert.equal(err.reason, 'invalid_option');
    assert.deepEqual(err.options, ['auto', 'en', 'de', 'es']);
  });
  assert.equal(await countWorkflows(), before, 'nothing was created');

  // media: copied from the chat into the backing session, with the other inputs mapped by label and id
  prepared = await service.prepare(v.s1, {
    templateId: 'paid-image',
    sourceSessionId: chat.id,
    inputs: { photo: img.id, WISH: 'neon rain', 'n3.seconds': 7, style: 'hard', loud: 'true' }
  });
  stored = await wfStore.readWorkflow(prepared.workflowId);
  const imageParam = stored.graph.nodes.find((item) => item.id === 'n1').params.asset;
  assert.equal(imageParam.sessionId, stored.sessionId, 'the file lives in the workflow');
  assert.equal(imageParam.type, 'image');
  assert.notEqual(imageParam.assetId, undefined);
  assert.ok(fs.readFileSync(path.join(sessions.sessionAssetDir(stored.sessionId), imageParam.file)).equals(PNG), 'the file was copied');
  assert.equal((await sessions.readLedger(chat.id)).length, 4, 'the chat is untouched (copy, not move)');
  const params3 = stored.graph.nodes.find((item) => item.id === 'n3').params;
  assert.deepEqual([params3.seconds, params3.style, params3.loud], [7, 'hard', true]);
  assert.equal(stored.graph.nodes.find((item) => item.id === 'n2').params.prompt, 'neon rain');
  assert.equal(prepared.inputs.find((item) => item.id === 'n1.asset').value.assetId, imageParam.assetId);
  assert.ok(prepared.inputs.find((item) => item.id === 'n1.asset').value.url.startsWith(`/assets/${chat.id}/`), 'the card shows the file at its address in the chat, not in the session behind the workflow');
  assert.ok(!JSON.stringify(prepared.inputs.find((item) => item.id === 'n1.asset').value.url).includes(stored.sessionId));
  assert.equal(prepared.inputs.find((item) => item.id === 'n4'), undefined);
  assert.deepEqual(prepared.inputs.filter((item) => item.applied).map((item) => item.id), ['n1.asset', 'n2.prompt', 'n3.seconds', 'n3.style', 'n3.loud']);

  // refused: foreign chats and files, nothing is created
  before = await countWorkflows();
  const sourceErr = (inputs, sourceSessionId) => service.prepare(v.s1, { templateId: 'paid-image', sourceSessionId, inputs });
  await rejects(sourceErr({ photo: imgOther.id }, chatOther.id), 'NOT_FOUND', (err) => assert.match(err.message, /Chat not found/));
  await rejects(sourceErr({ photo: img.id }, 'no-such-chat'), 'NOT_FOUND');
  await rejects(sourceErr({ photo: img.id }, 'bad id!'), 'INVALID_ID');
  await rejects(sourceErr({ photo: img.id }, undefined), 'INVALID_INPUT', (err) => assert.equal(err.reason, 'no_source'));
  await rejects(sourceErr({ photo: 'image-099' }, chat.id), 'INVALID_INPUT', (err) => assert.equal(err.reason, 'asset_not_found'));
  await rejects(sourceErr({ photo: audio.id }, chat.id), 'INVALID_INPUT', (err) => assert.equal(err.reason, 'wrong_type'));
  await rejects(sourceErr({ photo: pending.id }, chat.id), 'INVALID_INPUT', (err) => assert.equal(err.reason, 'asset_pending'));
  await rejects(sourceErr({ photo: [img.id, img2.id] }, chat.id), 'INVALID_INPUT', (err) => assert.equal(err.reason, 'too_many'));
  await rejects(sourceErr({ photo: 42 }, chat.id), 'INVALID_INPUT');
  // a participant cannot take a file from the chat of somebody else either
  await rejects(service.prepare(v.p1, { templateId: 'paid-image', sourceSessionId: chat.id, inputs: { photo: img.id } }), 'NOT_FOUND');
  assert.equal(await countWorkflows(), before, 'nothing was created for a refused request');

  // invalid inputs: refused before anything is created
  const bad = (inputs, code, check, template = 'paid-image', extra = {}) =>
    rejects(service.prepare(v.s1, { templateId: template, sourceSessionId: chat.id, inputs, ...extra }), code, check);
  await bad({ photo: img.id, nothing: 'x' }, 'INVALID_INPUT', (err) => assert.equal(err.reason, 'unknown_input'));
  await bad({ photo: img.id, seconds: 11 }, 'INVALID_INPUT', (err) => {
    assert.equal(err.reason, 'out_of_range');
    assert.equal(err.max, 10);
  });
  await bad({ photo: img.id, seconds: 2.5 }, 'INVALID_INPUT', (err) => assert.equal(err.reason, 'wrong_type'));
  await bad({ photo: img.id, seconds: 'many' }, 'INVALID_INPUT', (err) => assert.equal(err.reason, 'wrong_type'));
  await bad({ photo: img.id, style: 'medium' }, 'INVALID_INPUT', (err) => {
    assert.equal(err.reason, 'invalid_option');
    assert.deepEqual(err.options, ['soft', 'hard']);
  });
  await bad({ photo: img.id, loud: 'maybe' }, 'INVALID_INPUT', (err) => assert.equal(err.reason, 'wrong_type'));
  await bad({ photo: img.id, wish: { text: 'x' } }, 'INVALID_INPUT', (err) => assert.equal(err.reason, 'wrong_type'));
  await bad({ photo: img.id, wish: 'x'.repeat(20001) }, 'INVALID_INPUT', (err) => assert.equal(err.reason, 'too_long'));
  await bad({ photo: img.id, 'n1.asset': img.id }, 'INVALID_INPUT', (err) => assert.equal(err.reason, 'duplicate'));
  await bad({ same: 'x' }, 'INVALID_INPUT', (err) => assert.equal(err.reason, 'ambiguous'), 'twin');
  await bad({ wish: 'only a wish' }, 'MISSING_INPUT', (err) => assert.deepEqual(err.missing.map((item) => item.id), ['n1.asset']));
  await bad({}, 'MISSING_INPUT', null, 'free-text');
  await bad({ idea: '   ' }, 'MISSING_INPUT', null, 'free-text');
  await rejects(service.prepare(v.s1, { templateId: 'nothing-like-it' }), 'NOT_FOUND');
  await rejects(service.prepare(v.s1, {}), 'INVALID_REQUEST');
  await rejects(service.prepare(v.s1, { templateId: 'free-text', workflowId: own.id }), 'INVALID_REQUEST');
  await rejects(service.prepare(v.s1, { templateId: 'free-text', inputs: ['x'] }), 'INVALID_REQUEST');
  await rejects(service.prepare(v.s1, { templateId: 'free-text', inputs: { idea: 'x' }, name: 5 }), 'INVALID_REQUEST');
  await rejects(service.prepare(v.s1, { workflowId: 'bad id' }), 'INVALID_ID');
  assert.equal(await countWorkflows(), before, 'nothing was created for invalid inputs');
  // a file that vanished from the disk after it was listed: refused, the new workflow is removed again
  const ghost = await sessions.saveAsset(chat.id, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'ghost' });
  await fsp.rm(path.join(sessions.sessionAssetDir(chat.id), ghost.file));
  await bad({ photo: ghost.id }, 'INVALID_INPUT', (err) => assert.equal(err.reason, 'asset_unavailable'));
  assert.equal(await countWorkflows(), before, 'the half-made workflow was deleted');
  // WP48: the film in the HUD style with your own song starts without an idea (the model writes the brief from the lyrics); the film with the song by
  // ElevenLabs still needs it (the idea makes the song), so does the one with the song by Suno (the idea makes the song pack)
  for (const template of ['music-video-hud-elevenlabs', 'music-video-hud-suno']) {
    const inputs = template === 'music-video-hud-suno' ? { 'n1.asset': audio.id } : {};
    await rejects(realService.prepare(v.s1, { templateId: template, sourceSessionId: chat.id, inputs, lang: 'de' }), 'MISSING_INPUT', (err) => assert.deepEqual(err.missing.map((item) => item.id), ['n25.prompt'], template));
  }
  assert.equal(await countWorkflows(), before, 'nothing was created without the idea');
  prepared = await realService.prepare(v.s1, { templateId: 'music-video-hud', sourceSessionId: chat.id, inputs: { 'n1.asset': audio.id }, lang: 'de' });
  assert.equal(prepared.created, true);
  stored = await wfStore.readWorkflow(prepared.workflowId);
  assert.equal(stored.graph.nodes.find((item) => item.id === 'n4').params.brief, '', 'the idea stays empty');
  assert.equal(stored.graph.nodes.find((item) => item.id === 'n1').params.asset.type, 'audio');
  assert.deepEqual(prepared.inputs.filter((item) => item.applied).map((item) => item.id), ['n1.asset']);
  assert.equal(await countWorkflows(), before + 1, 'one workflow for the film without an idea');

  // existing workflows: own and shared are used as they are (inputs set in place), foreign ones refused
  const rev0 = (await wfStore.readWorkflow(own.id)).rev;
  prepared = await service.prepare(v.s1, { workflowId: own.id, inputs: { 'a.prompt': 'changed' } });
  assert.equal(prepared.created, false);
  assert.equal(prepared.origin, 'workflow');
  assert.equal(prepared.workflowId, own.id);
  assert.equal((await wfStore.readWorkflow(own.id)).graph.nodes.find((item) => item.id === 'a').params.prompt, 'changed');
  assert.equal(prepared.rev, rev0 + 1);
  assert.equal(prepared.name, 'Mein Ablauf', 'an existing workflow keeps its name');
  prepared = await service.prepare(v.s1, { workflowId: sharedTeam.id, inputs: { prompt: 'by a colleague' } });
  assert.equal(prepared.created, false, 'a workflow shared with the person is used as it is');
  await rejects(service.prepare(v.s1, { workflowId: foreignPrivate.id }), 'WORKFLOW_NOT_FOUND');
  await rejects(service.prepare(v.admin, { workflowId: foreignPrivate.id }), 'WORKFLOW_NOT_FOUND', null, 'an admin starts their own and shared workflows, not the private ones of others');
  await rejects(service.prepare(v.s1, { workflowId: 'wf-does-not-exist' }), 'WORKFLOW_NOT_FOUND');
  await rejects(service.prepare(v.p1, { workflowId: own.id }), 'WORKFLOW_NOT_FOUND');
  await rejects(service.prepare(v.p1, { workflowId: sharedTeam.id }), 'WORKFLOW_NOT_FOUND', null, 'a participant does not get what is shared with all internal people');
  await rejects(service.prepare(v.p3, { workflowId: p2Shared.id }), 'WORKFLOW_NOT_FOUND', null, 'another team');
  prepared = await service.prepare(v.p1, { workflowId: p2Shared.id });
  assert.equal(prepared.created, false, 'a participant uses what is shared with their team');
  // derived inputs set by label
  prepared = await service.prepare(v.s1, { workflowId: noApp.id, sourceSessionId: chat.id, inputs: { 'Image input': img2.id, 'Number input': 9, 't1.prompt': 'derived' } });
  stored = await wfStore.readWorkflow(noApp.id);
  assert.equal(stored.graph.nodes.find((item) => item.id === 'num').params.value, 9);
  assert.equal(stored.graph.nodes.find((item) => item.id === 'i1').params.asset.sessionId, stored.sessionId);
  // Higgsfield: refused for participants (template and workflow), allowed for internal people
  await rejects(service.prepare(v.p1, { templateId: 'hf-flow' }), 'FORBIDDEN_FOR_ROLE');
  await rejects(service.prepare(v.p1, { workflowId: p1Hf.id }), 'FORBIDDEN_FOR_ROLE');
  await rejects(service.prepare(v.guest, { templateId: 'hf-flow' }), 'FORBIDDEN_FOR_ROLE');
  assert.equal((await service.prepare(v.s1, { templateId: 'hf-flow' })).created, true);
  // an unconfirmed caller
  await rejects(service.prepare(v.anon, { templateId: 'free-text', inputs: { idea: 'x' } }), 'LOGIN_UNCONFIRMED');

  /* ============ E: estimate ============ */

  let view = await service.estimate(v.s1, own.id);
  assert.equal(view.paid, false);
  assert.equal(view.canStart, true);
  assert.equal(view.valid, true);
  assert.deepEqual(view.blockers, []);
  assert.equal(view.totals.paidNodes, 0);
  assert.equal(view.totals.usd, 0);
  assert.equal(view.totals.runSteps, 3);
  assert.equal(view.totals.localSteps, 3);
  assert.equal(view.budget, null, 'internal people have no budget');
  assert.deepEqual(view.steps.map((step) => [step.nodeId, step.runs, step.paid]), [['a', true, false], ['b', true, false], ['c', true, false]]);
  assert.equal(view.steps[2].label, 'Out');
  assert.equal(view.rev, (await wfStore.readWorkflow(own.id)).rev);
  // paid with an estimate
  view = await service.estimate(v.s1, sharedSpecific.id);
  assert.equal(view.paid, true);
  assert.equal(view.totals.paidNodes, 1);
  assert.equal(view.totals.usd, 0.5);
  assert.equal(view.totals.usdKnown, true);
  assert.equal(view.totals.localSteps, 2);
  assert.deepEqual(view.steps.find((step) => step.paid), { nodeId: 'b', type: 't.paid', label: 't.paid', status: 'stale', runs: true, paid: true, executions: 1, usd: 0.5, credits: null });
  // paid without a price: unknown, never 0
  const unknownFlow = await service.prepare(v.s1, { templateId: 'paid-unknown' });
  view = await service.estimate(v.s1, unknownFlow.workflowId);
  assert.equal(view.paid, true);
  assert.equal(view.totals.unknownNodes, 1);
  assert.equal(view.totals.usdKnown, false);
  assert.equal(view.steps.find((step) => step.paid).usd, null);
  // what blocks a start
  const incomplete = await service.prepare(v.s1, { templateId: 'paid-image', sourceSessionId: chat.id, inputs: { photo: img.id } });
  await wfStore.saveGraph(incomplete.workflowId, {
    baseRev: incomplete.rev,
    graph: { ...(await wfStore.readWorkflow(incomplete.workflowId)).graph, nodes: (await wfStore.readWorkflow(incomplete.workflowId)).graph.nodes.map((item) => (item.id === 'n1' ? { ...item, params: { asset: null } } : item)) }
  });
  view = await service.estimate(v.s1, incomplete.workflowId);
  assert.equal(view.valid, false);
  assert.equal(view.canStart, false);
  assert.equal(view.blockers[0].code, 'INVALID_GRAPH');
  assert.ok(view.issues.some((issue) => issue.level === 'error' && issue.nodeId === 'n1'));
  const unavailable = await mk(STAFF1, 'Nicht verfügbar', { nodes: [node('a', 'input.prompt', { prompt: 'x' }), node('u', 't.unavail', {}, 200, 0), node('c', 'output.result', {}, 400, 0)], edges: [edge('e1', 'a', 'prompt', 'u', 'in'), edge('e2', 'u', 'out', 'c', 'inputs')] });
  view = await service.estimate(v.s1, unavailable.id);
  assert.equal(view.canStart, false);
  assert.equal(view.blockers.find((item) => item.code === 'NODE_UNAVAILABLE').nodes[0], 'u');
  await rejects(service.estimate(v.s1, foreignPrivate.id), 'WORKFLOW_NOT_FOUND');
  await rejects(service.estimate(v.s1, 'nope'), 'WORKFLOW_NOT_FOUND');
  await rejects(service.estimate(v.p1, p1Hf.id), 'FORBIDDEN_FOR_ROLE');
  // participants: the budget line, the amount left and what is short
  const p1Paid = await service.prepare(v.p1, { templateId: 'paid-image', sourceSessionId: chatP1.id, inputs: { photo: imgP1.id } });
  view = await service.estimate(v.p1, p1Paid.workflowId);
  assert.equal(view.budget.limitUsd, 5);
  assert.equal(view.budget.remainingUsd, 5);
  assert.equal(view.budget.estimateUsd, 0.5);
  assert.equal(view.budget.enough, true);
  assert.equal(view.canStart, true);

  /* ============ S: start ============ */

  // a free run starts without an amount, and with maxUsd 0 ("free only")
  gate.current = null;
  let started = await service.start(v.s1, own.id);
  assert.equal(started.paid, false);
  assert.ok(started.runId);
  let finished = await engine.whenFinished(own.id, started.runId);
  assert.equal(finished.status, 'completed');
  started = await service.start(v.s1, own.id, { maxUsd: 0 });
  assert.equal((await engine.whenFinished(own.id, started.runId)).status, 'completed', 'a second run of cached nodes completes at once');
  // a paid run does not start without the accepted amount
  const paidCallsBefore = calls.paid;
  await rejects(service.start(v.s1, sharedSpecific.id), 'CONFIRMATION_REQUIRED', (err) => assert.equal(err.estimateUsd, 0.5));
  await rejects(service.start(v.s1, sharedSpecific.id, { maxUsd: 0 }), 'COST_CHANGED', (err) => assert.equal(err.estimateUsd, 0.5), 'the amount of a free-only start is checked against the plan');
  await rejects(service.start(v.s1, sharedSpecific.id, { maxUsd: 0.49 }), 'COST_CHANGED');
  await rejects(service.start(v.s1, unknownFlow.workflowId, { maxUsd: 5 }), 'COST_CHANGED', (err) => assert.equal(err.unknownNodes, 1), 'an unknown price is not covered by an amount');
  await rejects(service.start(v.s1, own.id, { maxUsd: -1 }), 'INVALID_REQUEST');
  await rejects(service.start(v.s1, own.id, { maxUsd: '1' }), 'INVALID_REQUEST');
  await rejects(service.start(v.s1, own.id, { rev: 0.5 }), 'INVALID_REQUEST');
  await rejects(service.start(v.s1, own.id, { rev: (await wfStore.readWorkflow(own.id)).rev + 5 }), 'REV_CONFLICT', null, 'the workflow changed since the person looked at it');
  assert.equal(calls.paid, paidCallsBefore, 'no paid step ran for any refused start');
  assert.deepEqual(await wfStore.listRuns(sharedSpecific.id), [], 'no run was recorded for a refused start');
  // a workflow that became paid after the card showed "free": maxUsd 0 refuses it
  const wasFree = await mk(STAFF1, 'War kostenlos', freeGraph());
  await wfStore.saveGraph(wasFree.id, { baseRev: wasFree.rev, graph: paidGraph() });
  await rejects(service.start(v.s1, wasFree.id, { maxUsd: 0 }), 'COST_CHANGED');
  // a price in credits is not covered by dollars: it needs the credits the person accepted (nothing given counts as 0)
  await rejects(service.start(v.s1, hfOwn.id), 'CONFIRMATION_REQUIRED', (err) => assert.equal(err.estimateCredits, 2));
  await rejects(service.start(v.s1, hfOwn.id, { maxUsd: 0 }), 'COST_CHANGED', (err) => assert.deepEqual([err.estimateCredits, err.maxCredits, err.estimateUsd], [2, 0, 0]), 'maxUsd 0 is not "free" for a run that costs credits');
  await rejects(service.start(v.s1, hfOwn.id, { maxUsd: 100 }), 'COST_CHANGED');
  await rejects(service.start(v.s1, hfOwn.id, { maxUsd: 0, maxCredits: 1.5 }), 'COST_CHANGED');
  await rejects(service.start(v.s1, hfOwn.id, { maxCredits: -1 }), 'INVALID_REQUEST');
  await rejects(service.start(v.s1, hfOwn.id, { maxCredits: '2' }), 'INVALID_REQUEST');
  // the start without a click (requireFree) refuses every run that has paid steps, whatever amounts are given
  await rejects(service.start(v.s1, hfOwn.id, { maxUsd: 0, requireFree: true }), 'COST_CHANGED');
  await rejects(service.start(v.s1, hfOwn.id, { maxUsd: 100, maxCredits: 100, maxUnknownNodes: 5, requireFree: true }), 'COST_CHANGED');
  await rejects(service.start(v.s1, sharedSpecific.id, { maxUsd: 100, requireFree: true }), 'COST_CHANGED');
  await rejects(service.start(v.s1, unknownFlow.workflowId, { maxUsd: 100, maxUnknownNodes: 5, requireFree: true }), 'COST_CHANGED');
  await rejects(service.start(v.s1, wasFree.id, { requireFree: true }), 'COST_CHANGED');
  assert.equal(calls.hf, 0, 'no credits were spent for any refused start');
  // a run that is free starts with requireFree
  const stillFree = await mk(STAFF1, 'Bleibt kostenlos', freeGraph());
  started = await service.start(v.s1, stillFree.id, { requireFree: true });
  assert.equal(started.paid, false);
  assert.equal((await engine.whenFinished(stillFree.id, started.runId)).status, 'completed');
  // an invalid plan never starts
  await rejects(service.start(v.s1, incomplete.workflowId, { maxUsd: 5 }), 'INVALID_GRAPH', (err) => assert.ok(err.issues.length));
  await rejects(service.start(v.s1, unavailable.id, { maxUsd: 0 }), 'NODE_UNAVAILABLE');
  await rejects(service.start(v.s1, foreignPrivate.id), 'WORKFLOW_NOT_FOUND');
  await rejects(service.start(v.p1, p1Hf.id, { maxUsd: 0 }), 'FORBIDDEN_FOR_ROLE');
  assert.equal(calls.hf, 0, 'Higgsfield was never called for a participant');
  // the accepted credits are enough: the run starts
  const hfRun = await service.start(v.s1, hfOwn.id, { maxUsd: 0, maxCredits: 2 });
  assert.deepEqual([hfRun.paid, hfRun.totals.credits, hfRun.totals.usd], [true, 2, 0]);
  assert.equal((await engine.whenFinished(hfOwn.id, hfRun.runId)).status, 'completed');
  assert.equal(calls.hf, 1);
  // the accepted amount is enough: the run starts and pays what the plan said
  const gateOne = openGate();
  started = await service.start(v.s1, sharedSpecific.id, { maxUsd: 0.5 });
  assert.equal(started.totals.usd, 0.5);
  await waitFor(() => gate.started >= 1, 'the paid step');
  // two starts at the same time on one workflow: one run (the other one is refused), also for a second click
  const twin = await mk(STAFF1, 'Doppelklick', freeGraph());
  const raced = await Promise.allSettled([service.start(v.s1, twin.id), service.start(v.s1, twin.id), service.start(v.s1, twin.id, { maxUsd: 0 })]);
  assert.equal(raced.filter((item) => item.status === 'fulfilled').length, 1, 'only one start wins');
  for (const item of raced.filter((entry) => entry.status === 'rejected')) assert.equal(item.reason.code, 'RUN_ACTIVE');
  await waitFor(async () => (await wfStore.listRuns(twin.id)).every((item) => item.status !== 'running'), 'the race run to end');
  assert.equal((await wfStore.listRuns(twin.id)).length, 1);
  // a workflow with an active run: prepare and a second start are refused
  await rejects(service.start(v.s1, sharedSpecific.id, { maxUsd: 0.5 }), 'RUN_ACTIVE');
  await rejects(service.prepare(v.s1, { workflowId: sharedSpecific.id, inputs: { prompt: 'while running' } }), 'RUN_ACTIVE', (err) => assert.equal(err.runId, started.runId));
  assert.ok((await service.estimate(v.s1, sharedSpecific.id)).blockers.some((item) => item.code === 'RUN_ACTIVE'));

  // findRun: the run of a workflow that is active, or started since a time (a caller that lost the id of its start)
  const foundRun = await service.findRun(v.s1, sharedSpecific.id, {});
  assert.deepEqual(foundRun, { runId: started.runId, workflowId: sharedSpecific.id });
  await rejects(service.findRun(v.s1, foreignPrivate.id, {}), 'WORKFLOW_NOT_FOUND');
  assert.equal(await service.findRun(v.s1, wasFree.id, { since: new Date().toISOString() }), null, 'no run, none found');
  const lateOne = await service.findRun(v.s1, stillFree.id, { since: new Date(Date.now() - 60000).toISOString() });
  assert.ok(lateOne && lateOne.workflowId === stillFree.id, 'a run started since the time is found');
  assert.equal(await service.findRun(v.s1, stillFree.id, { since: new Date(Date.now() + 60000).toISOString() }), null, 'a run from before the time is not');

  // prepare for a run that cannot start: a workflow made for it is removed, the inputs set in an existing one are taken back
  const unavailableRev = (await wfStore.readWorkflow(unavailable.id)).rev;
  await rejects(service.prepare(v.s1, { workflowId: unavailable.id, inputs: { 'a.prompt': 'changed by the Director' }, requireStartable: true }), 'NODE_UNAVAILABLE');
  const afterRefused = await wfStore.readWorkflow(unavailable.id);
  assert.equal(afterRefused.graph.nodes.find((item) => item.id === 'a').params.prompt, 'x', 'the input is back as it was');
  assert.ok(afterRefused.rev > unavailableRev, 'the way back is a save of its own');
  // without a refusal the inputs stay (that is the point of prepare)
  const keepsInputs = await service.prepare(v.s1, { workflowId: own.id, inputs: { 'a.prompt': 'kept' }, requireStartable: true });
  assert.equal(keepsInputs.inputsSet, true);
  assert.equal((await wfStore.readWorkflow(own.id)).graph.nodes.find((item) => item.id === 'a').params.prompt, 'kept');
  assert.equal((await service.prepare(v.s1, { workflowId: own.id, requireStartable: true })).inputsSet, false, 'nothing given, nothing set');

  // discardPrepared: only a workflow that prepare created from a template for this person, and only when it has no run
  const madeHere = await service.prepare(v.s1, { templateId: 'free-text', inputs: { idea: 'weg damit' } });
  assert.equal(madeHere.created, true);
  assert.equal(await service.discardPrepared(v.s2, madeHere), false, 'not for another person');
  assert.ok((await wfStore.listWorkflows()).some((item) => item.id === madeHere.workflowId));
  assert.equal(await service.discardPrepared(v.s1, madeHere), true);
  assert.ok(!(await wfStore.listWorkflows()).some((item) => item.id === madeHere.workflowId), 'the workflow is gone');
  assert.equal(await service.discardPrepared(v.s1, madeHere), false, 'a second call does nothing');
  const existingPrepared = await service.prepare(v.s1, { workflowId: own.id });
  assert.equal(existingPrepared.created, false);
  assert.equal(await service.discardPrepared(v.s1, existingPrepared), false, 'an existing workflow is never removed');
  assert.equal(await service.discardPrepared(v.s1, { created: true, workflowId: own.id }), false, 'nor one that was not created here');
  assert.equal(await service.discardPrepared(v.s1, { created: true, workflowId: 'bad id' }), false);
  assert.equal(await service.discardPrepared(v.s1, null), false);
  const ranOnce = await service.prepare(v.s1, { templateId: 'free-text', inputs: { idea: 'lief schon' } });
  const ranOnceRun = await service.start(v.s1, ranOnce.workflowId, { requireFree: true });
  await engine.whenFinished(ranOnce.workflowId, ranOnceRun.runId);
  assert.equal(await service.discardPrepared(v.s1, ranOnce), false, 'a workflow with a run stays');

  /* ============ R: status and cancel ============ */

  let state = await service.status(v.s1, started.runId, { workflowId: sharedSpecific.id });
  assert.equal(state.status, 'running');
  assert.equal(state.finished, false);
  assert.equal(state.step.total, 3);
  assert.ok(state.step.done >= 1 && state.step.done < 3);
  assert.deepEqual(state.running, ['t.paid']);
  assert.equal(state.outputs, undefined);
  assert.equal(state.workflowName, 'Direkt geteilt');
  // without the workflow id (a fresh service knows no run): found in the store
  const fresh = runServiceLib.createRunService({ engine, store: wfStore, registry, templates: templateDeps });
  assert.equal((await fresh.status(v.s1, started.runId)).runId, started.runId);
  // the colleague it is shared with sees the run; strangers do not know it exists
  assert.equal((await service.status(v.s2, started.runId)).status, 'running');
  await rejects(fresh.status(v.p1, started.runId), 'RUN_NOT_FOUND');
  await rejects(fresh.status(v.guest, started.runId), 'RUN_NOT_FOUND');
  await rejects(fresh.cancel(v.p1, started.runId), 'RUN_NOT_FOUND');
  await rejects(service.status(v.s1, 'r-unknown-0000'), 'RUN_NOT_FOUND');
  await rejects(service.status(v.s1, 'bad id'), 'INVALID_ID');
  await rejects(service.status(v.s1, started.runId, { workflowId: own.id }), 'RUN_NOT_FOUND', null, 'the run is not in that workflow');
  await rejects(service.status(v.anon, started.runId), 'LOGIN_UNCONFIRMED');
  // let it finish: completed, the effective cost, the outputs
  gateOne.release();
  const done = await engine.whenFinished(sharedSpecific.id, started.runId);
  assert.equal(done.status, 'completed');
  gate.current = null;
  state = await service.status(v.s1, started.runId);
  assert.equal(state.status, 'completed');
  assert.equal(state.finished, true);
  assert.equal(state.cost.usd, 0.4, 'the effective cost, not the estimate');
  assert.equal(state.step.done, state.step.total);
  assert.ok(Number.isFinite(state.durationMs));
  assert.equal(state.outputs.length, 1);
  assert.equal(state.outputs[0].label, 'Out');
  assert.equal(state.outputs[0].costUsd, null, 'the output node itself costs nothing');
  assert.deepEqual(state.outputs[0].items.map((item) => [item.type, item.text]), [['text', 'paid:hello']]);
  assert.deepEqual(state.failures, []);
  // the next run of the same, unchanged workflow: nothing to pay, the plan says "up to date"
  view = await service.estimate(v.s1, sharedSpecific.id);
  assert.equal(view.upToDate, true);
  assert.equal(view.paid, false);

  // cancel: the run stops, the status says so, finished runs cannot be cancelled again
  const gateTwo = openGate();
  const slow = await mk(STAFF1, 'Langsam', paidGraph());
  const slowRun = await service.start(v.s1, slow.id, { maxUsd: 0.5 });
  await waitFor(() => gate.started >= 2, 'the second paid step');
  const cancelled = await service.cancel(v.s1, slowRun.runId, { workflowId: slow.id });
  assert.equal(cancelled.cancelled, true);
  assert.equal((await engine.whenFinished(slow.id, slowRun.runId)).status, 'cancelled');
  state = await service.status(v.s1, slowRun.runId);
  assert.equal(state.status, 'cancelled');
  assert.equal(state.outputs, undefined);
  assert.equal((await service.cancel(v.s1, slowRun.runId)).cancelled, false);
  gateTwo.release();
  gate.current = null;
  // a failed run: the reason in plain words, the failing step named
  registry.register({ type: 't.boom', category: 'text', inputs: [{ id: 'in', type: 'text' }], outputs: [{ id: 'out', type: 'text' }], execute: async () => { throw new Error('the model said no'); } });
  const boomFlow = await mk(STAFF1, 'Boom', { nodes: [node('a', 'input.prompt', { prompt: 'x' }), node('b', 't.boom', { }, 200, 0), node('c', 'output.result', {}, 400, 0)], edges: [edge('e1', 'a', 'prompt', 'b', 'in'), edge('e2', 'b', 'out', 'c', 'inputs')] });
  const boom = await service.start(v.s1, boomFlow.id);
  await engine.whenFinished(boomFlow.id, boom.runId);
  state = await service.status(v.s1, boom.runId);
  assert.equal(state.status, 'failed');
  assert.match(state.error, /the model said no/);
  assert.equal(state.failures[0].nodeId, 'b');
  assert.equal(state.failures[0].message, 'the model said no');
  assert.equal(state.nodes.find((item) => item.nodeId === 'c').status, 'skipped');
  // outputs with media and a 3D model: the reference into the backing session, the cost, 3D is not sendable to the chat
  const mediaFlow = await mk(STAFF1, 'Mit Bild', freeGraph());
  const mediaSession = (await wfStore.readWorkflow(mediaFlow.id)).sessionId;
  const stub = await sessions.saveAsset(mediaSession, { kind: 'image', buffer: PNG, ext: '.png', prompt: 'result' });
  const glb = await sessions.saveAsset(mediaSession, { kind: 'model3d', buffer: Buffer.from('glTF'), ext: '.glb', prompt: 'model' });
  const entry = await wfStore.appendHistory(mediaFlow.id, 'c', {
    runId: 'r-manual-0001',
    createdAt: new Date().toISOString(),
    cost: { usd: 0.25, credits: null },
    variants: [{ result: types.listValue('any', [{ type: 'image', sessionId: mediaSession, assetId: stub.id, file: stub.file, url: stub.url }, { type: 'model3d', sessionId: mediaSession, assetId: glb.id, file: glb.file, url: glb.url }, textValue('note')]) }]
  });
  await wfStore.writeRun(mediaFlow.id, {
    id: 'r-manual-0001',
    workflowId: mediaFlow.id,
    mode: 'all',
    targets: ['c'],
    user: STAFF1,
    status: 'completed',
    startedAt: new Date(Date.now() - 4000).toISOString(),
    finishedAt: new Date().toISOString(),
    nodes: { c: { status: 'done', entry: entry.entry.id } },
    cost: { usd: 0.25, credits: 0 },
    error: null
  });
  state = await service.status(v.s1, 'r-manual-0001');
  assert.equal(state.cost.usd, 0.25);
  assert.equal(state.outputs[0].costUsd, 0.25);
  assert.deepEqual(state.outputs[0].items.map((item) => [item.type, item.assetId || null, item.sendToChat ?? null]), [['image', stub.id, true], ['model3d', glb.id, false], ['text', null, null]]);
  assert.equal(state.outputs[0].items[0].sessionId, mediaSession);
  assert.equal(state.outputs[0].items[0].url, stub.url);

  /* ============ budget of participants ============ */

  // the run reserves the plan amount while it runs and gives it back at the end
  const gateThree = openGate();
  const p1Run = await service.start(v.p1, p1Paid.workflowId, { maxUsd: 0.5 });
  await waitFor(() => budgetLib.defaultBudget.reservedFor(P1) > 0, 'the reservation');
  assert.equal(budgetLib.defaultBudget.reservedFor(P1), 0.5, 'the plan amount is reserved for the run');
  view = await service.estimate(v.p2, p2Shared.id);
  assert.equal(view.budget.reservedUsd, 0, 'the budget is per person: the reservation of P1 does not count for P2');
  view = await service.estimate(v.p1, p1Paid.workflowId);
  assert.ok(view.blockers.some((item) => item.code === 'RUN_ACTIVE'), 'the plan says a run is active');
  assert.equal(view.budget.reservedUsd, 0.5, 'and shows the reservation of the run');
  gateThree.release();
  await engine.whenFinished(p1Paid.workflowId, p1Run.runId);
  gate.current = null;
  assert.equal(budgetLib.defaultBudget.reservedFor(P1), 0, 'the reservation is gone when the run ends');
  assert.equal((await service.status(v.p1, p1Run.runId)).status, 'completed');
  // the budget is checked again at the click: 0.6 left, a run holds 0.5, the next one for 0.5 is refused and starts nothing
  const gateFour = openGate();
  const smallOne = await service.prepare(v.p4, { templateId: 'paid-unknown' });
  await wfStore.saveGraph(smallOne.workflowId, { baseRev: smallOne.rev, graph: paidGraph() });
  const smallTwo = await mk(P4, 'Zweiter', paidGraph(), { teamId: smallTeam.id });
  view = await service.estimate(v.p4, smallTwo.id);
  assert.equal(view.budget.enough, true, 'the card was fine when it was shown');
  const paidBeforeFirst = calls.paid;
  const first = await service.start(v.p4, smallOne.workflowId, { maxUsd: 0.5 });
  await waitFor(() => budgetLib.defaultBudget.reservedFor(P4) > 0 && calls.paid === paidBeforeFirst + 1, 'the first reservation and its paid step');
  const paidBeforeRefusal = calls.paid;
  await rejects(service.start(v.p4, smallTwo.id, { maxUsd: 0.5 }), 'BUDGET_INSUFFICIENT', (err) => {
    assert.equal(err.estimateUsd, 0.5);
    assert.ok(err.remainingUsd < 0.5);
  });
  view = await service.estimate(v.p4, smallTwo.id);
  assert.equal(view.budget.enough, false);
  assert.equal(view.budget.code, 'BUDGET_INSUFFICIENT');
  assert.equal(view.canStart, false);
  assert.ok(view.blockers.some((item) => item.code === 'BUDGET_INSUFFICIENT'));
  assert.deepEqual(await wfStore.listRuns(smallTwo.id), [], 'no run for the refused start');
  assert.equal(calls.paid, paidBeforeRefusal);
  gateFour.release();
  await engine.whenFinished(smallOne.workflowId, first.runId);
  gate.current = null;

  /* ============ the instance of the server ============ */

  assert.equal(typeof runServiceLib.runService, 'function');
  const appRunService = runServiceLib.runService();
  for (const name of ['listRunnable', 'prepare', 'estimate', 'start', 'status', 'cancel']) assert.equal(typeof appRunService[name], 'function', name);
  assert.throws(() => createServiceWithoutEngine(runServiceLib), /needs an engine/);
}

function createServiceWithoutEngine(lib) {
  return lib.createRunService({});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
