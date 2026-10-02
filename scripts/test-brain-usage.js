'use strict';

const assert = require('assert/strict');

async function main() {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  let requestBody;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    const stream = [
      'data: {"choices":[{"delta":{"content":"Hallo"},"finish_reason":null}]}',
      '',
      'data: {"choices":[],"usage":{"cost":0.0123}}',
      '',
      'data: [DONE]',
      ''
    ].join('\n');
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-test-key-with-enough-length';

  try {
    const or = require('../lib/openrouter');
    const { consumeChatStream } = require('../lib/brain');
    const response = await or.chatStream({ model: 'brain-test', messages: [] });
    assert.equal(requestBody.stream, true);
    assert.deepEqual(requestBody.usage, { include: true });
    const emitted = [];
    const result = await consumeChatStream(response, (event) => emitted.push(event));
    assert.equal(result.text, 'Hallo');
    assert.equal(result.usage.cost, 0.0123);
    assert.deepEqual(emitted, [{ type: 'text_delta', delta: 'Hallo' }]);
    console.log('Brain-Usage: Request-Flag und letzter SSE-Usage-Chunk werden korrekt verarbeitet.');
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
  console.log('test-brain-usage.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
