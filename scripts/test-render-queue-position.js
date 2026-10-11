'use strict';

// The place of a film in the render queue (WP54): counted per film (the chunks of one node run share a group), not per chunk;
// the estimate of the wait from the length of the pages (data-duration) and the speed (2 s of render per second of film at
// the start, then measured); «starting» while a render server in the cloud boots; «rendering» with the chunk; only numbers,
// nothing about other films. The texts in three languages (public/nodes/run.js queueText), the reducer of the page, and the
// engine: a node that waits for a render of the queue sends the place with its status, and its renders carry the group.

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { Readable } = require('stream');

delete process.env.AUTH_WHOAMI_URL;

const { createRenderAgentsStore } = require('../lib/render-agents');
const { createRenderQueue, filmSecondsOf } = require('../lib/render-queue');
const { defaultMayServe } = require('../lib/rendernode');
const runLib = require('../public/nodes/run');

const MP4 = require('./support/render-test-video');
const VERSIONS = { protocol: 1, agent: '1.0.0', hyperframes: '0.8.139', node: '22.17.0' };
const page = (seconds) => `<!doctype html><html><body><div id="main-composition" data-composition-id="main" data-width="1920" data-height="1080" data-start="0" data-duration="${seconds}" data-fps="24"><video class="clip" data-start="0" data-duration="99"></video></div></body></html>`;

function setup({ standby = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocd-queue-position-'));
  const clock = { now: Date.parse('2026-10-11T10:00:00Z') };
  const now = () => clock.now;
  const agents = createRenderAgentsStore({ file: path.join(dir, 'render-agents.json'), now });
  const queue = createRenderQueue({ dir: path.join(dir, 'render-queue'), agents, mayServe: defaultMayServe, standby, now, log: { warn() {} } });
  const computer = (name) => {
    clock.now += 61 * 1000;
    const { code } = agents.createPairingCode('lokal');
    return agents.pair({ code, ip: '10.0.0.1', name, versions: VERSIONS }).agent;
  };
  // jobs of one film come one after the other (a millisecond apart, as the chunks are sent)
  const film = async (group, chunks, seconds = 20) => {
    const ids = [];
    for (let i = 0; i < chunks; i += 1) {
      clock.now += 1;
      ids.push((await queue.enqueue({ html: page(seconds), quality: 'draft', owner: 'lokal', label: `${group} ${i + 1}`, ...(group ? { group } : {}) })).jobId);
    }
    return ids;
  };
  return { dir, clock, agents, queue, computer, film };
}

const poll = (queue, agent) => queue.poll(agent, { waitMs: 0 });
const done = (queue, agent, job) => queue.acceptResult(agent, job.jobId, job.lease, Readable.from([MP4]));

function testFilmLength() {
  assert.equal(filmSecondsOf(page(21.5)), 21.5);
  assert.equal(filmSecondsOf(page('20.125')), 20.13);
  assert.equal(filmSecondsOf('<div data-duration="5"></div>'), null, 'only the root composition counts');
  assert.equal(filmSecondsOf('<html></html>'), null);
  assert.equal(filmSecondsOf(`<div data-composition-id="main" data-duration="0"></div>`), null);
}

async function testPlacePerFilm() {
  const { queue, film, computer, clock } = setup();
  const a = await film('run-a:hud', 3);
  const b = await film('run-b:event', 3);
  const [c] = await film(null, 1, 10);
  // nothing renders and nothing starts: the places, no estimate
  assert.deepEqual(queue.filmStatus({ group: 'run-a:hud' }), { phase: 'queued', position: 1, total: 3, etaSeconds: null });
  assert.deepEqual(queue.filmStatus({ group: 'run-b:event' }), { phase: 'queued', position: 2, total: 3, etaSeconds: null });
  assert.deepEqual(queue.filmStatus({ jobId: c }), { phase: 'queued', position: 3, total: 3, etaSeconds: null }, 'a job without a group is a film of its own');
  // one computer takes the first chunk of A
  const pc = computer('PC');
  const first = await poll(queue, pc);
  assert.equal(first.jobId, a[0]);
  assert.deepEqual(queue.filmStatus({ group: 'run-a:hud' }), { phase: 'rendering', chunk: 1, chunks: 3, etaSeconds: 120 }, '3 chunks of 20 s at 2 s per second');
  // B waits for all of A (120 s on one worker), C for A and B (240 s): «Platz 3 von 3, etwa 4 min»
  assert.deepEqual(queue.filmStatus({ group: 'run-b:event' }), { phase: 'queued', position: 2, total: 3, etaSeconds: 120 });
  assert.deepEqual(queue.filmStatus({ jobId: c }), { phase: 'queued', position: 3, total: 3, etaSeconds: 240 });
  // only numbers: nothing about the other films
  for (const info of [queue.filmStatus({ group: 'run-b:event' }), queue.filmStatus({ jobId: c })]) {
    assert.deepEqual(Object.keys(info).sort(), ['etaSeconds', 'phase', 'position', 'total']);
  }
  // half of the first chunk: less to wait
  queue.progress(pc, first.jobId, first.lease, { progress: 0.5 });
  assert.equal(queue.filmStatus({ group: 'run-b:event' }).etaSeconds, 105, '20 + 80 s, rounded up to 15 s');
  // the first chunk took 40 s: chunk 2 of 3
  clock.now += 40 * 1000;
  await done(queue, pc, first);
  const second = await poll(queue, pc);
  assert.equal(second.jobId, a[1]);
  assert.equal(queue.filmStatus({ group: 'run-a:hud' }).chunk, 2);
  assert.equal(queue.speed(), 2, 'the measured 2 s per second of film');
  await done(queue, pc, second);
  await done(queue, pc, await poll(queue, pc));
  // A is done: B is first
  assert.equal(queue.filmStatus({ group: 'run-a:hud' }), null, 'a finished film has no place');
  // (the computer is not waiting in a long poll here, so no worker is known and there is no estimate)
  assert.deepEqual(queue.filmStatus({ group: 'run-b:event' }), { phase: 'queued', position: 1, total: 2, etaSeconds: null });
  assert.equal(queue.filmStatus({ group: 'nope' }), null);
  assert.equal(queue.filmStatus({ group: '../../etc' }), null);
  assert.equal(queue.filmStatus({}), null);
  // a slower computer moves the speed
  clock.now += 1;
  const next = await poll(queue, pc);
  clock.now += 100 * 1000;
  await done(queue, pc, next);
  assert.equal(Math.round(queue.speed() * 100) / 100, 2.9, '100 s for 20 s of film: 0.7 × 2 + 0.3 × 5');
  assert.equal(b.length, 3);
}

async function testTwoWorkersAndCloud() {
  let cloud = null;
  const { queue, film, computer } = setup({ standby: () => cloud });
  await film('run-a:hud', 2);
  await film('run-b:hud', 2);
  // a render server boots and nothing else is there: the first film waits for it
  cloud = { available: true, starting: 1, startingSeconds: 50 };
  assert.deepEqual(queue.filmStatus({ group: 'run-a:hud' }), { phase: 'starting', position: 1, total: 2, etaSeconds: 60 }, 'about 1 min');
  // the second film waits for the server and for the first film (2 × 40 s on one worker)
  assert.deepEqual(queue.filmStatus({ group: 'run-b:hud' }), { phase: 'queued', position: 2, total: 2, etaSeconds: 135 });
  // two computers render: the wait is shared
  cloud = null;
  const one = computer('One');
  const two = computer('Two');
  await poll(queue, one);
  await poll(queue, two);
  assert.deepEqual(queue.filmStatus({ group: 'run-a:hud' }), { phase: 'rendering', chunk: 1, chunks: 2, etaSeconds: 45 }, 'two chunks at the same time: 80 s of work on 2');
  assert.deepEqual(queue.filmStatus({ group: 'run-b:hud' }), { phase: 'queued', position: 2, total: 2, etaSeconds: 45 });
}

function translator() {
  const window = {
    document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
    navigator: { language: 'de-CH' },
    localStorage: { getItem: () => null, setItem() {} }
  };
  const root = path.resolve(__dirname, '..');
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'i18n.js'), 'utf8'), { window }, { filename: 'public/i18n.js' });
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'nodes', 'i18n-nodes.js'), 'utf8'), { window }, { filename: 'public/nodes/i18n-nodes.js' });
  return (lang) => (key, vars = {}) => Object.entries(vars).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), window.I18N[lang][key] || key);
}

function testTexts() {
  const tr = translator();
  const de = tr('de');
  assert.equal(runLib.queueText({ phase: 'queued', position: 2, total: 3, etaSeconds: 225 }, de), 'In der Warteschlange: Platz 2 von 3, etwa 4 min');
  assert.equal(runLib.queueText({ phase: 'starting', position: 1, total: 1, etaSeconds: 60 }, de), 'Render-Server startet, etwa 1 min');
  assert.equal(runLib.queueText({ phase: 'rendering', chunk: 2, chunks: 3 }, de), 'Wird gerendert: Stück 2 von 3');
  assert.equal(runLib.queueText({ phase: 'rendering', chunk: 1, chunks: 1, etaSeconds: 30 }, de), 'Wird gerendert, noch etwa 1 min');
  assert.equal(runLib.queueText({ phase: 'queued', position: 1, total: 1, etaSeconds: null }, de), 'In der Warteschlange: Platz 1 von 1');
  assert.equal(runLib.queueText({ phase: 'queued', position: 2, total: 3, etaSeconds: 225 }, tr('en')), 'In the queue: place 2 of 3, about 4 min');
  assert.equal(runLib.queueText({ phase: 'rendering', chunk: 2, chunks: 3 }, tr('es')), 'Renderizando: parte 2 de 3');
  assert.equal(runLib.queueText({ phase: 'hacked', position: 1 }, de), '');
  assert.equal(runLib.queueText(null, de), '');
  // the reducer keeps the place only while the node waits for its render, and only numbers
  let state = runLib.createRunState();
  state = runLib.reduce(state, { type: 'node_status', runId: 'r1', nodeId: 'n1', status: 'waiting_job', queue: { phase: 'queued', position: 2, total: 3, etaSeconds: 225, owner: 'someone@example.com' } }, 1000);
  assert.deepEqual(state.nodes.n1.queue, { phase: 'queued', position: 2, total: 3, etaSeconds: 225 });
  state = runLib.reduce(state, { type: 'node_status', runId: 'r1', nodeId: 'n1', status: 'waiting_job' }, 2000);
  assert.equal(state.nodes.n1.queue, undefined, 'a status without the place clears it');
  state = runLib.reduce(state, { type: 'node_status', runId: 'r1', nodeId: 'n1', status: 'waiting_job', queue: { phase: 'rendering', chunk: 1, chunks: 3 } }, 3000);
  state = runLib.reduce(state, { type: 'node_status', runId: 'r1', nodeId: 'n1', status: 'running' }, 4000);
  assert.equal(state.nodes.n1.queue, undefined, 'running again: no place');
}

// The engine: the renders of a node run are one film (toolCtx.renderGroup), and a node that waits sends the place of its film.
async function testEngine() {
  const store = require('../lib/store');
  const { createRegistry } = require('../lib/nodes/registry');
  const { createEventBus } = require('../lib/nodes/events');
  const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
  const { createEngine } = require('../lib/nodes/engine');
  const { textValue } = require('../lib/nodes/types');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-queue-engine-'));
  const bus = createEventBus();
  const registry = createRegistry();
  const seen = { groups: [], jobId: null };
  registry.register({
    type: 't.render',
    category: 'video',
    outputs: [{ id: 'out', type: 'text' }],
    async: true,
    execute: async (ctx) => {
      seen.groups.push(ctx.toolCtx.renderGroup);
      const jobId = `rq-test-${ctx.nodeId}`;
      await store.mutateSession(ctx.sessionId, (session) => {
        session.jobs.push({ jobId, assetId: 'vid-001', status: 'pending', kind: 'video', renderNodeId: 'render-queue' });
      });
      seen.jobId = jobId;
      const ids = await ctx.waitForJob({ jobId });
      return { variants: [{ out: textValue(`done:${ids.join(',')}`) }] };
    }
  });
  const wfStore = createWorkflowsStore({ dir, registry, events: bus });
  // the film of the node run is in the queue from the start (its jobs were sent before the wait)
  let place = { phase: 'queued', position: 2, total: 3, etaSeconds: 225, owner: 'x@example.com' };
  const asked = [];
  const engine = createEngine({
    store: wfStore,
    registry,
    events: bus,
    getConfig: () => ({}),
    limits: { jobPollMs: 20, queuePollMs: 20 },
    filmStatus: (group) => {
      asked.push(group);
      return place;
    }
  });
  const { workflow } = await wfStore.createWorkflow({ name: 'Queue test', graph: { nodes: [{ id: 'film', type: 't.render', typeVersion: 1, x: 0, y: 0, params: {} }], edges: [] } });
  const events = [];
  bus.subscribe(workflow.id, (event) => events.push(event));
  try {
    const runId = await engine.start(workflow.id, { mode: 'all' });
    while (!seen.jobId) await new Promise((resolve) => setTimeout(resolve, 5));
    const group = `${runId}:film`;
    assert.deepEqual(seen.groups, [group], 'the renders of the node run carry its group');
    // a page with the place: the status carries it (only the numbers)
    const deadline = Date.now() + 3000;
    let withPlace = null;
    while (!withPlace && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      withPlace = events.find((event) => event.type === 'node_status' && event.nodeId === 'film' && event.queue);
    }
    assert.ok(withPlace, 'the place reaches the page');
    assert.equal(withPlace.status, 'waiting_job');
    assert.deepEqual(withPlace.queue, { phase: 'queued', position: 2, total: 3, etaSeconds: 225 });
    assert.ok(asked.every((entry) => entry === group), 'asked for its own film only');
    place = { phase: 'rendering', chunk: 2, chunks: 3, etaSeconds: 60 };
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(events.some((event) => event.queue && event.queue.phase === 'rendering' && event.queue.chunk === 2), 'a change is sent');
    const sent = events.filter((event) => event.queue).length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(events.filter((event) => event.queue).length, sent, 'unchanged: not sent again within 15 s');
    await store.mutateSession(workflow.sessionId, (session) => {
      session.jobs.find((job) => job.jobId === seen.jobId).status = 'completed';
    });
    const record = await engine.whenFinished(workflow.id, runId);
    assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
    assert.equal(record.nodes.film.queue, undefined, 'the run record does not keep the place');
    const count = asked.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(asked.length, count, 'no more lookups after the wait');
  } finally {
    await wfStore.deleteWorkflow(workflow.id).catch(() => {});
  }
  // a wait for anything else (a provider job): nothing is asked again and nothing is sent
  const quiet = [];
  const engine2 = createEngine({ store: wfStore, registry, events: bus, getConfig: () => ({}), limits: { jobPollMs: 20, queuePollMs: 20 }, filmStatus: (group) => (quiet.push(group), null) });
  const again = await wfStore.createWorkflow({ name: 'Provider test', graph: { nodes: [{ id: 'film', type: 't.render', typeVersion: 1, x: 0, y: 0, params: {} }], edges: [] } });
  seen.jobId = null;
  const events2 = [];
  bus.subscribe(again.workflow.id, (event) => events2.push(event));
  try {
    const runId = await engine2.start(again.workflow.id, { mode: 'all' });
    while (!seen.jobId) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(quiet.length, 1, 'asked once when the wait began');
    await store.mutateSession(again.workflow.sessionId, (session) => {
      session.jobs.find((job) => job.jobId === seen.jobId).status = 'completed';
    });
    await engine2.whenFinished(again.workflow.id, runId);
    assert.ok(!events2.some((event) => event.queue));
  } finally {
    await wfStore.deleteWorkflow(again.workflow.id).catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  testFilmLength();
  await testPlacePerFilm();
  await testTwoWorkersAndCloud();
  testTexts();
  await testEngine();
  console.log('Platz in der Render-Warteschlange: pro Film, mit Schätzung, Serverstart und Stück, nur Zahlen, Texte in drei Sprachen und der Status des Nodes: korrekt.');
  console.log('test-render-queue-position.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
