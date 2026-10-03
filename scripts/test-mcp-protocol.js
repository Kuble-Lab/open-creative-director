'use strict';

// Conformance tests of the agent access (WP27, part 1): the MCP protocol over Streamable HTTP at /mcp, for the current
// protocol revision (2026-07-28, no handshake, per-request _meta and headers) and for the earlier ones (2025-11-25,
// 2025-06-18, 2025-03-26, initialize with version negotiation). A small express app mounts lib/mcp with a key store in a
// temp directory; no app data, no network except localhost, no paid call.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');

const { createMcp } = require('../lib/mcp');
const { createKeyStore } = require('../lib/mcp/keys');
const { createRateLimiter, originAllowed } = require('../lib/mcp/http');
const { defineTool, ToolError, validateArguments } = require('../lib/mcp/tools');
const protocolLib = require('../lib/mcp/protocol');

const PERSON = 'agent.owner@example.com';
const META = 'io.modelcontextprotocol/protocolVersion';
const CAPS = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, label, timeoutMs = 5000) {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timeout waiting for ${label}`);
    await sleepFor(10);
  }
}

const clock = { t: Date.parse('2026-10-03T10:00:00Z') };
let ownerValid = true;
const hold = { promise: null, release: null };
const newHold = () => {
  hold.promise = new Promise((resolve) => {
    hold.release = resolve;
  });
};
newHold();

function tools() {
  return [
    defineTool({
      name: 'echo',
      description: 'Returns the text it was given.',
      right: 'read',
      inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 20 }, times: { type: 'integer', minimum: 1, maximum: 3 } }, required: ['text'], additionalProperties: false },
      handler: async (args) => ({ content: [{ type: 'text', text: args.text.repeat(args.times || 1) }], structuredContent: { text: args.text } })
    }),
    defineTool({
      name: 'start_thing',
      description: 'Pretends to start something.',
      right: 'start',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'started'
    }),
    defineTool({
      name: 'refuse',
      description: 'Always refuses with a reason.',
      right: 'read',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        throw new ToolError('The budget is used up.');
      }
    }),
    defineTool({
      name: 'hold',
      description: 'Waits until the test lets it go.',
      right: 'read',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        await hold.promise;
        return 'released';
      }
    }),
    defineTool({
      name: 'explode',
      description: 'Fails with an internal error.',
      right: 'read',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        throw new Error('secret internal detail /var/lib/app');
      }
    })
  ];
}

function rpc(id, method, params) {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}

// A modern request: meta in the body, headers that agree with it.
function modern(id, method, params = {}, { version = '2026-07-28' } = {}) {
  const body = rpc(id, method, { ...params, _meta: { [META]: version, [CAPS]: {}, 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' } } });
  const headers = { 'MCP-Protocol-Version': version, 'Mcp-Method': method };
  if (method === 'tools/call') headers['Mcp-Name'] = params.name;
  return { body, headers };
}

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-mcp-protocol-'));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    const keys = createKeyStore({ file: path.join(dir, 'mcp-keys.json'), now: () => clock.t, viewerFor: () => (ownerValid ? { active: true, email: PERSON, identified: true, admin: false, kind: 'internal' } : null) });
    // generous for the tests in general; the rate limit test swaps in a small one
    let activeLimiter = createRateLimiter({ requests: 100000, windowMs: 60000, now: () => clock.t });
    const limiter = { take: (id) => activeLimiter.take(id), reset: () => activeLimiter.reset() };
    const mcp = createMcp({ keys, tools: tools(), limiter, env: { PUBLIC_BASE_URL: 'https://creator.example.com' }, maxBodyBytes: 4096, concurrency: { perKey: 3, largeSlots: 1, largeBodyBytes: 1024 }, sweepUploads: false });
    const app = express();
    mcp.mount(app);
    // like the app: a catch-all after it must never swallow /mcp
    app.get('*', (_req, res) => res.type('html').send('<html>shell</html>'));
    const server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const port = server.address().port;
    assert.notEqual(port, 3111);
    const url = `http://127.0.0.1:${port}/mcp`;
    const everything = []; // every response text, to look for the secret afterwards

    const readKey = keys.create({ name: 'Reader', owner: PERSON, right: 'read' });
    const startKey = keys.create({ name: 'Starter', owner: PERSON, right: 'start' });
    const secrets = [readKey.secret, startKey.secret];

    async function post(body, { token = readKey.secret, headers = {}, raw = false, path: urlPath = '/mcp', contentType = 'application/json', method = 'POST' } = {}) {
      const requestHeaders = { ...(contentType ? { 'Content-Type': contentType } : {}), Accept: 'application/json, text/event-stream', ...headers };
      if (token) requestHeaders.Authorization = `Bearer ${token}`;
      const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, { method, headers: requestHeaders, body: method === 'GET' || method === 'HEAD' ? undefined : raw ? body : JSON.stringify(body) });
      const text = await response.text();
      everything.push(text);
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (_) {
        json = null;
      }
      return { status: response.status, json, text, headers: response.headers };
    }
    const send = (message, options = {}) => post(message.body || message, { ...options, headers: { ...(message.headers || {}), ...(options.headers || {}) } });

    /* ----- legacy revisions: initialize, version negotiation ----- */

    for (const version of ['2025-11-25', '2025-06-18', '2025-03-26']) {
      const response = await post(rpc(1, 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1' } }));
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^application\/json/);
      assert.equal(response.json.jsonrpc, '2.0');
      assert.equal(response.json.id, 1);
      assert.equal(response.json.result.protocolVersion, version, 'the version of the client is used when the server speaks it');
      assert.deepEqual(response.json.result.capabilities.tools, { listChanged: false });
      assert.equal(response.json.result.serverInfo.name, 'open-creative-director');
      assert.ok(response.json.result.serverInfo.version);
      assert.equal('resultType' in response.json.result, false, 'legacy results have no resultType');
      assert.equal(response.headers.get('mcp-session-id'), null, 'no sessions');
    }
    const newer = await post(rpc('init-2', 'initialize', { protocolVersion: '2099-01-01', capabilities: {} }));
    assert.equal(newer.json.result.protocolVersion, '2025-11-25', 'an unknown version gets the newest earlier revision');
    assert.equal(newer.json.id, 'init-2', 'string ids are answered as they are');
    const older = await post(rpc(2, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} }));
    assert.equal(older.json.result.protocolVersion, '2025-11-25');
    const noVersion = await post(rpc(3, 'initialize', { capabilities: {} }));
    assert.equal(noVersion.json.error.code, -32602);
    assert.equal((await post(rpc(3, 'initialize'))).json.error.code, -32602);

    const initialized = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(initialized.status, 202);
    assert.equal(initialized.text, '');
    assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })).status, 202);
    assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/something-new' })).status, 202, 'an unknown notification is accepted and ignored');
    assert.equal((await post({ jsonrpc: '2.0', id: 9, result: {} })).status, 202, 'a response from the client is accepted and ignored');

    const ping = await post(rpc(4, 'ping'));
    assert.deepEqual(ping.json, { jsonrpc: '2.0', id: 4, result: {} });

    // the list depends on the right of the key; deterministic order
    const legacyHeaders = { 'MCP-Protocol-Version': '2025-06-18' };
    const readList = await post(rpc(5, 'tools/list'), { headers: legacyHeaders });
    assert.deepEqual(readList.json.result.tools.map((tool) => tool.name), ['echo', 'explode', 'hold', 'refuse']);
    assert.equal('resultType' in readList.json.result, false);
    const startList = await post(rpc(5, 'tools/list'), { token: startKey.secret });
    assert.deepEqual(startList.json.result.tools.map((tool) => tool.name), ['echo', 'explode', 'hold', 'refuse', 'start_thing']);
    const echoDefinition = startList.json.result.tools.find((tool) => tool.name === 'echo');
    assert.equal(echoDefinition.inputSchema.type, 'object');
    assert.equal(echoDefinition.annotations.readOnlyHint, true);
    assert.equal(startList.json.result.tools.find((tool) => tool.name === 'start_thing').annotations.readOnlyHint, false);
    assert.equal('handler' in echoDefinition, false);
    assert.equal('right' in echoDefinition, false);
    assert.equal((await post(rpc(5, 'tools/list', { cursor: 'abc' }))).json.error.code, -32602, 'there is only one page');

    // tools/call
    const echo = await post(rpc(6, 'tools/call', { name: 'echo', arguments: { text: 'ha', times: 2 } }));
    assert.equal(echo.json.result.isError, false);
    assert.deepEqual(echo.json.result.content, [{ type: 'text', text: 'haha' }]);
    assert.deepEqual(echo.json.result.structuredContent, { text: 'ha' });
    assert.equal((await post(rpc(7, 'tools/call', { name: 'start_thing' }), { token: startKey.secret })).json.result.content[0].text, 'started');

    // errors of the protocol are JSON-RPC errors
    const unknownTool = await post(rpc(8, 'tools/call', { name: 'nope', arguments: {} }));
    assert.equal(unknownTool.status, 200);
    assert.equal(unknownTool.json.error.code, -32602);
    assert.match(unknownTool.json.error.message, /Unknown tool/);
    assert.equal((await post(rpc(8, 'tools/call', {}))).json.error.code, -32602);
    assert.equal((await post(rpc(8, 'tools/call', { name: 'echo', arguments: [] }))).json.error.code, -32602);
    const unknownMethod = await post(rpc(9, 'resources/list'));
    assert.equal(unknownMethod.status, 200, 'the earlier revisions answer a JSON-RPC error with 200');
    assert.equal(unknownMethod.json.error.code, -32601);
    assert.equal(unknownMethod.json.id, 9);

    // errors of a tool are results with isError and a text the model can use
    const invalid = await post(rpc(10, 'tools/call', { name: 'echo', arguments: { text: 5 } }));
    assert.equal(invalid.json.error, undefined);
    assert.equal(invalid.json.result.isError, true);
    assert.match(invalid.json.result.content[0].text, /text must be string/);
    const missing = await post(rpc(10, 'tools/call', { name: 'echo', arguments: {} }));
    assert.match(missing.json.result.content[0].text, /text is required/);
    const tooLong = await post(rpc(10, 'tools/call', { name: 'echo', arguments: { text: 'x'.repeat(21) } }));
    assert.match(tooLong.json.result.content[0].text, /at most 20 characters/);
    const extra = await post(rpc(10, 'tools/call', { name: 'echo', arguments: { text: 'a', surprise: 1 } }));
    assert.match(extra.json.result.content[0].text, /not a known property/);
    const range = await post(rpc(10, 'tools/call', { name: 'echo', arguments: { text: 'a', times: 9 } }));
    assert.match(range.json.result.content[0].text, /at most 3/);
    const refused = await post(rpc(11, 'tools/call', { name: 'refuse' }));
    assert.deepEqual(refused.json.result, { content: [{ type: 'text', text: 'The budget is used up.' }], isError: true });
    const exploded = await post(rpc(12, 'tools/call', { name: 'explode' }));
    assert.equal(exploded.json.result.isError, true);
    assert.ok(!exploded.text.includes('/var/lib/app'), 'the detail of an unexpected error is not handed out');
    const forbidden = await post(rpc(13, 'tools/call', { name: 'start_thing' }));
    assert.equal(forbidden.json.result.isError, true, 'a read key cannot start anything');
    assert.match(forbidden.json.result.content[0].text, /may only read/);

    // malformed messages
    const broken = await post('{"jsonrpc":"2.0","id":1,"method":"ping", sk-secret-looking', { raw: true });
    assert.equal(broken.status, 400);
    assert.equal(broken.json.error.code, -32700);
    assert.equal(broken.json.id, null);
    assert.ok(!broken.text.includes('sk-secret'), 'the parser message (which can quote the body) is not echoed');
    assert.equal((await post('', { raw: true })).json.error.code, -32700);
    // batches belong to 2025-03-26 (the version without a header): answered one by one, as an array; later versions refuse them
    const batch = await post([rpc(1, 'ping'), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc('b', 'tools/list'), rpc(3, 'nope'), 7]);
    assert.equal(batch.status, 200);
    assert.ok(Array.isArray(batch.json));
    assert.equal(batch.json.length, 4, 'a notification has no answer');
    assert.deepEqual(batch.json[0], { jsonrpc: '2.0', id: 1, result: {} });
    assert.equal(batch.json[1].id, 'b');
    assert.deepEqual(batch.json[1].result.tools.map((tool) => tool.name), ['echo', 'explode', 'hold', 'refuse']);
    assert.equal(batch.json[2].error.code, -32601);
    assert.equal(batch.json[3].error.code, -32600, 'an element that is no message is an Invalid Request of its own');
    const batch2 = await post([rpc(1, 'ping')], { headers: { 'MCP-Protocol-Version': '2025-03-26' } });
    assert.deepEqual(batch2.json, [{ jsonrpc: '2.0', id: 1, result: {} }]);
    assert.equal((await post([{ jsonrpc: '2.0', method: 'notifications/initialized' }])).status, 202, 'only notifications: nothing to answer');
    for (const version of ['2025-06-18', '2025-11-25', '2026-07-28']) {
      const refusedBatch = await post([rpc(1, 'ping')], { headers: { 'MCP-Protocol-Version': version } });
      assert.equal(refusedBatch.status, 400, version);
      assert.equal(refusedBatch.json.error.code, -32600, version);
    }
    assert.equal((await post([])).json.error.code, -32600, 'an empty batch');
    assert.equal((await post(Array.from({ length: 11 }, (_, index) => rpc(index + 1, 'ping')))).status, 400, 'at most 10 messages');
    assert.equal((await post([rpc(1, 'initialize', { protocolVersion: '2025-03-26' }), rpc(2, 'ping')])).json[0].error.code, -32600, 'initialize is not part of a batch');
    assert.equal((await post([[rpc(1, 'ping')]])).json[0].error.code, -32600, 'no batch inside a batch');
    const batchCall = await post([rpc(1, 'tools/call', { name: 'echo', arguments: { text: 'a' } }), rpc(2, 'tools/call', { name: 'start_thing' })]);
    assert.equal(batchCall.json[0].result.content[0].text, 'a');
    assert.equal(batchCall.json[1].result.isError, true, 'the right of the key counts for every message of a batch');
    for (const bad of [{ id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: null, method: 'ping' }, { jsonrpc: '2.0', id: {}, method: 'ping' }, 'text', 42, null]) {
      const response = await post(bad);
      assert.equal(response.status, 400, JSON.stringify(bad));
      assert.equal(response.json.error.code, -32600, JSON.stringify(bad));
    }
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping', params: [] })).json.error.code, -32602);
    assert.equal((await post(rpc(1, 'ping'), { contentType: 'text/plain' })).status, 415);
    assert.equal((await post(rpc(1, 'ping'), { contentType: 'application/json; charset=utf-8' })).status, 200);

    /* ----- the current revision: no handshake, meta and headers ----- */

    const discover = await send(modern(20, 'server/discover'));
    assert.equal(discover.status, 200);
    assert.equal(discover.json.result.resultType, 'complete');
    assert.deepEqual(discover.json.result.supportedVersions, ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']);
    assert.deepEqual(discover.json.result.capabilities.tools, { listChanged: false });
    assert.equal(discover.json.result._meta[SERVER_INFO].name, 'open-creative-director');
    assert.ok(discover.json.result.ttlMs >= 0);
    assert.equal(discover.json.result.cacheScope, 'public');
    assert.match(discover.json.result.instructions, /same rules as the app/);

    const modernList = await send(modern(21, 'tools/list'));
    assert.equal(modernList.json.result.resultType, 'complete');
    assert.deepEqual(modernList.json.result.tools.map((tool) => tool.name), ['echo', 'explode', 'hold', 'refuse']);
    assert.ok(modernList.json.result.ttlMs >= 0);
    assert.equal(modernList.json.result.cacheScope, 'private', 'the list depends on the key');
    assert.equal(modernList.json.result._meta[SERVER_INFO].name, 'open-creative-director');

    const modernCall = await send(modern(22, 'tools/call', { name: 'echo', arguments: { text: 'hi' } }));
    assert.equal(modernCall.json.result.resultType, 'complete');
    assert.equal(modernCall.json.result.content[0].text, 'hi');
    // a tool name that is not plain ASCII travels base64 encoded in the header
    const encodedName = modern(23, 'tools/call', { name: 'echo', arguments: { text: 'hi' } });
    encodedName.headers['Mcp-Name'] = `=?base64?${Buffer.from('echo').toString('base64')}?=`;
    assert.equal((await send(encodedName)).json.result.content[0].text, 'hi');
    assert.equal((await send(modern(24, 'tools/call', { name: 'refuse' }))).json.result.isError, true);
    assert.equal((await send(modern(25, 'ping'))).json.result.resultType, 'complete');

    // the headers have to agree with the body (400 and -32020)
    const mismatches = [];
    const noVersionHeader = modern(30, 'tools/list');
    delete noVersionHeader.headers['MCP-Protocol-Version'];
    mismatches.push(noVersionHeader);
    const noMethodHeader = modern(31, 'tools/list');
    delete noMethodHeader.headers['Mcp-Method'];
    mismatches.push(noMethodHeader);
    const wrongMethod = modern(32, 'tools/list');
    wrongMethod.headers['Mcp-Method'] = 'tools/call';
    mismatches.push(wrongMethod);
    const wrongVersionHeader = modern(33, 'tools/list');
    wrongVersionHeader.headers['MCP-Protocol-Version'] = '2025-06-18';
    mismatches.push(wrongVersionHeader);
    const noName = modern(34, 'tools/call', { name: 'echo', arguments: { text: 'a' } });
    delete noName.headers['Mcp-Name'];
    mismatches.push(noName);
    const wrongName = modern(35, 'tools/call', { name: 'echo', arguments: { text: 'a' } });
    wrongName.headers['Mcp-Name'] = 'start_thing';
    mismatches.push(wrongName);
    const badEncoding = modern(36, 'tools/call', { name: 'echo', arguments: { text: 'a' } });
    badEncoding.headers['Mcp-Name'] = '=?base64?***?=';
    mismatches.push(badEncoding);
    for (const mismatch of mismatches) {
      const response = await send(mismatch);
      assert.equal(response.status, 400, JSON.stringify(mismatch.headers));
      assert.equal(response.json.error.code, -32020, JSON.stringify(mismatch.headers));
      assert.equal(response.json.id, mismatch.body.id);
    }
    const noCapabilities = modern(37, 'tools/list');
    delete noCapabilities.body.params._meta[CAPS];
    const noCaps = await send(noCapabilities);
    assert.equal(noCaps.status, 400);
    assert.equal(noCaps.json.error.code, -32602);
    const metaMissing = await post(rpc(38, 'tools/list'), { headers: { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' } });
    assert.equal(metaMissing.status, 400);
    assert.equal(metaMissing.json.error.code, -32020, 'a header that says 2026-07-28 over a body that does not is a header mismatch');
    assert.match(metaMissing.json.error.message, /Header mismatch/);
    const unsupportedMeta = await send(modern(39, 'tools/list', {}, { version: '1900-01-01' }));
    assert.equal(unsupportedMeta.status, 400);
    assert.equal(unsupportedMeta.json.error.code, -32022);
    assert.deepEqual(unsupportedMeta.json.error.data.supported, ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']);
    assert.equal(unsupportedMeta.json.error.data.requested, '1900-01-01');
    const unsupportedHeader = await post(rpc(40, 'tools/list'), { headers: { 'MCP-Protocol-Version': '1999-01-01' } });
    assert.equal(unsupportedHeader.status, 400);
    assert.equal(unsupportedHeader.json.error.code, -32022);
    const modernUnknown = await send(modern(41, 'resources/list'));
    assert.equal(modernUnknown.status, 404, 'the current revision answers an unknown method with 404');
    assert.equal(modernUnknown.json.error.code, -32601);
    // a session header of an older client is ignored, never echoed
    const withSession = await post(rpc(42, 'ping'), { headers: { 'Mcp-Session-Id': 'abc' } });
    assert.equal(withSession.status, 200);
    assert.equal(withSession.headers.get('mcp-session-id'), null);

    /* ----- no GET, no other path ----- */

    for (const method of ['GET', 'DELETE', 'PUT', 'PATCH']) {
      const response = await post(undefined, { method, token: readKey.secret });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get('allow'), 'POST');
    }
    assert.equal((await post(undefined, { method: 'GET', token: null })).status, 405, 'GET is 405 with or without a key');
    assert.equal((await post(undefined, { method: 'HEAD' })).status, 405);
    assert.equal((await post(rpc(1, 'ping'), { path: '/mcp/' })).status, 200, 'a trailing slash is the same endpoint');
    const other = await post(rpc(1, 'ping'), { path: '/mcp/elsewhere' });
    assert.equal(other.status, 404);
    assert.match(other.headers.get('content-type'), /json/, 'not the app shell');
    const shell = await fetch(`http://127.0.0.1:${port}/mcpish`);
    assert.match(await shell.text(), /shell/, 'other paths are not touched');

    /* ----- keys ----- */

    const noKey = await post(rpc(1, 'ping'), { token: null });
    assert.equal(noKey.status, 401);
    assert.equal(noKey.headers.get('www-authenticate'), 'Bearer realm="mcp"');
    assert.equal(noKey.json.error.data.reason, 'invalid_key');
    const wrongKey = await post(rpc(1, 'ping'), { token: 'ocd_k1_' + 'A'.repeat(43) });
    assert.equal(wrongKey.status, 401);
    assert.deepEqual(wrongKey.json, { ...noKey.json }, 'a missing key and a wrong key are answered the same');
    for (const malformed of ['abc', 'ocd_k1_short', `${readKey.secret}x`, readKey.secret.slice(0, -1), `ocd_k2_${readKey.secret.slice(7)}`]) {
      assert.equal((await post(rpc(1, 'ping'), { token: malformed })).status, 401, malformed.slice(0, 12));
    }
    assert.equal((await post(rpc(1, 'ping'), { token: null, headers: { Authorization: `Basic ${Buffer.from('a:b').toString('base64')}` } })).status, 401);
    assert.equal((await post(rpc(1, 'ping'), { token: null, headers: { Authorization: readKey.secret } })).status, 401, 'the scheme Bearer is required');
    assert.equal((await post(rpc(1, 'ping'), { token: null, path: `/mcp?key=${readKey.secret}&token=${readKey.secret}&access_token=${readKey.secret}` })).status, 401, 'a key in the URL is never accepted');
    assert.equal((await post(rpc(1, 'ping'), { token: null, headers: { Authorization: `bearer ${readKey.secret}` } })).status, 200, 'the scheme is case-insensitive');

    // a key that expired, was revoked or whose person may no longer use it
    const shortLived = keys.create({ name: 'Short', owner: PERSON, right: 'read', expiresInDays: 1 });
    secrets.push(shortLived.secret);
    assert.equal((await post(rpc(1, 'ping'), { token: shortLived.secret })).status, 200);
    clock.t += 25 * 3600 * 1000;
    limiter.reset();
    const expired = await post(rpc(1, 'ping'), { token: shortLived.secret });
    assert.equal(expired.status, 401);
    assert.equal(expired.json.error.data.reason, 'expired');
    clock.t -= 25 * 3600 * 1000;
    const toRevoke = keys.create({ name: 'Weg', owner: PERSON, right: 'read' });
    secrets.push(toRevoke.secret);
    assert.equal((await post(rpc(1, 'ping'), { token: toRevoke.secret })).status, 200);
    keys.revoke(toRevoke.key.id, PERSON);
    const revoked = await post(rpc(1, 'ping'), { token: toRevoke.secret });
    assert.equal(revoked.status, 401);
    assert.equal(revoked.json.error.data.reason, 'revoked');
    ownerValid = false;
    const orphan = await post(rpc(1, 'ping'));
    assert.equal(orphan.status, 403);
    assert.equal(orphan.json.error.data.reason, 'owner_invalid');
    assert.equal(orphan.headers.get('www-authenticate'), null);
    ownerValid = true;
    assert.equal((await post(rpc(1, 'ping'))).status, 200);

    /* ----- limits ----- */

    // the size: by Content-Length and for a chunked body without a length
    const big = await post(JSON.stringify(rpc(1, 'tools/call', { name: 'echo', arguments: { text: 'x'.repeat(6000) } })), { raw: true });
    assert.equal(big.status, 413);
    assert.equal(big.json.error.code, -32600);
    const chunkedBig = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readKey.secret}` } }, (response) => {
        response.resume();
        resolve(response.statusCode);
        request.destroy();
      });
      request.on('error', (err) => (err.code === 'ECONNRESET' ? resolve('reset') : reject(err)));
      request.write(Buffer.alloc(6000, 0x20));
    });
    assert.equal(chunkedBig, 413, 'no Content-Length: the size is counted while the body arrives');

    // the rate limit: per key, with Retry-After
    activeLimiter = createRateLimiter({ requests: 5, windowMs: 60000, now: () => clock.t });
    const statuses = [];
    for (let index = 0; index < 7; index += 1) statuses.push((await post(rpc(1, 'ping'), { token: startKey.secret })).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
    const limited = await post(rpc(1, 'ping'), { token: startKey.secret });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal(limited.json.error.data.retryAfterSeconds, Number(limited.headers.get('retry-after')));
    assert.equal((await post(rpc(1, 'ping'), { token: readKey.secret })).status, 200, 'the other key has its own window');
    assert.equal((await post(rpc(1, 'ping'), { token: 'ocd_k1_' + 'B'.repeat(43) })).status, 401, 'a wrong key is refused before the limit');
    clock.t += 61 * 1000;
    assert.equal((await post(rpc(1, 'ping'), { token: startKey.secret })).status, 200, 'the window moves on');
    // a batch is charged as many requests as it has messages
    activeLimiter = createRateLimiter({ requests: 5, windowMs: 60000, now: () => clock.t });
    assert.equal((await post([rpc(1, 'ping'), rpc(2, 'ping'), rpc(3, 'ping'), rpc(4, 'ping')])).status, 200);
    assert.equal((await post([rpc(1, 'ping'), rpc(2, 'ping'), rpc(3, 'ping')])).status, 429, 'four used, three more do not fit into five');
    clock.t += 61 * 1000;
    assert.equal((await post(rpc(1, 'ping'))).status, 200, 'the window moves on');

    // the origin: a page of another origin is refused, command line tools and the app itself are not
    activeLimiter = createRateLimiter({ requests: 100000, windowMs: 60000, now: () => clock.t });
    assert.equal((await post(rpc(1, 'ping'), { headers: { Origin: 'https://evil.example.org' } })).status, 403);
    assert.equal((await post(rpc(1, 'ping'), { headers: { Origin: 'null' } })).status, 403);
    assert.equal((await post(rpc(1, 'ping'), { headers: { Origin: 'https://creator.example.com' } })).status, 200);
    // the whole origin counts: scheme, host and port
    assert.equal((await post(rpc(1, 'ping'), { headers: { Origin: 'http://creator.example.com' } })).status, 403, 'another scheme');
    assert.equal((await post(rpc(1, 'ping'), { headers: { Origin: 'https://creator.example.com:8443' } })).status, 403, 'another port');
    assert.equal((await post(rpc(1, 'ping'), { headers: { Origin: 'http://localhost:5173' } })).status, 403, 'with a public address the loopback names are not welcome');
    assert.equal((await post(rpc(1, 'ping'), { headers: { Origin: `http://localhost:${port}` } })).status, 403, 'not even its own port');
    const at = (origin, localPort) => ({ headers: { origin }, socket: { localPort } });
    // a local installation (no public address): the loopback names, on the port the request came in on
    assert.equal(originAllowed(at('http://localhost:3999', 3999), {}), true);
    assert.equal(originAllowed(at('http://127.0.0.1:3999', 3999), {}), true);
    assert.equal(originAllowed(at('http://[::1]:3999', 3999), {}), true);
    assert.equal(originAllowed(at('http://localhost:9999', 3999), {}), false, 'a page on another local port');
    assert.equal(originAllowed(at('http://localhost', 3999), {}), false, 'port 80 is not the port of the app');
    assert.equal(originAllowed(at('http://localhost:3999', undefined), {}), false, 'without a socket nothing is known');
    assert.equal(originAllowed(at('https://evil.example.org', 3999), {}), false);
    assert.equal(originAllowed(at('ftp://localhost:3999', 3999), {}), false);
    assert.equal(originAllowed(at('http://localhost:3999', 3999), { PUBLIC_BASE_URL: 'https://creator.example.com' }), false);
    assert.equal(originAllowed(at('http://localhost:3999', 3999), { PUBLIC_BASE_URL: 'http://localhost:3999' }), true, 'the public address is a loopback address itself');
    assert.equal(originAllowed(at('http://localhost:9999', 3999), { PUBLIC_BASE_URL: 'http://localhost:3999' }), false);
    assert.equal(originAllowed({ headers: { origin: 'https://creator.example.com' } }, { PUBLIC_BASE_URL: 'https://creator.example.com/sub/path/' }), true, 'a path in the address does not matter');
    assert.equal(originAllowed({ headers: { origin: 'https://CREATOR.example.com' } }, { PUBLIC_BASE_URL: 'https://creator.example.com' }), true);
    assert.equal(originAllowed({ headers: { origin: 'https://other.example' } }, { MCP_ALLOWED_ORIGINS: 'https://other.example, x.example' }), true);
    assert.equal(originAllowed({ headers: { origin: 'https://x.example' } }, { MCP_ALLOWED_ORIGINS: 'https://other.example, x.example' }), true, 'a bare host means https');
    assert.equal(originAllowed({ headers: { origin: 'http://x.example' } }, { MCP_ALLOWED_ORIGINS: 'https://other.example, x.example' }), false);
    assert.equal(originAllowed({ headers: { origin: 'https://other.example:444' } }, { MCP_ALLOWED_ORIGINS: 'https://other.example' }), false);
    assert.equal(originAllowed({ headers: { origin: 'https://sub.creator.example.com' } }, { PUBLIC_BASE_URL: 'https://creator.example.com' }), false);
    assert.equal(originAllowed({ headers: {} }, {}), true);

    /* ----- requests at the same moment: per key, and large bodies in the whole app ----- */

    const readId = readKey.key.id;
    newHold();
    const holds = [1, 2, 3].map((index) => post(rpc(index, 'tools/call', { name: 'hold' })));
    await waitFor(() => mcp.gate.inUse(readId) === 3, 'three requests in progress');
    const fourth = await post(rpc(4, 'ping'));
    assert.equal(fourth.status, 429, 'a fourth request at once is refused');
    assert.equal(fourth.headers.get('retry-after'), '1');
    assert.match(fourth.json.error.message, /at once/);
    assert.equal(fourth.json.error.data.retryAfterSeconds, 1);
    assert.equal((await post(rpc(5, 'ping'), { token: startKey.secret })).status, 200, 'another key has its own places');
    hold.release();
    for (const answer of await Promise.all(holds)) {
      assert.equal(answer.status, 200);
      assert.equal(answer.json.result.content[0].text, 'released');
    }
    await waitFor(() => mcp.gate.inUse(readId) === 0, 'the places are given back');
    assert.equal((await post(rpc(6, 'ping'))).status, 200, 'and free again');
    // a request that fails gives its place back as well (413, 415, broken JSON)
    for (let index = 0; index < 5; index += 1) {
      assert.equal((await post('x'.repeat(5000), { raw: true })).status, 413);
      assert.equal((await post(rpc(1, 'ping'), { contentType: 'text/plain' })).status, 415);
      assert.equal((await post('{', { raw: true })).status, 400);
    }
    assert.equal(mcp.gate.inUse(readId), 0);

    // a large body (above 1 KB here, above 1 MB in the app) holds the one large place until its answer is sent
    // a request whose body arrives in two parts: { done: promise of { status, json }, finish() sends the rest }
    // (with a Content-Length, or chunked without one)
    const slowPost = (token, text, { chunked = false } = {}) => {
      let finish;
      const done = new Promise((resolve, reject) => {
        const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(chunked ? {} : { 'Content-Length': String(Buffer.byteLength(text)) }) };
        const request = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers }, (response) => {
          const parts = [];
          response.on('data', (chunk) => parts.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(parts).toString('utf8')) }));
        });
        request.on('error', reject);
        request.write(text.slice(0, 1500));
        finish = () => request.end(text.slice(1500));
      });
      return { done, finish: () => finish() };
    };
    const bigMessage = (id) => JSON.stringify({ ...rpc(id, 'ping'), pad: 'p'.repeat(2000) });
    const firstLarge = slowPost(readKey.secret, bigMessage(1));
    await waitFor(() => mcp.gate.largeInUse === 1, 'a large body in progress');
    const refusedLarge = await post(bigMessage(2), { token: startKey.secret, raw: true });
    assert.equal(refusedLarge.status, 429, 'a second large body, from another key, is refused: the place is for the whole app');
    assert.equal(refusedLarge.headers.get('retry-after'), '2');
    assert.match(refusedLarge.json.error.message, /large/);
    assert.equal((await post(rpc(7, 'ping'), { token: startKey.secret })).status, 200, 'small requests go on');
    assert.equal(mcp.gate.largeInUse, 1);
    firstLarge.finish();
    const finishedLarge = await firstLarge.done;
    assert.equal(finishedLarge.status, 200, JSON.stringify(finishedLarge.json));
    assert.equal(finishedLarge.json.id, 1);
    await waitFor(() => mcp.gate.largeInUse === 0, 'the large place is given back');
    assert.equal((await post(bigMessage(3), { raw: true })).status, 200, 'and free again');
    // a body that only turns out to be large while it arrives (no Content-Length) is counted too
    const chunkedLarge = slowPost(readKey.secret, bigMessage(8), { chunked: true });
    await waitFor(() => mcp.gate.largeInUse === 1, 'a chunked large body in progress');
    chunkedLarge.finish();
    assert.equal((await chunkedLarge.done).status, 200);
    await waitFor(() => mcp.gate.largeInUse === 0, 'the large place is given back after a chunked body');
    // the usual limits still apply to a large body
    assert.equal((await post('x'.repeat(5000), { raw: true })).status, 413);
    assert.equal(mcp.gate.largeInUse, 0);

    /* ----- helpers ----- */

    assert.equal(protocolLib.decodeHeaderValue('plain'), 'plain');
    assert.equal(protocolLib.decodeHeaderValue(`=?base64?${Buffer.from('Grüsse').toString('base64')}?=`), 'Grüsse');
    assert.equal(protocolLib.decodeHeaderValue('=?base64?%%?='), null);
    assert.deepEqual(validateArguments({ type: 'object', required: ['a'], properties: { a: { type: 'array', items: { type: 'string' }, maxItems: 2 } } }, { a: [1, 'x', 'y'] }), ['arguments.a must have at most 2 items', 'arguments.a[0] must be string, not number']);
    assert.throws(() => defineTool({ name: 'bad name', description: 'x', right: 'read', inputSchema: { type: 'object' }, handler() {} }), /Invalid tool name/);
    assert.throws(() => defineTool({ name: 'x', description: 'x', right: 'admin', inputSchema: { type: 'object' }, handler() {} }), /right/);

    /* ----- the secrets stay out of everything ----- */

    const output = `${everything.join('\n')}\n${warnings.join('\n')}`;
    for (const secret of secrets) assert.ok(!output.includes(secret), 'a secret shows up in an answer or a log line');
    assert.ok(warnings.length > 0 && warnings.some((line) => line.includes('explode')), 'the unexpected error was logged by name');
    assert.ok(!warnings.some((line) => line.includes('/var/lib/app')), 'without its detail');

    await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  } finally {
    console.warn = originalWarn;
    await fsp.rm(dir, { recursive: true, force: true });
  }
  console.log('MCP-Protokoll: aktuelle und frühere Revisionen, Versionsaushandlung, Kopfzeilen, Fehler, Batches, Schlüssel, Grössen- und Ratenlimit, gleichzeitige Anfragen, Origin und GET 405 sind korrekt.');
  console.log('test-mcp-protocol.js: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
