'use strict';

// Exercise the chat route in process: closing a response must not cancel the turn
// or its running render; the result remains available after reconnecting.
const assert = require('assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { createRenderQueue } = require('../lib/render-queue');
const { app } = require('../server');
const store = require('../lib/store');
const brain = require('../lib/brain');
const or = require('../lib/openrouter');

async function main() {
  const handler = app._router.stack.find((layer) => layer.route?.path === '/api/sessions/:id/message' && layer.route.methods.post).route.stack.at(-1).handle;
  const original = brain.runTurn;
  const hasKey = or.hasKey;
  const session = await store.createSession();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-render-'));
  const queue = createRenderQueue({ dir, mayServe: () => 0 });
  try {
    or.hasKey = () => true;
    for (const disconnect of [false, true]) {
      let renderId;
      let turnCompleted = false;
      const response = new EventEmitter();
      Object.assign(response, {
        writableFinished: false,
        writeHead() {}, write() {},
        end() { this.writableFinished = true; this.emit('close'); },
        status(code) { throw new Error(`Unexpected HTTP ${code}`); }
      });
      brain.runTurn = async (options) => {
        assert.equal(options.signal, undefined, 'chat lifetime is independent of the response');
        const job = await queue.enqueue({ html: '<html>render</html>', signal: options.signal });
        renderId = job.jobId;
        const agent = { id: 'chat-agent', owner: 'owner' };
        const lease = await queue.poll(agent, { waitMs: 0 });
        assert.equal(lease.jobId, renderId);
        if (disconnect) response.emit('close');
        await new Promise((resolve) => setImmediate(resolve));
        queue.progress(agent, renderId, lease.lease, { progress: 0.5 });
        await queue.acceptResult(agent, renderId, lease.lease,
          Readable.from([require('./support/render-test-video')]));
        options.emit({ type: 'status', phase: 'done' });
        turnCompleted = true;
      };
      await handler({ params: { id: session.id }, body: { text: 'render' }, headers: {} }, response);
      assert.equal(turnCompleted, true, 'turn completes even after disconnect');
      assert.equal(queue.status(renderId).status, 'completed', 'render result survives response close');
    }
    console.log('test-chat-render-cancellation.js: ok');
  } finally {
    brain.runTurn = original;
    or.hasKey = hasKey;
    await store.deleteSession(session.id);
    queue.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
