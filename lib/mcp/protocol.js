'use strict';

// MCP protocol (JSON-RPC 2.0), independent of HTTP and of the keys: handle() takes one parsed message with the request
// headers and returns { status, json } (json is absent for a notification, which is answered 202 without a body).
//
// Protocol versions (https://modelcontextprotocol.io/specification, current revision 2026-07-28, read 2026-10-03):
//   modern  2026-07-28   no handshake. Every request carries _meta["io.modelcontextprotocol/protocolVersion"] and
//                        ["io.modelcontextprotocol/clientCapabilities"]; the HTTP headers MCP-Protocol-Version,
//                        Mcp-Method and (tools/call) Mcp-Name must match the body; results carry resultType; list
//                        results carry ttlMs and cacheScope; server/discover tells the supported versions.
//   legacy  2025-11-25, 2025-06-18, 2025-03-26
//                        initialize (the version is negotiated), notifications/initialized, no sessions here (the
//                        server never hands out an Mcp-Session-Id and ignores one it receives).
// The server answers both on the same endpoint (a "dual-era" server). The era of a request is decided by its _meta
// version, else by the MCP-Protocol-Version header, else it is legacy 2025-03-26.
// JSON-RPC batches (an array of messages) are part of 2025-03-26 only (later revisions dropped them): they are taken without
// the version header or with 2025-03-26, at most 10 messages, answered one after the other as an array. initialize is not
// allowed inside a batch.
//
// Errors of the protocol (unknown method, bad params, wrong version ...) are JSON-RPC errors. A tool that does not do its
// job answers with a result that has isError: true and a text the model can act on.

const { ToolError, rightAllows, validateArguments } = require('./tools');

const MODERN_VERSIONS = Object.freeze(['2026-07-28']);
const LEGACY_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26']);
const SUPPORTED_VERSIONS = Object.freeze([...MODERN_VERSIONS, ...LEGACY_VERSIONS]);
const LATEST_VERSION = MODERN_VERSIONS[0];
const LATEST_LEGACY_VERSION = LEGACY_VERSIONS[0];
const DEFAULT_HEADERLESS_VERSION = '2025-03-26';
const BATCH_VERSION = '2025-03-26';
const MAX_BATCH = 10;

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

const ERROR = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  HEADER_MISMATCH: -32020,
  UNSUPPORTED_VERSION: -32022
});

const LIST_TTL_MS = 60 * 1000;
const DISCOVER_TTL_MS = 5 * 60 * 1000;
const MAX_NAME_CHARS = 128;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (id) => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));

function rpcError(status, id, code, message, data) {
  return { status, json: { jsonrpc: '2.0', id: validId(id) ? id : null, error: { code, message, ...(data !== undefined ? { data } : {}) } } };
}

// "=?base64?<text>?=" is how a client sends a header value that is not plain ASCII.
function decodeHeaderValue(raw) {
  if (typeof raw !== 'string') return null;
  const match = /^=\?base64\?(.*)\?=$/.exec(raw);
  if (!match) return raw;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(match[1])) return null;
  return Buffer.from(match[1], 'base64').toString('utf8');
}

function createProtocol({
  serverInfo = { name: 'open-creative-director', version: '0.0.0' },
  instructions = '',
  tools = [],
  formatToolError = null,
  log = (...args) => console.warn(...args)
} = {}) {
  const registry = new Map();
  for (const tool of tools) registry.set(tool.name, tool);

  const capabilities = () => ({ tools: { listChanged: false } });
  const publicTool = (tool) => ({
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: tool.right === 'read', ...(tool.annotations || {}) }
  });

  /* ----- results ----- */

  // A modern result carries resultType and the server's identity; a legacy one is as it is.
  function complete(era, result, extra = {}) {
    if (era.modern) {
      return { resultType: 'complete', ...result, ...extra, _meta: { ...(result._meta || {}), [META_SERVER_INFO]: serverInfo } };
    }
    return result;
  }

  const ok = (id, result) => ({ status: 200, json: { jsonrpc: '2.0', id, result } });

  /* ----- the era of a request ----- */

  function unsupported(id, requested) {
    return rpcError(400, id, ERROR.UNSUPPORTED_VERSION, 'Unsupported protocol version', {
      supported: SUPPORTED_VERSIONS.slice(),
      requested: String(requested).slice(0, 40)
    });
  }

  // { era } or { error }
  function eraOf(message, headers) {
    const params = isObject(message.params) ? message.params : {};
    const meta = isObject(params._meta) ? params._meta : null;
    const headerVersion = headers['mcp-protocol-version'];
    if (message.method === 'initialize') return { era: { modern: false, version: LATEST_LEGACY_VERSION } };
    if (meta && meta[META_VERSION] !== undefined) {
      const version = meta[META_VERSION];
      if (typeof version !== 'string' || !SUPPORTED_VERSIONS.includes(version)) return { error: unsupported(message.id, version) };
      return { era: { modern: MODERN_VERSIONS.includes(version), version, fromMeta: true } };
    }
    if (headerVersion !== undefined) {
      if (typeof headerVersion !== 'string' || !SUPPORTED_VERSIONS.includes(headerVersion)) return { error: unsupported(message.id, headerVersion) };
      if (MODERN_VERSIONS.includes(headerVersion)) {
        // the header says "modern", the body does not: the header does not match the body
        return { error: rpcError(400, message.id, ERROR.HEADER_MISMATCH, `Header mismatch: the MCP-Protocol-Version header says ${headerVersion}, but params._meta["${META_VERSION}"] and ["${META_CAPABILITIES}"] are missing`) };
      }
      return { era: { modern: false, version: headerVersion } };
    }
    return { era: { modern: false, version: DEFAULT_HEADERLESS_VERSION } };
  }

  // The modern era repeats the version, the method and the tool name in HTTP headers; they have to agree with the body.
  function checkModern(message, headers, era) {
    const params = isObject(message.params) ? message.params : {};
    const mismatch = (text) => rpcError(400, message.id, ERROR.HEADER_MISMATCH, `Header mismatch: ${text}`);
    if (!isObject(params._meta[META_CAPABILITIES])) {
      return rpcError(400, message.id, ERROR.INVALID_PARAMS, `params._meta["${META_CAPABILITIES}"] is required`);
    }
    if (headers['mcp-protocol-version'] === undefined) return mismatch('the MCP-Protocol-Version header is missing');
    if (headers['mcp-protocol-version'] !== era.version) return mismatch('the MCP-Protocol-Version header does not match the version in the request');
    if (headers['mcp-method'] === undefined) return mismatch('the Mcp-Method header is missing');
    if (headers['mcp-method'] !== message.method) return mismatch('the Mcp-Method header does not match the method');
    if (message.method === 'tools/call' && typeof params.name === 'string') {
      if (headers['mcp-name'] === undefined) return mismatch('the Mcp-Name header is missing');
      if (decodeHeaderValue(headers['mcp-name']) !== params.name) return mismatch('the Mcp-Name header does not match the tool name');
    }
    return null;
  }

  /* ----- methods ----- */

  function initialize(message) {
    const params = isObject(message.params) ? message.params : {};
    if (typeof params.protocolVersion !== 'string' || !params.protocolVersion) {
      return rpcError(200, message.id, ERROR.INVALID_PARAMS, 'initialize needs params.protocolVersion');
    }
    // the version of the client when we speak it, else the newest legacy version (the client decides whether it can use it)
    const version = LEGACY_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : LATEST_LEGACY_VERSION;
    return ok(message.id, {
      protocolVersion: version,
      capabilities: capabilities(),
      serverInfo,
      ...(instructions ? { instructions } : {})
    });
  }

  function discover(message, era) {
    return ok(
      message.id,
      complete(era, { supportedVersions: SUPPORTED_VERSIONS.slice(), capabilities: capabilities(), ...(instructions ? { instructions } : {}) }, { ttlMs: DISCOVER_TTL_MS, cacheScope: 'public' })
    );
  }

  function visibleTools(context) {
    const right = context && context.key ? context.key.right : 'read';
    return [...registry.values()].filter((tool) => rightAllows(right, tool.right)).sort((a, b) => a.name.localeCompare(b.name));
  }

  function listTools(message, era, context) {
    const params = isObject(message.params) ? message.params : {};
    if (params.cursor !== undefined && params.cursor !== null && params.cursor !== '') {
      return rpcError(200, message.id, ERROR.INVALID_PARAMS, 'Invalid cursor');
    }
    // the list depends on the right of the key: private to this key
    return ok(message.id, complete(era, { tools: visibleTools(context).map(publicTool) }, era.modern ? { ttlMs: LIST_TTL_MS, cacheScope: 'private' } : {}));
  }

  function textResult(era, text, isError) {
    return complete(era, { content: [{ type: 'text', text }], isError });
  }

  function normaliseToolResult(era, value) {
    if (typeof value === 'string') return textResult(era, value, false);
    if (isObject(value) && Array.isArray(value.content)) {
      return complete(era, {
        content: value.content,
        ...(value.structuredContent !== undefined ? { structuredContent: value.structuredContent } : {}),
        isError: value.isError === true
      });
    }
    if (isObject(value)) {
      return complete(era, { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
    }
    return textResult(era, 'The tool returned nothing.', false);
  }

  async function callTool(message, era, context) {
    const params = isObject(message.params) ? message.params : {};
    if (typeof params.name !== 'string' || !params.name || params.name.length > MAX_NAME_CHARS) {
      return rpcError(200, message.id, ERROR.INVALID_PARAMS, 'params.name must be the name of a tool');
    }
    const tool = registry.get(params.name);
    if (!tool) return rpcError(200, message.id, ERROR.INVALID_PARAMS, `Unknown tool: ${params.name}`);
    const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
    if (!isObject(args)) return rpcError(200, message.id, ERROR.INVALID_PARAMS, 'params.arguments must be an object');
    const key = context && context.key ? context.key : { right: 'read' };
    if (!rightAllows(key.right, tool.right)) {
      return ok(message.id, textResult(era, `This key may only read. The tool ${tool.name} starts or changes something and needs a key with the right "read and start".`, true));
    }
    const problems = validateArguments(tool.inputSchema, args);
    if (problems.length) return ok(message.id, textResult(era, `The arguments are not valid: ${problems.join('; ')}.`, true));
    try {
      return ok(message.id, normaliseToolResult(era, await tool.handler(args, context)));
    } catch (err) {
      if (err instanceof ToolError) return ok(message.id, textResult(era, err.message, true));
      let text = null;
      try {
        text = formatToolError ? formatToolError(err, tool) : null;
      } catch (_) {
        text = null;
      }
      if (typeof text !== 'string' || !text) {
        log(`[mcp] Werkzeug ${tool.name} ist fehlgeschlagen: ${String(err && (err.code || err.name) || 'Fehler')}`);
        text = 'The tool failed unexpectedly. Try again later.';
      }
      return ok(message.id, textResult(era, text, true));
    }
  }

  /* ----- one message ----- */

  async function handleBatch(messages, headers, context) {
    const version = headers['mcp-protocol-version'];
    if (version !== undefined && version !== BATCH_VERSION) {
      return rpcError(400, null, ERROR.INVALID_REQUEST, `Batch requests are part of protocol version ${BATCH_VERSION} only; send one message per request`);
    }
    if (!messages.length) return rpcError(400, null, ERROR.INVALID_REQUEST, 'The batch is empty');
    if (messages.length > MAX_BATCH) return rpcError(400, null, ERROR.INVALID_REQUEST, `A batch has at most ${MAX_BATCH} messages`);
    const answers = [];
    for (const item of messages) {
      let answer;
      if (Array.isArray(item)) answer = rpcError(400, null, ERROR.INVALID_REQUEST, 'A batch cannot contain a batch');
      else if (isObject(item) && item.method === 'initialize') answer = rpcError(400, item.id, ERROR.INVALID_REQUEST, 'initialize cannot be part of a batch');
      else answer = await handleOne({ message: item, headers, context });
      if (answer.json !== undefined) answers.push(answer.json);
    }
    return answers.length ? { status: 200, json: answers } : { status: 202 };
  }

  async function handle({ message, headers = {}, context = {} } = {}) {
    if (Array.isArray(message)) return handleBatch(message, headers, context);
    return handleOne({ message, headers, context });
  }

  async function handleOne({ message, headers, context }) {
    if (!isObject(message) || message.jsonrpc !== '2.0') {
      return rpcError(400, isObject(message) ? message.id : null, ERROR.INVALID_REQUEST, 'The body is not a JSON-RPC 2.0 message');
    }
    if (typeof message.method !== 'string' || !message.method) {
      // a response to something the server never asked: nothing to do
      if ('result' in message || 'error' in message) return { status: 202 };
      return rpcError(400, message.id, ERROR.INVALID_REQUEST, 'The message has no method');
    }
    if (!('id' in message)) return { status: 202 }; // notifications (initialized, cancelled ...): accepted, nothing to do
    if (!validId(message.id)) return rpcError(400, null, ERROR.INVALID_REQUEST, 'The id must be a string or a number');
    if (message.params !== undefined && !isObject(message.params)) return rpcError(400, message.id, ERROR.INVALID_PARAMS, 'params must be an object');

    const found = eraOf(message, headers);
    if (found.error) return found.error;
    const era = found.era;
    if (era.modern) {
      const problem = checkModern(message, headers, era);
      if (problem) return problem;
    }

    switch (message.method) {
      case 'initialize':
        return initialize(message);
      case 'ping':
        return ok(message.id, era.modern ? { resultType: 'complete' } : {});
      case 'server/discover':
        return discover(message, era);
      case 'tools/list':
        return listTools(message, era, context);
      case 'tools/call':
        return callTool(message, era, context);
      default:
        // modern servers answer an unknown method with 404 (so a client can tell this server from a legacy one)
        return rpcError(era.modern ? 404 : 200, message.id, ERROR.METHOD_NOT_FOUND, `Method not found: ${message.method.slice(0, 80)}`);
    }
  }

  return { handle, maxBatch: MAX_BATCH, visibleTools, registerTool: (tool) => registry.set(tool.name, tool), toolNames: () => [...registry.keys()] };
}

module.exports = {
  MODERN_VERSIONS,
  LEGACY_VERSIONS,
  SUPPORTED_VERSIONS,
  LATEST_VERSION,
  LATEST_LEGACY_VERSION,
  META_VERSION,
  META_CAPABILITIES,
  META_SERVER_INFO,
  ERROR,
  createProtocol,
  decodeHeaderValue,
  rpcError
};
