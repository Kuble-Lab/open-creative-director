'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { PATHS } = require('./config');

const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_FILE = path.join(PATHS.root, 'data', 'chatgpt-auth.json');
const MODELS = Object.freeze(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
const BRAIN_MODELS = Object.freeze(MODELS.map((model) => `chatgpt/${model}`));
const ACCESS_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DISCONNECTED_MESSAGE = 'ChatGPT nicht verbunden - unter Einstellungen aus dem Codex-CLI-Login uebernehmen.';

class ChatGPTError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ChatGPTError';
    this.status = status;
  }
}

function createFileTokenStore(file = AUTH_FILE) {
  return {
    read() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw new ChatGPTError('ChatGPT-Anmeldedaten sind ungueltig oder konnten nicht gelesen werden.');
      }
    },
    async write(value) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const temporaryFile = `${file}.tmp`;
      await fsp.writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fsp.chmod(temporaryFile, 0o600);
      await fsp.rename(temporaryFile, file);
      await fsp.chmod(file, 0o600);
    },
    async remove() {
      await fsp.rm(file, { force: true });
    },
    removeSync() {
      fs.rmSync(file, { force: true });
    }
  };
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2 || !parts[1]) throw new ChatGPTError('ChatGPT-Access-Token ist kein gueltiges JWT.');
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload');
    return payload;
  } catch (_) {
    throw new ChatGPTError('ChatGPT-Access-Token enthaelt kein gueltiges JWT-Payload.');
  }
}

function tokenMetadata(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  const expiresAt = Number(payload.exp) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new ChatGPTError('ChatGPT-Access-Token enthaelt kein gueltiges Ablaufdatum.');
  }
  const authClaim = payload['https://api.openai.com/auth'];
  const plan = String(authClaim?.chatgpt_plan_type || '').trim();
  return { expiresAt, plan: plan || null };
}

function normaliseTokens(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const accessToken = String(value.access_token || '').trim();
  const refreshToken = String(value.refresh_token || '').trim();
  const accountId = String(value.account_id || '').trim();
  const accessExpiresAt = Number(value.access_expires_at);
  const plan = String(value.plan || '').trim();
  if (!accessToken || !refreshToken || !accountId || !Number.isFinite(accessExpiresAt)) return null;
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    account_id: accountId,
    access_expires_at: accessExpiresAt,
    plan: plan || null
  };
}

function stringifyOutput(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function messageContentParts(content, role) {
  const textType = role === 'assistant' ? 'output_text' : 'input_text';
  if (typeof content === 'string') return content ? [{ type: textType, text: content }] : [];
  if (content === null || content === undefined) return [];
  if (!Array.isArray(content)) return [{ type: textType, text: stringifyOutput(content) }];

  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) parts.push({ type: textType, text: part });
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
      if (part.text) parts.push({ type: textType, text: String(part.text) });
    } else if (role === 'user' && (part.type === 'image_url' || part.type === 'input_image')) {
      const imageUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (imageUrl) parts.push({ type: 'input_image', image_url: String(imageUrl) });
    }
  }
  return parts;
}

function messagesToInput(messages) {
  const input = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    const role = String(message.role || '');
    if (role === 'system' || role === 'developer') continue;
    if (role === 'tool') {
      const callId = String(message.tool_call_id || '').trim();
      if (callId) input.push({ type: 'function_call_output', call_id: callId, output: stringifyOutput(message.content) });
      continue;
    }
    if (role !== 'user' && role !== 'assistant') continue;

    const content = messageContentParts(message.content, role);
    if (content.length) input.push({ type: 'message', role, content });
    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const name = String(call?.function?.name || '').trim();
        const callId = String(call?.id || '').trim();
        if (!name || !callId) continue;
        input.push({
          type: 'function_call',
          name,
          arguments: typeof call.function.arguments === 'string' ? call.function.arguments : stringifyOutput(call.function.arguments || {}),
          call_id: callId
        });
      }
    }
  }
  return input;
}

function toolsToResponses(tools) {
  const mapped = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    const fn = tool?.type === 'function' && tool.function ? tool.function : tool;
    const name = String(fn?.name || '').trim();
    if (!name) continue;
    mapped.push({
      type: 'function',
      name,
      description: String(fn.description || ''),
      parameters: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
      strict: false
    });
  }
  return mapped;
}

function errorDetail(body, fallback = '') {
  if (!body) return fallback;
  if (typeof body === 'string') {
    try {
      return errorDetail(JSON.parse(body), body);
    } catch (_) {
      return body;
    }
  }
  return String(body.detail || body.error?.message || body.error || body.message || fallback || '').trim();
}

function createChatGPTClient({ env = process.env, fetchImpl, store, now = () => Date.now(), randomUUID = () => crypto.randomUUID() } = {}) {
  const tokenStore = store || createFileTokenStore(env.CHATGPT_AUTH_FILE || AUTH_FILE);
  const fetchRequest = fetchImpl || ((...args) => global.fetch(...args));
  let tokens = normaliseTokens(tokenStore.read?.());
  let refreshInFlight = null;

  async function clearTokens() {
    tokens = null;
    try {
      await tokenStore.remove?.();
    } catch (_) {
      /* Der Laufzeitstatus bleibt auch bei einem Dateisystemfehler getrennt. */
    }
  }

  async function persistTokens({ accessToken, refreshToken, accountId, fallbackPlan = null }) {
    const metadata = tokenMetadata(accessToken);
    const saved = {
      access_token: String(accessToken || '').trim(),
      refresh_token: String(refreshToken || '').trim(),
      account_id: String(accountId || '').trim(),
      access_expires_at: metadata.expiresAt,
      plan: metadata.plan || fallbackPlan || null
    };
    if (!saved.access_token || !saved.refresh_token || !saved.account_id) {
      throw new ChatGPTError('ChatGPT lieferte unvollstaendige Anmeldedaten.');
    }
    await tokenStore.write(saved);
    tokens = saved;
    return saved;
  }

  async function importFromCodexCli() {
    const sourceFile = env.CODEX_AUTH_FILE
      ? path.resolve(String(env.CODEX_AUTH_FILE))
      : path.join(os.homedir(), '.codex', 'auth.json');
    let source;
    try {
      source = JSON.parse(await fsp.readFile(sourceFile, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') throw new ChatGPTError(`Codex-CLI-Login nicht gefunden: ${sourceFile}`);
      throw new ChatGPTError('Codex-CLI-Login konnte nicht gelesen werden.');
    }
    if (source?.auth_mode !== 'chatgpt') {
      throw new ChatGPTError('Codex CLI ist nicht mit einem ChatGPT-Konto angemeldet.');
    }
    const sourceTokens = source.tokens;
    await persistTokens({
      accessToken: sourceTokens?.access_token,
      refreshToken: sourceTokens?.refresh_token,
      accountId: sourceTokens?.account_id
    });
    return status();
  }

  async function refreshAccessToken() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      if (!tokens?.refresh_token || !tokens?.account_id) {
        await clearTokens();
        throw new ChatGPTError(DISCONNECTED_MESSAGE);
      }
      let response;
      try {
        response = await fetchRequest(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            client_id: CLIENT_ID,
            grant_type: 'refresh_token',
            refresh_token: tokens.refresh_token,
            scope: 'openid profile email'
          })
        });
      } catch (err) {
        throw new ChatGPTError(`ChatGPT-Token-Refresh fehlgeschlagen: ${err.message}`);
      }
      const raw = await response.text();
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch (_) {
        /* Der HTTP-Fehler unten bleibt aussagekraeftig. */
      }
      if (!response.ok) {
        const detail = errorDetail(body, response.statusText);
        if (response.status === 400 || response.status === 401) await clearTokens();
        throw new ChatGPTError(`ChatGPT-Token-Refresh fehlgeschlagen (HTTP ${response.status}): ${detail}`, response.status);
      }
      const previous = tokens;
      await persistTokens({
        accessToken: body.access_token,
        refreshToken: body.refresh_token || previous.refresh_token,
        accountId: body.account_id || previous.account_id,
        fallbackPlan: previous.plan
      });
      return tokens.access_token;
    })();
    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  async function ensureAccessToken({ forceRefresh = false } = {}) {
    if (!tokens?.refresh_token || !tokens?.account_id) throw new ChatGPTError(DISCONNECTED_MESSAGE);
    if (forceRefresh || tokens.access_expires_at - now() < ACCESS_REFRESH_MARGIN_MS) return refreshAccessToken();
    return tokens.access_token;
  }

  function status() {
    const connected = Boolean(tokens?.refresh_token && tokens?.account_id);
    return {
      connected,
      plan: connected ? tokens.plan : null,
      expiresAt: connected ? tokens.access_expires_at : null,
      models: connected ? BRAIN_MODELS.slice() : []
    };
  }

  async function disconnect() {
    await clearTokens();
    return status();
  }

  async function consumeResponsesStream(response, callbacks) {
    if (!response.body?.getReader) throw new ChatGPTError('ChatGPT lieferte keinen lesbaren SSE-Stream.', response.status);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let usage = null;
    const toolCalls = [];
    const seenCalls = new Set();

    function handleLine(line) {
      if (!line.startsWith('data:')) return false;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return data === '[DONE]';
      let event;
      try {
        event = JSON.parse(data);
      } catch (_) {
        return false;
      }
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        text += event.delta;
        callbacks.onDelta?.(event.delta);
      } else if (event.type === 'response.output_item.done') {
        const item = event.item || event.output_item;
        if (item?.type === 'function_call') {
          const call = {
            name: String(item.name || ''),
            arguments: typeof item.arguments === 'string' ? item.arguments : stringifyOutput(item.arguments || {}),
            call_id: String(item.call_id || item.id || '')
          };
          const key = call.call_id || `${call.name}:${call.arguments}`;
          if (call.name && call.call_id && !seenCalls.has(key)) {
            seenCalls.add(key);
            toolCalls.push(call);
            callbacks.onToolCall?.(call);
          }
        }
      } else if (event.type === 'response.completed') {
        usage = event.response?.usage || event.usage || null;
        if (usage) callbacks.onUsage?.(usage);
      } else if (event.type === 'response.failed') {
        const detail = errorDetail(event.response?.error || event.error || event, 'ChatGPT-Antwort fehlgeschlagen.');
        throw new ChatGPTError(detail);
      }
      return false;
    }

    try {
      let done = false;
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
          buffer = buffer.slice(newlineIndex + 1);
          if (!line || line.startsWith(':')) continue;
          if (handleLine(line)) {
            done = true;
            break;
          }
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) handleLine(buffer.trim());
    } finally {
      try {
        await reader.cancel();
      } catch (_) {
        /* ignore */
      }
    }
    return { text, toolCalls, usage, finishReason: toolCalls.length ? 'tool_calls' : 'stop' };
  }

  async function responsesRequest(options, allow401Retry) {
    const accessToken = await ensureAccessToken();
    const model = String(options.model || '').replace(/^chatgpt\//, '');
    const controller = new AbortController();
    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(1000, Number(options.timeoutMs)) : DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await fetchRequest(RESPONSES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'chatgpt-account-id': tokens.account_id,
          'OpenAI-Beta': 'responses=experimental',
          originator: 'codex_cli_rs',
          session_id: options.sessionId,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream'
        },
        body: JSON.stringify({
          model,
          instructions: String(options.instructions || ''),
          input: Array.isArray(options.input) ? options.input : [],
          tools: Array.isArray(options.tools) ? options.tools : [],
          tool_choice: 'auto',
          parallel_tool_calls: false,
          store: false,
          stream: true,
          include: []
        }),
        signal: controller.signal
      });
      if (response.status === 401 && allow401Retry) {
        clearTimeout(timer);
        try {
          await response.body?.cancel?.();
        } catch (_) {
          /* Der Refresh darf nicht an einem nicht abbrechbaren Fehler-Body scheitern. */
        }
        await ensureAccessToken({ forceRefresh: true });
        return responsesRequest(options, false);
      }
      if (!response.ok) {
        const raw = await response.text();
        const detail = errorDetail(raw, response.statusText);
        throw new ChatGPTError(detail || `ChatGPT HTTP ${response.status}`, response.status);
      }
      return await consumeResponsesStream(response, options);
    } catch (err) {
      if (err instanceof ChatGPTError) throw err;
      if (controller.signal.aborted) throw new ChatGPTError('ChatGPT-Antwort hat das Zeitlimit erreicht.');
      throw new ChatGPTError(`ChatGPT-Anfrage fehlgeschlagen: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  function streamResponses({ model, instructions, input, tools, onDelta, onToolCall, onUsage, timeoutMs } = {}) {
    return responsesRequest({
      model,
      instructions,
      input,
      tools,
      onDelta,
      onToolCall,
      onUsage,
      timeoutMs,
      sessionId: randomUUID()
    }, true);
  }

  return { importFromCodexCli, ensureAccessToken, status, disconnect, streamResponses };
}

const client = createChatGPTClient();

module.exports = {
  ChatGPTError,
  createFileTokenStore,
  createChatGPTClient,
  decodeJwtPayload,
  tokenMetadata,
  messagesToInput,
  toolsToResponses,
  importFromCodexCli: client.importFromCodexCli,
  ensureAccessToken: client.ensureAccessToken,
  status: client.status,
  disconnect: client.disconnect,
  streamResponses: client.streamResponses,
  RESPONSES_URL,
  TOKEN_URL,
  CLIENT_ID,
  AUTH_FILE,
  MODELS,
  BRAIN_MODELS,
  ACCESS_REFRESH_MARGIN_MS,
  DISCONNECTED_MESSAGE
};
