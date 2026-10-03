'use strict';

// The groundwork of the explainer video that sits below the nodes (WP37b):
//   - spokenWords / secondsFor (lib/explainer-plan.js): numbers, years, units and signs count as the words they are said in
//   - lib/elevenlabs.js: readAlignment, refusesContext and ttsWithTimestamps (the endpoint, the text around the scene, the second call
//     without it where the API refuses it, other errors are not answered with a second call, an answer without times)
//   - the tool generate_speech_timed (lib/tools.js): node view only, the same price and booking as generate_speech, the alignment comes back
//   - the option `history` of llm.completeText: the turns come after the first user message, only well-formed text turns count
// A private copy of the app runs in a temp directory; nothing is paid and nothing leaves the machine.

const assert = require('assert/strict');

const { createIsolatedApp } = require('./support/isolated-app');

const KEY = 'el-secret-key-0123456789';
const STAFF = 'staff1@staff.example.com';

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

function testSpokenWords(planLib) {
  const { spokenWords, secondsFor, wordsFor } = planLib;
  assert.equal(spokenWords(''), 0);
  assert.equal(spokenWords('   '), 0);
  assert.equal(spokenWords(undefined), 0);
  assert.equal(spokenWords('Der See ist gesunken.'), 4, 'written words count one each');
  // numbers are said in words: a year is four, 55 is three (fünfundfünfzig), 12 is one, 412 is two, 2500 is three
  assert.equal(spokenWords('2026'), 4, 'a year');
  assert.equal(spokenWords('55'), 3);
  assert.equal(spokenWords('12'), 1);
  assert.equal(spokenWords('412'), 2);
  assert.equal(spokenWords('2500'), 3);
  assert.equal(spokenWords('2.500'), 3, 'a point before three digits is a thousands mark');
  assert.equal(spokenWords("2'500"), 3, 'so is an apostrophe');
  assert.equal(spokenWords('2,5'), 3, 'zwei Komma fünf');
  assert.equal(spokenWords('1,62'), 4, 'eins Komma sechs zwei');
  // units, abbreviations and signs
  assert.equal(spokenWords('m³'), 2, 'Kubikmeter');
  assert.equal(spokenWords('KI'), 1);
  assert.equal(spokenWords('WHO'), 2, 'letter by letter');
  assert.equal(spokenWords('%'), 1);
  assert.equal(spokenWords('2020-2025'), 4 + 1 + 4, 'a dash between two numbers is "bis"');
  assert.equal(spokenWords('Heute -5 Grad'), 1 + 1 + 1 + 1, 'a minus sign before a number is "minus"');
  assert.equal(spokenWords('ein-und-aus'), 3, 'a hyphen between words is no word');
  // the sentence of the voice test (9 written words with two numbers: 14 spoken words) and the pace that follows
  assert.equal(spokenWords('Seit 2020 sank der Pegel um 55 Zentimeter tief.'), 14);
  assert.equal(secondsFor('Seit 2020 sank der Pegel um 55 Zentimeter tief.', 'de'), 6.2, '14 spoken words at 135 a minute; the voice needed 5.44 s: the pace is on the slow side, on purpose');
  assert.equal(secondsFor('one two three', 'en'), 1.2);
  assert.equal(secondsFor('', 'de'), 0);
  assert.ok(wordsFor(60, 'de') > 100 && wordsFor(60, 'de') < 220);
}

function testAlignment(elevenlabs) {
  const { readAlignment, refusesContext } = elevenlabs;
  assert.deepEqual(readAlignment({ characters: ['a', 'b'], character_start_times_seconds: [0, 0.1], character_end_times_seconds: [0.1, 0.2] }), { characters: ['a', 'b'], starts: [0, 0.1], ends: [0.1, 0.2] });
  assert.equal(readAlignment(null), null);
  assert.equal(readAlignment('x'), null);
  assert.equal(readAlignment({}), null);
  assert.equal(readAlignment({ characters: [], character_start_times_seconds: [], character_end_times_seconds: [] }), null, 'no characters');
  assert.equal(readAlignment({ characters: ['a'], character_start_times_seconds: [0, 1], character_end_times_seconds: [1] }), null, 'lists of different length');
  assert.equal(readAlignment({ characters: ['a'], character_start_times_seconds: [0] }), null, 'a list is missing');
  assert.deepEqual(readAlignment({ characters: [null, 5], character_start_times_seconds: ['0', 1], character_end_times_seconds: [1, 2] }).characters, ['', '5'], 'characters are text; numbers in strings are read');
  assert.equal(refusesContext({ status: 422, message: 'The fields previous_text and next_text are not supported' }), true);
  assert.equal(refusesContext({ status: 400, message: 'next text is not allowed for this model' }), true);
  assert.equal(refusesContext({ status: 422, message: 'The text is too short' }), false);
  assert.equal(refusesContext({ status: 401, message: 'previous_text' }), false, 'only 400 and 422');
  assert.equal(refusesContext(null), false);
  assert.equal(refusesContext(new Error('previous_text')), false, 'an error without a status');
}

async function main() {
  const attempts = [];
  const realFetch = global.fetch;
  const eleven = { calls: [], refuse: false, fail: null, noAlignment: false, silent: false };
  const respond = (status, body) => {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: new Map(), async text() { return text; }, async json() { return JSON.parse(text); } };
  };
  global.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (/^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/[^/]+\/with-timestamps/.test(url)) {
      const body = JSON.parse(init.body);
      eleven.calls.push({ url, body, key: init.headers['xi-api-key'] });
      if (eleven.fail) return respond(eleven.fail.status, eleven.fail.body);
      if (eleven.refuse && ('previous_text' in body || 'next_text' in body)) return respond(eleven.refuse.status || 422, eleven.refuse.body || { detail: { message: 'previous_text and next_text are not supported for this model' } });
      const characters = [...body.text];
      const alignment = {
        characters,
        character_start_times_seconds: characters.map((_c, index) => index * 0.05),
        character_end_times_seconds: characters.map((_c, index) => (index + 1) * 0.05)
      };
      return respond(200, {
        audio_base64: eleven.silent ? '' : Buffer.from('fake-mp3-bytes').toString('base64'),
        alignment: eleven.noAlignment ? null : alignment,
        normalized_alignment: eleven.noAlignment ? null : { ...alignment, characters: characters.map((char) => char.toUpperCase()) }
      });
    }
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
      attempts.push(url);
      return Promise.reject(new Error(`network access refused in the test: ${url}`));
    }
    return realFetch(input, init);
  };
  const iso = await createIsolatedApp({
    env: {
      ADMIN_EMAILS: 'admin@example.com',
      SUPERADMIN_EMAILS: '',
      INTERNAL_EMAIL_DOMAINS: 'staff.example.com',
      OPENROUTER_API_KEY: 'sk-or-v1-test-key-with-enough-length',
      ELEVENLABS_API_KEY: KEY,
      PUBLIC_BASE_URL: '',
      GTS_API_TOKEN: ''
    }
  });
  try {
    await run(iso, eleven);
  } finally {
    restoreAll();
    global.fetch = realFetch;
    await iso.cleanup();
  }
  assert.deepEqual(attempts, [], 'no request left the machine');
  console.log('test-explainer-voice-tool.js: ok');
}

async function run(iso, eleven) {
  const planLib = iso.load('lib/explainer-plan');
  const elevenlabs = iso.load('lib/elevenlabs');
  const tools = iso.load('lib/tools');
  const store = iso.load('lib/store');
  const costs = iso.load('lib/costs');
  const llm = iso.load('lib/nodes/llm');
  const or = iso.load('lib/openrouter');

  testSpokenWords(planLib);
  testAlignment(elevenlabs);

  /* ---------- ttsWithTimestamps ---------- */

  {
    eleven.calls.length = 0;
    const plain = await elevenlabs.ttsWithTimestamps({ text: 'Hallo Welt.', voiceId: 'v1', modelId: 'eleven_v4' });
    assert.equal(eleven.calls.length, 1);
    assert.match(eleven.calls[0].url, /\/v1\/text-to-speech\/v1\/with-timestamps\?output_format=mp3_44100_128$/);
    assert.equal(eleven.calls[0].key, KEY);
    assert.deepEqual(eleven.calls[0].body, { text: 'Hallo Welt.', model_id: 'eleven_v4' }, 'without a context no fields');
    assert.equal(plain.audio.toString(), 'fake-mp3-bytes');
    assert.deepEqual(plain.alignment.characters, [...'Hallo Welt.']);
    assert.equal(plain.alignment.ends.at(-1), 0.55);
    assert.deepEqual(plain.normalizedAlignment.characters, [...'HALLO WELT.'], 'the normalised text is its own alignment');
    assert.equal(plain.contextDropped, false);
    // a voice id is put into the path safely
    eleven.calls.length = 0;
    await elevenlabs.ttsWithTimestamps({ text: 'x', voiceId: 'a/b c', modelId: 'm' });
    assert.match(eleven.calls[0].url, /text-to-speech\/a%2Fb%20c\/with-timestamps/);
    // the text around the scene goes along, an empty side is left out
    eleven.calls.length = 0;
    await elevenlabs.ttsWithTimestamps({ text: 'x', voiceId: 'v', modelId: 'm', previousText: 'Davor.', nextText: '' });
    assert.deepEqual(eleven.calls[0].body, { text: 'x', model_id: 'm', previous_text: 'Davor.' });
    // refused: once more without it
    eleven.calls.length = 0;
    eleven.refuse = true;
    const dropped = await elevenlabs.ttsWithTimestamps({ text: 'x', voiceId: 'v', modelId: 'm', previousText: 'Davor.', nextText: 'Danach.' });
    assert.equal(eleven.calls.length, 2);
    assert.ok('previous_text' in eleven.calls[0].body && !('previous_text' in eleven.calls[1].body));
    assert.equal(dropped.contextDropped, true);
    assert.ok(dropped.audio.length > 0);
    eleven.refuse = false;
    // the API words the refusal as a rejected model (a 422 that names model_id, or a status unsupported_model): classify() turns it into
    // ELEVENLABS_MODEL_REJECTED with a message without the field names, but the call is still made once more without the fields
    for (const [name, refuse] of [
      ['422 unsupported_model', { status: 422, body: { detail: { status: 'unsupported_model', message: 'previous_text is not supported for model_id eleven_v3' } } }],
      ['422 naming model_id', { status: 422, body: { detail: [{ loc: ['body', 'previous_text'], msg: 'not allowed for model_id eleven_v3' }] } }],
      ['400 invalid_request', { status: 400, body: { detail: { status: 'invalid_request', message: 'next_text cannot be used with this model' } } }]
    ]) {
      eleven.calls.length = 0;
      eleven.refuse = refuse;
      const result = await elevenlabs.ttsWithTimestamps({ text: 'x', voiceId: 'v', modelId: 'eleven_v3', previousText: 'Davor.', nextText: 'Danach.' });
      assert.equal(eleven.calls.length, 2, `${name}: a second call without the fields`);
      assert.ok(!('previous_text' in eleven.calls[1].body) && !('next_text' in eleven.calls[1].body), `${name}: the second call has no context`);
      assert.equal(result.contextDropped, true, name);
      assert.ok(result.audio.length > 0, name);
    }
    // the error itself keeps what the API said (key scrubbed), so that the refusal can be read whatever class it got
    eleven.fail = { status: 422, body: { detail: { status: 'unsupported_model', message: `previous_text is not supported for model_id eleven_v3 (${KEY})` } } };
    eleven.calls.length = 0;
    const rejected = await errorOf(elevenlabs.ttsWithTimestamps({ text: 'x', voiceId: 'v', modelId: 'eleven_v3', previousText: 'Davor.' }));
    assert.equal(rejected.code, 'ELEVENLABS_MODEL_REJECTED');
    assert.ok(!/previous_text/.test(rejected.message), 'the message of the class has no field names');
    assert.ok(/previous_text/.test(rejected.apiMessage) && !rejected.apiMessage.includes(KEY));
    assert.equal(elevenlabs.refusesContext(rejected), true);
    assert.equal(eleven.calls.length, 2, 'a real refusal of the model is asked twice: with the fields and without, and then it is an error');
    eleven.fail = null;
    eleven.refuse = false;
    // other errors are not answered with a second call, and the key does not appear in the message
    for (const [status, body, withContext] of [[401, { detail: { message: 'Invalid API key' } }, true], [422, { detail: { message: 'The text is too short' } }, true], [500, { detail: { message: 'boom' } }, false]]) {
      eleven.calls.length = 0;
      eleven.fail = { status, body };
      const error = await errorOf(elevenlabs.ttsWithTimestamps({ text: 'x', voiceId: 'v', modelId: 'm', previousText: withContext ? 'Davor.' : '' }));
      assert.ok(error, `${status} is an error`);
      assert.equal(eleven.calls.length, 1, `${status}: no second call`);
      assert.ok(!String(error.message).includes(KEY));
    }
    eleven.fail = null;
    // a refusal without any context in the call is an error, too
    eleven.calls.length = 0;
    eleven.fail = { status: 422, body: { detail: { message: 'previous_text is not allowed' } } };
    assert.ok(await errorOf(elevenlabs.ttsWithTimestamps({ text: 'x', voiceId: 'v', modelId: 'm' })));
    assert.equal(eleven.calls.length, 1);
    eleven.fail = null;
    // an answer without times: the audio is there, the alignment is null
    eleven.noAlignment = true;
    const none = await elevenlabs.ttsWithTimestamps({ text: 'x', voiceId: 'v', modelId: 'm' });
    assert.equal(none.alignment, null);
    assert.equal(none.normalizedAlignment, null);
    assert.ok(none.audio.length > 0);
    eleven.noAlignment = false;
  }

  /* ---------- generate_speech_timed ---------- */

  {
    const journal = [];
    patch(costs, 'recordCost', async (entry) => {
      journal.push(entry);
      return entry;
    });
    const session = await store.createSession();
    const events = [];
    const toolCtx = { nodeView: true, sessionId: session.id, config: {}, user: STAFF, emit: (event) => events.push(event) };
    // the Director's tools do not list it, and a call without the node view is refused
    assert.ok(!tools.toolDefinitions().some((definition) => definition.function.name === 'generate_speech_timed'));
    eleven.calls.length = 0;
    const refused = await errorOf(tools.executeTool({ sessionId: session.id, config: {}, user: STAFF, emit: () => {} }, 'generate_speech_timed', { text: 'Hallo.' }));
    assert.match(refused.message, /nur in der Node-Ansicht/);
    assert.equal(eleven.calls.length, 0, 'nothing was sent');

    eleven.calls.length = 0;
    const result = await tools.executeTool(toolCtx, 'generate_speech_timed', { text: '  Hallo Welt.  ', previous_text: ' Davor. ', next_text: 5 });
    assert.deepEqual(eleven.calls[0].body, { text: 'Hallo Welt.', model_id: 'eleven_v4', previous_text: 'Davor.' }, 'the text is trimmed; a next_text that is not text is left out');
    assert.match(eleven.calls[0].url, new RegExp(`/text-to-speech/${tools.DEFAULT_ELEVENLABS_VOICE_ID}/with-timestamps`), 'the default voice');
    assert.equal(result.asset.kind, 'audio');
    assert.equal(result.alignment.characters.join(''), 'Hallo Welt.');
    assert.equal(result.contextDropped, false);
    assert.deepEqual(result.inject, []);
    assert.equal(events[0].type, 'tool_start');
    assert.equal(events[0].tool, 'generate_speech_timed');
    // the price and the booking are the ones of generate_speech
    const price = tools.speechEstimateUsd('Hallo Welt.', 'eleven_v4');
    assert.equal(tools.toolEstimateUsd('generate_speech_timed', { text: 'Hallo Welt.' }), price);
    assert.equal(tools.toolEstimateUsd('generate_speech_timed', { text: 'x'.repeat(1000), model_id: 'eleven_flash_v2_5' }), 0.04);
    assert.equal(journal.length, 1);
    assert.equal(journal[0].type, 'speech');
    assert.equal(journal[0].cost, price);
    assert.equal(journal[0].model, 'elevenlabs/eleven_v4');
    const spoken = (await store.readLedger(session.id)).find((entry) => entry.id === result.asset.id);
    assert.ok(spoken && spoken.cost === price && spoken.costEstimated === true);

    // the checks of the plain speech apply: no text, too long, a missing key
    for (const [args, pattern] of [[{ text: '   ' }, /text fehlt/], [{ text: 'x'.repeat(2501) }, /maximal 2500/], [{ text: 'x', model_id: ' ' }, /model_id darf nicht leer sein/], [{ text: 'x', voice_id: ' ' }, /voice_id darf nicht leer sein/]]) {
      const error = await errorOf(tools.executeTool(toolCtx, 'generate_speech_timed', args));
      assert.match(error.message, pattern);
    }
    // the refusal of the context is passed on to the caller, and booked once
    journal.length = 0;
    eleven.refuse = true;
    const again = await tools.executeTool(toolCtx, 'generate_speech_timed', { text: 'Satz.', previous_text: 'Davor.' });
    assert.equal(again.contextDropped, true);
    assert.equal(journal.length, 1, 'the call that was refused is not booked');
    eleven.refuse = false;
    // an empty audio file is an error and nothing is booked
    journal.length = 0;
    eleven.silent = true;
    const empty = await errorOf(tools.executeTool(toolCtx, 'generate_speech_timed', { text: 'Satz.' }));
    assert.match(empty.message, /leere Audio-Datei/);
    assert.equal(journal.length, 0);
    eleven.silent = false;
  }

  /* ---------- the history of completeText ---------- */

  {
    const sent = [];
    patch(or, 'postJson', async (route, payload) => {
      sent.push({ route, payload });
      return { choices: [{ message: { content: 'ok' } }], usage: { cost: 0.01 } };
    });
    patch(costs, 'recordCost', async (entry) => entry);
    const base = { model: 'vendor/some-model', system: 'SYSTEM', prompt: 'FIRST', sessionId: 'nodes', user: STAFF };
    await llm.completeText(base);
    assert.deepEqual(sent[0].payload.messages.map((message) => message.role), ['system', 'user'], 'no history: as before');
    sent.length = 0;
    await llm.completeText({
      ...base,
      history: [
        { role: 'assistant', content: 'answer so far' },
        { role: 'user', content: 'what is wrong' },
        { role: 'system', content: 'not allowed' },
        { role: 'assistant', content: '   ' },
        { role: 'user', content: 5 },
        null,
        'text'
      ]
    });
    const messages = sent[0].payload.messages;
    assert.deepEqual(messages.map((message) => message.role), ['system', 'user', 'assistant', 'user'], 'the turns follow the first user message, in order; malformed turns are dropped');
    assert.equal(messages[1].content, 'FIRST');
    assert.equal(messages[2].content, 'answer so far');
    assert.equal(messages[3].content, 'what is wrong');
    assert.deepEqual(Object.keys(messages[2]).sort(), ['content', 'role']);
    // not an array: no history
    sent.length = 0;
    await llm.completeText({ ...base, history: 'x' });
    assert.equal(sent[0].payload.messages.length, 2);
    // the first message carries the images, the history stays text
    sent.length = 0;
    const discovery = iso.load('lib/discovery');
    patch(discovery, 'brainSupportsImages', async () => true);
    await llm.completeText({ ...base, images: ['data:image/png;base64,AAAA'], history: [{ role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }] });
    const withImage = sent[0].payload.messages;
    assert.ok(Array.isArray(withImage[1].content), 'the first user message has the image parts');
    assert.equal(withImage[2].content, 'a');
    assert.equal(withImage[3].content, 'b');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
