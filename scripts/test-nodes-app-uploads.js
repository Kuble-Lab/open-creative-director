'use strict';

// App file fields restore saved values and the last executed overrides without a browser or network.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadPage, FakeNode } = require('./support/fake-dom');
const registry = require('../lib/nodes/registry').registry;
const run = require('../public/nodes/run');
const clone = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

async function testUploads() {
  const photo = { assetId: 'upload-001', sessionId: 'wf-session', type: 'image', url: '/assets/wf-session/photo.png' };
  // the list of the workflow's files carries more than a value (the name and date of the upload)
  const listed = (asset) => ({ ...asset, prompt: 'photo.png', createdAt: '2026-10-11T12:00:00.000Z' });
  const audio = { assetId: 'upload-002', sessionId: 'wf-session', type: 'audio', url: '/assets/wf-session/music.wav' };
  const workflow = {
    id: 'wf1', name: 'Photo app', sessionId: 'wf-session',
    graph: { nodes: [
      { id: 'photos', type: 'input.media_list', params: { kind: 'image', assets: [] } },
      { id: 'music', type: 'input.audio', params: { asset: { assetId: audio.assetId } } },
      { id: 'plan', type: 'event_video.plan', params: { photo_motion: 'ai', ai_marks: {} } },
      { id: 'out', type: 'output.result', params: {} },
      { id: 'brief', type: 'input.prompt', params: { prompt: '' } },
      { id: 'empty', type: 'input.media_list', params: { assets: [{ assetId: 'gone', missing: true }] } }
    ], edges: [], groups: [], notes: [] },
    app: { enabled: true, inputs: [
      { node: 'photos', param: 'assets', marks: { node: 'plan', param: 'ai_marks' } },
      { node: 'music', param: 'asset' },
      { node: 'empty', param: 'assets', optional: true },
      { node: 'brief', param: 'prompt', label: 'What is the film about?' }
    ], outputs: [{ node: 'out' }] }
  };
  const results = { nodes: {
    photos: { history: [{ params: { assets: [{ assetId: photo.assetId }] } }] },
    plan: { history: [{ params: { ai_marks: { [photo.assetId]: 'never' } } }] },
    brief: { selected: { entry: 'selected' }, history: [{ id: 'newer', params: { prompt: 'Wrong newer value' } }, { id: 'selected', params: { prompt: 'An evening of ideas' } }] }
  } };
  const requests = [];
  const started = [];
  let cached = false;
  let issues = [];
  let eventHandlers;
  let record = null;
  const page = loadPage('en', { api: {
    getWorkflow: async () => ({ workflow: clone(workflow), results: clone(results) }),
    assets: async () => ({ assets: [listed(photo), listed(audio)] }),
    outputsZipUrl: () => '/fake.zip',
    openEvents: (_id, handlers) => { eventHandlers = handlers; return { close() {} }; },
    listRuns: async () => ({ runs: record ? [{ id: record.id }] : [] }),
    getRun: async () => clone(record),
    startRun: async (_id, request) => { started.push(clone(request)); return { runId: 'test-run' }; },
    plan: async (_id, request) => {
      requests.push(clone(request));
      return { valid: !issues.length, nodes: cached ? { out: { status: 'cached', paid: false } } : {}, order: cached ? ['out'] : [], issues, totals: { paidNodes: 0, usd: 0, credits: 0, unknownNodes: 0 } };
    }
  } });
  page.OCD.run = run;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/nodes/app-mode.js'), 'utf8'), {
    window: page.window, document: page.document, localStorage: page.window.localStorage,
    setTimeout, clearTimeout, setInterval, clearInterval, URL, console
  });
  const host = new FakeNode('div');
  const app = page.OCD.appMode.createAppView({ host });
  const reg = { types: new Map(registry.list().map((def) => [def.type, def])) };
  await app.open('wf1', reg);
  await tick();
  const customLabel = host.find((node) => node.tagName === 'LABEL' && node.textContent === 'What is the film about?')[0];
  const customInput = host.find((node) => node.attributes['aria-labelledby'] === customLabel.id)[0];
  assert.ok(customInput, 'custom label names its input');
  assert.equal(customInput.attributes['aria-label'], undefined, 'no conflicting generic name');
  assert.ok(host.find((node) => node.classes?.has('nv-batch-count')).length, host.textContent);
  assert.equal(host.find((node) => node.classes?.has('nv-batch-count'))[0].textContent, 'Items: 1');
  assert.ok(host.find((node) => node.tagName === 'IMG' && node.attributes.src === 'assets/wf-session/photo.png').length);
  assert.ok(host.find((node) => node.tagName === 'AUDIO').length, 'single assets also restore previews');
  const mark = host.find((node) => node.tagName === 'SELECT' && node.dataset.mark === 'never')[0];
  assert.ok(mark, 'the last run marks are restored');
  assert.ok(mark.attributes['aria-label'], 'per-photo mark labels remain specific');
  assert.equal(requests.at(-1).overrides.photos.assets[0].assetId, photo.assetId);
  assert.deepEqual(requests.at(-1).overrides.photos.assets[0], photo, 'a restored file has the fields of a value only, so the nodes after it stay cached');
  assert.equal(requests.at(-1).overrides.music.asset.assetId, audio.assetId);
  assert.equal(requests.at(-1).overrides.empty, undefined, 'untouched empty fields do not overwrite saved values');
  assert.deepEqual(requests.at(-1).overrides.plan.ai_marks, { [photo.assetId]: 'never' });
  assert.equal(requests.at(-1).overrides.brief.prompt, 'An evening of ideas', 'a text field restores what the last run used');
  host.find((node) => node.classes?.has('nv-apprun'))[0].fire('click');
  await tick();
  assert.equal(started.length, 1, 'restored fields start without selecting files again');
  assert.equal(started[0].overrides.photos.assets[0].assetId, photo.assetId);
  app.close();
  await app.open('wf1', reg);
  await tick();
  const restoredMark = host.find((node) => node.tagName === 'SELECT' && node.dataset.mark === 'never')[0];
  restoredMark.value = 'always';
  restoredMark.fire('change');
  app.close();
  await app.open('wf1', reg);
  await tick();
  assert.ok(host.find((node) => node.tagName === 'SELECT' && node.dataset.mark === 'always').length, 'edited marks survive reopening');
  cached = true;
  host.find((node) => node.classes?.has('nv-apprun'))[0].fire('click');
  await tick();
  assert.equal(started.length, 2, 'run again works without selecting files');
  assert.equal(started[1].force, true);
  assert.equal(started[1].overrides.photos.assets[0].assetId, photo.assetId);
  app.close();
  cached = false;
  await app.open('wf1', reg);
  await tick();
  const remove = host.find((node) => node.classes?.has('nv-asset-remove'))[0];
  remove.fire('click');
  app.close();
  await app.open('wf1', reg);
  await tick();
  assert.deepEqual(requests.at(-1).overrides.photos.assets, [], 'an explicit removal survives reopening');
  assert.deepEqual(requests.at(-1).overrides.plan.ai_marks, {}, 'removing all files clears their marks');
  app.close();
  workflow.app.outputs[0].approve = true;
  workflow.app.outputs[0].switches = { node: 'plan', param: 'ai_choice' };
  results.nodes.plan.selected = { entry: 'old-plan' };
  results.nodes.plan.history[0].id = 'old-plan';
  results.nodes.out = { selected: { entry: 'old-out' }, history: [{ id: 'old-out', variants: [{ result: { type: 'text', value: 'Old selection' } }] }] };
  await app.open('wf1', reg);
  await tick();
  assert.match(host.textContent, /The switches per photo appear after a new step 1/);
  app.close();
  results.nodes.plan.history[0].variants = [{ shots: { type: 'text', value: JSON.stringify({ shots: [{ kind: 'video' }] }) } }];
  await app.open('wf1', reg);
  await tick();
  assert.doesNotMatch(host.textContent, /The switches per photo appear after a new step 1/, 'video-only plans do not promise photo switches');
  app.close();
  issues = [{ level: 'error', nodeId: 'plan', code: 'EVENTMUSIC_TOO_MANY_FILES', data: { node: 'photos', field: 'assets' } }];
  await app.open('wf1', reg);
  await tick();
  assert.match(host.textContent, /at most one|only one/i, 'too many music files keeps its actual message');
  assert.doesNotMatch(host.textContent, /is empty/i);
  app.close();
  issues = [];
  cached = true;
  const switchData = { base: 'plan-a', unit: { usd: 0.2 }, items: [{ id: 'p0', label: 'Photo', auto: true, on: true }] };
  results.nodes.plan.history[0].variants[0].ai_switches = { type: 'text', value: JSON.stringify(switchData) };
  await app.open('wf1', reg);
  await tick();
  const toggle = () => host.find((node) => node.attributes.role === 'switch')[0];
  assert.equal(toggle().attributes['aria-checked'], 'true');
  toggle().fire('click');
  assert.equal(toggle().attributes['aria-checked'], 'false');
  app.close();
  await app.open('wf1', reg);
  await tick();
  assert.equal(toggle().attributes['aria-checked'], 'false', 'unsubmitted switch survives reopening');
  app.close();
  switchData.base = 'plan-b';
  results.nodes.plan.history[0].variants[0].ai_switches.value = JSON.stringify(switchData);
  await app.open('wf1', reg);
  await tick();
  assert.equal(toggle().attributes['aria-checked'], 'true', 'a new plan discards old switches');
  eventHandlers.onEvent({ type: 'run_started', runId: 'reconnect', plan: {} });
  eventHandlers.onEvent({ type: 'run_cost', runId: 'reconnect', usd: 0.1 });
  record = { id: 'reconnect', status: 'failed', cost: { usd: 2, credits: 0 }, error: 'Recovered failure', nodes: {} };
  eventHandlers.onEvent({ type: 'snapshot', activeRun: null });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.match(host.textContent, /Recovered failure/);
  assert.match(host.find((node) => node.classes?.has('nv-appstatus-cost'))[0].textContent, /2[.,]00/, 'final cost replaces the partial cost');
  app.close();
  await app.open('wf1', reg);
  await tick();
  assert.match(host.textContent, /Recovered failure/, 'reopening loads the latest run');
  app.close();
}

testUploads().then(() => console.log('test-nodes-app-uploads.js: ok')).catch((err) => { console.error(err); process.exitCode = 1; });
