'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadPage, FakeNode } = require('./support/fake-dom');
const { textFields, applyTextOverrides, validateTextOverrides } = require('../lib/event-video/text-overrides');
const registry = require('../lib/nodes/registry').registry;
const engine = require('../lib/nodes/engine');
const run = require('../public/nodes/run');
const graphics = JSON.parse(fs.readFileSync(path.join(__dirname, 'support/event-video/graphics-60.json'), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

function testOverrides() {
  const base = JSON.stringify(textFields(graphics).map(({ path, value }) => [path, value]));
  const patch = (values, basis = base) => JSON.stringify({ base: basis, values });
  const corrected = applyTextOverrides(graphics, patch({ 'title.text': 'New title', 'endcard.line': 'See you soon', 'endcard.url': 'example.org' }));
  assert.equal(corrected.title.text, 'New title');
  assert.equal(corrected.endcard.line, 'See you soon');
  assert.equal(applyTextOverrides(graphics, patch({ 'title.sub': '', 'endcard.url': '' })).title.sub, null, 'optional text can be removed');
  assert.notEqual(graphics.title.text, 'New title', 'source is immutable');
  assert.deepEqual(corrected.soundbites, graphics.soundbites);
  assert.deepEqual(corrected.voiceover, graphics.voiceover, 'spoken texts remain unchanged');
  assert.equal(applyTextOverrides(graphics, ''), graphics);
  assert.equal(applyTextOverrides(graphics, patch({ 'title.text': 'Old edit' }, 'old')), graphics, 'stale edits do not alter a new plan');
  assert.throws(() => applyTextOverrides(graphics, patch({ '__proto__.polluted': 'x' })));
  assert.throws(() => applyTextOverrides(graphics, patch({ 'title.text': 'x'.repeat(29) })));
  assert.throws(() => applyTextOverrides(graphics, patch({ 'title.text': '' })));
  assert.throws(() => applyTextOverrides(graphics, 'broken JSON'));
  const moved = clone(graphics);
  moved.title.start += 0.1;
  assert.equal(applyTextOverrides(moved, patch({ 'title.text': 'Kept edit' })).title.text, 'Kept edit', 'timing changes keep corrections');
  const def = registry.get('event_video.render');
  assert.equal(def.validate({ text_overrides: patch({ 'title.text': '' }) })[0].code, 'EVENTRENDER_TEXT_INVALID');
  assert.deepEqual(def.validate({ text_overrides: patch({ 'title.text': 'Good' }) }), []);
  const forbidden = require('../lib/event-video/contract').FORBIDDEN_TEXT.source;
  for (const field of textFields(graphics)) {
    for (const value of [forbidden, 'x'.repeat(field.max + 1), ...(/\.(text|line)$/.test(field.path) ? ['', '   '] : [])]) {
      const raw = patch({ [field.path]: value });
      const issues = validateTextOverrides(raw);
      assert.equal(issues[0]?.code, 'EVENTRENDER_TEXT_INVALID', `preflight rejects ${field.path}`);
      assert.equal(issues[0].data.field, field.path);
      const rendered = clone(graphics);
      const parts = field.path.split('.');
      const key = parts.pop();
      parts.reduce((item, part) => item[part], rendered)[key] = value.trim() ? value : null;
      assert.equal(require('../lib/event-video/contract').checkGraphics(rendered).ok, false, `graphics contract rejects ${field.path}`);
      assert.throws(() => applyTextOverrides(graphics, raw), `render also rejects ${field.path}`);
    }
  }
  assert.equal(validateTextOverrides(patch({ 'title.sub': ' '.repeat(41) }))[0].code, 'EVENTRENDER_TEXT_INVALID');
  const emptyThird = { 'lower_thirds.0.name': '', 'lower_thirds.0.role': '', 'lower_thirds.0.label': '' };
  assert.equal(validateTextOverrides(patch(emptyThird))[0].data.field, 'lower_thirds.0');
  assert.throws(() => applyTextOverrides(graphics, patch(emptyThird)));
  assert.deepEqual(validateTextOverrides(patch({ ...emptyThird, 'lower_thirds.0.label': 'Guest' })), []);
  const params = { quality: 'standard' };
  assert.equal(engine.computeCacheKey(def, params, {}, {}), engine.computeCacheKey(def, { ...params, text_overrides: '' }, {}, {}), 'default preserves historical cache keys');
  assert.notEqual(engine.computeCacheKey(def, params, {}, {}), engine.computeCacheKey(def, { ...params, text_overrides: patch({ 'title.text': 'New' }) }, {}, {}));
}

async function testUI(lang) {
  const nodes = [
    { id: 'source', type: 'input.prompt', params: { prompt: 'Event' } },
    { id: 'planner', type: 'event_video.plan', params: {} },
    { id: 'render', type: 'event_video.render', params: {} },
    { id: 'board', type: 'output.result', params: {} }
  ];
  const workflow = { id: 'event', name: 'Event', sessionId: 'session', graph: { nodes, edges: [
    { id: 'e1', from: { node: 'planner', port: 'board' }, to: { node: 'board', port: 'value' } },
    { id: 'e2', from: { node: 'planner', port: 'graphics' }, to: { node: 'render', port: 'graphics' } }
  ], groups: [], notes: [] }, app: { enabled: true, inputs: [{ node: 'source', param: 'prompt' }], outputs: [{ node: 'board', approve: true }] } };
  const variant = { board: { type: 'text', value: 'Current planner board' }, graphics: { type: 'text', value: JSON.stringify(graphics) }, ai_switches: { type: 'text', value: JSON.stringify({ base: 'plan-a', items: [] }) } };
  const results = { nodes: {
    planner: { selected: { entry: 'plan-a' }, history: [{ id: 'plan-a', variants: [variant] }] },
    board: { selected: { entry: 'board-a' }, history: [{ id: 'board-a', variants: [{ result: { type: 'text', value: 'Storyboard' } }] }] }
  } };
  const requests = [], started = [], confirmations = [];
  // the status of the last run (null: none yet); only a run that did not end well is offered for continuing
  let changed = false, complete = false, partial = false, staleOutput = false, lastRun = null;
  const page = loadPage(lang, { api: {
    getWorkflow: async () => ({ workflow: clone(workflow), results: clone(results) }),
    assets: async () => ({ assets: [] }), outputsZipUrl: () => '/test.zip',
    openEvents: () => ({ close() {} }), listRuns: async () => ({ runs: lastRun ? [{ id: 'last' }] : [] }),
    getRun: async () => ({ id: 'last', status: lastRun, mode: 'all', nodes: {}, cost: { usd: 0, credits: 0 } }),
    startRun: async (_id, request) => { started.push(clone(request)); return { runId: 'run' }; },
    plan: async (_id, request) => {
      requests.push(clone(request));
      const all = request.mode === 'all';
      const statuses = { source: { status: changed ? 'stale' : 'cached' }, planner: { status: request.force || partial ? 'stale' : 'cached' } };
      if (request.force) Object.assign(statuses.planner, { paid: true, executions: 1, estimate: { usd: 0.03 }, followup: { kind: 'eventAiClips', count: 3, usd: 0.6 } });
      if (!request.force) statuses.board = { status: partial || staleOutput ? 'stale' : 'cached' };
      if (all) statuses.render = { status: complete ? 'cached' : 'stale' };
      return { valid: true, nodes: statuses, order: Object.keys(statuses), issues: [], totals: { paidNodes: 0, usd: 0, credits: 0, unknownNodes: 0 } };
    }
  } });
  page.OCD.run = run;
  page.OCD.ui.dialog = async (options) => { confirmations.push(options); return true; };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/nodes/app-mode.js'), 'utf8'), {
    window: page.window, document: page.document, localStorage: page.window.localStorage, setTimeout, clearTimeout, setInterval, clearInterval, URL, console
  });
  const app = page.OCD.appMode.createAppView({ host: (page.host = new FakeNode('div')) });
  const reg = { types: new Map(registry.list().map((def) => [def.type, def])) };
  const find = (cls) => page.host.find((node) => node.classes.has(cls))[0];
  const open = async () => { await app.open('event', reg); await tick(); };
  const fields = () => find('nv-apptexts').find((node) => node.tagName === 'INPUT');
  await open();
  assert.deepEqual(clone(page.OCD.appMode.eventTextFields(graphics)).map(({ path, value, max }) => ({ path, value, max })), textFields(graphics));
  assert.equal(find('nv-appreplan').classes.has('hidden'), false);
  assert.equal(find('nv-appresume').textContent, '', 'a step that waits for its approval is not an interrupted run');
  assert.equal(find('nv-apprun-label').textContent, page.window.I18N[lang]['nodes.app.approveFinish']);
  app.close(); lastRun = 'cancelled';
  await open();
  assert.match(find('nv-appresume').textContent, /source|Text|Prompt/);
  assert.equal(find('nv-apprun-label').textContent, page.window.I18N[lang]['nodes.app.resume']);
  app.close(); lastRun = null;
  await open();
  const thirdIndexes = textFields(graphics).map((field, index) => field.path.startsWith('lower_thirds.0.') ? index : -1).filter((index) => index >= 0);
  assert.equal(thirdIndexes.length, 3);
  for (const index of thirdIndexes) { fields()[index].value = ''; fields()[index].fire('input'); }
  for (const index of thirdIndexes) assert.equal(fields()[index].getAttribute('aria-invalid'), 'true');
  find('nv-apprun').fire('click'); await tick();
  assert.equal(started.length, 0, 'an empty lower third cannot start work');
  app.close(); await open();
  for (const index of thirdIndexes) assert.equal(fields()[index].getAttribute('aria-invalid'), 'true', 'restored invalid drafts are marked');
  fields()[thirdIndexes[0]].value = 'Guest'; fields()[thirdIndexes[0]].fire('input');
  for (const index of thirdIndexes) assert.equal(fields()[index].getAttribute('aria-invalid'), 'false', 'correcting one field clears the group error');
  fields()[0].value = 'Corrected title';
  fields()[0].fire('input');
  app.close();
  await open();
  assert.equal(fields()[0].value, 'Corrected title', 'draft survives reopening');
  const all = requests.filter((request) => request.mode === 'all').at(-1);
  assert.equal(JSON.parse(all.overrides.render.text_overrides).values['title.text'], 'Corrected title');
  assert.equal(all.overrides.planner, undefined, 'text correction never changes planner parameters');
  assert.equal(requests.filter((request) => request.mode !== 'all').at(-1).overrides.render, undefined, 'approval preview ignores render edits');
  fields()[0].value = 'x'.repeat(29);
  fields()[0].fire('input');
  find('nv-apprun').fire('click');
  await tick();
  assert.equal(started.length, 0, 'invalid edits cannot start paid work');
  fields()[0].value = 'Corrected title'; fields()[0].fire('input');
  find('nv-appreplan').fire('click'); await tick();
  assert.equal(started.length, 1);
  assert.equal(confirmations.at(-1).body.find((node) => node.classes.has('nv-confirm-name')).length, 1, 'cost dialog lists only the planner');
  assert.deepEqual(started[0].nodeIds, ['planner']);
  assert.equal(started[0].force, true);
  assert.deepEqual(started[0].overrides.planner.ai_choice, {}, 'replan never reuses approval switches');
  assert.equal(started[0].overrides.render, undefined);
  app.close();
  changed = true;
  await open();
  find('nv-appreplan').fire('click'); await tick();
  assert.equal(started.length, 1, 'changed ancestors cannot be silently regenerated');
  app.close(); changed = false;
  variant.ai_switches.value = JSON.stringify({ base: 'plan-b', items: [] });
  staleOutput = true;
  await open();
  assert.equal(fields()[0].value, graphics.title.text, 'new plan discards corrections');
  assert.equal(fields()[0].disabled, false, 'planner-only run is immediately ready for approval');
  assert.ok(page.host.textContent.includes('Current planner board'), 'new planner board replaces stale output');
  find('nv-apprun').fire('click'); await tick();
  assert.equal(started.length, 2);
  assert.equal(started[1].force, false, 'resume reuses cached outputs');
  assert.equal(started[1].mode, 'all');
  app.close(); partial = true; lastRun = 'interrupted';
  await open();
  assert.equal(find('nv-apprun-label').textContent, page.window.I18N[lang]['nodes.app.resume']);
  find('nv-apprun').fire('click'); await tick();
  assert.equal(started.at(-1).force, false, 'interrupted first stage also resumes without forcing');
  assert.deepEqual(started.at(-1).nodeIds, ['board']);
  app.close(); partial = false; staleOutput = false;
  await open();
  const beforeRace = started.length;
  complete = true;
  find('nv-apprun').fire('click'); await tick();
  assert.equal(started.length, beforeRace, 'a resume that became complete never forces a new paid run');
  app.close();
  await open();
  assert.equal(find('nv-appresume').textContent, '');
  assert.equal(find('nv-apprun-label').textContent, page.window.I18N[lang]['nodes.app.runAgain']);
  app.close();
  workflow.app.outputs[0].approve = false;
  complete = false; lastRun = 'failed';
  await open();
  assert.equal(find('nv-apprun-label').textContent, page.window.I18N[lang]['nodes.app.resume']);
  const beforeUnstagedRace = started.length;
  const beforeConfirmations = confirmations.length;
  const beforeRequests = requests.length;
  complete = true;
  find('nv-apprun').fire('click'); await tick();
  assert.equal(started.length, beforeUnstagedRace, 'unstaged resume does not restart a completed workflow');
  assert.equal(confirmations.length, beforeConfirmations, 'no paid confirmation for stale resume intent');
  assert.ok(requests.slice(beforeRequests).every((request) => !request.force));
  assert.equal(find('nv-apprun-label').textContent, page.window.I18N[lang]['nodes.app.runAgain']);
  app.close();
  workflow.app.outputs[0].approve = true;
  page.window.localStorage.setItem('ocd-nodes-app-event', '{}');
  results.nodes.render = { selected: { entry: 'render-a' }, history: [{ id: 'render-a', params: { text_overrides: all.overrides.render.text_overrides } }] };
  await open();
  assert.equal(fields()[0].value, graphics.title.text, 'an older rendered correction cannot attach to a new plan');
  app.close();
  variant.ai_switches.value = JSON.stringify({ base: 'plan-a', items: [] });
  await open();
  assert.equal(fields()[0].value, 'Corrected title', 'executed overrides restore without browser drafts');
  app.close();
}

(async () => {
  testOverrides();
  for (const lang of ['de', 'en', 'es']) await testUI(lang);
  console.log('test-nodes-app-event-approval.js: ok');
})().catch((error) => { console.error(error); process.exitCode = 1; });
