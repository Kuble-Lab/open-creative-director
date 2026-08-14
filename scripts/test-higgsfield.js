'use strict';

const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  createFileTokenStore,
  createHiggsfieldClient,
  extractJobIds,
  extractUrls,
  parseJobStatus,
  DISCONNECTED_MESSAGE
} = require('../lib/higgsfield');
const higgsfield = require('../lib/higgsfield');
const { toolDefinitions, executeTool } = require('../lib/tools');

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

function mcpResponse(text, { sse = false, status = 200 } = {}) {
  const payload = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } };
  if (!sse) return jsonResponse(payload, status);
  return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 0, result: { content: [{ type: 'text', text: 'alt' }] } })}\n\ndata: ${JSON.stringify(payload)}\n\n`, {
    status,
    headers: { 'Content-Type': 'text/event-stream' }
  });
}

async function writeTokens(file, value) {
  await fsp.writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function testDeviceFlow(directory) {
  const file = path.join(directory, 'device-auth.json');
  const requests = [];
  const responses = [
    jsonResponse({
      device_code: 'device-123',
      verification_uri: 'https://higgsfield.ai/device/test',
      expires_in: 900,
      interval: 3
    }),
    jsonResponse({ error: 'authorization_pending' }, 400),
    jsonResponse({
      access_token: 'access-1',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'refresh-1',
      refresh_expires_in: 604800
    })
  ];
  const client = createHiggsfieldClient({
    store: createFileTokenStore(file),
    now: () => 1_000_000,
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return responses.shift();
    }
  });

  assert.deepEqual(await client.startConnect(), {
    verificationUri: 'https://higgsfield.ai/device/test',
    expiresIn: 900
  });
  assert.deepEqual(await client.pollConnect(), { connected: false, pending: true });
  assert.deepEqual(await client.pollConnect(), { connected: true });
  assert.deepEqual(requests.map((request) => request.body), [{}, { device_code: 'device-123' }, { device_code: 'device-123' }]);
  assert.equal(client.status().connected, true);
  const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(saved.access_token, 'access-1');
  assert.equal(saved.refresh_token, 'refresh-1');
  assert.equal(saved.access_expires_at, 4_600_000);
  assert.equal(saved.refresh_expires_at, 605_800_000);
  assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
}

async function testRotatingRefresh(directory) {
  const file = path.join(directory, 'refresh-auth.json');
  await writeTokens(file, {
    access_token: 'access-old',
    access_expires_at: 1_200_000,
    refresh_token: 'refresh-old',
    refresh_expires_at: 10_000_000
  });
  let refreshCalls = 0;
  const client = createHiggsfieldClient({
    store: createFileTokenStore(file),
    now: () => 1_000_000,
    fetchImpl: async (url, options) => {
      assert.match(url, /\/refresh$/);
      assert.deepEqual(JSON.parse(options.body), { refresh_token: 'refresh-old' });
      refreshCalls += 1;
      return jsonResponse({
        access_token: 'access-new',
        expires_in: 3600,
        refresh_token: 'refresh-rotated',
        refresh_expires_in: 604800
      });
    }
  });

  const [first, second] = await Promise.all([client.ensureAccessToken(), client.ensureAccessToken()]);
  assert.equal(first, 'access-new');
  assert.equal(second, 'access-new');
  assert.equal(refreshCalls, 1, 'parallele Refreshes muessen dedupliziert werden');
  const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(saved.refresh_token, 'refresh-rotated', 'rotierter Refresh-Token wurde nicht persistiert');
}

async function testRefreshFailureDisconnects(directory) {
  const file = path.join(directory, 'failed-refresh-auth.json');
  await writeTokens(file, {
    access_token: 'access-old',
    access_expires_at: 1_100_000,
    refresh_token: 'refresh-expired',
    refresh_expires_at: 10_000_000
  });
  const client = createHiggsfieldClient({
    store: createFileTokenStore(file),
    now: () => 1_000_000,
    fetchImpl: async () => jsonResponse({ error: 'invalid_grant' }, 401)
  });
  await assert.rejects(client.ensureAccessToken(), (err) => err.message === DISCONNECTED_MESSAGE);
  await assert.rejects(fsp.stat(file), { code: 'ENOENT' });
  assert.deepEqual(client.status(), { connected: false, refreshExpiresAt: null, pending: false });
}

async function testMcpFormatsAnd401(directory) {
  const file = path.join(directory, 'mcp-auth.json');
  let time = 1_000_000;
  await writeTokens(file, {
    access_token: 'access-a',
    access_expires_at: time + 3_600_000,
    refresh_token: 'refresh-a',
    refresh_expires_at: time + 604_800_000
  });
  const requests = [];
  const responses = [
    mcpResponse('Credits: 9040.87 | Plan: ultra'),
    mcpResponse('Job 11111111-1111-4111-8111-111111111111 — completed\nhttps://cdn.example/result.png', { sse: true }),
    jsonResponse({ error: 'expired' }, 401),
    jsonResponse({
      access_token: 'access-b',
      expires_in: 3600,
      refresh_token: 'refresh-b',
      refresh_expires_in: 604800
    }),
    mcpResponse('Credits: 9000 | Plan: ultra'),
    mcpResponse('MCP error -32602: model is required'),
    jsonResponse({ jsonrpc: '2.0', id: 9, error: { code: -32602, message: 'Invalid params' } })
  ];
  const client = createHiggsfieldClient({
    store: createFileTokenStore(file),
    now: () => time,
    fetchImpl: async (url, options) => {
      requests.push({ url, authorization: options.headers?.Authorization, body: options.body });
      return responses.shift();
    }
  });

  assert.equal(await client.mcpCall('balance', {}), 'Credits: 9040.87 | Plan: ultra');
  assert.match(await client.mcpCall('job_status', { jobId: '11111111-1111-4111-8111-111111111111' }), /completed/);
  assert.equal(await client.mcpCall('balance', {}), 'Credits: 9000 | Plan: ultra');
  await assert.rejects(client.mcpCall('generate_image_batch', {}), /MCP error -32602: model is required/);
  await assert.rejects(client.mcpCall('generate_image_batch', {}), /Invalid params/);
  const refreshRequest = requests.find((request) => /\/refresh$/.test(request.url));
  assert.ok(refreshRequest, '401 muss genau einen Refresh ausloesen');
  const finalMcp = requests.filter((request) => /mcp\.higgsfield\.ai/.test(request.url)).at(-1);
  assert.equal(finalMcp.authorization, 'Bearer access-b');
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).refresh_token, 'refresh-b');
}

function testTextParsers() {
  const submit = 'Submitted 1/1 image generations.\n- index 0: 1fff21fa-3cb7-440c-b436-72f5af6ff79d (pending)';
  assert.deepEqual(extractJobIds(submit), ['1fff21fa-3cb7-440c-b436-72f5af6ff79d']);
  const completed =
    'Job 1fff21fa-3cb7-440c-b436-72f5af6ff79d — completed\n' +
    'https://cdn.example/a.png\nhttps://cdn.example/b.png';
  assert.deepEqual(extractUrls(completed), ['https://cdn.example/a.png', 'https://cdn.example/b.png']);
  assert.deepEqual(parseJobStatus(completed), {
    status: 'completed',
    urls: ['https://cdn.example/a.png', 'https://cdn.example/b.png'],
    text: completed
  });
}

async function testToolGating() {
  const originalStatus = higgsfield.status;
  try {
    higgsfield.status = () => ({ connected: false, refreshExpiresAt: null, pending: false });
    assert.equal(toolDefinitions().some((tool) => tool.function.name.startsWith('higgsfield_')), false);
    await assert.rejects(
      executeTool({ sessionId: 'test', emit() {}, user: 'test' }, 'higgsfield_check_balance', {}),
      (err) => err.message === DISCONNECTED_MESSAGE
    );
    higgsfield.status = () => ({ connected: true, refreshExpiresAt: Date.now() + 10000, pending: false });
    const names = toolDefinitions().map((tool) => tool.function.name);
    assert.ok(names.includes('higgsfield_models'));
    assert.ok(names.includes('higgsfield_generate_image'));
    assert.ok(names.includes('higgsfield_generate_video'));
    assert.ok(names.includes('higgsfield_check_balance'));
  } finally {
    higgsfield.status = originalStatus;
  }
}

async function main() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'vcd-higgsfield-'));
  try {
    await testDeviceFlow(directory);
    await testRotatingRefresh(directory);
    await testRefreshFailureDisconnects(directory);
    await testMcpFormatsAnd401(directory);
    testTextParsers();
    await testToolGating();
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
  console.log('higgsfield ok: Device-Flow, Rotation, Fehler, JSON/SSE, 401, Parser und Tool-Gating');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
