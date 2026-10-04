'use strict';

// The language model adapter for documents and the web (WP37a, lib/nodes/llm.js and lib/discovery.js):
//   - PDFs as "file" parts with the plugin file-parser (engine native), only for a model whose input modalities contain "file"
//   - any other model gets the text alone, and so does every chatgpt/ model; onFilesSkipped says so
//   - plugins are passed through (the web search with its domains), the cited sources come back as citations [{ url, title }]
//   - unchanged: a call without files and plugins has the payload it always had; costs, journal and the empty answer
//   - discovery.brainSupportsFiles: "file" in the public list; an unknown model or a failed fetch means no files
// OpenRouter and the ChatGPT subscription are replaced; a fetch guard refuses everything except localhost.

const assert = require('assert/strict');

const { createIsolatedApp } = require('./support/isolated-app');

const restorers = [];
function patch(target, key, value) {
  const original = target[key];
  target[key] = value;
  restorers.push(() => {
    target[key] = original;
  });
}
function restoreAll() {
  while (restorers.length) restorers.pop()();
}

async function main() {
  const attempts = [];
  const realFetch = global.fetch;
  global.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
      attempts.push(url);
      return Promise.reject(new Error(`network access refused in the test: ${url}`));
    }
    return realFetch(input, init);
  };
  const iso = await createIsolatedApp({ env: { OPENROUTER_API_KEY: 'sk-or-v1-test-key-with-enough-length', ADMIN_EMAILS: 'admin@example.com', SUPERADMIN_EMAILS: '', GTS_API_TOKEN: '' } });
  try {
    await run(iso, realFetch);
  } finally {
    restoreAll();
    global.fetch = realFetch;
    await iso.cleanup();
  }
  assert.deepEqual(attempts, [], 'no request left the machine');
  console.log('test-explainer-llm.js: ok');
}

async function run(iso, realFetch) {
  const llm = iso.load('lib/nodes/llm');
  const or = iso.load('lib/openrouter');
  const chatgpt = iso.load('lib/chatgpt');
  const discovery = iso.load('lib/discovery');
  const costs = iso.load('lib/costs');

  const journal = [];
  patch(costs, 'recordCost', async (entry) => {
    journal.push(entry);
    return entry;
  });
  const posts = [];
  let reply = () => ({ choices: [{ message: { content: 'The answer' } }], usage: { cost: 0.01 } });
  patch(or, 'postJson', async (route, payload) => {
    posts.push({ route, payload });
    return reply(payload);
  });
  const streams = [];
  patch(chatgpt, 'status', () => ({ connected: true }));
  patch(chatgpt, 'streamResponses', async (options) => {
    streams.push(options);
    return { text: 'From ChatGPT', toolCalls: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  });
  const realSupportsFiles = discovery.brainSupportsFiles;
  const realSupportsImages = discovery.brainSupportsImages;
  const realIsRestricted = iso.load('lib/access').isRestricted;
  const realBrainModelAllowed = iso.load('lib/access').brainModelAllowed;
  const supportsFiles = new Set(['vendor/reads-files']);
  patch(discovery, 'brainSupportsFiles', async (model) => supportsFiles.has(model));
  patch(discovery, 'brainSupportsImages', async () => true);

  const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 test').toString('base64')}`;
  const files = [{ filename: 'report.pdf', dataUrl: PDF }];

  /* ---------- files: the OpenRouter format ---------- */
  {
    const skipped = [];
    const result = await llm.completeText({ model: 'vendor/reads-files', system: 'sys', prompt: 'Summarise', files, onFilesSkipped: (info) => skipped.push(info), sessionId: 's1' });
    const { payload } = posts[0];
    assert.deepEqual(payload.messages[0], { role: 'system', content: 'sys' });
    assert.deepEqual(payload.messages[1].content, [
      { type: 'text', text: 'Summarise' },
      { type: 'file', file: { filename: 'report.pdf', file_data: PDF } }
    ]);
    assert.deepEqual(payload.plugins, [{ id: 'file-parser', pdf: { engine: 'native' } }], 'the model reads the PDF itself');
    assert.equal(result.filesSent, 1);
    assert.deepEqual(skipped, []);
    assert.equal(result.usd, 0.01);
    assert.equal(journal.length, 1, 'the cost is booked as before');
    assert.equal(journal[0].cost, 0.01);
    // a different engine on request
    posts.length = 0;
    await llm.completeText({ model: 'vendor/reads-files', prompt: 'x', files, pdfEngine: 'mistral-ocr', sessionId: 's1' });
    assert.deepEqual(posts[0].payload.plugins, [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }]);
    // a file-parser plugin of the caller is kept, not doubled
    posts.length = 0;
    await llm.completeText({ model: 'vendor/reads-files', prompt: 'x', files, plugins: [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }], sessionId: 's1' });
    assert.deepEqual(posts[0].payload.plugins, [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }]);
    // files and images side by side
    posts.length = 0;
    await llm.completeText({ model: 'vendor/reads-files', prompt: 'x', files, images: ['data:image/png;base64,AAAA'], sessionId: 's1' });
    assert.deepEqual(posts[0].payload.messages[0].content.map((part) => part.type), ['text', 'file', 'image_url']);
  }

  /* ---------- a model without file support, and ChatGPT: the text alone ---------- */
  {
    posts.length = 0;
    const skipped = [];
    const result = await llm.completeText({ model: 'vendor/text-only', prompt: 'Summarise', files, onFilesSkipped: (info) => skipped.push(info), sessionId: 's1' });
    assert.equal(posts[0].payload.messages[0].content, 'Summarise', 'a plain string, no parts');
    assert.equal(posts[0].payload.plugins, undefined, 'no file-parser without files');
    assert.equal(result.filesSent, 0);
    assert.deepEqual(skipped, [{ model: 'vendor/text-only', reason: 'model', count: 1 }]);

    posts.length = 0;
    const gptSkipped = [];
    const gpt = await llm.completeText({ model: 'chatgpt/gpt-5.6-sol', prompt: 'Summarise', files, onFilesSkipped: (info) => gptSkipped.push(info), sessionId: 's1' });
    assert.equal(posts.length, 0, 'the subscription does not go through OpenRouter');
    assert.equal(streams.length, 1);
    assert.deepEqual(streams[0].input[0].content.map((part) => part.type), ['input_text'], 'no file part for the subscription');
    assert.equal(gpt.text, 'From ChatGPT');
    assert.equal(gpt.filesSent, 0);
    assert.deepEqual(gpt.citations, []);
    assert.deepEqual(gptSkipped, [{ model: 'chatgpt/gpt-5.6-sol', reason: 'chatgpt', count: 1 }]);
  }

  /* ---------- unchanged without files and plugins ---------- */
  {
    posts.length = 0;
    await llm.completeText({ model: 'vendor/text-only', system: 'You are terse', prompt: 'Hi', temperature: 0.3, maxTokens: 200, json: true, sessionId: 's1' });
    assert.deepEqual(posts[0].payload, {
      model: 'vendor/text-only',
      messages: [{ role: 'system', content: 'You are terse' }, { role: 'user', content: 'Hi' }],
      usage: { include: true },
      temperature: 0.3,
      max_tokens: 200,
      response_format: { type: 'json_object' }
    });
    reply = () => ({ choices: [{ message: { content: '  ' } }], usage: { cost: 0 } });
    await assert.rejects(llm.completeText({ model: 'vendor/text-only', prompt: 'Hi', sessionId: 's1' }), /empty answer/);
    reply = () => ({ choices: [{ message: { content: 'ok' } }] });
    assert.equal((await llm.completeText({ model: 'vendor/text-only', prompt: 'Hi', sessionId: 's1' })).usd, null, 'no reported cost stays null');
  }

  /* ---------- an empty answer is billed all the same (WP40 part C) ---------- */
  {
    posts.length = 0;
    journal.length = 0;
    reply = () => ({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { cost: 0.2, completion_tokens: 9000, completion_tokens_details: { reasoning_tokens: 8950 } }
    });
    const caught = await llm.completeText({ model: 'vendor/text-only', prompt: 'Hi', sessionId: 's-empty', maxTokens: 9000 }).then(() => null, (err) => err);
    assert.ok(caught, 'the call still fails');
    assert.match(caught.message, /^The model returned an empty answer/);
    assert.match(caught.message, /finish_reason length, 9000 output tokens, 8950 of them reasoning/, 'the detail is in the message');
    assert.equal(caught.usd, 0.2);
    assert.equal(caught.finishReason, 'length');
    assert.equal(caught.completionTokens, 9000);
    assert.equal(caught.reasoningTokens, 8950);
    assert.equal(journal.length, 1, 'the reported cost of the empty call is booked');
    assert.equal(journal[0].cost, 0.2);
    assert.equal(journal[0].sessionId, 's-empty');
    assert.equal(journal[0].model, 'vendor/text-only');

    // no reported cost: nothing is booked (as before); the error says null and keeps what is known
    journal.length = 0;
    reply = () => ({ choices: [{ message: { content: ' ' }, finish_reason: 'stop' }] });
    const free = await llm.completeText({ model: 'vendor/text-only', prompt: 'Hi', sessionId: 's-empty' }).then(() => null, (err) => err);
    assert.match(free.message, /^The model returned an empty answer \(finish_reason stop\)$/);
    assert.equal(free.usd, null);
    assert.equal(free.completionTokens, null);
    assert.equal(journal.length, 0, 'no cost reported, nothing to book');

    // the budget key settles the cost too
    const budget = iso.load('lib/budget');
    const settled = [];
    patch(budget, 'settle', (key, cost) => settled.push({ key, cost }));
    reply = () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { cost: 0.05 } });
    await assert.rejects(llm.completeText({ model: 'vendor/text-only', prompt: 'Hi', sessionId: 's-empty', budgetKey: 'run-1' }), /empty answer/);
    assert.deepEqual(settled, [{ key: 'run-1', cost: 0.05 }], 'the budget key of the run is charged');

    // a participant without a reported cost is charged the flat amount, like for any other call
    journal.length = 0;
    const access = iso.load('lib/access');
    patch(access, 'isRestricted', () => true);
    patch(access, 'brainModelAllowed', () => true);
    reply = () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });
    const flat = await llm.completeText({ model: 'vendor/text-only', prompt: 'Hi', sessionId: 's-empty', unknownCostUsd: 0.07 }).then(() => null, (err) => err);
    assert.equal(flat.usd, null);
    assert.equal(flat.bookedUsd, 0.07);
    assert.deepEqual(journal.map((entry) => entry.cost), [0.07], 'the same rule bookUnknown as for a successful call');
    access.isRestricted = realIsRestricted;
    access.brainModelAllowed = realBrainModelAllowed;
  }

  /* ---------- the same when a subscription call is replaced by OpenRouter ---------- */
  {
    posts.length = 0;
    journal.length = 0;
    streams.length = 0;
    patch(chatgpt, 'status', () => ({ connected: false }));
    reply = () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { cost: 0.11, completion_tokens: 500 } });
    const replaced = await llm.completeText({ model: 'chatgpt/gpt-5.6-sol', prompt: 'Hi', sessionId: 's-empty' }).then(() => null, (err) => err);
    assert.equal(streams.length, 0, 'the subscription was not used');
    assert.equal(posts.length, 1, 'the call went through OpenRouter');
    assert.equal(replaced.usd, 0.11);
    assert.equal(replaced.model, 'openai/gpt-5.6-sol', 'the error names the model that was billed');
    assert.deepEqual(journal.map((entry) => [entry.model, entry.cost]), [['openai/gpt-5.6-sol', 0.11]], 'booked under the replacement model');
    assert.match(replaced.message, /finish_reason length, 500 output tokens\)$/, 'no reasoning count where none was reported');
    // the subscription itself: an empty answer costs nothing and books nothing, as before
    journal.length = 0;
    patch(chatgpt, 'status', () => ({ connected: true }));
    const original = chatgpt.streamResponses;
    patch(chatgpt, 'streamResponses', async () => ({ text: ' ', toolCalls: [], usage: null }));
    await assert.rejects(llm.completeText({ model: 'chatgpt/gpt-5.6-sol', prompt: 'Hi', sessionId: 's-empty' }), /empty answer/);
    assert.equal(journal.length, 0);
    chatgpt.streamResponses = original;
    chatgpt.status = () => ({ connected: true });
    reply = () => ({ choices: [{ message: { content: 'ok' } }], usage: { cost: 0.01 } });
  }

  /* ---------- the web search and its sources ---------- */
  {
    posts.length = 0;
    reply = () => ({
      choices: [
        {
          message: {
            content: 'Heat pumps reach a seasonal COP of 4.',
            annotations: [
              { type: 'url_citation', url_citation: { url: 'https://example.org/a', title: 'Agency report', content: 'x', start_index: 0, end_index: 38 } },
              { type: 'url_citation', url_citation: { url: 'https://example.org/b', title: '  Second source ', start_index: 0, end_index: 38 } },
              { type: 'url_citation', url_citation: { url: 'https://example.org/a', title: 'Agency report', start_index: 5, end_index: 20 } },
              { type: 'something_else', foo: 1 },
              { type: 'url_citation', url_citation: { title: 'no url' } }
            ]
          }
        }
      ],
      usage: { cost: 0.02 }
    });
    const plugin = { id: 'web', max_results: 5, include_domains: ['example.org'], exclude_domains: ['spam.test'] };
    const result = await llm.completeText({ model: 'vendor/text-only', prompt: 'Research', plugins: [plugin], sessionId: 's1' });
    assert.deepEqual(posts[0].payload.plugins, [plugin], 'the web plugin goes through as given');
    assert.notEqual(posts[0].payload.plugins[0], plugin, 'a copy: the caller\'s object is not shared');
    assert.deepEqual(result.citations, [
      { url: 'https://example.org/a', title: 'Agency report' },
      { url: 'https://example.org/b', title: 'Second source' }
    ]);
    assert.deepEqual(result.citationSpans, [
      { url: 'https://example.org/a', end: 38 },
      { url: 'https://example.org/b', end: 38 },
      { url: 'https://example.org/a', end: 20 }
    ]);
    // the web plugin and a file together
    posts.length = 0;
    await llm.completeText({ model: 'vendor/reads-files', prompt: 'x', files, plugins: [plugin], sessionId: 's1' });
    assert.deepEqual(posts[0].payload.plugins.map((item) => item.id), ['web', 'file-parser']);
    // an answer without annotations has no citations
    reply = () => ({ choices: [{ message: { content: 'plain' } }], usage: { cost: 0 } });
    const plain = await llm.completeText({ model: 'vendor/text-only', prompt: 'x', plugins: [plugin], sessionId: 's1' });
    assert.deepEqual(plain.citations, []);
    assert.deepEqual(plain.citationSpans, []);
  }

  /* ---------- discovery: the public model list ---------- */
  {
    discovery.resetModalityCache();
    const list = {
      data: [
        { id: 'anthropic/claude-opus-5.5', architecture: { input_modalities: ['text', 'image', 'file'] } },
        { id: 'vendor/text-only', architecture: { input_modalities: ['text'] } },
        { id: 'vendor/no-info', architecture: {} }
      ]
    };
    let calls = 0;
    let failing = false;
    const guard = global.fetch;
    global.fetch = async (url) => {
      if (String(url).startsWith('https://openrouter.ai/')) {
        calls += 1;
        if (failing) throw new Error('offline');
        return { ok: true, json: async () => list };
      }
      return guard(url);
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(await realSupportsFiles('anthropic/claude-opus-5.5'), true, '"file" among the input modalities');
      assert.equal(await realSupportsFiles('vendor/text-only'), false);
      assert.equal(await realSupportsFiles('vendor/no-info'), false);
      assert.equal(await realSupportsFiles('vendor/unknown'), false, 'an unknown model gets no files (unlike images)');
      assert.equal(calls, 1, 'the list is fetched once');
      discovery.resetModalityCache();
      failing = true;
      assert.equal(await realSupportsFiles('anthropic/claude-opus-5.5'), false, 'a failed fetch means no files');
      assert.equal(await realSupportsImages('anthropic/claude-opus-5.5'), true, 'images keep their rule: unknown or failed means yes');
      failing = false;
      assert.equal(await realSupportsFiles('anthropic/claude-opus-5.5'), true, 'the next call tries again after a failure');
    } finally {
      console.warn = warn;
      global.fetch = guard;
      discovery.resetModalityCache();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
