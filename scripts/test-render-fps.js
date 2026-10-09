'use strict';

// The frame rate of a render job (WP44): the HUD of the music video is drawn at 24 fps, so the render job can carry `fps` (the render node
// service already reads it, render-node/service.js). Everything that existed before stays as it was: a job without `fps` sends exactly the
// body it sent before and the tool call has the same result. Pinned first (the "unchanged" half), then the new half.

const assert = require('assert/strict');

const store = require('../lib/store');
const rendernode = require('../lib/rendernode');
const costs = require('../lib/costs');
const { executeTool } = require('../lib/tools');
const { createRenderNodeClient } = rendernode;

const NODE = { id: 'node-0000000a', name: 'Alpha', url: 'https://alpha.test', token: 'alpha-test-token', enabled: true };
const HTML = '<div id="main-composition" data-composition-id="main" data-width="1920" data-height="1080" data-start="0" data-duration="3"></div>';

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// A client whose only node answers the health check and takes jobs; `bodies` collects the bodies sent to /render.
function clientWithBodies(bodies) {
  return createRenderNodeClient({
    store: { listNodes: () => [{ ...NODE }] },
    env: {},
    fetchImpl: async (url, options) => {
      const { pathname } = new URL(url);
      if (pathname === '/health') return jsonResponse({ ok: true, running: false, queue: 0, streamingUploads: false });
      if (pathname === '/render') {
        bodies.push(JSON.parse(options.body));
        return jsonResponse({ jobId: 'job-fps' });
      }
      throw new Error(`unexpected stub url ${url}`);
    }
  });
}

async function testClientBodies() {
  const bodies = [];
  const client = clientWithBodies(bodies);

  // unchanged: the body of a job without fps
  await client.submit(HTML);
  await client.submit(HTML, 'draft');
  await client.submit(HTML, 'high', undefined, 'portrait');
  assert.deepEqual(Object.keys(bodies[0]), ['html', 'quality']);
  assert.equal(bodies[0].quality, 'standard');
  assert.deepEqual(Object.keys(bodies[1]), ['html', 'quality']);
  assert.deepEqual(Object.keys(bodies[2]), ['html', 'quality', 'resolution']);
  assert.equal(bodies[2].resolution, 'portrait');
  assert.equal(Object.prototype.hasOwnProperty.call(bodies[2], 'fps'), false, 'no fps unless it was asked for');
  await client.submit(HTML, 'draft', undefined, 'landscape', undefined);
  assert.deepEqual(Object.keys(bodies[3]), ['html', 'quality', 'resolution'], 'an undefined fps is no fps');

  // new: the body carries the frame rate
  await client.submit(HTML, 'standard', undefined, 'landscape', 24);
  assert.equal(bodies[4].fps, 24);
  assert.equal(bodies[4].resolution, 'landscape');
  await client.submit(HTML, 'standard', undefined, undefined, 60);
  assert.equal(bodies[5].fps, 60);
  assert.equal(Object.prototype.hasOwnProperty.call(bodies[5], 'resolution'), false);

  // refused before anything is sent
  const sent = bodies.length;
  for (const bad of [0, 61, 24.5, -1, '24', Number.NaN, null, true]) {
    await assert.rejects(client.submit(HTML, 'draft', undefined, 'landscape', bad), /Bildrate|fps/i, `fps ${String(bad)} is refused`);
  }
  assert.equal(bodies.length, sent, 'a refused job is never sent');
}

async function testToolCall() {
  store.ensureDirs();
  const session = await store.createSession();
  const originalSubmit = rendernode.submit;
  const originalRecordCost = costs.recordCost;
  const calls = [];
  rendernode.submit = async function submitDouble(html, quality, assets, resolution) {
    calls.push({ args: [...arguments], resolution });
    return { jobId: `job-${calls.length}`, nodeId: 'node-00000001' };
  };
  costs.recordCost = async (entry) => entry;
  const ctx = { sessionId: session.id, emit() {}, user: 'test' };
  try {
    // unchanged: the call to the dispatcher and the job of a tool call without fps
    const plain = await executeTool(ctx, 'render_motion_graphics', { html: HTML, label: 'Ohne Bildrate' });
    assert.equal(calls[0].args.length, 4, 'the dispatcher gets the same four arguments as before');
    assert.equal(calls[0].resolution, 'landscape');
    assert.equal(Object.prototype.hasOwnProperty.call(plain.job, 'fps'), false, 'the job has no fps');
    assert.match(plain.toolResult, /gestartet/);

    // new: fps goes to the dispatcher and into the job
    const rated = await executeTool(ctx, 'render_motion_graphics', { html: HTML, label: 'Mit Bildrate', fps: 24 });
    assert.equal(calls[1].args.length, 5);
    assert.equal(calls[1].args[4], 24);
    assert.equal(rated.job.fps, 24);
    const asText = await executeTool(ctx, 'render_motion_graphics', { html: HTML, label: 'Bildrate als Text', fps: '30' });
    assert.equal(calls[2].args[4], 30);
    assert.equal(asText.job.fps, 30);
    // empty values mean "not set"
    await executeTool(ctx, 'render_motion_graphics', { html: HTML, label: 'Leer', fps: '' });
    await executeTool(ctx, 'render_motion_graphics', { html: HTML, label: 'Null', fps: null });
    assert.equal(calls[3].args.length, 4);
    assert.equal(calls[4].args.length, 4);

    // refused: no job is made
    const made = calls.length;
    for (const bad of [0, 61, 24.5, 'abc', -3]) {
      await assert.rejects(executeTool(ctx, 'render_motion_graphics', { html: HTML, label: 'Falsch', fps: bad }), /fps/, `fps ${bad} is refused`);
    }
    assert.equal(calls.length, made);
  } finally {
    rendernode.submit = originalSubmit;
    costs.recordCost = originalRecordCost;
    await store.deleteSession(session.id).catch(() => {});
  }
}

async function main() {
  await testClientBodies();
  await testToolCall();
  console.log('test-render-fps.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
