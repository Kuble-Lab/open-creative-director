'use strict';

// Provider calls and the session monitor are mocked; no network and no paid jobs.
const assert = require('assert/strict');
const fal = require('../lib/fal');
const queue = require('../lib/fal-run');
const jobs = require('../lib/nodes/jobs');
const store = require('../lib/store');
const budget = require('../lib/budget');
const poller = require('../lib/poller');
const { registry } = require('../lib/nodes/registry');
const engine = require('../lib/nodes/engine');
const { textValue, listValue } = require('../lib/nodes/types');
const run = require('../public/nodes/run');
const styles = require('../lib/event-video/styles');
const eventPlan = require('../lib/event-video/plan');
const openrouter = require('../lib/openrouter');
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function testCancelClient() {
  const calls = [];
  const client = fal.createFalClient({ getKey: () => 'test-key', fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify(init.method === 'POST'
      ? { request_id: 'r', status_url: 'https://queue.fal.run/test/model/requests/r/status', response_url: 'https://queue.fal.run/test/model/requests/r' }
      : { status: 'CANCELLATION_REQUESTED' }) };
  } });
  const job = await client.submit('test/model/nested', {});
  assert.equal(job.cancelUrl, 'https://queue.fal.run/test/model/requests/r/cancel');
  await client.cancelJob(job);
  assert.equal(calls[1].init.method, 'PUT');
  assert.equal(calls[1].init.headers.Authorization, 'Key test-key');
  assert.equal(calls[1].init.signal.aborted, false);
  await client.cancelJob({ statusUrl: job.statusUrl, cancelUrl: 'https://queue.fal.run/test/model/requests/custom/cancel' });
  assert.match(calls[2].url, /custom\/cancel$/);
  await assert.rejects(client.cancelJob({ cancelUrl: 'https://example.invalid/cancel' }), /ungueltig/);
  const abort = new AbortController(); abort.abort();
  const before = calls.length;
  await assert.rejects(client.submit('test/model', {}, { signal: abort.signal }), { name: 'AbortError' });
  assert.equal(calls.length, before);
}

async function testQueue() {
  const saved = { wait: jobs.waitForSessionJob, read: store.readSession, mutate: store.mutateSession, cancel: fal.cancelJob, release: budget.releaseJob, failed: poller.handleFailed };
  const records = [];
  const waits = new Map();
  const logs = [];
  const cancelled = [];
  const released = [];
  jobs.waitForSessionJob = (_sessionId, id, { signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(jobs.abortError());
    const abort = () => reject(jobs.abortError());
    signal.addEventListener('abort', abort, { once: true });
    waits.set(id, () => { signal.removeEventListener('abort', abort); records.find((job) => job.jobId === id).status = 'completed'; resolve([id]); });
  });
  store.readSession = async () => ({ jobs: records });
  store.mutateSession = async (_id, fn) => fn({ jobs: records });
  budget.releaseJob = (job) => released.push(job.assetId);
  // an accepted cancellation closes the job the way of a failed one (the poller releases the budget there)
  poller.handleFailed = async (_sessionId, job) => { const target = records.find((item) => item.assetId === job.assetId); if (target) target.status = 'failed'; budget.releaseJob(job); };
  fal.cancelJob = async (job) => {
    cancelled.push(job.assetId);
    if (job.assetId === 'a7') return { status: 'IN_PROGRESS' };
    if (job.assetId === 'a8') throw new fal.FalError('Already running (HTTP 400)', 400);
    return { status: 'CANCELLATION_REQUESTED' };
  };
  try {
    const controller = new AbortController();
    const ctx = { signal: controller.signal, nodeId: 'node', sessionId: 'session', emit: (event) => logs.push(event.label) };
    const submitted = [];
    const submit = (number) => queue.run({ ...ctx, runSignal: controller.signal, signal: new AbortController().signal }, async () => {
      submitted.push(number);
      const job = { jobId: `j${number}`, assetId: `a${number}`, source: 'fal', status: 'pending' };
      records.push(job);
      return { job };
    });
    const outcomes = Array.from({ length: 9 }, (_unused, index) => submit(index + 1).then((value) => value, (error) => error));
    await tick();
    assert.deepEqual(submitted, [1, 2, 3, 4], 'Mapped executions with distinct signals share four slots and preserve input order');
    waits.get('j2')();
    await tick();
    assert.deepEqual(submitted, [1, 2, 3, 4, 5], 'A finished job frees exactly one slot');
    for (const id of ['j1', 'j3', 'j4']) waits.get(id)();
    await tick();
    assert.deepEqual(submitted, [1, 2, 3, 4, 5, 6, 7, 8]);
    // Completed providers are skipped even when the wait has not caught up yet.
    records.find((job) => job.jobId === 'j6').status = 'completed';
    controller.abort();
    const result = await Promise.all(outcomes);
    await queue.drain(controller.signal);
    assert.equal(result[8].name, 'AbortError', 'Queued work never submits after cancellation');
    assert.deepEqual(cancelled.sort(), ['a5', 'a7', 'a8']);
    assert.deepEqual(released, ['a5']);
    assert.equal(records.find((job) => job.assetId === 'a7').status, 'pending', 'A running job stays pollable and billable');
    assert.ok(logs.some((line) => /IN_PROGRESS.*charged/.test(line)));
    assert.ok(logs.some((line) => /HTTP 400.*charged/.test(line)));
    assert.ok(logs.some((line) => /already completed/.test(line)));
    await queue.cancelJob(ctx, records.find((job) => job.assetId === 'a5'));
    assert.equal(cancelled.filter((id) => id === 'a5').length, 1, 'Cancellation is idempotent within a run');

    // Abort during submit: preserve its returned id, cancel it, and do not return a successful submission.
    const race = new AbortController();
    await assert.rejects(queue.run({ ...ctx, signal: race.signal }, async () => {
      race.abort();
      const job = { jobId: 'race', assetId: 'race', source: 'fal', status: 'pending' };
      records.push(job);
      return { job };
    }), { name: 'AbortError' });
    assert.ok(cancelled.includes('race'));
    const refused = new AbortController();
    const pending = await queue.run({ ...ctx, signal: refused.signal }, async () => {
      refused.abort();
      const job = { jobId: 'refused', assetId: 'a7', source: 'fal', status: 'pending' };
      records.push(job);
      return { job };
    });
    await queue.drain(refused.signal);
    assert.equal(pending.job.status, 'pending', 'An unconfirmed in-flight cancellation returns its job to preserve the tool budget grant');


    const resumed = new AbortController();
    const resumeCtx = { ...ctx, signal: resumed.signal, runSignal: resumed.signal };
    records.push({ jobId: 'old', assetId: 'old', source: 'fal', status: 'pending' });
    records.push({ jobId: 'cached', assetId: 'cached', source: 'fal', status: 'completed' });
    await queue.adopt(resumeCtx, { jobId: 'old', assetId: 'old' });
    await queue.adopt(resumeCtx, { jobId: 'cached', assetId: 'cached' });
    const fresh = [];
    const make = (number, nodeId = 'node') => queue.run({ ...resumeCtx, nodeId }, async () => {
      fresh.push(number);
      const job = { jobId: `new${number}`, assetId: `new${number}`, source: 'fal', status: 'pending' };
      records.push(job);
      return { job };
    }).then((value) => value, (error) => error);
    const made = [make(1), make(2), make(3), make(4)];
    await tick();
    assert.deepEqual(fresh, [1, 2, 3], 'An unfinished adopted job takes a slot, a cached result does not');
    const other = make(5, 'another-node');
    await tick();
    assert.deepEqual(fresh, [1, 2, 3, 5], 'A different node has its own slots');
    waits.get('old')();
    await tick();
    assert.deepEqual(fresh, [1, 2, 3, 5, 4]);
    resumed.abort();
    await Promise.all([...made, other]);
    await queue.drain(resumed.signal);
  } finally {
    jobs.waitForSessionJob = saved.wait;
    store.readSession = saved.read;
    store.mutateSession = saved.mutate;
    fal.cancelJob = saved.cancel;
    budget.releaseJob = saved.release;
    poller.handleFailed = saved.failed;
  }
}

function testCosts() {
  const template = require('../lib/nodes/templates/event-video.json');
  const workflow = { sessionId: 'session', graph: structuredClone(template.graph) };
  const node = (id) => workflow.graph.nodes.find((item) => item.id === id);
  node('n2').params.assets = Array.from({ length: 7 }, (_unused, index) => ({ sessionId: 'session', assetId: `p${index}` }));
  node('n3').params.prompt = 'A day of talks and workshops.';
  node('n10').params.photo_motion = 'ai';
  node('n10').params.max_ai_photos = 2;
  node('n10').params.ai_marks = { p0: 'always', p1: 'always', p2: 'always', missing: 'always' };
  const ready = { ...registry, availability: () => true };
  const limits = engine.resolveLimits();
  const results = { nodes: {} };
  const compute = (overrides = {}) => engine.computePlan({ workflow, results, request: engine.normaliseRequest({ mode: 'node', nodeIds: ['n10'], overrides }, workflow, registry), registry: ready, limits });
  const savedKey = openrouter.hasKey;
  openrouter.hasKey = () => true;
  try {
    const plan = compute();
    assert.equal(plan.nodes.n7.executions, 7, 'Fresh upload lists have a known map length before they run');
    assert.equal(plan.nodes.n7.estimate.usd, 0.006);
    assert.equal(plan.nodes.n6.executions, 0, 'Empty upload lists cost zero');
    assert.equal(plan.nodes.n6.estimate.usd, 0);
    assert.equal(registry.get('event_video.analyze').cost.estimate({}, { inputs: { media: listValue('image', []) } }), 0);
    assert.deepEqual(plan.nodes.n10.followup, { kind: 'eventAiClips', count: 3, usd: 0.6 });
    const info = run.describePlan(plan);
    assert.equal(info.followup.length, 1);
    assert.equal(info.totals.usd, plan.totals.usd, 'The future clips never enter step 1 totals');
    assert.equal(compute({ n10: { photo_motion: 'code' } }).nodes.n10.followup, null);
    assert.equal(compute({ n10: { max_ai_photos: 50 } }).nodes.n10.followup.count, 7);
    assert.equal(compute({ n2: { assets: node('n2').params.assets.slice(0, 5) }, n10: { max_ai_photos: 16 } }).nodes.n10.followup.count, 5);
    results.nodes.n11 = { history: [{ cost: { usd: 0.24 }, freshItemCount: 2, variants: [{ video: listValue('video', Array.from({ length: 5 }, () => ({ type: 'video' }))) }] }] };
    assert.equal(compute().nodes.n10.followup.usd, 0.36, 'Clip price counts fresh items, excluding cache hits');

    const def = registry.get('event_video.plan');
    const params = registry.normalizeParams(def, { model: 'anthropic/claude-opus-5.5' });
    const context = { nodeId: 'n10', results, inputs: { style: textValue(JSON.stringify(styles.combineStyle({ length: 30 }))), photos: listValue('image', node('n2').params.assets) } };
    const estimate = def.cost.estimate(params, context);
    assert.ok(estimate.usd >= 0.0628 && estimate.usd <= 0.0847, `First-run 17-pick estimate: ${estimate.usd}`);
    const photoOnly = { ...context, inputs: { style: textValue(JSON.stringify(styles.combineStyle({ length: 60 }))), photos: listValue('image', Array.from({ length: 17 }, (_, index) => ({ assetId: `photo${index}` }))), videos: listValue('video', []) } };
    const photoPrice = def.cost.estimate(params, photoOnly).usd;
    assert.ok(photoPrice >= 0.0628 && photoPrice <= 0.0847, `Known 17-photo first-run estimate: ${photoPrice}`);
    assert.equal(eventPlan.estimate({ picks: 17 }, { llm: { inputPerMillion: 4, outputPerMillion: 20, charsPerToken: 3 } }).tokens.output, 3200);
    results.nodes.n10 = { history: [
      { cost: { usd: 0 }, params, variants: [] },
      { cost: { usd: 0.0804 }, params, variants: [{ shots: textValue(JSON.stringify({ duration: 30, shots: Array(17).fill({}) })) }] }
    ] };
    assert.equal(def.cost.estimate(params, context).usd, 0.0804, 'A zero-cost reuse does not hide the last paid answer');
    context.inputs.style = textValue(JSON.stringify(styles.combineStyle({ length: 60 })));
    assert.equal(def.cost.estimate(params, context).usd, 0.1608, 'Longer films scale the previous measurement');
    const depthWorkflow = { sessionId: 'session', graph: { nodes: [node('n2'), { id: 'depth', type: 'fal.depth_map', params: {} }], edges: [{ id: 'depth-edge', from: { node: 'n2', port: 'items' }, to: { node: 'depth', port: 'image' } }] } };
    node('n2').params.assets = [];
    const depth = engine.computePlan({ workflow: depthWorkflow, results: { nodes: {} }, request: engine.normaliseRequest({ mode: 'all' }, depthWorkflow, registry), registry: ready, limits });
    assert.equal(depth.nodes.depth.executions, 0);
    assert.equal(depth.totals.usd, 0);
    assert.equal(depth.totals.unknownNodes, 0);
  } finally { openrouter.hasKey = savedKey; }
}

async function main() {
  await testCancelClient();
  await testQueue();
  testCosts();
  console.log('test-fal-cost-plan.js: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
