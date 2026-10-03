'use strict';

// Expensive brain models stay away from participants and guests (WP24, parts C and D1).
//
//   C1  config.restrictedBrainModels: when set, participants and guests see and use only these brain models (chat menu,
//       default model, LLM nodes); empty or missing changes nothing
//   C2  the server enforces it: another model in a chat request gets the default of the list (with a notice), a
//       model chosen by hand in a node is refused, the Director's own entry point refuses it as well
//   D1  the unused model.codex* texts are gone; every new text exists in German, English and Spanish
//
// A private copy of the app runs in a temp directory. The second phase (no setting) runs in a child process because one
// process holds one private app. OpenRouter is a local double and a fetch guard refuses everything except localhost.

const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { createIsolatedApp } = require('./support/isolated-app');

const root = path.resolve(__dirname, '..');
const ADMIN = 'admin@example.com';
const STAFF = 'colleague@staff.example.com';
const P1 = 'p1@gmail.example';
const GUEST = 'guest@gmail.example';
const LIST = ['openai/gpt-5.6-luna', 'google/gemini-3.1-pro'];
const FABLE = 'anthropic/claude-fable-5';
const OPUS = 'anthropic/claude-opus-4.6';

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

function parseEvents(text) {
  return text.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5).trim()));
}

function scriptedOpenRouter(or) {
  const requests = [];
  or.chatStream = async (payload) => {
    requests.push(payload);
    const lines = [`data: ${JSON.stringify({ choices: [{ delta: { content: 'Okay.' } }] })}`, '', `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`, '', 'data: [DONE]', ''];
    return new Response(lines.join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return requests;
}

function loadDictionary(lang) {
  const storage = new Map([['vcd-lang', lang]]);
  const window = {
    document: { documentElement: { lang: '' }, querySelectorAll: () => [], createElement: () => ({}) },
    navigator: { language: lang },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame() {}
  };
  const sandbox = { window, document: window.document, requestAnimationFrame() {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/i18n.js'), 'utf8'), sandbox, { filename: 'public/i18n.js' });
  return window.I18N[lang];
}

/* ---------- units ---------- */

function testUnits() {
  const config = require('../lib/config');
  const access = require('../lib/access');
  assert.deepEqual(config.normaliseRestrictedBrainModels(undefined), []);
  assert.deepEqual(config.normaliseRestrictedBrainModels(null), []);
  assert.deepEqual(config.normaliseRestrictedBrainModels('openai/x'), [], 'a string is not a list');
  assert.deepEqual(config.normaliseRestrictedBrainModels([]), []);
  assert.deepEqual(config.normaliseRestrictedBrainModels([' openai/a ', '', 3, null, 'openai/a', 'chatgpt/gpt-5.6-sol', 'b/c']), ['openai/a', 'b/c'], 'trimmed, no duplicates, never a subscription model');

  const all = ['a/one', 'b/two', 'chatgpt/gpt-5.6-sol'];
  assert.deepEqual(config.availableBrainModels(all, false), ['a/one', 'b/two'], 'as before');
  assert.deepEqual(config.availableBrainModels(all, true), ['a/one', 'b/two', ...config.CHATGPT_BRAIN_MODELS], 'as before');
  assert.deepEqual(config.availableBrainModels(all, true, []), config.availableBrainModels(all, true), 'an empty list changes nothing');
  assert.deepEqual(config.availableBrainModels(all, true, undefined), config.availableBrainModels(all, true));
  assert.deepEqual(config.availableBrainModels(all, false, ['b/two', 'z/other']), ['b/two', 'z/other'], 'the list replaces the whole offer');
  assert.deepEqual(config.availableBrainModels(all, true, ['chatgpt/gpt-5.6-sol']), config.availableBrainModels(all, true), 'a list of subscription models only is no list');
  assert.equal(config.availableDefaultBrain('a/one', ['b/two', 'z/other']), 'b/two');

  const participant = { active: true, email: 'p@x.example', kind: 'participant' };
  const guest = { active: true, email: 'g@x.example', kind: 'guest' };
  const internal = { active: true, email: 'i@x.example', kind: 'internal' };
  assert.equal(access.isRestricted(participant), true);
  const list = ['b/two', 'z/other'];
  assert.equal(access.brainModelAllowed(participant, 'a/one', list), false);
  assert.equal(access.brainModelAllowed(participant, 'b/two', list), true);
  assert.equal(access.brainModelAllowed(participant, 'a/one', []), true, 'no list, no restriction');
  assert.equal(access.brainModelAllowed(participant, 'a/one', undefined), true);
  assert.equal(access.brainModelAllowed(guest, 'a/one', list), false, 'guests too');
  assert.equal(access.brainModelAllowed(internal, 'a/one', list), true, 'internal people are not restricted');
  assert.equal(access.brainModelAllowed(access.LOCAL_VIEWER, 'a/one', list), true, 'neither is the local mode');
  assert.deepEqual(access.brainModelFor(participant, 'a/one', { restrictedModels: list, defaultBrain: 'z/other' }), { model: 'z/other', changed: true }, 'the default of the list when it is on the list');
  assert.deepEqual(access.brainModelFor(participant, 'a/one', { restrictedModels: list, defaultBrain: 'a/one' }), { model: 'b/two', changed: true }, 'else the first model of the list');
  assert.deepEqual(access.brainModelFor(participant, 'b/two', { restrictedModels: list, defaultBrain: 'z/other' }), { model: 'b/two', changed: false });
  assert.deepEqual(access.brainModelFor(internal, 'a/one', { restrictedModels: list, defaultBrain: 'z/other' }), { model: 'a/one', changed: false });
}

/* ---------- D1 ---------- */

function testCleanup() {
  const source = fs.readFileSync(path.join(root, 'public/i18n.js'), 'utf8');
  assert.equal(/model\.codex/.test(source), false, 'no model.codex* key is left');
  for (const file of ['public/app.js', 'public/index.html', 'public/shell.js', 'public/access-client.js']) {
    assert.equal(/model\.codex/.test(fs.readFileSync(path.join(root, file), 'utf8')), false, `${file} does not use them`);
  }
  const keys = ['chat.notice.BRAIN_MODEL_REPLACED', 'role.feature.models'];
  const seen = new Set();
  for (const lang of ['de', 'en', 'es']) {
    const dict = loadDictionary(lang);
    for (const key of Object.keys(dict)) assert.equal(key.startsWith('model.codex'), false, `${lang}: ${key}`);
    for (const key of keys) {
      assert.ok(dict[key] && dict[key].trim(), `${lang}: ${key}`);
      assert.equal(dict[key].includes('ß'), false, `${lang}.${key}`);
      seen.add(dict[key]);
    }
    // the other model hints still exist
    for (const key of ['model.fable', 'model.kimi', 'model.chatgptSubscription', 'model.openrouter']) assert.ok(dict[key], `${lang}: ${key}`);
  }
  assert.equal(seen.size, keys.length * 3, 'written in each language');
  const defaultConfig = require('../lib/config').DEFAULT_CONFIG;
  assert.deepEqual(defaultConfig.brainModels, ['anthropic/claude-opus-4.6', 'openai/gpt-5.2', 'google/gemini-3.1-pro'], 'D2: the default models stay');
  assert.equal(defaultConfig.defaultBrain, 'anthropic/claude-opus-4.6');
  assert.equal('restrictedBrainModels' in defaultConfig, false, 'D2: the default config does not change');
}

/* ---------- the app ---------- */

async function main() {
  const withoutSetting = process.argv.includes('--without');
  if (!withoutSetting) {
    testUnits();
    testCleanup();
  }
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
    },
    config: {
      brainModels: [OPUS, 'openai/gpt-5.2', 'google/gemini-3.1-pro', 'openai/gpt-5.6-luna', FABLE],
      defaultBrain: OPUS,
      // set in both cases, so a list in the repository's config.json does not leak in: undefined drops the key from the
      // copy's config.json (JSON.stringify), which is "no setting"
      restrictedBrainModels: withoutSetting ? undefined : LIST
    }
  });
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  const originalError = console.error;
  console.error = (...args) => {
    if (!/^\[chat\]/.test(String(args[0]))) originalError(...args);
  };
  try {
    await (withoutSetting ? runWithout : runWith)(iso);
  } finally {
    console.error = originalError;
    await iso.cleanup();
    guard.restore();
  }
  assert.deepEqual(guard.attempts, [], 'no request left the machine');
  if (!withoutSetting) {
    const child = spawnSync(process.execPath, [__filename, '--without'], { encoding: 'utf8', env: process.env, timeout: 120000 });
    assert.equal(child.status, 0, `the phase without the setting failed:\n${child.stdout}\n${child.stderr}`);
    console.log('Modelliste fuer Teilnehmende: Liste in Chat-Auswahl, Standardmodell und Nodes, serverseitig durchgesetzt, ohne Einstellung wie bisher, alte Schluessel entfernt.');
  } else {
    console.log('  ohne Einstellung: alles wie bisher.');
  }
  console.log('test-restricted-models.js: ok');
}

async function setup(iso) {
  const api = iso.request;
  const chatgptMod = iso.load('lib/chatgpt');
  chatgptMod.status = () => ({ connected: true, plan: 'pro', expiresAt: null, models: chatgptMod.BRAIN_MODELS });
  const or = iso.load('lib/openrouter');
  const discovery = iso.load('lib/discovery');
  discovery.brainSupportsImages = async () => true;
  or.listVideoModels = async () => ({ data: [] });
  const requests = scriptedOpenRouter(or);
  const team = (await api('/api/teams', { method: 'POST', as: ADMIN, json: { name: 'Kurs', budgetUsd: 5 } })).body.team;
  assert.equal((await api(`/api/teams/${team.id}/members`, { method: 'POST', as: ADMIN, json: { emails: [P1] } })).status, 201);
  const say = async (as, brainModel) => {
    const chat = (await api('/api/sessions', { method: 'POST', as, json: {} })).body.session;
    const response = await api(`/api/sessions/${chat.id}/message`, { method: 'POST', as, json: { text: 'Hallo', brainModel } });
    return { status: response.status, body: response.body, events: response.status === 200 ? parseEvents(response.text) : [], chat };
  };
  const configOf = async (as) => (await api('/api/config', { as })).body;
  const optionsOf = async (as) => (await api('/api/nodes/options/brain-models', { as })).body.options.map((option) => option.value);
  return { api, or, requests, say, configOf, optionsOf, chatgptMod };
}

async function runWith(iso) {
  const { api, requests, say, configOf, optionsOf, chatgptMod } = await setup(iso);
  const FULL = [OPUS, 'openai/gpt-5.2', 'google/gemini-3.1-pro', 'openai/gpt-5.6-luna', FABLE];

  // ============ C1: what people see ============
  const admin = await configOf(ADMIN);
  assert.deepEqual(admin.brainModels.filter((m) => !m.startsWith('chatgpt/')), FULL, 'admins see everything configured');
  assert.ok(admin.brainModels.some((m) => m.startsWith('chatgpt/')), 'and the subscription models');
  assert.equal(admin.defaultBrain, OPUS);
  const staff = await configOf(STAFF);
  assert.deepEqual(staff.brainModels.filter((m) => !m.startsWith('chatgpt/')), FULL, 'internal people are not restricted');
  for (const who of [P1, GUEST]) {
    const view = await configOf(who);
    assert.deepEqual(view.brainModels, LIST, `${who}: only the models of the list, no subscription models`);
    assert.equal(view.defaultBrain, LIST[0], `${who}: the default model is the first of the list when the configured default is not on it`);
  }
  assert.deepEqual(await optionsOf(P1), LIST, 'the LLM nodes offer the same list');
  assert.deepEqual(await optionsOf(GUEST), LIST);
  assert.deepEqual((await optionsOf(ADMIN)).filter((m) => !m.startsWith('chatgpt/')), FULL);

  // ============ C2: the server enforces it ============
  // a model outside the list (an old tab, a hand-made request) gets the default of the list, with a notice
  let turn = await say(P1, FABLE);
  assert.equal(turn.status, 200);
  assert.equal(requests.at(-1).model, LIST[0], 'the expensive model is never called');
  const notice = turn.events.find((event) => event.type === 'notice');
  assert.equal(notice.code, 'BRAIN_MODEL_REPLACED');
  assert.equal(notice.model, LIST[0]);
  assert.deepEqual(turn.events.filter((event) => event.type === 'error'), []);
  // also a model the app knows but the list does not
  turn = await say(GUEST, OPUS);
  assert.equal(requests.at(-1).model, LIST[0]);
  // a model of the list is used as asked, without a notice
  const callsBefore = requests.length;
  turn = await say(P1, LIST[1]);
  assert.equal(requests.at(-1).model, LIST[1]);
  assert.equal(requests.length, callsBefore + 1);
  assert.equal(turn.events.some((event) => event.type === 'notice'), false);
  // no model at all: the default of the list
  turn = await say(P1, undefined);
  assert.equal(requests.at(-1).model, LIST[0]);
  assert.equal(turn.events.some((event) => event.type === 'notice'), false);
  // the subscription models stay refused (403) as before
  turn = await say(P1, 'chatgpt/gpt-5.6-sol');
  assert.equal(turn.status, 403);
  assert.equal(turn.body.code, 'FORBIDDEN_FOR_ROLE');
  assert.equal(requests.length, callsBefore + 2);
  // internal people choose freely
  turn = await say(STAFF, FABLE);
  assert.equal(requests.at(-1).model, FABLE);
  turn = await say(ADMIN, OPUS);
  assert.equal(requests.at(-1).model, OPUS);

  // the Director's own entry point refuses another model as well (no way in around the route)
  const brain = iso.load('lib/brain');
  const access = iso.load('lib/access');
  const chat = (await api('/api/sessions', { method: 'POST', as: P1, json: {} })).body.session;
  const store = iso.load('lib/store');
  const before = requests.length;
  await assert.rejects(
    brain.runTurn({ sessionId: chat.id, text: 'Hallo', brainModel: FABLE, config: { restrictedBrainModels: LIST, imageModel: 'x', videoModel: 'y' }, emit() {}, user: P1 }),
    (error) => error instanceof access.RoleRestrictedError && error.feature === 'models' && error.code === 'FORBIDDEN_FOR_ROLE'
  );
  assert.equal(requests.length, before, 'nothing was sent to a provider');
  assert.equal((await store.readSession(chat.id)).messages.length, 0, 'nothing was stored');

  // the LLM nodes: a blank model is the default of the list, a model chosen by hand outside the list is refused
  const or = iso.load('lib/openrouter');
  const posts = [];
  or.postJson = async (route, payload) => {
    posts.push(payload);
    return { choices: [{ message: { content: 'Antwort' } }], usage: { cost: 0.001 } };
  };
  const registry = iso.load('lib/nodes/registry').createRegistry();
  iso.load('lib/nodes/nodes-basic').registerAll(registry);
  iso.load('lib/nodes/nodes-generate').registerAll(registry);
  const def = registry.get('llm.chat');
  const run = (user, model) => def.execute({
    sessionId: 'nodes-restricted',
    user,
    config: { defaultBrain: OPUS, brainModels: FULL, restrictedBrainModels: LIST },
    toolCtx: {},
    signal: new AbortController().signal,
    log() {}
  }, { prompt: { type: 'text', value: 'Hallo' } }, registry.normalizeParams(def, { model }));
  await run(P1, '');
  assert.equal(posts.at(-1).model, LIST[0], 'a blank model: the default of the list for a participant');
  await run(STAFF, '');
  assert.equal(posts.at(-1).model, OPUS, 'a blank model: the configured default for internal people');
  await run(P1, LIST[1]);
  assert.equal(posts.at(-1).model, LIST[1]);
  const postsBefore = posts.length;
  await assert.rejects(run(P1, FABLE), (error) => error instanceof access.RoleRestrictedError && error.feature === 'models');
  await assert.rejects(run(GUEST, OPUS), (error) => error.code === 'FORBIDDEN_FOR_ROLE');
  assert.equal(posts.length, postsBefore, 'a refused node call reaches no provider');
  await run(STAFF, FABLE);
  assert.equal(posts.at(-1).model, FABLE, 'internal people may choose any model');

  // the same participant over the API sees the 403 sentence key in all languages (checked in testCleanup)
  void chatgptMod;
}

async function runWithout(iso) {
  const { requests, say, configOf, optionsOf } = await setup(iso);
  const REGULAR = [OPUS, 'openai/gpt-5.2', 'google/gemini-3.1-pro', 'openai/gpt-5.6-luna', FABLE];
  // without the setting participants see every configured model except the subscription ones, as before
  for (const who of [P1, GUEST]) {
    const view = await configOf(who);
    assert.deepEqual(view.brainModels, REGULAR);
    assert.equal(view.defaultBrain, OPUS);
  }
  assert.deepEqual(await optionsOf(P1), REGULAR);
  // an empty list is the same as no list
  const turn = await say(P1, FABLE);
  assert.equal(turn.status, 200);
  assert.equal(requests.at(-1).model, FABLE, 'the chosen model is used');
  assert.equal(turn.events.some((event) => event.type === 'notice'), false);
  const refused = await say(P1, 'chatgpt/gpt-5.6-sol');
  assert.equal(refused.status, 403, 'the rule about the subscription models is unchanged');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
