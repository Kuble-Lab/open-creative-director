'use strict';
const assert = require('node:assert/strict');
const { createExecutors, definitions, runtimeText } = require('../lib/suno-agent');
(async () => {
  const a = { active: true, identified: true, email: 'a@example.com' };
  const b = { active: true, identified: true, email: 'b@example.com' };
  const session = {};
  const calls = [];
  const suno = {
    status: email => ({ connected: email === a.email }),
    mcpCall: async (email, name, args) => {
      calls.push({ email, name, args });
      return { structuredContent: name === 'audio-download' && !args.confirm ? { status: 'requires_credit' } : { status: 'complete', clip_ids: ['clip-a', 'clip-b'] } };
    }
  };
  const ex = createExecutors({ suno, sessions: { mutateSession: async (_id, fn) => fn(session) } });
  const ctx = { viewer: a, sessionId: 'session1', sunoTurnId: 'turn1', sunoUserText: 'Erstelle einen Song', emit() {} };
  await assert.rejects(ex.suno_status({ viewer: {} }), /Login/);
  assert.equal(JSON.parse((await ex.suno_status({ viewer: b })).toolResult).connected, false);
  assert.equal(calls.length, 0);
  await ex.suno_library(ctx, { query: 'jazz', owner: b.email });
  assert.equal(calls.at(-1).email, a.email);
  assert.equal(calls.at(-1).name, 'library-search');
  await assert.rejects(ex.suno_generate(ctx, { description: 'x', lyrics: 'y' }), /nicht beides/);
  await assert.rejects(ex.suno_generate({ viewer: a }, { description: 'x' }), /Chat/);
  const song = JSON.parse((await ex.suno_generate(ctx, { lyrics: 'Hallo Welt', style: 'pop' })).toolResult);
  assert.deepEqual(song.clip_ids, ['clip-a', 'clip-b']);
  const key = calls.at(-1).args.idempotency_key;
  await ex.suno_generate(ctx, { lyrics: 'Hallo Welt', style: 'pop' });
  assert.equal(calls.at(-1).args.idempotency_key, key);
  await ex.suno_generate({ ...ctx, viewer: b }, { lyrics: 'Hallo Welt', style: 'pop' });
  assert.notEqual(calls.at(-1).args.idempotency_key, key);
  await ex.suno_download(ctx, { id: 'clip-a' });
  const count = calls.length;
  await assert.rejects(ex.suno_download({ ...ctx, sunoUserText: 'ja' }, { id: 'clip-a', confirm: true }), /bestätigt/);
  await assert.rejects(ex.suno_download({ ...ctx, viewer: b, sunoTurnId: 'turn2', sunoPreviousTurnId: 'turn1', sunoUserText: 'ja' }, { id: 'clip-a', confirm: true }), /bestätigt/);
  const next = { ...ctx, sunoTurnId: 'turn2', sunoPreviousTurnId: 'turn1', sunoUserText: 'ja' };
  await assert.rejects(ex.suno_download({ ...next, sunoUserText: 'nein' }, { id: 'clip-a', confirm: true }), /bestätigt/);
  await assert.rejects(ex.suno_download(next, { id: 'clip-b', confirm: true }), /bestätigt/);
  await assert.rejects(ex.suno_download(next, { id: 'clip-a', format: 'wav', confirm: true }), /bestätigt/);
  assert.equal(calls.length, count, 'invalid approvals never reach provider');
  await ex.suno_download(next, { id: 'clip-a', confirm: true });
  assert.equal(calls.at(-1).args.confirm, true);
  await assert.rejects(ex.suno_download(next, { id: 'clip-a', confirm: true }), /bestätigt/);
  assert.match(runtimeText(a, { suno }), /connected to Suno/);
  assert.match(runtimeText(b, { suno, nodeAssistant: true }), /does not execute/);
  const facade = require('../lib/tools');
  assert.ok(facade.toolDefinitions(a).some(d => d.function.name === 'suno_generate'));
  assert.ok(!facade.toolDefinitions().some(d => d.function.name.startsWith('suno_')));
  const mcp = require('../lib/mcp/suno-tools').createSunoReadTools();
  assert.deepEqual(mcp.map(t => t.name), ['suno_status', 'suno_library', 'suno_audio']);
  assert.ok(mcp.every(t => t.right === 'read'));
  assert.equal(definitions.length, 5);
  console.log('test-suno-agent.js: ok');
})().catch(e => { console.error(e); process.exitCode = 1; });
