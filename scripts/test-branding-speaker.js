'use strict';

// The speaker voice of a branding and where it goes (WP38f):
//   - lib/brandings.js: the optional field speaker { voiceId, name } (saved, checked, removed with null, old brandings stay valid), the
//     list and the Markdown summary; the brand profile of input.branding and the Markdown of a branding WITHOUT a speaker stay byte for
//     byte as they were (the keys of every explainer video depend on the profile)
//   - PATCH /api/brandings/:id (admins only, only the field speaker), the schema of update_branding, the interview text
//   - input.branding: the third output voice (with and without a speaker voice, without a branding); an empty output blocks nothing
//   - explainer.voice and audio.tts: the connected voice replaces the parameter, an empty input falls back to it, a restricted account
//     may only use library voices (parameter and a log line otherwise); the cache keys of nodes without the connection are unchanged
//   - the three explainer video templates: voice of the branding wired to every voice node, the texts in de, en and es
// A private copy of the app runs in a temp directory. Nothing is paid and nothing leaves the machine.

const assert = require('assert/strict');
const crypto = require('crypto');

const { createIsolatedApp } = require('./support/isolated-app');

const ADMIN = 'admin@example.com';
const STAFF = 'staff1@staff.example.com';
const GUEST = 'guest1@gmail.example';

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
const errorOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
};

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
  const iso = await createIsolatedApp({
    env: { ADMIN_EMAILS: ADMIN, SUPERADMIN_EMAILS: '', INTERNAL_EMAIL_DOMAINS: 'staff.example.com', OPENROUTER_API_KEY: '', GTS_API_TOKEN: '', PUBLIC_BASE_URL: '' }
  });
  await iso.listen();
  try {
    await run(iso);
  } finally {
    restoreAll();
    global.fetch = realFetch;
    await iso.cleanup();
  }
  assert.deepEqual(attempts, [], 'no request left the machine');
  console.log('test-branding-speaker.js: ok');
}

async function run(iso) {
  const brandings = iso.load('lib/brandings');
  const store = iso.load('lib/store');
  const assets = iso.load('lib/nodes/assets');
  const elevenlabs = iso.load('lib/elevenlabs');
  const tools = iso.load('lib/tools');
  const engine = iso.load('lib/nodes/engine');
  const { registry: real } = iso.load('lib/nodes/registry');
  const explainerNodes = iso.load('lib/nodes/nodes-explainer');
  const { textValue } = iso.load('lib/nodes/types');

  /* ---------- the field ---------- */

  const plain = await brandings.createBranding({ name: 'Plain', description: 'no voice' });
  assert.equal('speaker' in plain, false, 'a new branding has no speaker field');
  await brandings.updateBranding(plain.id, { colors: [{ role: 'primary', name: 'Ocean', hex: '#0055AA', usage: '' }], voice: { tone: 'warm', language: 'de', dos: 'short', donts: 'jargon' }, guidelines: 'Rule.' });
  const summaryBefore = await brandings.brandingSummary(plain.id);
  assert.ok(!summaryBefore.includes('Sprecherstimme'), 'no speaker, no section');

  // an old file (written before the field existed) is valid as it is
  assert.equal(brandings.normaliseSpeaker(undefined), null);
  assert.equal(brandings.normaliseSpeaker(null), null);
  assert.equal(brandings.normaliseSpeaker({ voiceId: '' }), null, 'an empty voice id means no voice');
  assert.deepEqual(brandings.normaliseSpeaker({ voiceId: ' abc_DEF-123 ', name: '  Anna   Muster ' }), { voiceId: 'abc_DEF-123', name: 'Anna Muster' });
  assert.deepEqual(brandings.normaliseSpeaker({ voiceId: 'v1' }), { voiceId: 'v1', name: '' });

  const saved = await brandings.updateBranding(plain.id, { speaker: { voiceId: ' voice-1 ', name: ' Anna ' } });
  assert.deepEqual(saved.speaker, { voiceId: 'voice-1', name: 'Anna' });
  assert.deepEqual((await brandings.readBranding(plain.id)).speaker, { voiceId: 'voice-1', name: 'Anna' }, 'it is on the disk');
  assert.deepEqual((await brandings.listBrandings()).find((item) => item.id === plain.id).speaker, { voiceId: 'voice-1', name: 'Anna' });
  const summaryWith = await brandings.brandingSummary(plain.id);
  assert.match(summaryWith, /## Sprecherstimme\n- Stimme: Anna \(ElevenLabs-Voice-ID `voice-1`\)/);
  // other changes keep it
  assert.deepEqual((await brandings.updateBranding(plain.id, { description: 'changed' })).speaker, { voiceId: 'voice-1', name: 'Anna' });
  // wrong shapes are refused and leave the file as it was
  for (const bad of ['voice-1', 5, ['v'], { voiceId: 5 }, { voiceId: 'has space' }, { voiceId: 'a/b' }, { voiceId: 'x'.repeat(101) }, { voiceId: 'v', name: 5 }, { voiceId: 'v', extra: 1 }, { voiceId: 'v', name: 'n'.repeat(201) }]) {
    const err = await errorOf(brandings.updateBranding(plain.id, { speaker: bad }));
    assert.ok(err, `refused: ${JSON.stringify(bad)}`);
  }
  assert.deepEqual((await brandings.readBranding(plain.id)).speaker, { voiceId: 'voice-1', name: 'Anna' });
  // null removes the field: the branding is the plain old shape again, and so is its Markdown
  await brandings.updateBranding(plain.id, { speaker: null });
  assert.equal('speaker' in (await brandings.readBranding(plain.id)), false);
  assert.equal('speaker' in (await brandings.listBrandings()).find((item) => item.id === plain.id), false);
  assert.equal((await brandings.brandingSummary(plain.id)).replace(/changed/, 'no voice'), summaryBefore, 'the Markdown without a speaker is byte for byte the old one');

  /* ---------- the profile of input.branding stays as it was ---------- */

  const profileSample = {
    id: 'abc-123', name: 'Acme', description: 'A brand', colors: [{ role: 'primary', name: 'Ocean', hex: '#0055AA', usage: 'headlines' }],
    typography: [{ role: 'headline', family: 'Inter', weights: '700', source: 'upload', usage: 'titles', file: 'assets/inter.woff2' }],
    logos: [{ variant: 'main', file: 'assets/logo.png', usage: 'screen' }], imagery: { style: 'calm', references: [] },
    voice: { tone: 'warm', language: 'de', dos: 'short', donts: 'jargon' }, motion: { outro: null, notes: 'slow' }, sound: [], formats: [], guidelines: 'Rule.'
  };
  const profileText = JSON.stringify(explainerNodes.brandProfile(profileSample), null, 2);
  // measured with the code before WP38f: this is the text that the keys of the planner and of every scene are made of
  assert.equal(crypto.createHash('sha256').update(profileText).digest('hex'), 'a6be0571b59722b83b0cb9b053902303e72d4bc84e3ecc37be3990be0c83b2be');
  assert.equal(JSON.stringify(explainerNodes.brandProfile({ ...profileSample, speaker: { voiceId: 'v1', name: 'Anna' } }), null, 2), profileText, 'a speaker voice is not part of the profile');

  /* ---------- PATCH /api/brandings/:id ---------- */

  {
    const url = `/api/brandings/${plain.id}`;
    assert.equal((await iso.request(url, { method: 'PATCH', as: STAFF, json: { speaker: null } })).status, 403, 'admins only');
    const set = await iso.request(url, { method: 'PATCH', as: ADMIN, json: { speaker: { voiceId: 'voice-2', name: 'Ben' } } });
    assert.equal(set.status, 200, set.text);
    assert.deepEqual(set.body.speaker, { voiceId: 'voice-2', name: 'Ben' });
    assert.equal((await iso.request(url, { method: 'PATCH', as: ADMIN, json: { speaker: { voiceId: 'bad id' } } })).status, 400);
    assert.equal((await iso.request(url, { method: 'PATCH', as: ADMIN, json: { name: 'x' } })).status, 400, 'only the speaker field');
    assert.equal((await iso.request(url, { method: 'PATCH', as: ADMIN, json: { speaker: null, name: 'x' } })).status, 400);
    assert.equal((await iso.request('/api/brandings/nope-1', { method: 'PATCH', as: ADMIN, json: { speaker: null } })).status, 404);
    assert.equal((await iso.request('/api/brandings/a..b', { method: 'PATCH', as: ADMIN, json: { speaker: null } })).status, 400);
    const cleared = await iso.request(url, { method: 'PATCH', as: ADMIN, json: { speaker: null } });
    assert.equal(cleared.status, 200);
    assert.equal('speaker' in cleared.body, false);
    assert.equal((await iso.request(`/api/brandings/${plain.id}`, { as: ADMIN })).body.name, 'Plain', 'nothing else changed');
  }

  /* ---------- the Director: tool schema and interview ---------- */

  {
    const update = tools.toolDefinitions().find((definition) => definition.function.name === 'update_branding');
    const speaker = update.function.parameters.properties.patch.properties.speaker;
    assert.ok(speaker, 'update_branding takes a speaker');
    assert.deepEqual(speaker.anyOf.map((entry) => entry.type), ['object', 'null']);
    assert.deepEqual(speaker.anyOf[0].required, ['voiceId']);
    const brain = require('fs').readFileSync(require('path').join(iso.root, 'lib', 'brain.js'), 'utf8');
    assert.match(brain, /Sprecherstimme/);
    assert.match(brain, /Einverstaendnis der Person/);
  }

  /* ---------- input.branding: the output voice ---------- */

  const sessionId = (await store.createSession()).id;
  function makeCtx({ user = STAFF } = {}) {
    const controller = new AbortController();
    const logs = [];
    const config = { defaultBrain: 'vendor/default-brain', brainModels: ['vendor/default-brain'], imageModel: 'openai/gpt-image-2' };
    return {
      workflowId: 'wf-test', runId: 'r-test', nodeId: 'n1', sessionId, user, config, signal: controller.signal,
      toolCtx: { nodeView: true, sessionId, config, user, emit() {}, signal: controller.signal },
      log: (line) => logs.push(line),
      saveOutputFile: (options) => assets.saveOutputFile(sessionId, options),
      withLocalSlot: (fn) => fn(),
      logs
    };
  }
  const exec = (type, ctx, inputs, raw = {}) => {
    const def = real.get(type);
    return def.execute(ctx, inputs, real.normalizeParams(def, raw));
  };
  const brandingDef = real.get('input.branding');
  assert.deepEqual(brandingDef.outputs.map((port) => [port.id, port.type]), [['brand', 'text'], ['logo', 'image'], ['voice', 'text']]);
  {
    const voiced = await brandings.createBranding({ name: 'Voiced' });
    await brandings.updateBranding(voiced.id, { speaker: { voiceId: 'voice-9', name: 'Clara' } });
    const withCtx = makeCtx();
    const result = await exec('input.branding', withCtx, {}, { branding: voiced.id });
    assert.deepEqual(result.variants[0].voice, textValue('voice-9'));
    assert.ok(withCtx.logs.some((line) => /Speaker voice of the branding: Clara/.test(line)));
    // the profile text of the same branding without the voice is the same text
    await brandings.updateBranding(voiced.id, { speaker: null });
    const without = await exec('input.branding', makeCtx(), {}, { branding: voiced.id });
    assert.equal(without.variants[0].voice, undefined, 'a branding without a speaker voice leaves the output empty');
    assert.equal(without.variants[0].brand.value, result.variants[0].brand.value, 'the profile is the same with and without');
    // no branding: no voice either
    const none = await exec('input.branding', makeCtx(), {}, {});
    assert.equal(none.variants[0].voice, undefined);
    assert.deepEqual(brandingDef.emptyOutputs({ branding: '' }), ['logo', 'voice']);
    assert.deepEqual(brandingDef.emptyOutputs({ branding: voiced.id }), []);
  }

  /* ---------- an empty output blocks nothing ---------- */

  {
    const node = (id, type, params = {}) => ({ id, type, typeVersion: 1, x: 0, y: 0, params });
    const edge = (id, from, fromPort, to, toPort) => ({ id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
    const graph = (branding) => ({
      nodes: [node('b', 'input.branding', { branding }), node('t', 'input.text', { text: 'Hallo' }), node('s', 'audio.tts', { text: '' })],
      edges: [edge('e1', 'b', 'voice', 's', 'voice'), edge('e2', 't', 'text', 's', 'text')]
    });
    for (const branding of ['', 'some-branding']) {
      const issues = engine.validateGraph({ graph: graph(branding) }, real, null);
      assert.deepEqual(issues.filter((issue) => issue.nodeId === 's' && /voice/.test(`${issue.port}${issue.code}`)), [], `no issue about the empty voice (branding "${branding}")`);
    }
    const ttsDef = real.get('audio.tts');
    const params = real.normalizeParams(ttsDef, {});
    const ports = real.portsFor(ttsDef, params);
    const edges = [edge('e1', 'b', 'voice', 's', 'voice'), edge('e2', 't', 'text', 's', 'text')];
    const resolved = engine.resolveNodeInputs({
      node: { id: 's' }, ports, params, edges, maxListItems: 50,
      outputsOf: (id) => (id === 'b' ? { brand: textValue('{}') } : { text: textValue('Hallo') })
    });
    assert.deepEqual(Object.keys(resolved.inputs), ['text'], 'the empty voice is an input without a value, the node runs');
  }

  /* ---------- the keys of nodes without the connection ---------- */

  {
    const keyOf = (type, inputs) => {
      const def = real.get(type);
      const params = real.normalizeParams(def, {});
      const edges = Object.keys(inputs).map((id) => ({ from: { node: 'u', port: id }, to: { node: 'n', port: id } }));
      const resolved = engine.resolveNodeInputs({ node: { id: 'n' }, ports: real.portsFor(def, params), params, edges, outputsOf: () => inputs, maxListItems: 50 });
      assert.equal('voice' in resolved.inputs, false, `${type}: nothing is taken from the parameter for the input voice`);
      return engine.computeCacheKey(def, params, resolved.inputs);
    };
    // measured with the code before WP38f
    assert.equal(keyOf('explainer.voice', { narration: textValue('Hallo Welt.') }), 'sha256:e9a32c9a51296d58991a23d750a70d39e706827fe0f9737c7ab0a27848cfa20b');
    assert.equal(keyOf('audio.tts', { text: textValue('Hallo Welt.') }), 'sha256:41c0002e34b949c35a9a7ea0121bf807a965bc97f1aa22d9f194a2614f10d06f');
    // connected: the voice is part of the key (another voice is another recording)
    const def = real.get('explainer.voice');
    const params = real.normalizeParams(def, {});
    assert.notEqual(engine.computeCacheKey(def, params, { narration: textValue('Hallo Welt.'), voice: textValue('v1') }), engine.computeCacheKey(def, params, { narration: textValue('Hallo Welt.') }));
    assert.notEqual(engine.computeCacheKey(def, params, { narration: textValue('Hallo Welt.'), voice: textValue('v1') }), engine.computeCacheKey(def, params, { narration: textValue('Hallo Welt.'), voice: textValue('v2') }));
  }

  /* ---------- the speech nodes ---------- */

  {
    const spoken = [];
    patch(elevenlabs, 'hasKey', () => true);
    patch(elevenlabs, 'listVoices', async () => [
      { voice_id: 'lib-voice', name: 'Library', category: 'premade' },
      { voice_id: 'clone-voice', name: 'Clone', category: 'cloned' }
    ]);
    const realExecute = tools.executeTool;
    patch(tools, 'executeTool', async (ctx, name, args) => {
      if (name !== 'generate_speech' && name !== 'generate_speech_timed') return realExecute(ctx, name, args);
      spoken.push({ name, voice: args.voice_id });
      const saved = await store.saveAsset(sessionId, { kind: 'audio', buffer: Buffer.from('RIFF'), ext: '.mp3', prompt: 'fake' });
      return { asset: { id: saved.id, cost: 0 }, alignment: null, contextDropped: false };
    });
    const speak = async (type, user, inputs, params) => {
      spoken.length = 0;
      const ctx = makeCtx({ user });
      const base = type === 'audio.tts' ? { text: textValue('Hallo Welt.') } : { narration: textValue('Hallo Welt.') };
      await exec(type, ctx, { ...base, ...inputs }, params).catch((err) => {
        // the audio of the fake has no length: the explainer node ends after the call, which is all that is looked at here
        if (!/audio|length|ffprobe|ffmpeg/i.test(err.message)) throw err;
      });
      return { voice: spoken[0] && spoken[0].voice, logs: ctx.logs };
    };
    for (const type of ['audio.tts', 'explainer.voice']) {
      // the parameter alone
      assert.equal((await speak(type, STAFF, {}, { voice_id: 'own-voice' })).voice, 'own-voice', `${type}: the parameter`);
      assert.equal((await speak(type, STAFF, {}, {})).voice, tools.DEFAULT_ELEVENLABS_VOICE_ID, `${type}: the default voice`);
      // the input replaces the parameter
      const replaced = await speak(type, STAFF, { voice: textValue(' clone-voice ') }, { voice_id: 'own-voice' });
      assert.equal(replaced.voice, 'clone-voice', `${type}: the connected voice`);
      assert.ok(replaced.logs.some((line) => /Voice from the input/.test(line)));
      // an empty or blank input falls back to the parameter
      assert.equal((await speak(type, STAFF, { voice: textValue('   ') }, { voice_id: 'own-voice' })).voice, 'own-voice', `${type}: a blank input`);
      assert.equal((await speak(type, STAFF, { voice: undefined }, { voice_id: 'own-voice' })).voice, 'own-voice', `${type}: no input`);
      // a restricted account: a library voice is fine, a cloned one is not used (the parameter counts, a line says so)
      assert.equal((await speak(type, GUEST, { voice: textValue('lib-voice') }, { voice_id: 'lib-voice' })).voice, 'lib-voice');
      const okLib = await speak(type, GUEST, { voice: textValue('lib-voice') }, { voice_id: tools.DEFAULT_ELEVENLABS_VOICE_ID });
      assert.equal(okLib.voice, 'lib-voice', `${type}: a library voice at the input of a guest`);
      const refused = await speak(type, GUEST, { voice: textValue('clone-voice') }, { voice_id: tools.DEFAULT_ELEVENLABS_VOICE_ID });
      assert.equal(refused.voice, tools.DEFAULT_ELEVENLABS_VOICE_ID, `${type}: a cloned voice at the input of a guest is not used`);
      assert.ok(refused.logs.some((line) => /not one of the library voices/.test(line)), `${type}: the log says so`);
      // the list cannot be read: not used either
      patch(elevenlabs, 'listVoices', async () => {
        throw new Error('down');
      });
      const unreadable = await speak(type, GUEST, { voice: textValue('lib-voice') }, { voice_id: tools.DEFAULT_ELEVENLABS_VOICE_ID });
      assert.equal(unreadable.voice, tools.DEFAULT_ELEVENLABS_VOICE_ID);
      restorers.pop()();
    }
    // the default voice of the app is allowed at the input without a look at the list
    assert.equal((await speak('audio.tts', GUEST, { voice: textValue(tools.DEFAULT_ELEVENLABS_VOICE_ID) }, { voice_id: 'x' })).voice, tools.DEFAULT_ELEVENLABS_VOICE_ID);
    // the ports
    assert.deepEqual(real.get('audio.tts').inputs.map((port) => [port.id, port.type, Boolean(port.required), port.param || null]), [['text', 'text', true, 'text'], ['voice', 'text', false, null]]);
    assert.deepEqual(real.get('explainer.voice').inputs.map((port) => port.id), ['narration', 'context', 'voice']);
  }

  /* ---------- the templates ---------- */

  {
    const templates = iso.load('lib/nodes/templates');
    const WIRING = { 'explainer-video': ['n5'], 'explainer-video-topic': ['n5'], 'explainer-video-presenter': ['n5', 'n12'] };
    for (const [id, voices] of Object.entries(WIRING)) {
      const documentEn = await templates.resolveTemplate(id, { lang: 'en' });
      const edges = documentEn.graph.edges.filter((entry) => entry.from.node === 'n3' && entry.from.port === 'voice');
      assert.deepEqual(edges.map((entry) => `${entry.to.node}.${entry.to.port}`).sort(), voices.map((voice) => `${voice}.voice`).sort(), `${id}: the voice of the branding goes to every voice node`);
      const types = Object.fromEntries(documentEn.graph.nodes.map((entry) => [entry.id, entry.type]));
      assert.equal(types.n3, 'input.branding');
      for (const voice of voices) assert.equal(types[voice], 'explainer.voice');
      assert.match(documentEn.description, /The voice comes from the branding if it has a speaker voice; otherwise the voice chosen in the node applies\./);
      assert.ok(documentEn.graph.notes.some((note) => /The voice comes from the branding if it has a speaker voice/.test(note.text)), `${id}: the note`);
      for (const [lang, pattern] of [['de', /Die Stimme kommt aus dem Branding, falls es eine Sprecherstimme hat; sonst gilt die Wahl im Node\./], ['es', /La voz viene del branding si este tiene una voz de locución; si no, vale la elección del nodo\./]]) {
        const document = await templates.resolveTemplate(id, { lang });
        assert.match(document.description, pattern, `${id} ${lang}: description`);
        assert.ok(document.graph.notes.some((note) => pattern.test(note.text)), `${id} ${lang}: note`);
      }
      const issues = engine.validateGraph({ graph: documentEn.graph }, real, null).filter((issue) => issue.level === 'error');
      assert.deepEqual(issues.filter((issue) => issue.port === 'voice'), [], `${id}: the connection is valid`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
