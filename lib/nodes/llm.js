'use strict';

// Text completion adapter of the node view (SPEC §5.3): one non-streaming call through OpenRouter
// (`/chat/completions`) or the ChatGPT subscription (`chatgpt/*` models). Mirrors what
// `/api/roles/generate` (server.js) and `recordBrainUsage` (lib/brain.js) already do.

const or = require('../openrouter');
const chatgpt = require('../chatgpt');
const costs = require('../costs');
const discovery = require('../discovery');

const CHATGPT_PREFIX = 'chatgpt/';

function isChatGPTModel(model) {
  return String(model || '').startsWith(CHATGPT_PREFIX);
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.type === 'text' || typeof part?.text === 'string' ? String(part.text || '') : ''))
      .join('');
  }
  return '';
}

function userContent(prompt, images) {
  if (!images.length) return prompt;
  return [
    { type: 'text', text: prompt },
    ...images.map((url) => ({ type: 'image_url', image_url: { url } }))
  ];
}

async function journal(entry) {
  try {
    await costs.recordCost({ ts: new Date().toISOString(), type: 'brain', ...entry });
  } catch (err) {
    console.warn('[costs] Node-LLM-Kosten konnten nicht erfasst werden:', err.message);
  }
}

// Completes one prompt. Returns { text, usd, billing, usage, model }; `usd` is 0 for the ChatGPT subscription
// and null when the provider reported no cost. Throws for missing keys, non-vision models with images and empty answers.
//   options: { model, system, prompt, images = [dataUrl], temperature, maxTokens, json, sessionId, user }
async function completeText(options = {}) {
  const model = String(options.model || '').trim();
  const system = String(options.system || '').trim();
  const prompt = String(options.prompt || '');
  const images = Array.isArray(options.images) ? options.images.filter(Boolean) : [];
  const sessionId = options.sessionId || 'nodes';
  const user = options.user || 'lokal';
  if (!model) throw new Error('No model selected');
  if (!prompt.trim() && !images.length) throw new Error('The prompt is empty');

  if (isChatGPTModel(model)) {
    // The ChatGPT route has no temperature/max_tokens/response_format; JSON is requested in the instructions.
    const instructions = options.json
      ? `${system}${system ? '\n\n' : ''}Respond with a single valid JSON object and nothing else.`
      : system;
    const result = await chatgpt.streamResponses({
      model,
      instructions,
      input: chatgpt.messagesToInput([{ role: 'user', content: userContent(prompt, images) }]),
      tools: []
    });
    const text = String(result?.text || '').trim();
    if (!text) throw new Error('The model returned an empty answer');
    await journal({ sessionId, model, cost: 0, user, billing: 'Abo', usage: result?.usage || null });
    return { text, usd: 0, billing: 'Abo', usage: result?.usage || null, model };
  }

  if (images.length && !(await discovery.brainSupportsImages(model))) {
    throw new Error(`Model ${model} does not accept images; choose a vision-capable model`);
  }
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: userContent(prompt, images) });
  const payload = { model, messages, usage: { include: true } };
  if (Number.isFinite(options.temperature)) payload.temperature = options.temperature;
  if (Number.isInteger(options.maxTokens) && options.maxTokens > 0) payload.max_tokens = options.maxTokens;
  if (options.json) payload.response_format = { type: 'json_object' };

  let completion;
  try {
    completion = await or.postJson('/chat/completions', payload);
  } catch (err) {
    // Some models reject response_format: retry once without it, exactly like /api/roles/generate.
    if (err.status !== 400 || !payload.response_format) throw err;
    const fallback = { ...payload };
    delete fallback.response_format;
    completion = await or.postJson('/chat/completions', fallback);
  }
  const text = textOfContent(completion?.choices?.[0]?.message?.content).trim();
  if (!text) throw new Error('The model returned an empty answer');
  const reported = Number(completion?.usage?.cost);
  const usd = Number.isFinite(reported) && reported >= 0 ? reported : null;
  if (usd !== null) await journal({ sessionId, model, cost: usd, user });
  return { text, usd, billing: null, usage: completion?.usage || null, model };
}

module.exports = { completeText, isChatGPTModel, textOfContent };
