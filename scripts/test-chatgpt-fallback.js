'use strict';

// When the ChatGPT subscription fails, one model call of the Director (and of an LLM node) is repeated through OpenRouter
// (WP24, part B). Everything is a local double: the subscription is a real client with a scripted fetch, OpenRouter is a
// replaced function, and a fetch guard refuses everything that is not localhost, so nothing is paid and nothing leaves
// the machine.
//
//   B1  replacement per model call: 401 (refresh failed), 429, 5xx, network error, timeout; none for 400 or after output
//   B2  without an OpenRouter key the error stays, in plain words
//   B3  the replaced step is booked with the openai/... model and the cost OpenRouter reports
//   B4  a notice in the chat (live and stored), three languages, one log line without secrets
//   B5  ten minutes straight to OpenRouter, a missing login needs no pause, a new login ends it
//   B6  the LLM nodes use the same function

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { createIsolatedApp } = require('./support/isolated-app');

const root = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MODEL = 'chatgpt/gpt-6.1-sol';
const REPLACEMENT = 'openai/gpt-6.1-sol';
const FAKE_ACCESS_TOKEN_MARKER = 'dummy-signature';
const FAKE_REFRESH = 'refresh-token-never-logged';
const NOW = 1_900_000_000_000;

function jwt() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp: 2_000_000_000, 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } })}.${FAKE_ACCESS_TOKEN_MARKER}`;
}

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

const sse = (events) => `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
const sseResponse = (events) => new Response(sse(events), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

// A stream that delivers some events and then breaks (the connection drops in the middle of an answer).
function brokenResponse(events) {
  const encoder = new TextEncoder();
  let sent = false;
  return new Response(new ReadableStream({
    pull(controller) {
      if (sent) {
        controller.error(new TypeError('terminated'));
        return;
      }
      sent = true;
      controller.enqueue(encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')));
    }
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const okStep = (text, tool) => [
  ...(text ? [{ type: 'response.output_text.delta', delta: text }] : []),
  ...(tool ? [{ type: 'response.output_item.done', item: { type: 'function_call', name: tool.name, arguments: JSON.stringify(tool.args || {}), call_id: tool.id } }] : []),
  { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }
];

// The subscription: a real client (lib/chatgpt.js) over a scripted fetch. Each entry of `script` answers one call.
function makeSubscription(chatgptMod) {
  const script = [];
  const calls = [];
  const refreshes = [];
  const saved = { access_token: jwt(), refresh_token: FAKE_REFRESH, account_id: 'account-test', access_expires_at: 2_000_000_000_000, plan: 'pro' };
  const store = { read: () => saved, async write() {}, async remove() {}, removeSync() {} };
  const fetchImpl = async (url, init) => {
    if (url === chatgptMod.TOKEN_URL) {
      refreshes.push(url);
      return new Response('{"error":"invalid_grant"}', { status: 400 });
    }
    const body = JSON.parse(init.body);
    calls.push({ url, model: body.model, input: body.input });
    const step = script.shift();
    if (!step) throw new Error('no scripted answer left');
    if (step.throw) throw step.throw;
    if (step.broken) return brokenResponse(step.broken);
    if (step.events) return sseResponse(step.events);
    return new Response(step.body || '{}', { status: step.status || 500 });
  };
  const client = chatgptMod.createChatGPTClient({ store, now: () => NOW, randomUUID: () => 'session-test', fetchImpl });
  return { client, script, calls, refreshes, say: (...steps) => script.push(...steps) };
}

// OpenRouter chat stream: scripted rounds, requests recorded, the cost goes out in the usage chunk.
function scriptedOpenRouter(or) {
  const rounds = [];
  const requests = [];
  or.chatStream = async (payload) => {
    requests.push(payload);
    const round = rounds.shift();
    if (!round) throw new Error('OpenRouter: no scripted answer left');
    if (round.fail) throw round.fail;
    const lines = [];
    if (round.text) lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: round.text } }] })}`, '');
    (round.tools || []).forEach((call, index) => {
      lines.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: `or-call-${requests.length}-${index}`, function: { name: call.name, arguments: JSON.stringify(call.args || {}) } }] } }] })}`, '');
    });
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: round.tools ? 'tool_calls' : 'stop' }] })}`, '');
    lines.push(`data: ${JSON.stringify({ choices: [], usage: { cost: round.cost ?? 0.0123 } })}`, '', 'data: [DONE]', '');
    return new Response(lines.join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { rounds, requests, say: (...list) => rounds.push(...list) };
}

function loadUi(lang) {
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

/* ---------- units: which failures may be repeated ---------- */

async function testClassification(chatgptMod, fb) {
  const err = (status, kind, extra = {}) => Object.assign(new chatgptMod.ChatGPTError('x', status, { kind, code: extra.code || null }), { delivered: Boolean(extra.delivered) });
  const reason = fb.replaceableReason;
  // repeated
  for (const status of [401, 403, 408, 429, 500, 502, 503, 504]) assert.ok(reason(err(status, 'http')), `HTTP ${status}`);
  for (const status of [400, 404, 413, 422]) assert.equal(reason(err(status, 'http')), null, `HTTP ${status} is a fault in the request`);
  assert.ok(reason(err(0, 'not_connected')));
  assert.ok(reason(err(400, 'refresh')), 'a refresh that fails with 400 is a lost login, not a bad request');
  assert.ok(reason(err(0, 'network')));
  assert.ok(reason(err(0, 'timeout')));
  assert.ok(reason(err(0, 'stream', { code: 'rate_limit_exceeded' })));
  assert.ok(reason(err(0, 'stream', { code: 'server_error' })));
  assert.equal(reason(err(0, 'stream', { code: 'invalid_prompt' })), null);
  assert.equal(reason(err(0, 'stream')), null, 'an unknown stream failure is not repeated');
  // never repeated after output, never for bugs
  assert.equal(reason(err(429, 'http', { delivered: true })), null);
  assert.equal(reason(err(0, 'network', { delivered: true })), null);
  assert.equal(reason(new Error('boom')), null);
  assert.equal(reason(new TypeError('x')), null);
  assert.equal(reason(null), null);
  assert.equal(reason(err(0, null)), null, 'an error without a kind');

  assert.equal(fb.replacementModel('chatgpt/gpt-6.1-sol'), 'openai/gpt-6.1-sol');
  assert.equal(fb.replacementModel('chatgpt/gpt-5.6-luna'), 'openai/gpt-5.6-luna');
  assert.equal(fb.isSubscriptionModel('chatgpt/x'), true);
  assert.equal(fb.isSubscriptionModel('openai/x'), false);
}

// The real client marks its errors; the cases of B1 end to end, without the app.
async function testClientErrors(chatgptMod, fb) {
  const attempt = async (step, options = {}) => {
    const sub = makeSubscription(chatgptMod);
    sub.say(step);
    const seen = [];
    try {
      await sub.client.streamResponses({ model: MODEL, instructions: 'x', input: [], tools: [], onDelta: (d) => seen.push(d), ...options });
    } catch (error) {
      return { error, seen, sub };
    }
    throw new Error('the call should have failed');
  };
  const reasonOf = (r) => fb.replaceableReason(r.error);

  let r = await attempt({ status: 401, body: '{"detail":"expired"}' });
  assert.equal(r.error.kind, 'refresh', 'a 401 triggers a refresh, which fails here');
  assert.ok(reasonOf(r));
  assert.equal(r.sub.client.status().connected, false, 'the existing status logic: a failed refresh means not connected');
  r = await attempt({ status: 429, body: '{"detail":"usage limit reached"}' });
  assert.equal(r.error.status, 429);
  assert.ok(reasonOf(r));
  r = await attempt({ status: 503, body: 'upstream' });
  assert.ok(reasonOf(r));
  r = await attempt({ throw: new TypeError('fetch failed') });
  assert.equal(r.error.kind, 'network');
  assert.ok(reasonOf(r));
  r = await attempt({ status: 400, body: '{"detail":"bad request"}' });
  assert.equal(reasonOf(r), null);
  r = await attempt({ events: [{ type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: 'slow down' } } }] });
  assert.ok(reasonOf(r), 'a failed stream with a limit code before any output');
  r = await attempt({ events: [{ type: 'response.failed', response: { error: { code: 'invalid_prompt', message: 'no' } } }] });
  assert.equal(reasonOf(r), null);
  r = await attempt({ broken: [{ type: 'response.output_text.delta', delta: 'Hallo' }] });
  assert.equal(r.error.delivered, true, 'text arrived before the stream broke');
  assert.deepEqual(r.seen, ['Hallo']);
  assert.equal(reasonOf(r), null);
  r = await attempt({ events: [{ type: 'response.output_text.delta', delta: 'Hallo' }, { type: 'response.failed', response: { error: { code: 'server_error', message: 'x' } } }] });
  assert.equal(reasonOf(r), null, 'no repeat after streamed text, even for a server error');
  r = await attempt({ events: [{ type: 'response.output_item.done', item: { type: 'function_call', name: 'echo', arguments: '{}', call_id: 'c1' } }, { type: 'response.failed', response: { error: { code: 'server_error', message: 'x' } } }] });
  assert.equal(reasonOf(r), null, 'no repeat after a tool call arrived');

  // a timeout at the connection: the fetch never answers (the smallest timeout of the client is one second)
  const hangClient = chatgptMod.createChatGPTClient({
    store: { read: () => ({ access_token: jwt(), refresh_token: FAKE_REFRESH, account_id: 'a', access_expires_at: 2_000_000_000_000, plan: 'pro' }), async write() {}, async remove() {} },
    now: () => NOW,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
  });
  const started = Date.now();
  let timeoutError;
  try {
    await hangClient.streamResponses({ model: MODEL, instructions: 'x', input: [], tools: [], timeoutMs: 1000 });
  } catch (error) {
    timeoutError = error;
  }
  assert.ok(Date.now() - started < 5000);
  assert.equal(timeoutError.kind, 'timeout');
  assert.ok(fb.replaceableReason(timeoutError));

  // review: a subscription that hangs without any reply gives up after the (short) first-event timeout, long before the
  // timeout of the whole answer; the error is a replaceable timeout. Here: 1 s against the 5 minutes of the whole answer.
  const quietStarted = Date.now();
  let quietError;
  try {
    await hangClient.streamResponses({ model: MODEL, instructions: 'x', input: [], tools: [], firstEventTimeoutMs: 1000 });
  } catch (error) {
    quietError = error;
  }
  assert.ok(Date.now() - quietStarted < 5000, 'the call did not wait for the timeout of the whole answer');
  assert.equal(quietError.kind, 'timeout');
  assert.equal(quietError.delivered, false);
  assert.match(quietError.message, /nicht rechtzeitig/);
  assert.ok(fb.replaceableReason(quietError), 'the Director may move on to OpenRouter');

  // once the first byte has arrived, the first-event timeout is over: only the timeout of the whole answer counts
  const encoder = new TextEncoder();
  const slowClient = chatgptMod.createChatGPTClient({
    store: { read: () => ({ access_token: jwt(), refresh_token: FAKE_REFRESH, account_id: 'a', access_expires_at: 2_000_000_000_000, plan: 'pro' }), async write() {}, async remove() {} },
    now: () => NOW,
    // like a real fetch, the body breaks when the call is aborted
    fetchImpl: (_url, init) => Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(': keep-alive\n\n'));
        init.signal.addEventListener('abort', () => controller.error(new Error('aborted')));
      }
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
  });
  const slowStarted = Date.now();
  let slowError;
  try {
    await slowClient.streamResponses({ model: MODEL, instructions: 'x', input: [], tools: [], firstEventTimeoutMs: 1000, timeoutMs: 2500 });
  } catch (error) {
    slowError = error;
  }
  assert.ok(Date.now() - slowStarted >= 2000, 'the keep-alive ended the first-event wait; the whole-answer timeout decided');
  assert.equal(slowError.kind, 'timeout');
  assert.match(slowError.message, /Zeitlimit/);
}

/* ---------- units: run() and the pause ---------- */

async function testRunRules(chatgptMod, fb, or) {
  const originalStatus = chatgptMod.status;
  const originalKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-test-key-with-enough-length';
  let clock = 1_000_000;
  fb.useClock(() => clock);
  try {
    chatgptMod.status = () => ({ connected: true });
    const fail = (status) => Object.assign(new chatgptMod.ChatGPTError('limit', status, { kind: 'http' }));
    let subscriptionCalls = 0;
    let replacementModels = [];
    const base = {
      model: MODEL,
      subscription: async () => { subscriptionCalls += 1; throw fail(429); },
      replacement: async (model) => { replacementModels.push(model); return { text: 'ok' }; }
    };
    const first = await fb.run(base);
    assert.equal(first.replaced, true);
    assert.equal(first.model, REPLACEMENT);
    assert.deepEqual(replacementModels, [REPLACEMENT]);
    assert.equal(fb.isPaused(), true, 'a failure pauses the subscription');
    assert.equal(fb.pausedUntil(), clock + 10 * 60 * 1000, 'for ten minutes');

    // during the pause: straight to OpenRouter, the subscription is not tried
    clock += 9 * 60 * 1000 + 59 * 1000;
    const second = await fb.run(base);
    assert.equal(second.replaced, true);
    assert.equal(subscriptionCalls, 1, 'no new attempt inside the ten minutes');
    // after the pause: tried again
    clock += 2000;
    assert.equal(fb.isPaused(), false);
    const third = await fb.run({ ...base, subscription: async () => { subscriptionCalls += 1; return { text: 'abo' }; } });
    assert.equal(third.replaced, false);
    assert.equal(third.model, MODEL);
    assert.equal(subscriptionCalls, 2);

    // a new login ends the pause at once
    await fb.run(base);
    assert.equal(fb.isPaused(), true);
    fb.resume();
    assert.equal(fb.isPaused(), false);

    // a missing login needs no pause: the status says it, the subscription is not tried
    fb.useClock(() => clock);
    chatgptMod.status = () => ({ connected: false });
    subscriptionCalls = 0;
    const gone = await fb.run(base);
    assert.equal(gone.replaced, true);
    assert.equal(gone.reason, 'not_connected');
    assert.equal(subscriptionCalls, 0);
    assert.equal(fb.isPaused(), false);
    chatgptMod.status = () => ({ connected: true });

    // the notice callback runs first, before the replacement; a failing notice does not stop the answer
    const order = [];
    await fb.run({
      ...base,
      replacement: async () => { order.push('replacement'); return {}; },
      onReplaced: (info) => { order.push(`notice ${info.from} -> ${info.to}`); throw new Error('notice failed'); }
    });
    assert.deepEqual(order, [`notice ${MODEL} -> ${REPLACEMENT}`, 'replacement']);

    // 400: nothing is repeated, nothing is paused
    fb.useClock(() => clock);
    replacementModels = [];
    await assert.rejects(fb.run({ ...base, subscription: async () => { throw fail(400); } }), (error) => error.status === 400);
    assert.deepEqual(replacementModels, []);
    assert.equal(fb.isPaused(), false);

    // no key: the error is the plain one and nothing is paused
    delete process.env.OPENROUTER_API_KEY;
    assert.equal(or.hasKey(), false);
    await assert.rejects(fb.run(base), (error) => {
      assert.ok(error instanceof fb.SubscriptionUnavailableError);
      assert.equal(error.code, 'CHATGPT_UNAVAILABLE');
      assert.equal(error.messageDe, fb.MESSAGE_DE);
      assert.equal(error.cause.status, 429, 'the original error stays attached');
      return true;
    });
    assert.equal(fb.isPaused(), false, 'without a key a pause would help nobody');
    // no key and an error that is not repeatable: the original error
    await assert.rejects(fb.run({ ...base, subscription: async () => { throw fail(400); } }), (error) => error.status === 400);
  } finally {
    chatgptMod.status = originalStatus;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    fb.useClock(null);
  }
}

/* ---------- the app ---------- */

async function main() {
  const guard = guardFetch();
  const iso = await createIsolatedApp({
    active: false,
    env: {
      OPENROUTER_API_KEY: 'sk-or-v1-test-key-with-enough-length',
      PUBLIC_BASE_URL: '',
      ELEVENLABS_API_KEY: '',
      FAL_KEY: '',
      GTS_API_TOKEN: ''
    }
  });
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  const logged = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => {
    logged.push(args.map(String).join(' '));
    originalLog(...args);
  };
  // the server logs the failures this test provokes on purpose; only unexpected ones are shown
  console.error = (...args) => {
    if (!/^\[chat\]/.test(String(args[0]))) originalError(...args);
  };
  try {
    await run(iso, guard, logged);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    await iso.cleanup();
    guard.restore();
  }
  assert.deepEqual(guard.attempts, [], 'no request left the machine');
  console.log('ChatGPT-Ersatz: Ersatz pro Modellaufruf bei 401, 429, 5xx, Netzwerkfehler und Timeout, keiner bei 400 oder nach Ausgabe, kein doppelter Werkzeug-Aufruf, Kosten mit openai/-Modell, Hinweis, 10-Minuten-Pause, Nodes mit derselben Funktion.');
  console.log('test-chatgpt-fallback.js: ok');
}

async function run(iso, guard, logged) {
  const api = iso.request;
  const chatgptMod = iso.load('lib/chatgpt');
  const fb = iso.load('lib/chatgpt-fallback');
  const or = iso.load('lib/openrouter');
  const store = iso.load('lib/store');
  const costs = iso.load('lib/costs');
  const discovery = iso.load('lib/discovery');
  discovery.brainSupportsImages = async () => true;
  or.listVideoModels = async () => ({ data: [] });

  await testClassification(chatgptMod, fb);
  await testClientErrors(chatgptMod, fb);
  await testRunRules(chatgptMod, fb, or);

  const director = scriptedOpenRouter(or);
  let clock = 5_000_000;
  fb.useClock(() => clock);
  let sub = null;
  const connect = () => {
    sub = makeSubscription(chatgptMod);
    chatgptMod.status = () => sub.client.status();
    chatgptMod.streamResponses = (options) => sub.client.streamResponses(options);
    chatgptMod.ensureAccessToken = (options) => sub.client.ensureAccessToken(options);
    fb.useClock(() => clock);
    return sub;
  };

  const newChat = async () => (await api('/api/sessions', { method: 'POST', json: {} })).body.session;
  const say = async (chat, text, brainModel = MODEL) => {
    const response = await api(`/api/sessions/${chat.id}/message`, { method: 'POST', json: { text, brainModel } });
    return { status: response.status, events: response.status === 200 ? parseEvents(response.text) : [], body: response.body };
  };
  const messagesOf = async (chat) => (await store.readSession(chat.id)).messages;
  const brainCosts = async () => (await costs.readCosts()).filter((entry) => entry.type === 'brain');
  const notices = (turn) => turn.events.filter((event) => event.type === 'notice');
  const errorsOf = (turn) => turn.events.filter((event) => event.type === 'error');
  const textOf = (turn) => turn.events.filter((event) => event.type === 'text_delta').map((event) => event.delta).join('');
  const orMessages = (index = -1) => director.requests.at(index).messages.slice(1); // without the system prompt

  // ============ B1 / B3 / B4: 401 with a failed refresh ============
  connect();
  let chat = await newChat();
  sub.say({ status: 401, body: '{"detail":"expired"}' });
  director.say({ text: 'Antwort über OpenRouter.', cost: 0.0123 });
  let turn = await say(chat, 'Hallo');
  assert.equal(turn.status, 200);
  assert.deepEqual(errorsOf(turn), [], 'the chat goes on');
  assert.equal(textOf(turn), 'Antwort über OpenRouter.');
  assert.equal(sub.refreshes.length, 1, 'the refresh was tried first (existing behaviour)');
  assert.equal(director.requests.length, 1);
  assert.equal(director.requests[0].model, REPLACEMENT, 'chatgpt/<model> becomes openai/<model>');
  assert.equal(director.requests[0].messages[0].role, 'system');
  assert.equal(notices(turn).length, 1);
  assert.equal(notices(turn)[0].code, 'CHATGPT_REPLACED');
  assert.match(notices(turn)[0].message, /OpenRouter/);
  assert.equal(notices(turn)[0].model, REPLACEMENT);
  assert.ok(turn.events.findIndex((event) => event.type === 'notice') < turn.events.findIndex((event) => event.type === 'text_delta'), 'the notice comes before the answer');
  // booked with the model that answered, with the cost OpenRouter reports, like any other OpenRouter answer
  let entries = await brainCosts();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].model, REPLACEMENT);
  assert.equal(entries[0].cost, 0.0123);
  assert.equal(entries[0].billing, undefined, 'no subscription label');
  assert.equal(entries[0].sessionId, chat.id);
  // the answer carries the stored mark (the notice survives a reload)
  let messages = await messagesOf(chat);
  const answered = messages.filter((m) => m.role === 'assistant');
  assert.equal(answered.length, 1);
  assert.deepEqual(answered[0].subscriptionFallback, { from: MODEL, model: REPLACEMENT });
  // the failed login is not connected any more (the status logic), no pause is needed
  assert.equal(sub.client.status().connected, false);

  // ============ B4: one log line without secrets ============
  const lines = logged.filter((line) => line.startsWith('[chatgpt]'));
  assert.ok(lines.length >= 1, 'a log line for the replacement');
  for (const line of lines) {
    for (const secret of [FAKE_REFRESH, FAKE_ACCESS_TOKEN_MARKER, 'Bearer', 'access_token', 'refresh_token', 'account-test', 'Authorization']) {
      assert.equal(line.includes(secret), false, `log line shows ${secret}`);
    }
    assert.equal(line.includes('Hallo'), false, 'no content of the call');
  }
  assert.ok(lines.some((line) => line.includes(REPLACEMENT)));

  // ============ B1 / B5: 429, the ten minutes ============
  connect();
  chat = await newChat();
  sub.say({ status: 429, body: '{"detail":"usage limit reached"}' });
  director.say({ text: 'Zweite Antwort.', cost: 0.02 });
  turn = await say(chat, 'Noch eins');
  assert.deepEqual(errorsOf(turn), []);
  assert.equal(sub.calls.length, 1);
  assert.equal(fb.isPaused(), true);
  assert.equal(director.requests.at(-1).model, REPLACEMENT);

  // inside the ten minutes: straight to OpenRouter, the subscription is not asked
  clock += 9 * 60 * 1000;
  director.say({ text: 'Direkt über OpenRouter.', cost: 0.03 });
  turn = await say(chat, 'Und weiter');
  assert.deepEqual(errorsOf(turn), []);
  assert.equal(sub.calls.length, 1, 'no new attempt during the pause');
  assert.equal(director.requests.at(-1).model, REPLACEMENT);
  assert.equal(notices(turn).length, 1, 'every answer through OpenRouter says so (it is billed)');
  // after the ten minutes: the subscription is tried again and answers
  clock += 61 * 1000;
  sub.say({ events: okStep('Wieder über das Abo.') });
  turn = await say(chat, 'Wieder da?');
  assert.deepEqual(errorsOf(turn), []);
  assert.equal(sub.calls.length, 2);
  assert.equal(textOf(turn), 'Wieder über das Abo.');
  assert.deepEqual(notices(turn), []);
  entries = await brainCosts();
  const subscriptionEntry = entries.at(-1);
  assert.equal(subscriptionEntry.model, MODEL);
  assert.equal(subscriptionEntry.cost, 0);
  assert.equal(subscriptionEntry.billing, 'Abo');
  assert.deepEqual(entries.slice(-3, -1).map((entry) => [entry.model, entry.cost]), [[REPLACEMENT, 0.02], [REPLACEMENT, 0.03]]);
  messages = await messagesOf(chat);
  assert.equal(messages.filter((m) => m.subscriptionFallback).length, 2, 'only the replaced answers carry the mark');

  // ============ B1: server error, network error, a failed stream before any output ============
  for (const [label, step] of [
    ['503', { status: 503, body: '<html>Bad gateway</html>' }],
    ['network error', { throw: new TypeError('fetch failed') }],
    ['stream failure with a limit code', { events: [{ type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: 'slow down' } } }] }]
  ]) {
    connect();
    chat = await newChat();
    sub.say(step);
    director.say({ text: `Ersatz bei ${label}.` });
    turn = await say(chat, 'Test');
    assert.deepEqual(errorsOf(turn), [], label);
    assert.equal(textOf(turn), `Ersatz bei ${label}.`, label);
    assert.equal(director.requests.at(-1).model, REPLACEMENT, label);
    assert.equal(notices(turn).length, 1, label);
  }

  // ============ B1: no replacement for 400, a failure the stream cannot repeat ============
  for (const [label, step] of [
    ['400', { status: 400, body: '{"detail":"The request is not valid"}' }],
    ['failed stream, bad prompt', { events: [{ type: 'response.failed', response: { error: { code: 'invalid_prompt', message: 'Prompt rejected' } } }] }],
    ['text, then the stream breaks', { broken: [{ type: 'response.output_text.delta', delta: 'Halbe Antwort' }] }],
    ['text, then a server error', { events: [{ type: 'response.output_text.delta', delta: 'Halbe Antwort' }, { type: 'response.failed', response: { error: { code: 'server_error', message: 'boom' } } }] }]
  ]) {
    connect();
    chat = await newChat();
    const orBefore = director.requests.length;
    const costsBefore = (await brainCosts()).length;
    sub.say(step);
    turn = await say(chat, 'Test');
    assert.equal(director.requests.length, orBefore, `${label}: OpenRouter was not called`);
    assert.deepEqual(notices(turn), [], label);
    assert.equal(errorsOf(turn).length, 1, `${label}: the error is shown`);
    assert.equal(errorsOf(turn)[0].fatal, true, label);
    assert.equal(errorsOf(turn)[0].code, undefined, `${label}: the plain error stays`);
    assert.equal(fb.isPaused(), false, `${label}: nothing is paused`);
    assert.equal((await brainCosts()).length, costsBefore, `${label}: nothing is booked`);
    if (label.startsWith('text')) assert.equal(textOf(turn), 'Halbe Antwort', `${label}: what arrived stays`);
  }

  // ============ B1: a tool ran, then the subscription fails: the replacement goes on, the tool never runs twice ============
  connect();
  chat = await newChat();
  const memoryBefore = (await store.readBrainMemory()).length;
  sub.say(
    { events: okStep('Ich merke mir das.', { name: 'save_memory', id: 'call-sub-1', args: { note: 'Erste Notiz' } }) },
    { status: 429, body: '{"detail":"usage limit reached"}' }
  );
  director.say(
    { text: 'Noch eine Notiz.', tools: [{ name: 'save_memory', args: { note: 'Zweite Notiz' } }], cost: 0.01 },
    { text: 'Fertig.', cost: 0.02 }
  );
  turn = await say(chat, 'Merk dir bitte etwas');
  assert.deepEqual(errorsOf(turn), [], JSON.stringify(errorsOf(turn)));
  assert.equal(sub.calls.length, 2, 'step 1 through the subscription, step 2 tried there once');
  assert.equal(director.requests.length >= 2, true);
  const memory = (await store.readBrainMemory()).slice(memoryBefore).map((entry) => entry.note);
  assert.deepEqual(memory, ['Erste Notiz', 'Zweite Notiz'], 'each tool ran exactly once');
  // step 2 (replaced) saw the neutral history: user, assistant with the tool call, the tool result with the same id
  const replacedRequest = director.requests.at(-2);
  assert.equal(replacedRequest.model, REPLACEMENT);
  const seen = replacedRequest.messages.slice(1);
  assert.deepEqual(seen.map((m) => m.role), ['user', 'assistant', 'tool']);
  assert.equal(seen[1].tool_calls[0].id, 'call-sub-1');
  assert.equal(seen[1].tool_calls[0].function.name, 'save_memory');
  assert.equal(seen[2].tool_call_id, 'call-sub-1');
  assert.equal(seen[2].content, 'Gemerkt.');
  assert.ok(replacedRequest.tools.some((tool) => tool.function.name === 'save_memory'), 'the tools are offered to the replacement');
  // step 3 (OpenRouter again, the subscription is paused): both tool calls with their results, in order
  const lastRequest = director.requests.at(-1);
  assert.equal(sub.calls.length, 2, 'the paused subscription is not asked for step 3');
  assert.deepEqual(lastRequest.messages.slice(1).map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'tool']);
  assert.equal(lastRequest.messages.slice(1)[3].tool_calls[0].id, 'or-call-' + (director.requests.length - 1) + '-0');
  // the subscription call got the same history in its own format
  assert.deepEqual(sub.calls[1].input.map((item) => item.type), ['message', 'message', 'function_call', 'function_call_output']);
  assert.equal(sub.calls[1].input[2].call_id, 'call-sub-1');
  // three steps, three bookings: Abo, then twice OpenRouter
  entries = (await brainCosts()).filter((entry) => entry.sessionId === chat.id);
  assert.deepEqual(entries.map((entry) => [entry.model, entry.cost, entry.billing || null]), [[MODEL, 0, 'Abo'], [REPLACEMENT, 0.01, null], [REPLACEMENT, 0.02, null]]);
  messages = await messagesOf(chat);
  assert.equal(messages.filter((m) => m.subscriptionFallback).length, 1, 'the mark is set once per turn');
  assert.equal(messages.filter((m) => m.role === 'tool').length, 2);
  assert.equal(notices(turn).length, 1, 'the live notice is shown once per turn');

  // ============ not connected, with a key: the answer still runs, without trying the subscription ============
  connect();
  chatgptMod.status = () => ({ connected: false, plan: null, expiresAt: null, models: [] });
  fb.useClock(() => clock);
  let attempted = 0;
  chatgptMod.streamResponses = async () => { attempted += 1; throw new Error('must not be called'); };
  chat = await newChat();
  director.say({ text: 'Ohne Abo.', cost: 0.005 });
  turn = await say(chat, 'Test');
  assert.deepEqual(errorsOf(turn), [], JSON.stringify(errorsOf(turn)));
  assert.equal(textOf(turn), 'Ohne Abo.');
  assert.equal(attempted, 0);
  assert.equal(director.requests.at(-1).model, REPLACEMENT, 'the chosen model stays the one asked for, not the default');
  assert.equal(notices(turn).length, 1);
  assert.equal(fb.isPaused(), false, 'a missing login needs no pause');

  // ============ B2: no key ============
  iso.setEnv('OPENROUTER_API_KEY', '');
  assert.equal(or.hasKey(), false);
  // connected, but the subscription fails and there is nothing to fall back to: plain words, a code, nothing else runs
  connect();
  chat = await newChat();
  sub.say({ status: 429, body: '{"detail":"usage limit reached"}' });
  const orBeforeNoKey = director.requests.length;
  turn = await say(chat, 'Test');
  assert.equal(director.requests.length, orBeforeNoKey);
  assert.equal(errorsOf(turn).length, 1);
  assert.equal(errorsOf(turn)[0].code, 'CHATGPT_UNAVAILABLE');
  assert.equal(errorsOf(turn)[0].message, fb.MESSAGE_DE);
  assert.equal(errorsOf(turn)[0].message.includes('usage limit'), false, 'no raw provider text');
  assert.equal(errorsOf(turn)[0].message.includes('ß'), false);
  assert.equal(fb.isPaused(), false);
  // not connected and no key: the message of today
  chatgptMod.status = () => ({ connected: false, plan: null, expiresAt: null, models: [] });
  turn = await say(chat, 'Test');
  assert.equal(errorsOf(turn)[0].message, chatgptMod.DISCONNECTED_MESSAGE);
  iso.setEnv('OPENROUTER_API_KEY', 'sk-or-v1-test-key-with-enough-length');

  // ============ B4: texts in three languages ============
  const texts = new Set();
  for (const lang of ['de', 'en', 'es']) {
    const dict = loadUi(lang);
    for (const key of ['chat.notice.CHATGPT_REPLACED', 'chat.error.CHATGPT_UNAVAILABLE']) {
      assert.ok(dict[key] && dict[key].length > 20, `${lang}: ${key}`);
      assert.equal(dict[key].includes('ß'), false, `${lang}.${key}`);
      texts.add(dict[key]);
    }
  }
  assert.equal(texts.size, 6, 'every sentence is written in each language');
  assert.match(loadUi('de')['chat.notice.CHATGPT_REPLACED'], /ChatGPT-Abo nicht erreichbar.*OpenRouter.*berechnet/);
  assert.equal(loadUi('de')['chat.error.CHATGPT_UNAVAILABLE'], fb.MESSAGE_DE, 'the German fallback of the server is the German text');
  const clientSource = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  assert.match(clientSource, /event\.type === 'notice'/);
  assert.match(clientSource, /message\.subscriptionFallback/);
  assert.equal(/innerHTML\s*=\s*[^;]*notice/i.test(clientSource), false, 'the notice is written as text');

  // ============ B6: the LLM nodes ============
  await testNodes(iso, fb);
  fb.useClock(null);
}

async function testNodes(iso, fb) {
  const llm = iso.load('lib/nodes/llm');
  const chatgptMod = iso.load('lib/chatgpt');
  const or = iso.load('lib/openrouter');
  const costs = iso.load('lib/costs');
  const discovery = iso.load('lib/discovery');
  discovery.brainSupportsImages = async () => true;
  const sub = (() => {
    const s = makeSubscription(chatgptMod);
    chatgptMod.status = () => s.client.status();
    chatgptMod.streamResponses = (options) => s.client.streamResponses(options);
    return s;
  })();
  fb.useClock(() => 9_000_000);
  const posts = [];
  or.postJson = async (route, payload) => {
    posts.push({ route, payload });
    return { choices: [{ message: { content: 'Antwort des Nodes' } }], usage: { cost: 0.0042 } };
  };
  const before = (await costs.readCosts()).length;
  const replacedInfo = [];

  // the subscription answers: booked as before
  sub.say({ events: okStep('Aus dem Abo') });
  let result = await llm.completeText({ model: MODEL, prompt: 'Hallo', sessionId: 'nodes-test', user: 'lokal' });
  assert.equal(result.text, 'Aus dem Abo');
  assert.equal(result.billing, 'Abo');
  assert.equal(result.usd, 0);
  assert.equal(posts.length, 0);

  // 429: the same call through OpenRouter with the openai/ model, booked with the reported cost
  sub.say({ status: 429, body: '{"detail":"usage limit reached"}' });
  result = await llm.completeText({ model: MODEL, prompt: 'Hallo', sessionId: 'nodes-test', user: 'lokal', onReplaced: (info) => replacedInfo.push(info) });
  assert.equal(result.text, 'Antwort des Nodes');
  assert.equal(result.model, REPLACEMENT);
  assert.equal(result.usd, 0.0042);
  assert.equal(result.replaced, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].payload.model, REPLACEMENT);
  assert.deepEqual(replacedInfo.map((info) => [info.from, info.to]), [[MODEL, REPLACEMENT]]);
  const entries = (await costs.readCosts()).slice(before);
  assert.deepEqual(entries.map((entry) => [entry.model, entry.cost, entry.billing || null]), [[MODEL, 0, 'Abo'], [REPLACEMENT, 0.0042, null]]);

  // the pause is shared with the Director: the next call goes straight to OpenRouter
  const callsBefore = sub.calls.length;
  result = await llm.completeText({ model: MODEL, prompt: 'Nochmal', sessionId: 'nodes-test', user: 'lokal' });
  assert.equal(sub.calls.length, callsBefore, 'the paused subscription is not asked');
  assert.equal(result.model, REPLACEMENT);
  assert.equal(posts.length, 2);
  assert.ok(fb.isPaused());

  // 400: not repeated
  fb.useClock(() => 9_000_000);
  sub.say({ status: 400, body: '{"detail":"bad request"}' });
  const postsBefore = posts.length;
  await assert.rejects(llm.completeText({ model: MODEL, prompt: 'Hallo', sessionId: 'nodes-test', user: 'lokal' }), (error) => error.status === 400);
  assert.equal(posts.length, postsBefore);

  // no key: plain words
  iso.setEnv('OPENROUTER_API_KEY', '');
  sub.say({ status: 503, body: 'down' });
  await assert.rejects(llm.completeText({ model: MODEL, prompt: 'Hallo', sessionId: 'nodes-test', user: 'lokal' }), (error) => error.code === 'CHATGPT_UNAVAILABLE');
  iso.setEnv('OPENROUTER_API_KEY', 'sk-or-v1-test-key-with-enough-length');

  // the node itself: llm.chat asks through askModel, which logs the replacement in the run log of the node
  fb.useClock(() => 9_000_000);
  const registry = iso.load('lib/nodes/registry').createRegistry();
  iso.load('lib/nodes/nodes-basic').registerAll(registry);
  iso.load('lib/nodes/nodes-generate').registerAll(registry);
  const logs = [];
  const ctx = {
    sessionId: 'nodes-test',
    user: 'lokal',
    config: { defaultBrain: MODEL, brainModels: [MODEL] },
    toolCtx: {},
    signal: new AbortController().signal,
    log: (line) => logs.push(line)
  };
  const def = registry.get('llm.chat');
  const params = registry.normalizeParams(def, { model: '' });
  sub.say({ status: 503, body: 'down' });
  const executed = await def.execute(ctx, { prompt: { type: 'text', value: 'Hallo' } }, params);
  assert.equal(executed.variants[0].text.value, 'Antwort des Nodes');
  assert.equal(executed.cost.usd, 0.0042,'the node shows the cost that was really charged');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /ChatGPT subscription not reachable \(http_503\).*openai\/gpt-6\.1-sol.*billed/);
  assert.equal(/ß/.test(logs[0]), false);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
