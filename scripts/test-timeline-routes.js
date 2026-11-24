'use strict';

const assert = require('assert/strict');
const express = require('express');
const http = require('http');
const { fixture } = require('./support/timeline');
const { registerNodeRoutes } = require('../lib/nodes/routes');

async function main() {
  const f = await fixture();
  const savedAuth = process.env.AUTH_WHOAMI_URL;
  const savedAdmins = process.env.ADMIN_EMAILS;
  const server = http.createServer();
  let modelCalls = 0;
  try {
    await f.run({ mode: 'node', nodeIds: ['make'] });
    process.env.AUTH_WHOAMI_URL = 'https://whoami.invalid/me';
    process.env.ADMIN_EMAILS = '';
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.kubleUser = req.headers['x-test-user'] || 'owner@example.com'; next(); });
    registerNodeRoutes(app, { store: f.store, registry: f.registry, engine: f.engine, timelineResolveAsset: async (value) => value,
      timelineComplete: async () => { modelCalls++; return { text: 'New camera prompt' }; } });
    server.on('request', app);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${server.address().port}/api/workflows/${f.id}/timeline`;
    async function request(method, suffix = '', body, user = 'owner@example.com') {
      const response = await fetch(base + suffix, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': user }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    }
    const rev = (await f.store.readWorkflow(f.id)).rev;
    for (const [method, suffix, body] of [
      ['GET', ''], ['GET', '/cut'], ['PUT', '/cut/review', { kind: 'clip', status: 'approved' }],
      ['POST', '/cut/clips/clip%3A0/feedback', { text: 'Improve', rev }]
    ]) assert.equal((await request(method, suffix, body, 'outsider@example.com')).status, 404);
    assert.equal(modelCalls, 0);
    let response = await request('GET');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.nodes.map((node) => ({ nodeId: node.nodeId, clips: node.clips })), [{ nodeId: 'cut', clips: 2 }]);
    response = await request('GET', '/cut');
    assert.equal(response.body.timeline.clips[0].review.status, 'open');
    assert.equal(response.body.timeline.clips[0].prompt, 'a first');
    assert.equal((await request('GET', '/unknown')).status, 404);
    assert.deepEqual((await request('GET', '/source')).body, { timeline: null });
    response = await request('PUT', '/cut/review', { keys: ['clip:0'], status: 'approved' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.timeline.clips.map((clip) => clip.review.status), ['approved', 'open']);
    response = await request('PUT', '/cut/review', { kind: 'clip', status: 'approved' });
    assert.ok(response.body.timeline.clips.every((clip) => clip.review.status === 'approved'));
    for (const invalid of [{}, { keys: [], status: 'open' }, { keys: ['../bad'], status: 'open' }, { keys: ['__proto__'], status: 'open' },
      { keys: ['clip:0'], kind: 'clip', status: 'open' }, { keys: ['missing'], status: 'open' }, { kind: 'clip', status: 'bad' }, { kind: 'x'.repeat(33), status: 'open' }]) {
      assert.equal((await request('PUT', '/cut/review', invalid)).status, 400);
    }
    for (const invalid of [{}, { text: 'x' }, { text: 1, rev }, { text: 'x'.repeat(8001), rev }]) {
      assert.equal((await request('POST', '/cut/clips/clip%3A0/feedback', invalid)).status, 400);
    }
    assert.equal((await request('POST', '/cut/clips/bad%2Fkey/feedback', { text: '', rev })).status, 400);
    assert.equal((await request('POST', '/cut/clips/clip%3A0/feedback', { text: 'x', rev: rev - 1 })).status, 409);
    response = await request('POST', '/cut/clips/clip%3A0/feedback', { text: '', rev });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.runRequest, { mode: 'items', nodeId: 'make', items: [0] });
    assert.equal(modelCalls, 0);
    response = await request('POST', '/cut/clips/clip%3A0/feedback', { text: 'A closer view', rev });
    assert.equal(response.status, 200);
    assert.equal(response.body.prompt, 'New camera prompt');
    assert.equal(response.body.rev, rev + 1);
    const isBusy = f.engine.isBusy;
    f.engine.isBusy = () => true;
    assert.equal((await request('POST', '/cut/clips/clip%3A0/feedback', { text: 'x', rev: rev + 1 })).status, 409);
    f.engine.isBusy = isBusy;
    assert.equal(modelCalls, 1);
    assert.equal(f.calls.cut, 0);
    assert.equal(f.calls.down, 0);
  } finally {
    if (savedAuth === undefined) delete process.env.AUTH_WHOAMI_URL; else process.env.AUTH_WHOAMI_URL = savedAuth;
    if (savedAdmins === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = savedAdmins;
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await f.cleanup();
  }
  console.log('test-timeline-routes.js: ok');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
