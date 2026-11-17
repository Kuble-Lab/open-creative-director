'use strict';
// The Suno song node: the pack parser, the mapping onto the live tool schema, the creation with polling and download, the guards
// against a second spend, and the node itself with a real session. Suno is mocked; no credits are used.
process.env.AUTH_WHOAMI_URL = 'http://127.0.0.1:9/whoami'; // a personal login is active: Suno has no anonymous mode
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const song = require('../lib/suno-song');

const PACK = 'Here is the pack.\n\nTITLE\nPatch Before Midnight\n\nSTYLE\nDark electropop,\n124 BPM\n\nEXCLUDE\nrap, country\n\nLYRICS\n```\n[Verse 1]\nOctober twenty\n\n[Chorus]\n(Patch before midnight)\n```\n';
const OWNER = 'a@example.com';
const SCHEMA = { type: 'object', properties: { lyrics: {}, style: {}, title: {}, negative_tags: {}, idempotency_key: {}, description: {} } };

function mockSuno({ tools = [{ name: 'audio-create', inputSchema: SCHEMA }, { name: 'audio-retrieve', inputSchema: {} }, { name: 'audio-download', inputSchema: {} }],
  connected = true, pendingPolls = 1, clipUrl = true, credit = false, listFails = false, confirmFails = 0 } = {}) {
  const calls = [];
  const polls = new Map();
  return {
    calls,
    status: () => ({ connected }),
    mcpTools: async () => { if (listFails) throw new Error('no list'); return tools; },
    mcpCall: async (owner, name, args) => {
      calls.push({ owner, name, args });
      if (name === 'audio-create') return { structuredContent: { status: 'submitted', clip_ids: ['clip-a', 'clip-b'] } };
      if (name === 'audio-retrieve') {
        const seen = polls.get(args.id) || 0;
        polls.set(args.id, seen + 1);
        if (seen < pendingPolls) return { content: [{ type: 'text', text: JSON.stringify({ id: args.id, status: 'processing' }) }] };
        return { structuredContent: { id: args.id, status: 'complete', title: 'Patch', song_url: `https://suno.com/song/${args.id}`, ...(clipUrl ? { audio_url: `https://cdn1.suno.ai/${args.id}.mp3` } : {}) } };
      }
      if (name === 'audio-download') {
        if (credit && !args.confirm) return { structuredContent: { status: 'requires_credit' } };
        if (args.confirm && confirmFails-- > 0) throw Object.assign(new Error('Suno konnte diese Anfrage nicht ausführen.'), { status: 502, detail: 'not ready' });
        return { structuredContent: { status: 'complete', download_url: `https://cdn1.suno.ai/dl/${args.id}.mp3` } };
      }
      throw new Error(`unexpected tool ${name}`);
    }
  };
}
const fast = { sleep: async () => {}, pollMs: 1 };

(async () => {
  // --- the pack ---
  const pack = song.parsePack(PACK);
  assert.deepEqual(pack, { title: 'Patch Before Midnight', style: 'Dark electropop, 124 BPM', exclude: 'rap, country', lyrics: '[Verse 1]\nOctober twenty\n\n[Chorus]\n(Patch before midnight)' });
  assert.equal(song.parsePack('## TITLE\nA\n## STYLE: pop\n## LYRICS\nTitle\nla la').lyrics, 'Title\nla la', 'markdown headings; a lyric line is no heading');
  assert.equal(song.parsePack('LYRICS\nla\nSTYLE of the night\nla').lyrics, 'la\nSTYLE of the night\nla', 'a lyric line that starts with a block word stays a lyric line');
  assert.equal(song.parsePack('just words').lyrics, 'just words');
  assert.throws(() => song.checkPack(song.parsePack('TITLE\nA\nSTYLE\npop')), { code: 'SUNO_LYRICS_MISSING' });
  assert.throws(() => song.checkPack(song.parsePack('LYRICS\nla')), { code: 'SUNO_STYLE_MISSING' });
  assert.throws(() => song.checkPack({ ...pack, lyrics: 'x'.repeat(6001) }), { code: 'SUNO_FIELD_TOO_LONG' });

  // --- the arguments follow the live schema ---
  assert.deepEqual(song.createArguments(pack, SCHEMA, 'k').args, { lyrics: pack.lyrics, style: pack.style, title: pack.title, negative_tags: pack.exclude, idempotency_key: 'k' });
  const other = song.createArguments(pack, { properties: { prompt: {}, tags: {}, title: {} } }, 'k');
  assert.deepEqual(other.args, { prompt: pack.lyrics, tags: pack.style, title: pack.title });
  assert.deepEqual(other.dropped, ['exclude'], 'a field Suno does not know is left out and named');
  assert.deepEqual(song.createArguments(pack, null, 'k').args, { lyrics: pack.lyrics, style: pack.style, title: pack.title, idempotency_key: 'k' }, 'no tool list: the names of the chat tools, no exclude');
  assert.throws(() => song.createArguments(pack, { properties: { description: {} } }, 'k'), { code: 'SUNO_SCHEMA' });
  assert.throws(() => song.createArguments(pack, { properties: { lyrics: {}, style: {} }, required: ['voice_id'] }, 'k'), { code: 'SUNO_SCHEMA' });
  assert.deepEqual(song.clipIds({ clips: [{ id: 'a' }, { id: 'b' }] }), ['a', 'b']);
  assert.deepEqual(song.clipIds({ id: 'one' }), ['one']);
  assert.deepEqual(song.clipIds({ clip_ids: ['ok', 'not ok!'] }), ['ok']);
  assert.equal(song.audioUrl({ audio_url: 'http://cdn1.suno.ai/a.mp3' }), null, 'https only');
  assert.equal(song.stateOf({ status: 'streaming' }), 'pending');
  assert.notEqual(song.idempotencyKey(OWNER, ['a', '1']), song.idempotencyKey('b@example.com', ['a', '1']));

  // --- the creation ---
  let suno = mockSuno();
  const logs = [];
  let remembered = null;
  let songs = await song.createSong({ suno, owner: OWNER, pack, key: 'k1', log: (line) => logs.push(line), onClips: (ids) => { remembered = ids; }, ...fast });
  assert.deepEqual(songs.map((item) => [item.id, item.url]), [['clip-a', 'https://cdn1.suno.ai/clip-a.mp3'], ['clip-b', 'https://cdn1.suno.ai/clip-b.mp3']]);
  assert.deepEqual(remembered, ['clip-a', 'clip-b'], 'the ids are handed over before the waiting starts');
  assert.equal(suno.calls.filter((call) => call.name === 'audio-create').length, 1);
  assert.equal(suno.calls[0].args.negative_tags, 'rap, country');
  assert.ok(suno.calls.every((call) => call.owner === OWNER));
  assert.ok(!suno.calls.some((call) => call.name === 'audio-download'), 'a clip with a file needs no download call');
  assert.ok(logs.some((line) => /own Suno credits/.test(line)));

  suno = mockSuno();
  songs = await song.createSong({ suno, owner: OWNER, pack, key: 'k1', resume: ['clip-a', 'clip-b'], takes: 1, ...fast });
  assert.deepEqual(songs.map((item) => item.id), ['clip-a']);
  assert.ok(!suno.calls.some((call) => call.name === 'audio-create'), 'a remembered creation is never made again');

  suno = mockSuno({ connected: false });
  await assert.rejects(song.createSong({ suno, owner: OWNER, pack, key: 'k', ...fast }), { code: 'SUNO_NOT_CONNECTED' });
  assert.equal(suno.calls.length, 0);

  suno = mockSuno({ tools: [{ name: 'songs-make', inputSchema: {} }] });
  await assert.rejects(song.createSong({ suno, owner: OWNER, pack, key: 'k', ...fast }), { code: 'SUNO_SCHEMA' });
  assert.equal(suno.calls.length, 0, 'an unknown tool list spends nothing');

  suno = mockSuno({ listFails: true });
  await song.createSong({ suno, owner: OWNER, pack, key: 'k', ...fast });
  assert.ok(!('negative_tags' in suno.calls[0].args));

  suno = mockSuno({ clipUrl: false, credit: true });
  await assert.rejects(song.createSong({ suno, owner: OWNER, pack, key: 'k', ...fast }), { code: 'SUNO_DOWNLOAD_CREDIT' });
  assert.ok(!suno.calls.some((call) => call.args.confirm), 'no download credit without the switch');
  suno = mockSuno({ clipUrl: false, credit: true });
  songs = await song.createSong({ suno, owner: OWNER, pack, key: 'k', allowDownloadCredit: true, takes: 1, ...fast });
  assert.equal(songs[0].url, 'https://cdn1.suno.ai/dl/clip-a.mp3');
  assert.equal(suno.calls.filter((call) => call.args.confirm === true).length, 1);

  suno = mockSuno({ clipUrl: false, credit: true, confirmFails: 2 });
  songs = await song.createSong({ suno, owner: OWNER, pack, key: 'k', allowDownloadCredit: true, takes: 1, ...fast });
  assert.equal(songs[0].url, 'https://cdn1.suno.ai/dl/clip-a.mp3', 'a download that Suno still prepares is asked for again');
  assert.equal(suno.calls.filter((call) => call.name === 'audio-create').length, 1);
  suno = mockSuno({ clipUrl: false, credit: true, confirmFails: 3 });
  await assert.rejects(song.createSong({ suno, owner: OWNER, pack, key: 'k', allowDownloadCredit: true, takes: 1, ...fast }), /nicht ausführen/);

  suno = mockSuno({ pendingPolls: 1e9 });
  let clock = 0;
  await assert.rejects(song.createSong({ suno, owner: OWNER, pack, key: 'k', ...fast, now: () => (clock += 60000), timeoutMs: 180000 }), { code: 'SUNO_TIMEOUT' });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(song.createSong({ suno: mockSuno(), owner: OWNER, pack, key: 'k', signal: aborted.signal, resume: ['clip-a'], ...fast }), { code: 'SUNO_CANCELLED' });

  // --- the file ---
  const audio = (type = 'audio/mpeg', url) => async (target) => ({ ok: true, status: 200, url: url || target, headers: new Headers({ 'content-type': type }), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
  assert.equal((await song.fetchAudio('https://cdn1.suno.ai/a.mp3', { fetchImpl: audio() })).ext, '.mp3');
  assert.equal((await song.fetchAudio('https://cdn1.suno.ai/a.wav', { fetchImpl: audio('audio/wav') })).ext, '.wav');
  assert.equal((await song.fetchAudio('https://suno-data-uploads.s3.amazonaws.com/x/a.mp3?X-Amz-Signature=1', { fetchImpl: audio() })).ext, '.mp3', 'the bucket of the download links of Suno');
  await assert.rejects(song.fetchAudio('https://other-bucket.s3.amazonaws.com/a.mp3', { fetchImpl: audio() }), { code: 'SUNO_AUDIO_HOST' });
  await assert.rejects(song.fetchAudio('https://evil.example/a.mp3', { fetchImpl: audio() }), { code: 'SUNO_AUDIO_HOST' });
  await assert.rejects(song.fetchAudio('https://notsuno.ai/a.mp3', { fetchImpl: audio() }), { code: 'SUNO_AUDIO_HOST' });
  await assert.rejects(song.fetchAudio('https://cdn1.suno.ai/a.mp3', { fetchImpl: audio('audio/mpeg', 'https://evil.example/a.mp3') }), { code: 'SUNO_AUDIO_HOST' });
  await assert.rejects(song.fetchAudio('https://cdn1.suno.ai/a.mp3', { fetchImpl: audio('text/html') }), { code: 'SUNO_AUDIO_TYPE' });
  assert.equal((await song.fetchAudio('https://files.example.net/a.mp3', { fetchImpl: audio(), extraHosts: ['example.net'] })).ext, '.mp3');

  // --- the node, with a real session ---
  const registry = require('../lib/nodes/registry');
  const def = registry.defaultRegistry ? registry.defaultRegistry.get('suno.song') : null;
  const { createDefinition } = require('../lib/nodes/nodes-suno');
  {
    // the switch of the download credit is on by default and stands on the card of the node (decision of 2026-11-17)
    const credit = createDefinition().params.find((param) => param.id === 'allow_download_credit');
    assert.deepEqual([credit.kind, credit.default, credit.inline], ['boolean', true, true]);
  }
  if (def) {
    assert.equal(def.paid, false, 'Suno bills the person, not the app');
    assert.equal(registry.providerOf(def), 'suno');
  }
  const store = require('../lib/store');
  const session = await store.createSession({ title: 'Suno test' });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'suno-songs-'));
  suno = mockSuno();
  const node = createDefinition({ suno, directory, fetchImpl: audio(), ...fast });
  assert.equal(node.validate({ pack: '' }, {})[0].code, 'SUNO_PACK_MISSING');
  assert.equal(node.validate({ pack: 'TITLE\nA' }, {})[0].code, 'SUNO_LYRICS_MISSING');
  assert.deepEqual(node.validate({ pack: '' }, { pack: { connected: true } }), []);
  const user = OWNER;
  const ctx = { sessionId: session.id, user, signal: new AbortController().signal, log: () => {} };
  const params = { pack: '', takes: 2, version: 1, allow_download_credit: false };
  const access = require('../lib/access');
  if (access.viewerOf({ kubleUser: user }).identified) {
    const first = await node.execute(ctx, { pack: { value: PACK } }, params);
    assert.equal(first.variants.length, 2);
    assert.equal(first.variants[0].audio.type, 'audio');
    assert.equal(first.variants[0].lyrics.value, pack.lyrics);
    assert.ok(fs.existsSync(require('../lib/nodes/assets').assetFilePath(first.variants[0].audio)));
    await node.execute(ctx, { pack: { value: PACK } }, params);
    assert.equal(suno.calls.filter((call) => call.name === 'audio-create').length, 1, 'the same pack is one song: the second run picks it up');
    await node.execute(ctx, { pack: { value: PACK } }, { ...params, version: 2 });
    assert.equal(suno.calls.filter((call) => call.name === 'audio-create').length, 2, 'a new version is a new song');
    assert.notEqual(suno.calls.filter((call) => call.name === 'audio-create')[0].args.idempotency_key, suno.calls.filter((call) => call.name === 'audio-create')[1].args.idempotency_key);
    await assert.rejects(node.execute({ ...ctx, user: null }, { pack: { value: PACK } }, params), { code: 'SUNO_LOGIN' });
  } else {
    throw new Error('the test user is not identified: adapt the test to lib/access');
  }
  fs.rmSync(directory, { recursive: true, force: true });
  console.log('test-suno-song.js: ok');
})().catch((err) => { console.error(err); process.exitCode = 1; });
