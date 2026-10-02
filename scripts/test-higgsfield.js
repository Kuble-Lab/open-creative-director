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
const store = require('../lib/store');
const poller = require('../lib/poller');
const { toolDefinitions, executeTool } = require('../lib/tools');

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

function mcpResponse(text, { sse = false, status = 200, structured } = {}) {
  const payload = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } };
  if (structured !== undefined) payload.result.structuredContent = structured;
  if (!sse) return jsonResponse(payload, status);
  return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 0, result: { content: [{ type: 'text', text: 'alt' }] } })}\n\ndata: ${JSON.stringify(payload)}\n\n`, {
    status,
    headers: { 'Content-Type': 'text/event-stream' }
  });
}

async function writeTokens(file, value) {
  await fsp.writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

// Legacy device-flow tokens (no `auth` field) keep refreshing through fnf-device-auth; the OAuth login itself is
// covered by test-higgsfield-oauth.js.
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

// mcpCall answers the first text part; with { withStructured: true } it answers { text, structured } (list_voices keeps
// its paging cursor only in structuredContent), also after a 401 refresh.
async function testStructuredContent(directory) {
  const file = path.join(directory, 'structured-auth.json');
  const time = 2_000_000;
  await writeTokens(file, {
    access_token: 'access-a',
    access_expires_at: time + 3_600_000,
    refresh_token: 'refresh-a',
    refresh_expires_at: time + 604_800_000
  });
  const voices = {
    voices: [{ voice_id: 'e2a2d2e6-0000-4000-8000-000000000001', voice_type: 'preset', name: 'Grady', gender: 'male', preview_url: 'https://cdn.example/p.mp3' }],
    has_more: true,
    next_cursor: ':4'
  };
  const text = '1 voice(s):\n- Grady (voice_id=e2a2d2e6-0000-4000-8000-000000000001, voice_type=preset)';
  const responses = [
    mcpResponse(text, { structured: voices }),
    mcpResponse(text, { structured: voices }),
    mcpResponse('no structured part'),
    mcpResponse(text, { structured: 'not an object' }),
    mcpResponse(text, { sse: true, structured: voices }),
    jsonResponse({ error: 'expired' }, 401),
    jsonResponse({ access_token: 'access-b', expires_in: 3600, refresh_token: 'refresh-b', refresh_expires_in: 604800 }),
    mcpResponse(text, { structured: voices })
  ];
  const client = createHiggsfieldClient({
    store: createFileTokenStore(file),
    now: () => time,
    fetchImpl: async () => responses.shift()
  });
  assert.equal(await client.mcpCall('list_voices', { size: 100 }), text, 'the default is the plain text part');
  assert.deepEqual(await client.mcpCall('list_voices', { size: 100 }, { withStructured: true }), { text, structured: voices });
  assert.deepEqual(await client.mcpCall('list_voices', {}, { withStructured: true }), { text: 'no structured part', structured: null });
  assert.equal((await client.mcpCall('list_voices', {}, { withStructured: true })).structured, null, 'a non-object structuredContent is ignored');
  assert.deepEqual(await client.mcpCall('list_voices', {}, { withStructured: true }), { text, structured: voices }, 'JSON and SSE answers alike');
  assert.deepEqual(await client.mcpCall('list_voices', {}, { withStructured: true }), { text, structured: voices }, 'the option survives the 401 retry');
  assert.equal(responses.length, 0);
}

// Audio results (Higgsfield speech): the extension follows the MIME type or the URL, only endings the app accepts
// as audio are used (fallback .wav, the default format of seed_audio), and a completed audio job stores audio assets
// (no network: the download is replaced).
async function testAudioResults() {
  const extension = poller.higgsfieldResultExtension;
  assert.equal(extension('audio', 'audio/mpeg', 'https://cdn.example/result'), '.mp3');
  assert.equal(extension('audio', 'audio/mp3', 'https://cdn.example/result'), '.mp3');
  assert.equal(extension('audio', 'audio/wav; charset=binary', 'https://cdn.example/result'), '.wav');
  assert.equal(extension('audio', 'audio/x-wav', 'https://cdn.example/result'), '.wav');
  assert.equal(extension('audio', 'audio/wave', 'https://cdn.example/result'), '.wav');
  assert.equal(extension('audio', 'audio/vnd.wave', 'https://cdn.example/result'), '.wav');
  assert.equal(extension('audio', 'audio/mp4', 'https://cdn.example/result'), '.m4a');
  assert.equal(extension('audio', 'audio/x-m4a', 'https://cdn.example/result'), '.m4a');
  assert.equal(extension('audio', 'audio/aac', 'https://cdn.example/result'), '.aac');
  // no usable MIME type: the URL extension decides (query strings are ignored), else the fallback is .wav
  assert.equal(extension('audio', 'application/octet-stream', 'https://cdn.example/voice.WAV?sig=1'), '.wav');
  assert.equal(extension('audio', '', 'https://cdn.example/voice.m4a'), '.m4a');
  assert.equal(extension('audio', '', 'https://cdn.example/voice.aac'), '.aac');
  assert.equal(extension('audio', '', 'https://cdn.example/voice.mp3?sig=1'), '.mp3', 'an mp3 result keeps its ending');
  assert.equal(extension('audio', '', 'https://cdn.example/voice.ogg'), '.wav', 'endings the app does not accept fall back to .wav');
  assert.equal(extension('audio', 'audio/ogg', 'https://cdn.example/voice.opus'), '.wav', 'ogg_opus is no audio the app can use');
  assert.equal(extension('audio', 'application/octet-stream', 'https://cdn.example/result'), '.wav', 'no ending at all: WAV, not blindly mp3');
  assert.equal(extension('audio', '', 'not a url'), '.wav');
  assert.equal(extension('audio', undefined, undefined), '.wav');
  // unchanged for image and video
  assert.equal(extension('image', 'image/webp', 'https://cdn.example/a'), '.webp');
  assert.equal(extension('image', '', 'https://cdn.example/a'), '.png');
  assert.equal(extension('video', 'video/webm', 'https://cdn.example/a'), '.webm');
  assert.equal(extension('video', '', 'https://cdn.example/a'), '.mp4');

  const session = await store.createSession();
  const originalDownload = higgsfield.downloadResult;
  try {
    // submitHiggsfieldJob reserves audio results as .wav (seed_audio answers WAV by default)
    const asset = await store.reserveAsset(session.id, { kind: 'audio', ext: '.wav', prompt: 'Hallo Welt' });
    assert.equal(asset.file, `${asset.id}.wav`);
    const now = new Date().toISOString();
    const job = {
      jobId: '2fff21fa-3cb7-440c-b436-72f5af6ff79d',
      provider: 'higgsfield',
      source: 'higgsfield',
      kind: 'audio',
      assetId: asset.id,
      file: asset.file,
      status: 'pending',
      prompt: 'Hallo Welt',
      mode: 'higgsfield_audio',
      model: 'seed_audio',
      createdAt: now,
      submittedAt: now,
      cost: 0,
      error: null
    };
    await store.mutateSession(session.id, (saved) => saved.jobs.push(job));
    higgsfield.downloadResult = async (url) => ({
      buffer: Buffer.from(`audio bytes of ${url}`),
      contentType: url.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav',
      url
    });
    await poller.handleHiggsfieldCompleted(session.id, job, {
      status: 'completed',
      urls: ['https://cdn.example/speech.mp3', 'https://cdn.example/speech-alt.wav']
    });

    const ledger = await store.readLedger(session.id);
    const first = ledger.find((entry) => entry.id === asset.id);
    assert.equal(first.file, `${asset.id}.mp3`, 'the reserved asset takes the extension of the result (an mp3 result replaces the .wav reservation)');
    assert.equal(first.kind, 'audio');
    assert.equal(first.pending, undefined);
    assert.equal(ledger.length, 2);
    const second = ledger.find((entry) => entry.id !== asset.id);
    assert.equal(second.kind, 'audio', 'further results of an audio job are audio assets, too');
    assert.equal(second.file, `${second.id}.wav`);
    assert.match(await fsp.readFile(path.join(store.sessionAssetDir(session.id), first.file), 'utf8'), /speech\.mp3/);

    const saved = await store.readSession(session.id);
    const done = saved.jobs.find((entry) => entry.assetId === asset.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.file, `${asset.id}.mp3`);
    assert.deepEqual(done.resultAssetIds, [asset.id, second.id]);
    assert.ok(saved.messages.some((message) => message.type === 'job_update' && /fertig generiert/.test(message.content)));
    assert.ok(saved.messages.some((message) => message.hidden && /Higgsfield-Audio-Job/.test(message.content)));
  } finally {
    higgsfield.downloadResult = originalDownload;
    await store.deleteSession(session.id);
  }
}

async function main() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'vcd-higgsfield-'));
  try {
    await testRotatingRefresh(directory);
    await testRefreshFailureDisconnects(directory);
    await testMcpFormatsAnd401(directory);
    await testStructuredContent(directory);
    testTextParsers();
    await testToolGating();
    await testAudioResults();
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
  console.log('higgsfield ok: Legacy-Refresh, Rotation, Fehler, JSON/SSE, 401, structuredContent, Parser, Tool-Gating und Audio-Ergebnisse');
  console.log('test-higgsfield.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
