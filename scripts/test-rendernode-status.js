'use strict';

const assert = require('assert/strict');

const { createRenderNodeClient } = require('../lib/rendernode');

async function main() {
  let calls = 0;
  let healthRequest;
  const client = createRenderNodeClient({
    store: { listNodes: () => [] },
    env: {
      RENDER_NODE_URL: 'http://render-node.test',
      RENDER_NODE_TOKEN: 'test-token'
    },
    fetchImpl: async (url, options) => {
      calls += 1;
      healthRequest = { url, options };
      return new Response(JSON.stringify({ ok: true, queue: 2, running: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });

  const health = await client.health();
  assert.equal(health.ok, true);
  assert.equal(healthRequest.url, 'http://render-node.test/health');
  assert.equal(healthRequest.options.headers?.Authorization, undefined, 'Der Healthcheck darf keine Auth senden');

  client.resetStatusCache();
  calls = 0;
  const node = client.listNodes()[0];
  const first = await client.nodeStatus(node);
  const second = await client.nodeStatus(node);
  assert.deepEqual(first, { online: true, running: false, queue: 2 });
  assert.deepEqual(second, first);
  assert.equal(calls, 1, 'Der 15-Sekunden-Cache muss den zweiten Healthcheck verhindern');
  console.log('Render-Node: Healthcheck ohne Auth und 15-Sekunden-Cache sind korrekt.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
