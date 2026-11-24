'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const timeline = require('../public/nodes/timeline');
const clip = (key, start, extra = {}) => ({ key, start, duration: 3, kind: 'story', asset: { id: key }, review: { status: 'open' }, ...extra });
const clips = [clip('a', 0, { review: { status: 'approved', assetId: 'a' } }),
  clip('b', 3, { lipsync: true, over: 1, review: { status: 'open', feedback: [{ text: 'Earlier' }] }, producer: { nodeId: 'producer', item: 1 } }),
  clip('c', 6, { missing: true, asset: null }), clip('d', 9)];

const model = { duration: 12, clips };
const before = JSON.stringify(model);
const layout = timeline.layout(model, { zoom: 20, start: 2, width: 100 });
assert.equal(layout.width, 240);
assert.equal(layout.end, 7);
assert.deepEqual(layout.clips.map((entry) => [entry.clip.key, entry.left, entry.width, entry.overWidth]), [['a', 0, 60, 0], ['b', 60, 60, 20], ['c', 120, 60, 0]]);
assert.equal(timeline.layout(model, { zoom: 0 }).scale, 2);
assert.equal(timeline.layout(model, { zoom: 999 }).scale, 240);
assert.deepEqual(timeline.layout(model, { start: 12 }).clips, []);
assert.equal(JSON.stringify(model), before, 'layout never mutates the server view');

assert.equal(timeline.status(clips[0]), 'approved');
assert.equal(timeline.status({ ...clips[0], asset: { id: 'replacement' } }), 'open');
assert.equal(timeline.status(clips[1]), 'feedback');
assert.equal(timeline.status(clips[2]), 'missing');
const run = { active: true, mode: 'items', nodeId: 'producer', items: [1], nodes: { producer: { status: 'running' } } };
assert.equal(timeline.status(clips[1], run), 'remaking');
assert.equal(timeline.status(clips[1], { ...run, items: [0] }), 'feedback', 'other items do not look active');
assert.equal(timeline.status(clips[1], { ...run, nodes: { producer: { status: 'done' } } }), 'feedback');
assert.equal(timeline.status(clips[1], { ...run, active: false }), 'feedback');
assert.equal(timeline.status(clips[1], { active: true, request: { mode: 'items', targets: ['producer'], itemsRun: { nodeId: 'producer', items: [1] } } }), 'remaking');
assert.deepEqual(timeline.counts(clips), { total: 4, approved: 1, feedback: 1, remaking: 0, open: 1, missing: 1, remaining: 3 });
assert.equal(timeline.counts(clips, run).remaking, 1);
assert.deepEqual(timeline.filter(clips, 'open').map((item) => item.key), ['b', 'c', 'd']);
assert.deepEqual(timeline.filter(clips, 'lipsync'), [clips[1]]);
assert.deepEqual(timeline.filter(clips), clips);

assert.equal(timeline.clipAt(clips, -1), null);
assert.equal(timeline.clipAt(clips, 0), clips[0]);
assert.equal(timeline.clipAt(clips, 3), clips[1]);
assert.equal(timeline.clipAt(clips, 12), null);
assert.equal(timeline.clipAt([clip('a', 0), clip('b', 2)], 2.5).key, 'b');
assert.equal(timeline.clipAt([clip('a', 0), clip('b', 4)], 3.5), null);
assert.deepEqual(timeline.range(clips, 'b'), { start: 3, end: 6 });
assert.deepEqual(timeline.range(clips, 'a', 'neighbours'), { start: 0, end: 6 });
assert.deepEqual(timeline.range(clips, 'c', 'from'), { start: 6, end: 12 });
assert.equal(timeline.range(clips, 'unknown'), null);

assert.deepEqual(timeline.peaks(new Float32Array([0, -0.5, 1, 0.25]), 2), [0.5, 1]);
assert.deepEqual(timeline.peaks([[0, 0], [-0.8, 0.4]], 2), [0.8, 0.4]);
assert.deepEqual(timeline.peaks([], 3), [0, 0, 0]);
assert.deepEqual(timeline.peaks([NaN, Infinity, 2, -2], 2), [0, 1]);
assert.equal(timeline.clock(64.24), '1:04.2');
assert.equal(timeline.clock(59.96), '1:00.0');
assert.equal(timeline.clock(NaN), '0:00.0');
for (const [key, action] of [[' ', 'play'], ['ArrowLeft', 'previous'], ['ArrowRight', 'next'], ['O', 'approve']]) assert.equal(timeline.keyAction({ key }), action);
for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'VIDEO']) assert.equal(timeline.keyAction({ key: 'O', target: { tagName } }), null);
assert.equal(timeline.keyAction({ key: ' ', target: { isContentEditable: true } }), null);
assert.equal(timeline.keyAction({ key: 'O', ctrlKey: true }), null);
assert.equal(timeline.keyAction({ key: 'O', repeat: true }), null);

const context = { self: {} };
vm.runInNewContext(fs.readFileSync(require.resolve('../public/nodes/timeline'), 'utf8'), context);
assert.equal(context.self.OCDNodes.timeline.clock(64.24), '1:04.2', 'the browser uses the same pure module');

async function testApi() {
  const calls = [];
  const window = { getLang: () => 'de' };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/nodes/api'), 'utf8'), { window, encodeURIComponent,
    fetch: async (url, init) => {
      calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ timeline: null, nodes: [] }) };
    } });
  const api = window.OCDNodes.api;
  assert.equal((await api.getTimeline('workflow /', 'cut /')).timeline, null);
  await api.timelineNodes('workflow /');
  await api.reviewTimeline('workflow /', 'cut /', { keys: ['duet:3'], status: 'approved' });
  await api.timelineFeedback('workflow /', 'cut /', 'duet:3', { text: '', rev: 4 });
  assert.deepEqual(calls, [
    { url: 'api/workflows/workflow%20%2F/timeline/cut%20%2F', method: 'GET', body: undefined },
    { url: 'api/workflows/workflow%20%2F/timeline', method: 'GET', body: undefined },
    { url: 'api/workflows/workflow%20%2F/timeline/cut%20%2F/review', method: 'PUT', body: { keys: ['duet:3'], status: 'approved' } },
    { url: 'api/workflows/workflow%20%2F/timeline/cut%20%2F/clips/duet%3A3/feedback', method: 'POST', body: { text: '', rev: 4 } }
  ]);
}
testApi().then(() => console.log('test-nodes-timeline.js: ok')).catch((error) => { console.error(error); process.exitCode = 1; });
