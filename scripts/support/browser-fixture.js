'use strict';

// Only this test process sees the isolated stores and injected executors. No production hook.
const path = require('node:path');
const fs = require('node:fs/promises');
const { once } = require('node:events');

async function createFixture(temp, { listen = true } = {}) {
  await fs.mkdir(path.join(temp, 'config'), { recursive: true });
  await fs.copyFile(path.resolve(__dirname, '../../config/prompt-presets.json'), path.join(temp, 'config/prompt-presets.json'));
  // Set paths before loading any store; never load the checkout's settings or .env.
  const { PATHS } = require('../../lib/config');
  for (const key of ['root', 'assetsDir', 'projectsDir', 'publicRefsDir', 'configFile', 'envFile']) {
    PATHS[key] = key === 'root' ? temp : path.join(temp, key);
  }
  for (const name of Object.keys(process.env)) {
    if (!['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'CI', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'].includes(name) && !name.startsWith('OCD_TEST_')) delete process.env[name];
  }
  const originalFetch = global.fetch;
  global.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname !== '127.0.0.1') throw new Error(`External request forbidden in browser fixture: ${url.origin}`);
    return originalFetch(input, options);
  };
  const express = require('express');
  const { createRegistry } = require('../../lib/nodes/registry');
  const { createEventBus } = require('../../lib/nodes/events');
  const { createWorkflowsStore } = require('../../lib/nodes/workflows-store');
  const { createEngine } = require('../../lib/nodes/engine');
  const { registerNodeRoutes } = require('../../lib/nodes/routes');
  const { textValue } = require('../../lib/nodes/types');
  const registry = createRegistry();
  require('../../lib/nodes/nodes-basic').registerAll(registry);
  const calls = [];
  const workflowIds = [];
  const gates = new Map();
  registry.register({ type: 'test.preview', category: 'text', label: 'Local preview',
    inputs: [{ id: 'in', type: 'text' }], outputs: [{ id: 'out', type: 'text' }, { id: 'switches', type: 'text' }],
    params: [{ id: 'choice', kind: 'marks', items: 'in', source: 'switches', default: {}, options: ['auto', 'on', 'off'] }],
    execute: async (_ctx, inputs) => {
      calls.push('preview');
      return { variants: [{ out: textValue(inputs.in?.value || 'Preview'), switches: textValue(JSON.stringify({ base: 'fixture-v1', unit: { usd: 0 }, items: [{ id: 'p0', label: 'First image', auto: true, on: true }] })) }], cost: { usd: 1.25, credits: 0 } };
    } });
  registry.register({ type: 'test.gate', category: 'text', label: 'Local controlled step',
    inputs: [{ id: 'in', type: 'text' }], outputs: [{ id: 'out', type: 'text' }],
    params: [{ id: 'key', kind: 'text', default: 'gate' }],
    execute: async (ctx, inputs, params) => {
      calls.push(params.key);
      await new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
        ctx.signal.addEventListener('abort', abort, { once: true });
        gates.set(params.key, { finish(error) {
          ctx.signal.removeEventListener('abort', abort);
          if (error) reject(new Error(error)); else resolve();
        } });
        if (ctx.signal.aborted) abort();
      });
      return { variants: [{ out: textValue(inputs.in?.value || 'Finished') }] };
    } });
  registry.register({ type: 'test.after', category: 'text', label: 'Following step',
    inputs: [{ id: 'in', type: 'text' }], outputs: [{ id: 'out', type: 'text' }],
    execute: async (_ctx, inputs) => { calls.push('after'); return { variants: [{ out: inputs.in }] }; } });
  const events = createEventBus();
  const store = createWorkflowsStore({ dir: path.join(temp, 'workflows'), registry, events });
  const engine = createEngine({ store, registry, events, getConfig: () => ({}) });
  const app = express();
  app.use(express.json());
  const streams = new Set();
  app.use((req, res, next) => {
    if (/\/events$/.test(req.path)) { streams.add(res); res.on('close', () => streams.delete(res)); }
    next();
  });
  registerNodeRoutes(app, { store, registry, events, engine, listTemplates: () => [], pingMs: 100 });
  // Real shell routes/static files, without startServer's discovery, pollers or render queues.
  app.use(require('../../server').app);
  const server = listen ? app.listen(0, '127.0.0.1') : null;
  try { if (server) await once(server, 'listening'); }
  catch (error) { global.fetch = originalFetch; throw error; }
  const url = server ? `http://127.0.0.1:${server.address().port}` : null;
  const node = (id, type, params = {}) => ({ id, type, typeVersion: 1, x: 0, y: 0, params });
  const edge = (from, port, to, input = 'in') => ({ id: `${from}-${to}`, from: { node: from, port }, to: { node: to, port: input } });
  async function workflow({ approval = false, uploads = false, key = 'gate' } = {}) {
    const nodes = [node('brief', 'input.text', { text: 'Initial brief' }), node('preview', 'test.preview'), node('gate', 'test.gate', { key }), node('after', 'test.after'), node('preview-out', 'output.result'), node('final', 'output.result')];
    if (uploads) nodes.push(node('photo', 'input.image'), node('audio', 'input.audio'));
    const result = await store.createWorkflow({ name: 'Browser fixture',
      graph: { nodes, edges: [edge('brief', 'text', 'preview'), edge('preview', 'out', 'gate'), edge('gate', 'out', 'after'), edge('preview', 'out', 'preview-out', 'inputs'), edge('after', 'out', 'final', 'inputs')] },
      app: { enabled: true, inputs: [{ node: 'brief', param: 'text', label: 'Brief' }, ...(uploads ? [{ node: 'photo', param: 'asset', label: 'Photo', optional: true }, { node: 'audio', param: 'asset', label: 'Audio', optional: true }] : [])],
        outputs: [...(approval ? [{ node: 'preview-out', approve: true, switches: { node: 'preview', param: 'choice' } }] : []), { node: 'final' }] } });
    workflowIds.push(result.workflow.id);
    return result.workflow.id;
  }
  return { url, store, engine, events, calls, gates, workflow, streams,
    async close() {
      const finishing = [];
      for (const id of workflowIds) {
        const active = engine.activeRun(id);
        if (active) { engine.cancel(id, active.runId); finishing.push(engine.whenFinished(id, active.runId)); }
      }
      await Promise.all(finishing);
      for (const stream of streams) stream.destroy();
      if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      global.fetch = originalFetch;
    } };
}
module.exports = { createFixture };
