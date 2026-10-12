'use strict';

const assert = require('assert/strict');
const { EventEmitter } = require('events');
const https = require('node:https');
const or = require('../lib/openrouter');

async function main() {
  const original = https.request;
  const key = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-only-placeholder-key';
  let reply;
  let destroyed = 0;
  https.request = (_url, options, respond) => {
    const req = new EventEmitter();
    req.destroy = (err) => { destroyed += 1; req.emit('error', err); };
    req.end = (body) => {
      assert.deepEqual(JSON.parse(body), { model: 'test' });
      process.nextTick(() => {
        if (options.signal?.aborted) return req.destroy(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        options.signal?.addEventListener('abort', () => req.destroy(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
        if (!reply) return;
        const res = new EventEmitter();
        res.statusCode = reply.status || 200;
        respond(res);
        res.emit('data', Buffer.from(reply.text));
        if (!reply.hang) res.emit('end');
      });
    };
    return req;
  };
  try {
    reply = { text: '{"ok":true}' };
    assert.deepEqual(await or.postJson('/chat/completions', { model: 'test' }, { timeoutMs: 1000 }), { ok: true });
    reply = { status: 400, text: '{"error":{"message":"invalid format"}}' };
    await assert.rejects(or.postJson('/chat/completions', { model: 'test' }, { timeoutMs: 1000 }), { status: 400 });
    reply = { text: 'broken' };
    await assert.rejects(or.postJson('/chat/completions', { model: 'test' }, { timeoutMs: 1000 }), SyntaxError);
    reply = null;
    await assert.rejects(or.postJson('/chat/completions', { model: 'test' }, { timeoutMs: 10 }), { name: 'TimeoutError' });
    reply = { text: '{', hang: true };
    await assert.rejects(or.postJson('/chat/completions', { model: 'test' }, { timeoutMs: 10 }), { name: 'TimeoutError' });
    const controller = new AbortController();
    const pending = or.postJson('/chat/completions', { model: 'test' }, { timeoutMs: 1000, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(destroyed, 3);
    console.log('test-openrouter-long.js: ok');
  } finally {
    https.request = original;
    if (key === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = key;
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
