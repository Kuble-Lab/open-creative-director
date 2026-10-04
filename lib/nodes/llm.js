'use strict';

// Text completion adapter of the node view (SPEC §5.3): one non-streaming call through OpenRouter
// (`/chat/completions`) or the ChatGPT subscription (`chatgpt/*` models). Mirrors what
// `/api/roles/generate` (server.js) and `recordBrainUsage` (lib/brain.js) already do.

const or = require('../openrouter');
const chatgpt = require('../chatgpt');
const chatgptFallback = require('../chatgpt-fallback');
const costs = require('../costs');
const access = require('../access');
const budget = require('../budget');
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

// The user message: the prompt, and where there are any, the files (OpenRouter content parts of type "file": a PDF as a data URL)
// and the images.
function userContent(prompt, images, files = []) {
  if (!images.length && !files.length) return prompt;
  return [
    { type: 'text', text: prompt },
    ...files.map((file) => ({ type: 'file', file: { filename: file.filename, file_data: file.dataUrl } })),
    ...images.map((url) => ({ type: 'image_url', image_url: { url } }))
  ];
}

// Where in the answer each source was cited: [{ url, end }] (end_index of the annotation, in characters of the answer).
function citationSpansOf(completion) {
  const annotations = completion?.choices?.[0]?.message?.annotations;
  const spans = [];
  for (const annotation of Array.isArray(annotations) ? annotations : []) {
    if (annotation?.type !== 'url_citation') continue;
    const cite = annotation.url_citation || {};
    const url = String(cite.url || '').trim();
    const end = Number(cite.end_index);
    if (url && Number.isInteger(end) && end >= 0) spans.push({ url, end });
  }
  return spans;
}

// The sources a web search plugin cited: choices[0].message.annotations of type url_citation -> [{ url, title }], each URL once,
// in the order of the answer.
function citationsOf(completion) {
  const annotations = completion?.choices?.[0]?.message?.annotations;
  const found = [];
  const seen = new Set();
  for (const annotation of Array.isArray(annotations) ? annotations : []) {
    if (annotation?.type !== 'url_citation') continue;
    const cite = annotation.url_citation || {};
    const url = String(cite.url || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    found.push({ url, title: String(cite.title || '').trim() });
  }
  return found;
}

async function journal(entry, budgetKey = null) {
  try {
    await costs.recordCost({ ts: new Date().toISOString(), type: 'brain', ...entry });
    if (budgetKey) budget.settle(budgetKey, entry.cost);
  } catch (err) {
    console.warn('[costs] Node-LLM-Kosten konnten nicht erfasst werden:', err.message);
  }
}

// The turns that follow the first user message in a conversation that goes on (options.history): [{ role: 'assistant' | 'user', content }]
// with text only. A correction of a scene is such a turn pair: the answer of the model so far and what is wrong with it.
function historyOf(value) {
  return (Array.isArray(value) ? value : [])
    .filter((turn) => turn && (turn.role === 'assistant' || turn.role === 'user') && typeof turn.content === 'string' && turn.content.trim())
    .map((turn) => ({ role: turn.role, content: turn.content }));
}

// The detail of an empty answer: why it ended and what it used, for example " (finish_reason length, 9000 output tokens, 8950 of them reasoning)".
function emptyDetail({ finishReason, completionTokens, reasoningTokens }) {
  const parts = [];
  if (finishReason) parts.push(`finish_reason ${finishReason}`);
  if (completionTokens !== null) parts.push(`${completionTokens} output tokens`);
  if (completionTokens !== null && reasoningTokens !== null) parts.push(`${reasoningTokens} of them reasoning`);
  else if (reasoningTokens !== null) parts.push(`${reasoningTokens} reasoning tokens`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function countOf(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

// An empty answer is still a billed call: the error carries what the provider reported, so the caller can book it (see completeNow).
//   usd (reported cost or null), finishReason, completionTokens, reasoningTokens, model; emptyAnswer marks it.
function emptyAnswerError(model, completion, usd) {
  const finishReason = String(completion?.choices?.[0]?.finish_reason || '').trim() || null;
  const completionTokens = countOf(completion?.usage?.completion_tokens);
  const reasoningTokens = countOf(completion?.usage?.completion_tokens_details?.reasoning_tokens);
  const err = new Error(`The model returned an empty answer${emptyDetail({ finishReason, completionTokens, reasoningTokens })}`);
  Object.assign(err, { emptyAnswer: true, model, usd, finishReason, completionTokens, reasoningTokens });
  return err;
}

// The efforts of thinking a caller may ask for (OpenRouter `reasoning.effort`); unset is the model's own.
const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high']);

// One completion over OpenRouter (the regular route, and the replacement for a failed subscription call).
async function completeViaOpenRouter(model, { system, prompt, images, files = [], history = [], options }) {
  if (images.length && !(await discovery.brainSupportsImages(model))) {
    throw new Error(`Model ${model} does not accept images; choose a vision-capable model`);
  }
  // Files (PDF) are sent only to a model that takes them (input_modalities of the public list contain "file"); any other model
  // gets the text alone, and onFilesSkipped says so. The model reads the PDF itself (engine "native", billed as input tokens).
  let sentFiles = [];
  if (files.length) {
    if (await discovery.brainSupportsFiles(model)) sentFiles = files;
    else if (typeof options.onFilesSkipped === 'function') options.onFilesSkipped({ model, reason: 'model', count: files.length });
  }
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: userContent(prompt, images, sentFiles) });
  messages.push(...history);
  const payload = { model, messages, usage: { include: true } };
  const plugins = (Array.isArray(options.plugins) ? options.plugins : []).map((plugin) => ({ ...plugin }));
  if (sentFiles.length && !plugins.some((plugin) => plugin.id === 'file-parser')) {
    plugins.push({ id: 'file-parser', pdf: { engine: options.pdfEngine || 'native' } });
  }
  if (plugins.length) payload.plugins = plugins;
  if (Number.isFinite(options.temperature)) payload.temperature = options.temperature;
  if (Number.isInteger(options.maxTokens) && options.maxTokens > 0) payload.max_tokens = options.maxTokens;
  if (REASONING_EFFORTS.includes(options.reasoningEffort)) payload.reasoning = { effort: options.reasoningEffort };
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
  const reported = Number(completion?.usage?.cost);
  const usd = Number.isFinite(reported) && reported >= 0 ? reported : null;
  if (!text) throw emptyAnswerError(model, completion, usd);
  return { text, usd, usage: completion?.usage || null, citations: citationsOf(completion), citationSpans: citationSpansOf(completion), filesSent: sentFiles.length };
}

// Completes one prompt. Returns { text, usd, billing, usage, model }; `usd` is 0 for the ChatGPT subscription
// and null when the provider reported no cost. Throws for missing keys, non-vision models with images and empty answers.
//   options: { model, system, prompt, images = [dataUrl], files = [{ filename, dataUrl }], history = [{ role, content }], plugins, pdfEngine, temperature, maxTokens, json,
//              reasoningEffort, sessionId, user, budgetKey, restrictedModels, estimateUsd, unknownCostUsd, onReplaced, onFilesSkipped }
// reasoningEffort: 'low' | 'medium' | 'high', how much a thinking model thinks (OpenRouter `reasoning.effort`; a model without such a
// setting ignores it, the subscription keeps its own); unset or any other value is the model's own.
// files: PDFs as data URLs, sent as OpenRouter "file" parts with the plugin file-parser (engine "native" unless pdfEngine says
// otherwise) to a model whose input_modalities contain "file"; any other model (and every chatgpt/ model) gets the text alone and
// onFilesSkipped({ model, reason: 'model' | 'chatgpt', count }) is called. plugins: more OpenRouter plugins, for example the web
// search ({ id: 'web', max_results, include_domains, exclude_domains }); their sources come back as `citations` [{ url, title }]
// (only over OpenRouter; the subscription has no plugins, so its result has no citations).
// history: more turns after the prompt (the answer of the model so far and what is wrong with it: the conversation goes on), text only.
// A participant (lib/access.js) needs budget left (budgetKey: the reservation of the node run this call belongs to)
// and may not use the ChatGPT subscription.
// A call that is not part of a node run passes estimateUsd: it is reserved while the call is in flight, so several calls at
// the same time cannot together run past the budget. unknownCostUsd: when the provider reports no cost, a participant is
// charged this flat amount instead of nothing (`bookedUsd` in the result; `usd` stays null).
// When the subscription fails before an answer arrived, the call runs once through OpenRouter (the same function as the
// Director, lib/chatgpt-fallback.js): `model` is then the openai/... model, `usd` its cost, and onReplaced({ from, to,
// reason }) is called first.
async function completeText(options = {}) {
  const model = String(options.model || '').trim();
  const system = String(options.system || '').trim();
  const prompt = String(options.prompt || '');
  const images = Array.isArray(options.images) ? options.images.filter(Boolean) : [];
  const files = (Array.isArray(options.files) ? options.files : []).filter((file) => file && typeof file.dataUrl === 'string' && file.dataUrl);
  const history = historyOf(options.history);
  const sessionId = options.sessionId || 'nodes';
  const user = options.user || 'lokal';
  if (!model) throw new Error('No model selected');
  if (!prompt.trim() && !images.length) throw new Error('The prompt is empty');
  const viewer = access.viewerOf({ kubleUser: user });
  if (!access.modelAllowed(viewer, model)) {
    throw new access.RoleRestrictedError('chatgpt', 'The ChatGPT subscription is not available for your account', 'Das ChatGPT-Abo ist für dein Konto nicht verfügbar.');
  }
  // config.restrictedBrainModels: participants and guests use only the listed models (a blank model never gets here).
  if (!access.brainModelAllowed(viewer, model, options.restrictedModels)) {
    throw new access.RoleRestrictedError('models', 'This model is not available for your account', 'Dieses Modell ist für dein Konto nicht freigegeben.');
  }
  const estimateUsd = Number.isFinite(options.estimateUsd) && options.estimateUsd > 0 ? options.estimateUsd : null;
  const grant = await budget.begin(viewer, { runKey: options.budgetKey || null, label: 'llm', estimateUsd });
  try {
    return await completeNow({ model, system, prompt, images, files, history, sessionId, user, viewer, options, budgetKey: options.budgetKey || null });
  } finally {
    grant.release();
  }
}

// The unknown cost of a call is booked as a flat amount for a participant (see completeText).
async function bookUnknown(usd, { model, sessionId, user, viewer, options }, budgetKey) {
  const flat = Number(options.unknownCostUsd);
  if (usd !== null || !access.isRestricted(viewer) || !(flat > 0)) return null;
  await journal({ sessionId, model, cost: flat, user }, budgetKey);
  return flat;
}

// An empty answer from OpenRouter was billed all the same: the reported cost is booked like that of any other call (the flat
// amount for a participant when none was reported), then the error goes on. `bookedUsd` on the error says what a participant was charged.
async function bookEmpty(err, ctx, budgetKey) {
  if (!err || !err.emptyAnswer) return;
  const { sessionId, user } = ctx;
  const model = err.model || ctx.model;
  if (err.usd !== null && err.usd !== undefined) await journal({ sessionId, model, cost: err.usd, user }, budgetKey);
  const bookedUsd = await bookUnknown(err.usd ?? null, { ...ctx, model }, budgetKey);
  if (bookedUsd) err.bookedUsd = bookedUsd;
}

async function completeNow(ctx) {
  try {
    return await completeCall(ctx);
  } catch (err) {
    await bookEmpty(err, ctx, ctx.budgetKey);
    throw err;
  }
}

async function completeCall(ctx) {
  const { model, system, prompt, images, files, history, sessionId, user, options, budgetKey } = ctx;

  if (isChatGPTModel(model)) {
    // The ChatGPT route has no temperature/max_tokens/response_format; JSON is requested in the instructions.
    const instructions = options.json
      ? `${system}${system ? '\n\n' : ''}Respond with a single valid JSON object and nothing else.`
      : system;
    const outcome = await chatgptFallback.run({
      model,
      subscription: () => chatgpt.streamResponses({
        model,
        instructions,
        input: chatgpt.messagesToInput([{ role: 'user', content: userContent(prompt, images) }, ...history]),
        tools: []
      }),
      replacement: (openRouterModel) => completeViaOpenRouter(openRouterModel, { system, prompt, images, files, history, options }),
      onReplaced: options.onReplaced
    });
    if (outcome.replaced) {
      const { text, usd, usage, citations, citationSpans, filesSent } = outcome.result;
      if (usd !== null) await journal({ sessionId, model: outcome.model, cost: usd, user }, budgetKey);
      const bookedUsd = await bookUnknown(usd, { ...ctx, model: outcome.model }, budgetKey);
      return { text, usd, billing: null, usage, citations, citationSpans, filesSent, model: outcome.model, replaced: true, ...(bookedUsd ? { bookedUsd } : {}) };
    }
    const result = outcome.result;
    const text = String(result?.text || '').trim();
    if (!text) throw new Error('The model returned an empty answer');
    // the subscription route takes no files: the answer came from the text alone
    if (files.length && typeof options.onFilesSkipped === 'function') options.onFilesSkipped({ model, reason: 'chatgpt', count: files.length });
    await journal({ sessionId, model, cost: 0, user, billing: 'Abo', usage: result?.usage || null }, budgetKey);
    return { text, usd: 0, billing: 'Abo', usage: result?.usage || null, citations: [], citationSpans: [], filesSent: 0, model };
  }

  const { text, usd, usage, citations, citationSpans, filesSent } = await completeViaOpenRouter(model, { system, prompt, images, files, history, options });
  if (usd !== null) await journal({ sessionId, model, cost: usd, user }, budgetKey);
  const bookedUsd = await bookUnknown(usd, ctx, budgetKey);
  return { text, usd, billing: null, usage, citations, citationSpans, filesSent, model, ...(bookedUsd ? { bookedUsd } : {}) };
}

module.exports = { completeText, isChatGPTModel, textOfContent };
