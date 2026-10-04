'use strict';

// "Same as input" for the language of the research and of the explainer plan (WP38d): the nodes decide the language from the text
// they get (lib/language-detect.js, no model call) where the parameter language says "auto".
//   R   llm.research: the prompt and the sources line in the language of the topic, the log names language and source
//   P   explainer.plan: prompt, words per minute, target of words, the word for "page", the language in the script JSON (the real
//       code, never "auto"); what the person writes counts first (a German brief beats an English PDF); an edited script keeps its own
//   S   saved workflows keep their language and their cache key; new nodes (palette, assistant) start with auto, copies and templates
//       do not change; the label of the option is the same in the three languages
//   T   the five explainer templates start with auto and do not name a language of the interface any more
// The language model is replaced; nothing is paid and nothing leaves the machine (fetch guard).

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { createIsolatedApp } = require('./support/isolated-app');

const ROOT = path.resolve(__dirname, '..');
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

const GERMAN_BRIEF = 'Für den Gemeinderat, kurz und ohne Fachbegriffe, mit Beispielen aus der Schweiz.';
const ENGLISH_DOC = '=== D1: report.pdf (12 pages) ===\n[p. 1]\nThe heat pump takes the energy of the surroundings and turns it into heat.\n[p. 2]\nThe market is growing and the prices are falling.\n[p. 3]\nThe subsidy covers a part of the costs for the owners.';
const GERMAN_DOC = '=== D1: bericht.pdf (12 pages) ===\n[Seite 1]\nDie Wärmepumpe nutzt die Energie der Umgebung.\n[Seite 2]\nDer Markt wächst, und die Preise sinken.\n[Seite 3]\nDie Förderung deckt einen Teil der Kosten.';
const SPANISH_DOC = '=== D1: informe.pdf (12 pages) ===\n[p. 1]\nLa bomba de calor toma la energía del entorno.\n[p. 2]\nEl mercado crece y los precios bajan.\n[p. 3]\nLa ayuda cubre una parte de los costes.';

const VOCAB = ['Strom', 'Wärme', 'Pumpe', 'Kosten', 'Energie', 'Haus', 'Winter', 'Effizienz', 'Boden', 'Luft', 'Wasser', 'Förderung', 'Technik', 'Preis', 'Jahr', 'Markt'];
const narrationOf = (k, n) => Array.from({ length: n }, (_x, i) => `${VOCAB[(i + k) % VOCAB.length]}${k}`).join(' ') + '.';
function sceneOf(k, refs) {
  const narration = narrationOf(k, 22);
  const list = narration.replace(/\./g, '').split(' ');
  return {
    kind: 'motion',
    role: k === 1 ? 'hook' : k === 12 ? 'summary' : 'point',
    narration,
    on_screen: { title: `Titel ${k}`, bullets: [`Stichwort ${k}`], numbers: [], quote: null },
    elements: [{ type: 'title', content: `Titel ${k}`, anchor: list[0] }, { type: 'bullet', content: `Stichwort ${k}`, anchor: list[5] }],
    figure: null,
    image_prompt: null,
    clip_prompt: null,
    source_refs: refs || [`S. ${((k - 1) % 3) + 1}`]
  };
}
// refs: the numbered sources of research notes ("[1]"); without them the pages of a document
const planAnswer = (refs) => ({ title: 'Wärmepumpen', summary: 'Wie sie funktionieren', scenes: Array.from({ length: 12 }, (_x, i) => sceneOf(i + 1, refs)), presenter: null });

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
    env: {
      ADMIN_EMAILS: 'admin@example.com',
      SUPERADMIN_EMAILS: '',
      INTERNAL_EMAIL_DOMAINS: 'staff.example.com',
      OPENROUTER_API_KEY: 'sk-or-v1-test-key-with-enough-length',
      FAL_KEY: 'fal-test-key-with-enough-length',
      PUBLIC_BASE_URL: '',
      GTS_API_TOKEN: ''
    }
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
  console.log('test-explainer-language.js: ok');
}

async function run(iso) {
  const store = iso.load('lib/store');
  const assets = iso.load('lib/nodes/assets');
  const llm = iso.load('lib/nodes/llm');
  const or = iso.load('lib/openrouter');
  const fal = iso.load('lib/fal');
  const discovery = iso.load('lib/discovery');
  const costs = iso.load('lib/costs');
  const registryModule = iso.load('lib/nodes/registry');
  const engineLib = iso.load('lib/nodes/engine');
  const templates = iso.load('lib/nodes/templates');
  iso.load('lib/nodes/nodes-explainer');
  const { textValue } = iso.load('lib/nodes/types');
  const real = registryModule.registry;
  const graphLib = require('../public/nodes/graph');

  const session = await store.createSession();
  const sessionId = session.id;

  /* ---------- the model, replaced ---------- */

  const calls = [];
  const answers = { plan: [], research: [] };
  const kindOf = (system) => (/write the script of an explainer video/.test(system) ? 'plan' : /strict fact checker/.test(system) ? 'verify' : /careful research assistant/.test(system) ? 'research' : 'other');
  const realComplete = llm.completeText;
  llm.completeText = async (options) => {
    const kind = kindOf(options.system || '');
    calls.push({ kind, options });
    if (kind === 'research') {
      const next = answers.research.shift();
      return { text: next || 'Die Wärmepumpe [A](https://example.org/a).', usd: 0.05, citations: [{ url: 'https://example.org/a', title: 'A' }], citationSpans: [] };
    }
    return { text: JSON.stringify(planAnswer(/kind="research-notes"/.test(options.prompt || '') ? ['[1]'] : undefined)), usd: 0.3, citations: [], citationSpans: [] };
  };
  restorers.push(() => {
    llm.completeText = realComplete;
  });
  patch(costs, 'recordCost', async (entry) => entry);
  patch(discovery, 'brainSupportsFiles', async () => true);
  patch(or, 'hasKey', () => true);
  patch(fal, 'hasKey', () => true);

  function makeCtx() {
    const controller = new AbortController();
    const logs = [];
    const config = { defaultBrain: 'vendor/default-brain', brainModels: ['anthropic/claude-opus-5.5', 'vendor/default-brain'], imageModel: 'openai/gpt-image-2' };
    return {
      workflowId: 'wf-test',
      runId: 'r-test',
      nodeId: 'n1',
      sessionId,
      user: STAFF,
      config,
      signal: controller.signal,
      toolCtx: { nodeView: true, sessionId, config, user: STAFF, emit() {}, signal: controller.signal },
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
  const text = (value) => textValue(value);
  const languageLogs = (ctx) => ctx.logs.filter((line) => line.startsWith('Language:'));

  /* ============ R: llm.research ============ */

  // a German topic: the system text asks for German, the sources line is German, the log names the language and where it comes from
  {
    calls.length = 0;
    const ctx = makeCtx();
    const result = await exec('llm.research', ctx, { topic: text('Wie funktioniert Git und GitHub') }, { language: 'auto' });
    assert.match(calls[0].options.system, /Write in German \(Swiss High German/);
    assert.match(result.variants[0].sources.value, /\(abgerufen \d{4}-\d{2}-\d{2}\)/);
    assert.deepEqual(languageLogs(ctx), ['Language: German (from the topic)']);
  }
  // an English and a Spanish topic
  {
    calls.length = 0;
    const english = makeCtx();
    const out = await exec('llm.research', english, { topic: text('How does a heat pump work, and what does it cost to run?') }, { language: 'auto' });
    assert.match(calls[0].options.system, /Write in English/);
    assert.match(out.variants[0].sources.value, /\(retrieved \d{4}/);
    assert.deepEqual(languageLogs(english), ['Language: English (from the topic)']);
    const spanish = makeCtx();
    const outEs = await exec('llm.research', spanish, { topic: text('¿Cómo funciona una bomba de calor?') }, { language: 'auto' });
    assert.match(calls[1].options.system, /Write in Spanish/);
    assert.match(outEs.variants[0].sources.value, /\(consultado \d{4}/);
    assert.deepEqual(languageLogs(spanish), ['Language: Spanish (from the topic)']);
  }
  // a short topic decides nothing: the focus is asked next, then English
  {
    calls.length = 0;
    const withFocus = makeCtx();
    await exec('llm.research', withFocus, { topic: text('Git vs GitHub'), focus: text('Für Einsteiger, ohne Fachbegriffe') }, { language: 'auto' });
    assert.match(calls[0].options.system, /Write in German/);
    assert.deepEqual(languageLogs(withFocus), ['Language: German (from the focus)']);
    const alone = makeCtx();
    await exec('llm.research', alone, { topic: text('Git vs GitHub') }, { language: 'auto' });
    assert.match(calls[1].options.system, /Write in English/);
    assert.deepEqual(languageLogs(alone), ['Language: English (no hint in the input: English is the default)']);
    const weak = makeCtx();
    await exec('llm.research', weak, { topic: text('Wie funktioniert Git') }, { language: 'auto' });
    assert.match(calls[2].options.system, /Write in German/);
    assert.deepEqual(languageLogs(weak), ['Language: German (from the topic, few hints)']);
  }
  // a language named in the node is used as it is, and nothing is said about it
  {
    calls.length = 0;
    const ctx = makeCtx();
    const out = await exec('llm.research', ctx, { topic: text('Wie funktioniert Git und GitHub') }, { language: 'en' });
    assert.match(calls[0].options.system, /Write in English/);
    assert.match(out.variants[0].sources.value, /\(retrieved /);
    assert.deepEqual(languageLogs(ctx), []);
    // and the default of a node without the parameter is still English
    const bare = makeCtx();
    await exec('llm.research', bare, { topic: text('Wie funktioniert Git und GitHub') }, {});
    assert.match(calls[1].options.system, /Write in English/);
    assert.deepEqual(languageLogs(bare), []);
  }
  // the same input always gives the same prompt (the cache stays valid)
  {
    calls.length = 0;
    for (let i = 0; i < 3; i += 1) await exec('llm.research', makeCtx(), { topic: text('Git vs GitHub'), focus: text(GERMAN_BRIEF) }, { language: 'auto' });
    assert.equal(new Set(calls.map((call) => call.options.system)).size, 1);
  }

  /* ============ P: explainer.plan ============ */

  const plan = async (inputs, raw = {}) => {
    calls.length = 0;
    const ctx = makeCtx();
    const result = await exec('explainer.plan', ctx, inputs, { verify: false, length_seconds: 120, ...raw });
    return { ctx, out: result.variants[0], system: calls[0]?.options.system || '', prompt: calls[0]?.options.prompt || '', script: JSON.parse(result.variants[0].script.value) };
  };

  // German: the prompt, the words per minute (135) and the target of words (270), the word for a page, the code in the script
  {
    const found = await plan({ topic: text('Wie funktioniert Git und GitHub'), text: text(GERMAN_DOC) }, { language: 'auto' });
    assert.match(found.system, /Language of the narration and of the text on screen: German/);
    assert.match(found.system, /read at 135 words per minute, so about 270 words of narration/);
    assert.match(found.prompt, /Parameters: language de,/);
    assert.equal(found.script.language, 'de', 'the real code, never auto');
    assert.deepEqual(found.script.sources.map((source) => source.ref), ['S. 1', 'S. 2', 'S. 3'], 'the German word for a page');
    assert.match(found.out.sources.value, /^S\. 1/);
    assert.deepEqual(languageLogs(found.ctx), ['Language: German (from the topic)']);
    assert.equal(JSON.parse(found.out.shots.value).language, 'de');
  }
  // English: 150 words per minute and 300 words, "p."
  {
    const found = await plan({ topic: text('How does a heat pump work, and what does it cost to run?'), text: text(ENGLISH_DOC) }, { language: 'auto' });
    assert.match(found.system, /Language of the narration and of the text on screen: English\./);
    assert.match(found.system, /read at 150 words per minute, so about 300 words of narration/);
    assert.equal(found.script.language, 'en');
    assert.deepEqual(found.script.sources.map((source) => source.ref), ['p. 1', 'p. 2', 'p. 3']);
    assert.deepEqual(languageLogs(found.ctx), ['Language: English (from the topic)']);
  }
  // Spanish
  {
    const found = await plan({ topic: text('¿Cómo funciona una bomba de calor y cuánto cuesta usarla?'), text: text(SPANISH_DOC) }, { language: 'auto' });
    assert.match(found.system, /Language of the narration and of the text on screen: Spanish/);
    assert.match(found.system, /read at 150 words per minute, so about 300 words of narration/);
    assert.equal(found.script.language, 'es');
    assert.deepEqual(languageLogs(found.ctx), ['Language: Spanish (from the topic)']);
  }
  // what the person writes counts first: an English PDF and a German brief give German; without the brief the PDF decides
  {
    const withBrief = await plan({ text: text(ENGLISH_DOC), brief: text(GERMAN_BRIEF) }, { language: 'auto' });
    assert.equal(withBrief.script.language, 'de');
    assert.match(withBrief.system, /read at 135 words per minute/);
    assert.deepEqual(languageLogs(withBrief.ctx), ['Language: German (from the brief)']);
    const withoutBrief = await plan({ text: text(ENGLISH_DOC) }, { language: 'auto' });
    assert.equal(withoutBrief.script.language, 'en');
    assert.deepEqual(languageLogs(withoutBrief.ctx), ['Language: English (from the text input)']);
    // a short topic asks the next source: the brief, then the text
    const shortTopic = await plan({ topic: text('Git vs GitHub'), text: text(GERMAN_DOC) }, { language: 'auto' });
    assert.equal(shortTopic.script.language, 'de');
    assert.deepEqual(languageLogs(shortTopic.ctx), ['Language: German (from the text input)']);
    // a German topic beats English research notes
    const notes = 'Heat pumps reach a COP of 4 [1]. The costs of the owners fell by 12 % [2].';
    const sources = '[1] Agency report — https://example.org/a (retrieved 2026-10-03)\n[2] Paper — https://example.org/b (retrieved 2026-10-03)';
    const germanTopic = await plan({ topic: text('Wie funktioniert eine Wärmepumpe?'), notes: text(notes), sources: text(sources) }, { language: 'auto' });
    assert.equal(germanTopic.script.language, 'de');
    // a short topic with research notes: the notes decide, and the list of sources comes after them
    const shortWithNotes = await plan({ topic: text('Heat pumps'), notes: text(notes), sources: text(sources) }, { language: 'auto' });
    assert.equal(shortWithNotes.script.language, 'en');
    assert.deepEqual(languageLogs(shortWithNotes.ctx), ['Language: English (from the research notes)']);
  }
  // nothing to go on: English, and the log says so
  {
    const found = await plan({ topic: text('Git vs GitHub'), text: text('=== D1: x.pdf (3 pages) ===\n[p. 1]\n1234') }, { language: 'auto' });
    assert.equal(found.script.language, 'en');
    assert.deepEqual(languageLogs(found.ctx), ['Language: English (no hint in the input: English is the default)']);
  }
  // a language named in the node is used as it is: a German topic with "en" gives an English script, and nothing is logged
  {
    const found = await plan({ topic: text('Wie funktioniert Git und GitHub'), text: text(GERMAN_DOC) }, { language: 'en' });
    assert.equal(found.script.language, 'en');
    assert.deepEqual(languageLogs(found.ctx), []);
    const bare = await plan({ topic: text('Wie funktioniert Git und GitHub'), text: text(GERMAN_DOC) }, {});
    assert.equal(bare.script.language, 'en', 'a node without the parameter keeps English');
    const fixed = await plan({ topic: text('How does Git work and what is GitHub'), text: text(ENGLISH_DOC) }, { language: 'es' });
    assert.equal(fixed.script.language, 'es');
    assert.match(fixed.system, /Spanish/);
  }
  // the same input always gives the same prompt and the same script language
  {
    const first = await plan({ topic: text('Git vs GitHub'), brief: text(GERMAN_BRIEF), text: text(ENGLISH_DOC) }, { language: 'auto' });
    const second = await plan({ topic: text('Git vs GitHub'), brief: text(GERMAN_BRIEF), text: text(ENGLISH_DOC) }, { language: 'auto' });
    assert.equal(first.system, second.system);
    const withoutNonce = (prompt) => prompt.replace(/nonce="?[0-9a-f]+"?/g, 'nonce');
    assert.equal(withoutNonce(first.prompt), withoutNonce(second.prompt), 'apart from the random mark that fences the data');
    assert.equal(first.script.language, second.script.language);
  }
  // an edited script (phase two) keeps its own language with auto: no model call, whatever the inputs say now
  {
    const base = await plan({ topic: text('How does a heat pump work, and what does it cost to run?'), text: text(SPANISH_DOC) }, { language: 'es' });
    assert.equal(base.script.language, 'es');
    calls.length = 0;
    const ctx = makeCtx();
    const result = await exec('explainer.plan', ctx, { topic: text('How does a heat pump work, and what does it cost to run?'), text: text(ENGLISH_DOC) }, { language: 'auto', script: JSON.stringify(base.script) });
    assert.equal(calls.length, 0, 'an edited script is only checked');
    assert.equal(JSON.parse(result.variants[0].script.value).language, 'es');
    assert.deepEqual(languageLogs(ctx), ['Language: Spanish (from the script)']);
    // a script without a language of its own: the inputs decide as before
    const bare = JSON.parse(JSON.stringify(base.script));
    delete bare.language;
    const ctx2 = makeCtx();
    const result2 = await exec('explainer.plan', ctx2, { topic: text('How does a heat pump work, and what does it cost to run?'), text: text(SPANISH_DOC) }, { language: 'auto', script: JSON.stringify(bare) });
    assert.equal(JSON.parse(result2.variants[0].script.value).language, 'en');
    assert.deepEqual(languageLogs(ctx2), ['Language: English (from the topic)']);
  }

  /* ============ S: saved workflows, new nodes, labels ============ */

  // a saved node that names en, or has no language at all, runs in English with the key it always had; the golden keys were computed with
  // the code before WP38d (change them only with a deliberate change of the parameters of these two nodes)
  {
    const golden = {
      'llm.research': 'sha256:842b76ceff6d5cd7b38ef00ab167218863bf6708f77c16845cf7a15ba11fbe96',
      'explainer.plan': 'sha256:45ad3f6e94fccfd4bdfa439854869b67b5cd97ada102aef54ab19da31dac6846'
    };
    for (const type of ['llm.research', 'explainer.plan']) {
      const def = real.get(type);
      const inputs = { topic: { type: 'text', value: 'Heat pumps' } };
      const keyOf = (params) => engineLib.computeCacheKey(def, engineLib.effectiveParams(real, def, { id: 'n1', type, params }, {}), inputs);
      const saved = engineLib.effectiveParams(real, def, { id: 'n1', type, params: { topic: 'Heat pumps', language: 'en' } }, {});
      const bare = engineLib.effectiveParams(real, def, { id: 'n1', type, params: { topic: 'Heat pumps' } }, {});
      assert.equal(saved.language, 'en', `${type}: a saved en stays en`);
      assert.equal(bare.language, 'en', `${type}: a saved node without the parameter stays en`);
      assert.equal(keyOf({ topic: 'Heat pumps', language: 'en' }), golden[type], `${type}: the cache key of a saved node did not change`);
      assert.equal(keyOf({ topic: 'Heat pumps' }), golden[type], `${type}: nor did that of a node without the parameter`);
      assert.notEqual(keyOf({ topic: 'Heat pumps', language: 'auto' }), golden[type], `${type}: auto is another run`);
      assert.equal(engineLib.effectiveParams(real, def, { id: 'n1', type, params: { language: 'auto' } }, {}).language, 'auto');
      // an override of a run counts like a saved value
      assert.equal(engineLib.effectiveParams(real, def, { id: 'n1', type, params: {} }, { n1: { language: 'auto' } }).language, 'auto');
      assert.deepEqual(registryModule.checkParams(def, { language: 'auto' }), [], `${type}: auto is an option`);
      assert.equal(registryModule.checkParams(def, { language: 'fr' }).length, 1);
    }
  }
  // new nodes start with auto: the palette (addNode), the assistant (insertSubgraph with fresh); a copy or a template keeps what it has
  {
    const payload = JSON.parse(JSON.stringify(registryModule.publicRegistry()));
    const reg = graphLib.indexRegistry(payload);
    const withInitial = payload.nodeTypes.filter((def) => def.params.some((param) => param.initial !== undefined)).map((def) => def.type);
    assert.deepEqual(withInitial.sort(), ['explainer.plan', 'llm.research'], 'only these two nodes start with another value than their default');
    for (const def of payload.nodeTypes) {
      const initial = registryModule.initialParams(real.get(def.type));
      const defaults = registryModule.paramDefaults(real.get(def.type));
      const differing = Object.keys(initial).filter((key) => JSON.stringify(initial[key]) !== JSON.stringify(defaults[key]));
      assert.deepEqual(differing, ['explainer.plan', 'llm.research'].includes(def.type) ? ['language'] : [], def.type);
      // the client mirrors the server
      assert.deepEqual(graphLib.initialParams(reg.types.get(def.type)), initial, `${def.type}: the page and the server agree on the params of a new node`);
    }
    assert.equal(registryModule.paramDefaults(real.get('explainer.plan')).language, 'en');
    for (const type of ['llm.research', 'explainer.plan']) {
      const added = graphLib.addNode(reg, graphLib.emptyGraph(), type);
      assert.equal(added.node.params.language, 'auto', `${type}: a node from the palette`);
      assert.equal(graphLib.addNode(reg, graphLib.emptyGraph(), type, { params: { language: 'de' } }).node.params.language, 'de', 'what is given wins');
      const proposal = { nodes: [{ id: 'a', type, x: 0, y: 0, params: {} }, { id: 'b', type, x: 300, y: 0, params: { language: 'en' } }], edges: [] };
      const fresh = graphLib.insertSubgraph(graphLib.emptyGraph(), proposal, { reg, fresh: true });
      assert.deepEqual(fresh.graph.nodes.map((node) => node.params.language), ['auto', 'en'], `${type}: the assistant's new nodes start with auto, a named language stays`);
      const copy = graphLib.insertSubgraph(graphLib.emptyGraph(), proposal, { reg });
      assert.deepEqual(copy.graph.nodes.map((node) => node.params.language), ['en', 'en'], `${type}: a pasted node that has no language keeps the default`);
    }
    // the assistant of the page asks for new nodes
    assert.match(fs.readFileSync(path.join(ROOT, 'public/nodes/assistant-ui.js'), 'utf8'), /deps\.insert\(built\.sub, \{ history: 'insert-assistant', fresh: true \}\)/);
  }
  // the label of "auto" for the language: «Wie die Eingabe», in the three languages; other parameters keep "Automatisch"
  {
    const dict = {};
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/nodes/i18n-nodes.js'), 'utf8'), { window: { I18N: dict } });
    const payload = JSON.parse(JSON.stringify(registryModule.publicRegistry()));
    const uiFor = (lang) => {
      const window = { I18N: dict, OCDNodes: { graph: graphLib }, matchMedia: () => ({ matches: false, addEventListener() {} }) };
      window.t = (key) => (dict[lang][key] === undefined ? key : dict[lang][key]);
      vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/nodes/node-ui.js'), 'utf8'), { window, document: { createElement: () => ({}) } }, { filename: 'node-ui.js' });
      return window.OCDNodes.ui;
    };
    const expected = { de: ['Wie die Eingabe', 'Englisch', 'Deutsch', 'Spanisch'], en: ['Same as input', 'English', 'German', 'Spanish'], es: ['Igual que la entrada', 'Inglés', 'Alemán', 'Español'] };
    for (const lang of ['de', 'en', 'es']) {
      const ui = uiFor(lang);
      for (const type of ['llm.research', 'explainer.plan']) {
        const param = payload.nodeTypes.find((def) => def.type === type).params.find((item) => item.id === 'language');
        const entries = ui.optionsFor(param).options;
        assert.deepEqual(entries.map((entry) => entry.value), ['auto', 'en', 'de', 'es']);
        assert.deepEqual(entries.map((entry) => entry.label), expected[lang], `${lang} ${type}`);
      }
      // the other nodes with a language and the other uses of "auto" are not touched
      assert.equal(ui.optionLabelOf({ id: 'format' }, 'auto'), dict[lang]['nodes.option.auto']);
      assert.equal(ui.optionLabelOf({ id: 'language' }, 'en'), dict[lang]['nodes.option.en']);
      assert.equal(ui.optionLabel('auto'), dict[lang]['nodes.option.auto']);
      assert.notEqual(dict[lang]['nodes.option.language.auto'], dict[lang]['nodes.option.auto']);
    }
  }
  // the chat tools and the MCP tools see the new option like any other: the list of the inputs of a template names it, and a value that is
  // not an option is refused
  {
    const runServiceLib = iso.load('lib/nodes/run-service');
    for (const id of ['explainer-script-topic', 'explainer-video-topic']) {
      const doc = templates.resolveTemplate(id, { lang: 'en' });
      const inputs = runServiceLib.inputDescriptors(doc.graph, doc.app, real);
      const languageInputs = inputs.filter((input) => input.param === 'language');
      assert.equal(languageInputs.length, 2, `${id}: the language of the script and of the research`);
      for (const input of languageInputs) assert.deepEqual(input.options, ['auto', 'en', 'de', 'es'], `${id}.${input.id}`);
    }
  }

  /* ============ T: the templates ============ */

  const IDS = ['explainer-script', 'explainer-script-topic', 'explainer-video', 'explainer-video-topic', 'explainer-video-presenter'];
  for (const id of IDS) {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib/nodes/templates', `${id}.json`), 'utf8'));
    const nodes = raw.graph.nodes.filter((node) => node.type === 'llm.research' || node.type === 'explainer.plan');
    assert.ok(nodes.length >= 1);
    for (const node of nodes) assert.equal(node.params.language, 'auto', `${id}.${node.id}: auto`);
    // the languages of the interface do not change the language of the nodes any more
    for (const lang of ['de', 'es']) {
      assert.deepEqual(Object.keys(raw.i18n[lang]).filter((key) => /^param\.n\d+\.language$/.test(key)), [], `${id}.${lang}: no language of the interface in the parameter`);
    }
    for (const lang of ['en', 'de', 'es']) {
      const doc = templates.resolveTemplate(id, { lang });
      for (const node of doc.graph.nodes.filter((item) => item.type === 'llm.research' || item.type === 'explainer.plan')) assert.equal(node.params.language, 'auto', `${id}.${lang}.${node.id}`);
      // the description, the note and the app text say that the language follows the input, and how to change it
      const follows = { en: /language follows your (input|topic) automatically/, de: /Sprache folgt automatisch deine[rm] (Eingabe|Thema)/, es: /idioma sigue automáticamente tu (entrada|tema)/ }[lang];
      assert.match(doc.description, follows, `${id}.${lang}: description`);
      assert.match(doc.graph.notes[0].text, follows, `${id}.${lang}: note`);
      const old = { en: /Set the language of the script and of the research/, de: /Stelle die Sprache des Skripts/, es: /(Pon|Ajusta) el idioma del guion/ }[lang];
      assert.doesNotMatch(doc.graph.notes[0].text, old, `${id}.${lang}: the old advice to set both languages is gone`);
      assert.ok(!/ß/.test(doc.description + doc.graph.notes[0].text + doc.app.description), `${id}.${lang}: no sharp s`);
    }
  }
  // the three languages are complete: the German and Spanish texts are not the English one
  for (const id of IDS) {
    const en = templates.resolveTemplate(id, { lang: 'en' });
    for (const lang of ['de', 'es']) {
      const other = templates.resolveTemplate(id, { lang });
      assert.notEqual(other.description, en.description);
      assert.notEqual(other.graph.notes[0].text, en.graph.notes[0].text);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
