'use strict';

const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  createFileTokenStore,
  createChatGPTClient,
  tokenMetadata,
  messagesToInput,
  toolsToResponses,
  BRAIN_MODELS,
  RESPONSES_URL
} = require('../lib/chatgpt');
const { availableBrainModels } = require('../lib/config');
const costs = require('../lib/costs');

function dummyJwt({ exp, plan = 'plus' }) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    exp,
    'https://api.openai.com/auth': { chatgpt_plan_type: plan }
  })}.dummy`;
}

async function testStoreAndImport(directory) {
  const storeFile = path.join(directory, 'chatgpt-auth.json');
  const cliFile = path.join(directory, 'codex-auth.json');
  const exp = 2_000_000_000;
  const accessToken = dummyJwt({ exp, plan: 'pro' });
  await fsp.writeFile(cliFile, `${JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: 'dummy-id',
      access_token: accessToken,
      refresh_token: 'dummy-refresh',
      account_id: 'account-test'
    },
    last_refresh: '2030-01-01T00:00:00.000Z'
  })}\n`);

  const store = createFileTokenStore(storeFile);
  const client = createChatGPTClient({
    env: { CODEX_AUTH_FILE: cliFile },
    store,
    now: () => 1_900_000_000_000,
    fetchImpl: async () => { throw new Error('Netzwerkzugriff im Offline-Test'); }
  });
  const imported = await client.importFromCodexCli();
  assert.deepEqual(imported, {
    connected: true,
    plan: 'pro',
    expiresAt: exp * 1000,
    models: BRAIN_MODELS
  });
  const saved = store.read();
  assert.equal(saved.access_token, accessToken);
  assert.equal(saved.refresh_token, 'dummy-refresh');
  assert.equal(saved.account_id, 'account-test');
  assert.equal(saved.access_expires_at, exp * 1000);
  assert.equal(saved.plan, 'pro');
  assert.equal((await fsp.stat(storeFile)).mode & 0o777, 0o600);

  await client.disconnect();
  assert.deepEqual(client.status(), { connected: false, plan: null, expiresAt: null, models: [] });
  await assert.rejects(fsp.stat(storeFile), { code: 'ENOENT' });
}

function testJwtMetadata() {
  const exp = 2_123_456_789;
  assert.deepEqual(tokenMetadata(dummyJwt({ exp, plan: 'plus' })), {
    expiresAt: exp * 1000,
    plan: 'plus'
  });
  assert.throws(() => tokenMetadata('not-a-jwt'), /gueltiges JWT/);
}

function testAdapterMapping() {
  const input = messagesToInput([
    { role: 'system', content: 'System bleibt instructions.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Pruefe das Bild.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
      ]
    },
    {
      role: 'assistant',
      content: 'Ich rufe das Tool auf.',
      tool_calls: [{
        id: 'call_test',
        type: 'function',
        function: { name: 'echo', arguments: '{"text":"OK"}' }
      }]
    },
    { role: 'tool', tool_call_id: 'call_test', name: 'echo', content: 'OK' }
  ]);
  assert.deepEqual(input, [
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Pruefe das Bild.' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }
      ]
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Ich rufe das Tool auf.' }]
    },
    { type: 'function_call', name: 'echo', arguments: '{"text":"OK"}', call_id: 'call_test' },
    { type: 'function_call_output', call_id: 'call_test', output: 'OK' }
  ]);

  assert.deepEqual(toolsToResponses([{
    type: 'function',
    function: {
      name: 'echo',
      description: 'Echo text',
      parameters: { type: 'object', properties: { text: { type: 'string' } } }
    }
  }]), [{
    type: 'function',
    name: 'echo',
    description: 'Echo text',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    strict: false
  }]);
}

function testModelGating() {
  const configured = ['openai/gpt-5.6-sol', ...BRAIN_MODELS];
  assert.deepEqual(availableBrainModels(configured, false), ['openai/gpt-5.6-sol']);
  assert.deepEqual(availableBrainModels(configured, true), configured);
}

async function testSubscriptionCostEntry(directory) {
  const file = path.join(directory, 'costs.jsonl');
  const entry = await costs.recordCost({
    ts: '2030-01-01T00:00:00.000Z',
    sessionId: 'chatgpt-test',
    type: 'brain',
    model: 'chatgpt/gpt-5.6-sol',
    cost: 0,
    user: 'test@example.com',
    billing: 'Abo',
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
  }, file);
  assert.equal(entry.cost, 0);
  assert.equal(entry.billing, 'Abo');
  assert.deepEqual(entry.usage, { input_tokens: 10, output_tokens: 2, total_tokens: 12 });
  assert.deepEqual(await costs.readCosts(file), [entry]);
}

async function testResponsesContract(directory) {
  const storeFile = path.join(directory, 'stream-auth.json');
  const exp = 2_000_000_000;
  await createFileTokenStore(storeFile).write({
    access_token: dummyJwt({ exp }),
    refresh_token: 'refresh-stream',
    account_id: 'account-stream',
    access_expires_at: exp * 1000,
    plan: 'plus'
  });
  let request;
  const client = createChatGPTClient({
    store: createFileTokenStore(storeFile),
    now: () => 1_900_000_000_000,
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      const events = [
        { type: 'response.created', response: { id: 'resp_test' } },
        { type: 'response.output_text.delta', delta: 'OK' },
        {
          type: 'response.output_item.done',
          item: { type: 'function_call', name: 'echo', arguments: '{"text":"OK"}', call_id: 'call_stream' }
        },
        {
          type: 'response.completed',
          response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }
        }
      ];
      const sse = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
  });
  const deltas = [];
  const toolCalls = [];
  const usage = [];
  const result = await client.streamResponses({
    model: 'chatgpt/gpt-5.6-sol',
    instructions: 'Sag OK.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Sag OK' }] }],
    tools: [],
    onDelta: (delta) => deltas.push(delta),
    onToolCall: (call) => toolCalls.push(call),
    onUsage: (value) => usage.push(value)
  });
  assert.equal(request.url, RESPONSES_URL);
  assert.equal(request.options.headers.Authorization.startsWith('Bearer '), true);
  assert.equal(request.options.headers['chatgpt-account-id'], 'account-stream');
  assert.equal(request.options.headers['OpenAI-Beta'], 'responses=experimental');
  assert.equal(request.options.headers.originator, 'codex_cli_rs');
  assert.equal(request.options.headers.session_id, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(request.body, {
    model: 'gpt-5.6-sol',
    instructions: 'Sag OK.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Sag OK' }] }],
    tools: [],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: []
  });
  assert.deepEqual(deltas, ['OK']);
  assert.deepEqual(toolCalls, [{ name: 'echo', arguments: '{"text":"OK"}', call_id: 'call_stream' }]);
  assert.deepEqual(usage, [{ input_tokens: 10, output_tokens: 2, total_tokens: 12 }]);
  assert.equal(result.text, 'OK');
  assert.deepEqual(result.toolCalls, toolCalls);
}

async function test401RefreshRetry(directory) {
  const storeFile = path.join(directory, 'retry-auth.json');
  const oldToken = dummyJwt({ exp: 2_000_000_000, plan: 'plus' });
  const newToken = dummyJwt({ exp: 2_100_000_000, plan: 'pro' });
  await createFileTokenStore(storeFile).write({
    access_token: oldToken,
    refresh_token: 'refresh-old',
    account_id: 'account-retry',
    access_expires_at: 2_000_000_000_000,
    plan: 'plus'
  });
  const requests = [];
  const client = createChatGPTClient({
    store: createFileTokenStore(storeFile),
    now: () => 1_900_000_000_000,
    randomUUID: () => '22222222-2222-4222-8222-222222222222',
    fetchImpl: async (url, options) => {
      requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
      if (requests.length === 1) return new Response('{"detail":"expired"}', { status: 401 });
      if (requests.length === 2) {
        return new Response(JSON.stringify({
          access_token: newToken,
          refresh_token: 'refresh-rotated'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response([
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'OK' })}`,
        '',
        `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { total_tokens: 1 } } })}`,
        '',
        'data: [DONE]',
        ''
      ].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
  });
  const result = await client.streamResponses({
    model: 'gpt-5.6-sol',
    instructions: 'Sag OK.',
    input: [messageFixture('user', 'Sag OK')],
    tools: []
  });
  assert.equal(result.text, 'OK');
  assert.equal(requests.length, 3);
  assert.equal(requests[0].headers.session_id, '22222222-2222-4222-8222-222222222222');
  assert.equal(requests[2].headers.session_id, requests[0].headers.session_id, '401-Retry muss dieselbe Turn-ID behalten');
  assert.equal(requests[0].headers.Authorization, `Bearer ${oldToken}`);
  assert.equal(requests[2].headers.Authorization, `Bearer ${newToken}`);
  assert.equal(requests[1].body.refresh_token, 'refresh-old');
  assert.equal(createFileTokenStore(storeFile).read().refresh_token, 'refresh-rotated');
}

function messageFixture(role, text) {
  return { type: 'message', role, content: [{ type: 'input_text', text }] };
}

async function main() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'vcd-chatgpt-'));
  try {
    await testStoreAndImport(directory);
    testJwtMetadata();
    testAdapterMapping();
    testModelGating();
    await testSubscriptionCostEntry(directory);
    await testResponsesContract(directory);
    await test401RefreshRetry(directory);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
  console.log('chatgpt ok: Store, JWT, Adapter, Modell-Gating und Responses-SSE ohne Netz');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
