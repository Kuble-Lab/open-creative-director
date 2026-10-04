'use strict';

// The three explainer video workflows (WP37b): "Explainer video from a PDF" (explainer-video), "Explainer video for a topic"
// (explainer-video-topic) and "Explainer video with a presenter (portrait)" (explainer-video-presenter).
//   - they load and validate against the registry, `requires` is complete (fal.ai only for the presenter), the order, the gallery data
//   - the graph shapes, the settings that carry the video (page images, format, clips off, intro and outro), the Design App
//   - the texts in German, English and Spanish: the named cost, the hint "run the planner first", the consent note of the presenter
//   - the plan of the engine: valid, the price of the voice and of the scenes known once the planner has run
//   - the two steps through the real engine: first only the planner (no voice, no scene, no cost beyond research and script), then the
//     edited script and everything: every scene gets ITS voice, ITS brief and ITS pictures, the film has the length of the voices,
//     the subtitle file and the captions come out, the costs are booked
//   - the presenter version through the engine: intro and outro are the first and the last lip-sync clip, in a portrait film
// The language model, ElevenLabs, the render node, the image model and the lip sync are replaced; ffmpeg is real (and a stand-in for
// libass where the machine has none). Nothing is paid and nothing leaves the machine. Skipped when ffmpeg is missing.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');

const { createIsolatedApp } = require('./support/isolated-app');
const { createAssStandIn } = require('./support/fake-ffmpeg');
const { toneWav, createMedia } = require('./support/explainer-media');
const { makePdf } = require('./support/pdf');

const STAFF = 'staff1@staff.example.com';
const KEY = 'el-secret-key-0123456789';
const GSAP = 'https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js';
const IDS = ['explainer-video', 'explainer-video-topic', 'explainer-video-presenter'];
const near = (actual, expected, tolerance, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} !== ${expected} (±${tolerance})`.trim());

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

const VOCAB = ['Strom', 'Wärme', 'Pumpe', 'Kosten', 'Energie', 'Haus', 'Winter', 'Effizienz', 'Boden', 'Luft', 'Wasser', 'Förderung', 'Technik', 'Preis', 'Jahr', 'Markt'];
const narrationOf = (k, n) => Array.from({ length: n }, (_x, i) => `${VOCAB[(i + k) % VOCAB.length]}${k}`).join(' ') + '.';
const SECONDS_PER_CHAR = 0.02;

// the answer of the planner: 12 scenes, two of them stills (s3 and s7), optionally the two lines of a presenter
function planAnswer({ presenter = false, stills = [2, 6], refs = ['[1]'], figure = null } = {}) {
  return {
    title: 'Wärmepumpen',
    summary: 'Wie sie funktionieren',
    scenes: Array.from({ length: 12 }, (_x, i) => {
      const k = i + 1;
      const words = narrationOf(k, 22).replace(/\./g, '').split(' ');
      const still = stills.includes(i);
      return {
        kind: still ? 'still' : 'motion',
        role: k === 1 ? 'hook' : k === 12 ? 'summary' : 'point',
        narration: narrationOf(k, 22),
        on_screen: { title: `Titel ${k}`, bullets: [`Stichwort ${k}`], numbers: [], quote: null },
        elements: [{ type: 'title', content: `Titel ${k}`, anchor: words[0] }, { type: 'bullet', content: `Stichwort ${k}`, anchor: words[5] }],
        figure: figure && figure.scene === k ? { document: 0, page: figure.page, bbox: figure.bbox } : null,
        image_prompt: still ? `Bild der Szene ${k}` : null,
        clip_prompt: null,
        source_refs: [refs[i % refs.length]]
      };
    }),
    presenter: presenter ? { intro: 'Hallo, heute geht es um Wärmepumpen und darum, was sie im Betrieb wirklich kosten.', outro: 'Das war es für heute, danke fürs Zuschauen und bis zum nächsten Mal.' } : null
  };
}

async function main() {
  const attempts = [];
  const realFetch = global.fetch;
  const eleven = { calls: [] };
  const respond = (status, body) => {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: new Map(), async text() { return text; }, async json() { return JSON.parse(text); } };
  };
  global.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (/^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/[^/]+\/with-timestamps/.test(url)) {
      const body = JSON.parse(init.body);
      eleven.calls.push({ url, body });
      const characters = [...body.text];
      const alignment = {
        characters,
        character_start_times_seconds: characters.map((_c, index) => Math.round(index * SECONDS_PER_CHAR * 1000) / 1000),
        character_end_times_seconds: characters.map((_c, index) => Math.round((index + 1) * SECONDS_PER_CHAR * 1000) / 1000)
      };
      return respond(200, { audio_base64: toneWav(characters.length * SECONDS_PER_CHAR + 0.1, 600).toString('base64'), alignment, normalized_alignment: alignment });
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
      FAL_KEY: 'fal-test-key-with-enough-length',
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
  console.log('test-explainer-video-templates.js: ok');
}

async function run(iso, eleven) {
  const templates = iso.load('lib/nodes/templates');
  const nodeRegistry = iso.load('lib/nodes/registry');
  const store = iso.load('lib/store');
  const assets = iso.load('lib/nodes/assets');
  const llm = iso.load('lib/nodes/llm');
  const costs = iso.load('lib/costs');
  const discovery = iso.load('lib/discovery');
  const rendernode = iso.load('lib/rendernode');
  const jobsLib = iso.load('lib/nodes/jobs');
  const ffmpegLib = iso.load('lib/ffmpeg');
  const cuesLib = iso.load('lib/explainer-cues');
  const planLib = iso.load('lib/explainer-plan');
  const tools = iso.load('lib/tools');
  const { createEventBus } = iso.load('lib/nodes/events');
  const { createWorkflowsStore } = iso.load('lib/nodes/workflows-store');
  const { createEngine } = iso.load('lib/nodes/engine');
  const real = nodeRegistry.registry;

  const all = templates.loadTemplates();
  const byId = Object.fromEntries(all.map((template) => [template.id, template]));
  for (const id of IDS) assert.ok(byId[id], `${id} exists`);
  assert.deepEqual(
    templates.ORDER.filter((id) => id.startsWith('explainer-')),
    ['explainer-video', 'explainer-video-topic', 'explainer-video-presenter', 'explainer-script', 'explainer-script-topic'],
    'the finished videos come before the scripts'
  );

  /* ---------- shapes ---------- */

  const types = (template) => template.graph.nodes.map((node) => node.type);
  const wires = (template) => template.graph.edges.map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`);
  const nodeOf = (template, id) => template.graph.nodes.find((node) => node.id === id);
  for (const id of IDS) {
    const template = byId[id];
    const result = templates.validateTemplate(template);
    assert.ok(result.app.enabled && result.app.inputs.length && result.app.outputs.length, `${id} has a Design App`);
    assert.ok(template.graph.notes.length >= 1);
    assert.equal(template.graph.nodes.filter((node) => node.type === 'explainer.plan').length, 1);
    assert.equal(template.graph.nodes.filter((node) => node.type === 'explainer.edit').length, 1);
    // every param of every node is one of the node, with a valid value
    for (const node of template.graph.nodes) {
      const def = real.get(node.type);
      const params = JSON.parse(JSON.stringify(node.params));
      assert.deepEqual(real.normalizeParams(def, params), params, `${id}.${node.id} (${node.type}): the params are those of the node`);
    }
    // the planner ships empty (phase one), Opus 5.5 by decision of the account, the model of the scenes too
    const plan = template.graph.nodes.find((node) => node.type === 'explainer.plan');
    assert.equal(plan.params.script, '', 'the script ships empty');
    assert.equal(plan.params.model, '');
    assert.equal(plan.params.verify, true);
    assert.equal(plan.params.clips, false, 'no clip chain in these workflows: the planner plans no clips');
    assert.equal(plan.params.length_seconds, 120);
    const scene = template.graph.nodes.find((node) => node.type === 'explainer.scene');
    assert.equal(scene.params.model, '');
    assert.equal(scene.params.vision_check, true);
    assert.equal(scene.params.max_retries, 2);
    assert.equal(scene.params.fallback, true);
    assert.equal(scene.params.format, plan.params.format, 'the format is the same in the planner and in the scenes');
    // the same wiring in all three: the voice of the scenes, the briefs, the timing, the stills by scene id
    const wired = wires(template);
    const idOf = (type) => template.graph.nodes.find((node) => node.type === type).id;
    const [P, V, S, E, B, I] = [idOf('explainer.plan'), idOf('explainer.voice'), idOf('explainer.scene'), idOf('explainer.edit'), idOf('input.branding'), idOf('image.generate')];
    for (const wire of [`${P}.narration>${V}.narration`, `${P}.narration_context>${V}.context`, `${P}.briefs>${S}.brief`, `${V}.timing>${S}.timing`, `${P}.shots>${S}.shots`, `${S}.video>${E}.scenes`, `${V}.audio>${E}.audio`, `${V}.timing>${E}.timing`, `${P}.shots>${E}.shots`, `${B}.brand>${P}.brand`, `${B}.brand>${S}.brand`, `${P}.image_prompts>${I}.prompt`, `${I}.image>${S}.stills`]) {
      assert.ok(wired.includes(wire), `${id} has ${wire}`);
    }
    // the logo is not wired: without a branding there is none, and an input that waits for it stops the plan (OUTPUT_EMPTY); the note says how
    assert.ok(!wired.includes(`${B}.logo>${S}.logo`), `${id}: the logo is left out so that the workflow runs with the neutral profile`);
    assert.match(template.graph.notes[0].text, /Logo/);
    // the chain has its music: instrumental and quiet, made by ElevenLabs and fed into the cut (the task named it: scenes -> music -> cut)
    const musicNodes = template.graph.nodes.filter((node) => node.type === 'audio.music');
    assert.equal(musicNodes.length, 1, `${id}: one music node`);
    assert.equal(musicNodes[0].params.instrumental, true, `${id}: instrumental`);
    assert.ok(musicNodes[0].params.prompt.length > 20 && /no vocals/.test(musicNodes[0].params.prompt), `${id}: the description asks for no vocals`);
    assert.equal(musicNodes[0].params.length, 120, `${id}: as long as the default film (the cut repeats it where the film is longer)`);
    assert.ok(wired.includes(`${musicNodes[0].id}.audio>${E}.music`), `${id}: the music goes into the cut`);
    assert.equal(nodeOf(template, E).params.music_level, 'quiet', `${id}: quiet under the voice`);
    assert.equal(nodeOf(template, E).params.ducking, true, `${id}: lowered while the voice speaks`);
    assert.ok(templates.usesRestrictedNodes(template.graph) === false, `${id}: no restricted node`);
    // the cost range is in the description and the note, the hint to the two steps too
    assert.match(template.description, /Run the planner first/);
    assert.match(template.description, id === 'explainer-video-presenter' ? /topic version, with its music/ : /music about 0\.40/, `${id}: the music price is named`);
    assert.match(template.description, /paid ElevenLabs plan/, `${id}: and that the music needs a paid plan`);
    assert.match(template.graph.notes[0].text, /Background music/);
    assert.match(template.graph.notes[0].text, /Edited script/);
    assert.match(template.graph.notes[0].text, /confirmation/);
  }
  const pdf = byId['explainer-video'];
  assert.deepEqual(types(pdf), ['input.document', 'doc.read', 'input.branding', 'explainer.plan', 'explainer.voice', 'image.generate', 'explainer.scene', 'explainer.edit', 'output.result', 'output.result', 'output.result', 'audio.music']);
  assert.deepEqual(pdf.requires, ['openrouter', 'poppler', 'elevenlabs', 'rendernode', 'ffmpeg']);
  assert.equal(nodeOf(pdf, 'n2').params.page_images, 'all', 'the figures are cut out of the page images');
  for (const wire of ['n1.documents>n2.documents', 'n2.text>n4.text', 'n2.files>n4.documents', 'n2.info>n4.info', 'n2.pages>n7.pages', 'n2.info>n7.pages_info']) assert.ok(wires(pdf).includes(wire), `the PDF version has ${wire}`);
  assert.deepEqual(pdf.app.inputs[0], { node: 'n1', param: 'assets', label: 'PDF or text file' });
  const topic = byId['explainer-video-topic'];
  assert.deepEqual(topic.requires, ['openrouter', 'elevenlabs', 'rendernode', 'ffmpeg']);
  assert.deepEqual(types(topic).slice(0, 4), ['input.prompt', 'input.prompt', 'llm.research', 'input.branding']);
  for (const wire of ['n1.prompt>n2.topic', 'n6.prompt>n2.focus', 'n2.notes>n4.notes', 'n2.sources>n4.sources', 'n1.prompt>n4.topic', 'n6.prompt>n4.brief']) assert.ok(wires(topic).includes(wire), `the topic version has ${wire}`);
  const presenter = byId['explainer-video-presenter'];
  assert.deepEqual(presenter.requires, ['openrouter', 'elevenlabs', 'rendernode', 'ffmpeg', 'fal']);
  assert.equal(nodeOf(presenter, 'n4').params.format, 'portrait');
  assert.equal(nodeOf(presenter, 'n4').params.presenter, 'intro_outro');
  assert.equal(nodeOf(presenter, 'n8').params.format, 'portrait');
  assert.equal(nodeOf(presenter, 'n7').params.aspect_ratio, '9:16');
  assert.equal(nodeOf(presenter, 'n13').type, 'fal.h3_lipsync');
  assert.equal(nodeOf(presenter, 'n12').params.use_context, false, 'the two lines of the presenter have no scene around them');
  for (const wire of ['n4.presenter>n12.narration', 'n14.image>n13.image', 'n12.audio>n13.audio', 'n13.video>n15.items', 'n13.video>n16.items', 'n15.item>n9.intro', 'n16.item>n9.outro']) assert.ok(wires(presenter).includes(wire), `the presenter version has ${wire}`);
  assert.equal(nodeOf(presenter, 'n15').params.index, 0, 'the intro is the first clip');
  assert.equal(nodeOf(presenter, 'n16').params.index, -1, 'the outro is the last');
  for (const id of ['explainer-video', 'explainer-video-topic']) assert.ok(!byId[id].requires.includes('fal'), `${id} runs without fal.ai`);

  /* ---------- texts ---------- */

  const resolved = (id, lang) => templates.resolveTemplate(id, { lang });
  const NAMES = {
    'explainer-video': ['Explainer video from a PDF', 'Erklärvideo aus PDF', /^Vídeo explicativo a partir de un PDF/],
    'explainer-video-topic': ['Explainer video for a topic', 'Erklärvideo zu einem Thema', /^Vídeo explicativo sobre un tema/],
    'explainer-video-presenter': ['Explainer video with a presenter (portrait)', 'Erklärvideo mit Moderation (Hochformat)', /^Vídeo explicativo con presentador/]
  };
  for (const id of IDS) {
    assert.equal(resolved(id, 'en').name, NAMES[id][0]);
    assert.equal(resolved(id, 'de').name, NAMES[id][1]);
    assert.match(resolved(id, 'es').name, NAMES[id][2]);
    for (const lang of ['en', 'de', 'es']) {
      const doc = resolved(id, lang);
      // WP38d: the language follows the input in every language of the interface (it used to be the language of the interface)
      assert.equal(doc.graph.nodes.find((node) => node.id === 'n4').params.language, 'auto', `${id}.${lang}: the script follows the language of the input`);
      assert.match(doc.graph.notes[0].text, lang === 'de' ? /Skript \(bearbeitet\)/ : lang === 'es' ? /Guion \(editado\)/ : /Edited script/, `${lang}: the note names the field of the second step as the node calls it`);
      assert.match(doc.description, lang === 'de' ? /Starte zuerst nur den Planer/ : lang === 'es' ? /Ejecuta primero solo el planificador/ : /Run the planner first/);
      assert.match(doc.description, lang === 'de' ? /Bestätigung/ : lang === 'es' ? /confirmes/ : /confirmation/);
      assert.match(doc.description, /Opus 5\.5/);
      assert.equal(doc.app.enabled, true);
      assert.ok(doc.app.title && doc.app.description);
      for (const text of [doc.name, doc.description, doc.app.title, doc.app.description, doc.graph.notes[0].text, ...doc.graph.nodes.map((node) => node.title || '')]) assert.equal(String(text).includes('ß'), false, `${id}.${lang}: no sharp s`);
      // the nodes carry names in the language of the person
      for (const node of doc.graph.nodes.filter((item) => item.title)) assert.ok(node.title.length > 1);
    }
  }
  // the cost range is named (music of 0.40 included): PDF 2.50 to 3.50 dollars, topic 2 to 3, presenter 4 to 5, in every language
  for (const [id, low, high] of [['explainer-video', '2[.,]5', '3[.,]5'], ['explainer-video-topic', '2', '3'], ['explainer-video-presenter', '4', '5']]) {
    for (const lang of ['en', 'de', 'es']) {
      const text = resolved(id, lang).description;
      assert.match(text, new RegExp(`${low}0? (to|bis|a) ${high}0?`), `${id}.${lang}: the cost range`);
    }
  }
  // the consent: the presenter says it in the description and the note, in every language
  assert.match(resolved('explainer-video-presenter', 'en').graph.notes[0].text, /consent/);
  assert.match(resolved('explainer-video-presenter', 'de').graph.notes[0].text, /Einwilligung/);
  assert.match(resolved('explainer-video-presenter', 'es').graph.notes[0].text, /consentimiento/);
  assert.match(resolved('explainer-video-presenter', 'en').description, /consent/);
  assert.match(resolved('explainer-video-presenter', 'de').description, /Einwilligung/);
  // the cost of the script part is the one the script templates name, and the planner's own estimate stays within it
  {
    const own = (pages, chars) => planLib.estimateUsd({ model: 'anthropic/claude-opus-5.5', pdfPages: pages, textChars: chars, verify: true });
    assert.ok(own(20, 20000) >= 0.5 && own(20, 60000) <= 0.9);
    // 12 scenes: the scenes cost 0.10 each, the voice by its characters; the named range is not below that
    const voice = tools.speechEstimateUsd('x'.repeat(1700), 'eleven_v4');
    const scenes = 13 * 0.1;
    const music = tools.musicEstimateUsd(120 * 1000);
    near(music, 0.4, 1e-9, 'two minutes of music');
    // mix mode: at most 35 % of the 13 scenes are stills, a few cents each (the notes say so)
    const stills = 4 * 0.04;
    assert.ok(own(20, 40000) + voice + scenes + music + stills <= 3.5, 'PDF: a 20 page PDF and 2 minutes (with the music and the stills) stay within the named 3.50 dollars');
    assert.ok(own(20, 40000) + voice + scenes + music + stills >= 2.5, 'and are not below the named 2.50 dollars');
  }

  /* ---------- gallery data ---------- */

  const allOn = Object.fromEntries(templates.REQUIREMENTS.map((key) => [key, () => true]));
  const listed = Object.fromEntries(templates.listTemplates({ lang: 'de', checks: allOn }).map((item) => [item.id, item]));
  for (const id of IDS) {
    assert.equal(listed[id].available, true);
    assert.deepEqual(listed[id].requires, byId[id].requires);
    assert.equal(listed[id].cost.kind, 'partial', `${id}: only the music is priced beforehand ("from"), the rest depends on the run and is never invented`);
    assert.equal(listed[id].cost.usd, 0.4, `${id}: from 0.40`);
    assert.equal(listed[id].batch, false);
  }
  const without = (key, reason) => Object.fromEntries(templates.listTemplates({ lang: 'en', checks: { ...allOn, [key]: () => reason } }).map((item) => [item.id, item]));
  const noRender = without('rendernode', 'No render node configured');
  for (const id of IDS) assert.deepEqual(noRender[id].missing, [{ key: 'rendernode', reason: 'No render node configured' }], `${id} needs the render node`);
  assert.equal(noRender['explainer-script'].available, true);
  const noFal = without('fal', 'FAL_KEY is not set');
  assert.equal(noFal['explainer-video'].available, true);
  assert.equal(noFal['explainer-video-topic'].available, true);
  assert.equal(noFal['explainer-video-presenter'].available, false);
  assert.equal(without('poppler', 'no poppler')['explainer-video'].available, false);
  assert.equal(without('poppler', 'no poppler')['explainer-video-topic'].available, true);

  /* ---------- the engine, with everything but ffmpeg replaced ---------- */

  const bins = ffmpegLib.binaries();
  if (!bins.available) {
    console.log('ffmpeg not found: the runs through the engine are skipped');
    return;
  }
  const workDir = await fsp.mkdtemp(path.join(iso.root, 'explainer-templates-'));
  const media = createMedia({ ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe, dir: workDir });
  const standIn = await createAssStandIn(workDir, { real: bins.ffmpeg });
  const originalFfmpegPath = process.env.FFMPEG_PATH;
  restorers.push(() => {
    if (originalFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = originalFfmpegPath;
    ffmpegLib.resetFilterCache();
  });
  process.env.FFMPEG_PATH = standIn.file;
  ffmpegLib.resetFilterCache();

  const calls = [];
  const journal = [];
  const renders = [];
  const answers = { plan: [], research: [] };
  const USD = { research: 0.05, plan: 0.3, verify: 0.1, writer: 0.06, check: 0.03 };
  const durationOf = (text) => Number(/data-duration="([\d.]+)"/.exec(text)[1]);
  const sizeOf = (text) => ({ width: Number(/data-width="(\d+)"/.exec(text)[1]), height: Number(/data-height="(\d+)"/.exec(text)[1]) });
  const kindOf = (system = '') =>
    /write the script of an explainer video/.test(system) ? 'plan' : /strict fact checker/.test(system) ? 'verify' : /careful research assistant/.test(system) ? 'research' : /^You write ONE scene/.test(system) ? 'writer' : /^You check frames/.test(system) ? 'check' : 'other';
  patch(llm, 'completeText', async (options) => {
    const kind = kindOf(options.system);
    calls.push({ kind, options: JSON.parse(JSON.stringify({ ...options, onReplaced: undefined })) });
    if (kind === 'plan') return { text: JSON.stringify(answers.plan.shift() || planAnswer()), usd: USD.plan };
    if (kind === 'research') return answers.research.shift() || { text: 'Wärmepumpen erreichen eine Jahresarbeitszahl von 4 [Agentur](https://example.org/a).', usd: USD.research, citations: [{ url: 'https://example.org/a', title: 'Agentur' }], citationSpans: [] };
    if (kind === 'verify') {
      const script = JSON.parse(/Script to check:\n([\s\S]*?)\n\n<data/.exec(options.prompt)[1]);
      return { text: JSON.stringify({ scenes: script.scenes.map((item) => ({ id: item.id, narration: item.narration, bullets: item.on_screen.bullets, numbers: item.on_screen.numbers, quote_ok: true, issues: [] })) }), usd: USD.verify };
    }
    if (kind === 'check') return { text: '{"ok": true, "blockers": [], "minor": []}', usd: USD.check };
    if (kind === 'writer') {
      const duration = durationOf(options.system);
      const { width, height } = sizeOf(options.system);
      const title = /Titel[^\n"]*?(\d+)/.exec(options.prompt)?.[0] || 'Titel';
      const attached = [...String(options.prompt).matchAll(/\{\{asset:(\d+)\}\} = image/g)].map((match) => `<img src="{{asset:${match[1]}}}" style="width:100px">`).join('');
      return {
        text: `<!doctype html>
<html><head><meta charset="utf-8"><script src="${GSAP}"></script><style>body,html{margin:0;width:${width}px;height:${height}px;overflow:hidden}</style></head>
<body><div id="main-composition" data-composition-id="main" data-width="${width}" data-height="${height}" data-start="0" data-duration="${duration}"><h1 id="t">${title}</h1>${attached}
<script>const tl = gsap.timeline({paused:true}); tl.from('#t',{opacity:0,duration:0.5},0.3); tl.to({}, {duration:0.01}, ${duration - 0.01}); window.__timelines = window.__timelines || {}; window.__timelines['main'] = tl;</script></div></body></html>`,
        usd: USD.writer
      };
    }
    throw new Error(`a model call that the test does not know: ${String(options.system).slice(0, 60)}`);
  });
  patch(costs, 'recordCost', async (entry) => {
    journal.push(entry);
    return entry;
  });
  patch(discovery, 'brainSupportsFiles', async () => true);

  // the render node: the video is made when the job is waited for (the fake of the poller), with the length and the size of the HTML
  patch(rendernode, 'enabled', () => true);
  patch(rendernode, 'listConfiguredNodes', () => [{ id: 'rn1', name: 'Render 1', enabled: true }]);
  patch(rendernode, 'submit', async (html, quality, files, format) => {
    renders.push({ html, quality, files, format, jobId: `job-${renders.length + 1}` });
    return { jobId: `job-${renders.length}`, nodeId: 'rn1' };
  });
  let rendered = 0;
  patch(jobsLib, 'waitForSessionJob', async (sessionId, jobId, { assetId }) => {
    const entry = renders.find((item) => item.jobId === jobId);
    assert.ok(entry, `a render was submitted for ${jobId}`);
    const duration = durationOf(entry.html);
    const { width, height } = sizeOf(entry.html);
    rendered += 1;
    const file = path.join(store.sessionAssetDir(sessionId), `fake-render-${rendered}.mp4`);
    await media.ff(['-f', 'lavfi', '-i', `color=c=0x336699:s=${Math.round(width / 10)}x${Math.round(height / 10)}:r=30`, '-frames:v', String(Math.ceil(duration * 30 - 1e-9)), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', file]);
    await store.completeAssetFile(sessionId, assetId, file, { cost: 0, duration, ext: '.mp4', kind: 'video' });
    return [assetId];
  });

  // the image model: a picture of the ratio that is asked for, the prompt is kept
  const pictures = [];
  const imageDef = real.get('image.generate');
  const imageExecute = async (ctx, inputs, params) => {
    const size = params.aspect_ratio === '9:16' ? '36x64' : '64x36';
    const scratch = await assets.createScratchDir(ctx.sessionId);
    const file = path.join(scratch, 'picture.png');
    await media.ff(['-f', 'lavfi', '-i', `color=c=0xcc3333:s=${size}`, '-frames:v', '1', file]);
    const value = await ctx.saveOutputFile({ kind: 'image', ext: '.png', sourceFile: file, prompt: inputs.prompt.value, cost: 0.04 });
    await assets.removeScratchDir(scratch);
    pictures[ctx.itemIndex ?? 0] = { prompt: inputs.prompt.value, ratio: params.aspect_ratio, assetId: value.assetId };
    return { variants: [{ image: value }], cost: { usd: 0.04 } };
  };
  // the lip sync: a clip as long as the voice, with the voice in it
  const lipsync = [];
  const lipsyncDef = real.get('fal.h3_lipsync');
  const lipsyncExecute = async (ctx, inputs) => {
    const slice = assets.assetFilePath(inputs.audio);
    const length = (await media.probe(slice)).duration;
    const clip = await media.colourClip('00aa55', Math.round(length * 100) / 100, { size: '90x160', audioFile: slice });
    const scratch = await assets.createScratchDir(ctx.sessionId);
    const file = path.join(scratch, 'lipsync.mp4');
    await fsp.copyFile(clip, file);
    const value = await ctx.saveOutputFile({ kind: 'video', ext: '.mp4', sourceFile: file, prompt: 'lip sync', cost: 0.3, duration: length });
    await assets.removeScratchDir(scratch);
    lipsync[ctx.itemIndex ?? 0] = { seconds: length };
    return { variants: [{ video: value }], cost: { usd: 0.3 } };
  };

  // the music: a tone as long as asked for (the real node asks ElevenLabs by the minute: 0.20 USD)
  const musicCalls = [];
  const musicDef = real.get('audio.music');
  const musicExecute = async (ctx, inputs, params) => {
    const seconds = params.length;
    const scratch = await assets.createScratchDir(ctx.sessionId);
    const file = path.join(scratch, 'music.wav');
    await fsp.writeFile(file, toneWav(seconds, 220, { amplitude: 0.5 }));
    const value = await ctx.saveOutputFile({ kind: 'audio', ext: '.wav', sourceFile: file, prompt: inputs.prompt.value, cost: tools.musicEstimateUsd(seconds * 1000), duration: seconds });
    await assets.removeScratchDir(scratch);
    musicCalls.push({ prompt: inputs.prompt.value, length: seconds, instrumental: params.instrumental });
    return { variants: [{ audio: value }], cost: { usd: tools.musicEstimateUsd(seconds * 1000) } };
  };
  // the loudness of the film in a window (largest sample, 0 to 1)
  const loudness = async (file, from, to) => {
    const { samples, rate } = await media.pcm(file);
    let peak = 0;
    for (let at = Math.floor(from * rate); at < Math.min(samples.length, Math.floor(to * rate)); at += 1) peak = Math.max(peak, Math.abs(samples[at]));
    return peak;
  };

  const reset = () => {
    calls.length = 0;
    journal.length = 0;
    musicCalls.length = 0;
    renders.length = 0;
    pictures.length = 0;
    lipsync.length = 0;
    eleven.calls.length = 0;
    answers.plan.length = 0;
    answers.research.length = 0;
  };

  const registry = nodeRegistry.createRegistry();
  for (const type of real.list ? real.list().map((def) => def.type) : []) {
    if (type === 'image.generate') registry.register({ ...imageDef, available: () => true, prepare: undefined, execute: imageExecute });
    else if (type === 'audio.music') registry.register({ ...musicDef, available: () => true, prepare: undefined, execute: musicExecute });
    else if (type === 'fal.h3_lipsync') registry.register({ ...lipsyncDef, available: () => true, prepare: undefined, validate: undefined, execute: lipsyncExecute });
    else registry.register(real.get(type));
  }
  const bus = createEventBus();
  const flowStore = createWorkflowsStore({ dir: path.join(iso.root, 'data', 'workflows-explainer-video'), registry, events: bus });
  const engine = createEngine({
    store: flowStore,
    registry,
    events: bus,
    getConfig: () => ({ imageModel: 'openai/gpt-image-2', defaultBrain: 'vendor/default-brain', brainModels: ['vendor/default-brain'] }),
    limits: { jobPollMs: 20 }
  });
  const resultOf = async (workflowId, nodeId) => (await flowStore.readResults(workflowId)).nodes[nodeId].history[0];
  const writerCalls = () => calls.filter((call) => call.kind === 'writer');
  const sceneNumber = (call) => Number(/Scene s(\d+)/.exec(call.options.prompt)[1]);

  /* ----- the topic version: the planner alone, then the edited script and everything ----- */
  {
    const created = (await flowStore.createWorkflow({ document: templates.resolveTemplate('explainer-video-topic', { lang: 'de' }), user: STAFF, owner: null })).workflow;
    const id = created.id;
    // fewer, quicker: the film in 720p
    const graph = JSON.parse(JSON.stringify(created.graph));
    Object.assign(graph.nodes.find((node) => node.id === 'n9').params, { resolution: '720p', fps: '30' });
    await flowStore.saveGraph(id, { baseRev: created.rev, graph });

    // the plan before anything ran: valid, the sum is not known (the research and the script decide the length)
    const plan0 = await engine.plan(id, { mode: 'all', user: STAFF });
    assert.equal(plan0.valid, true, JSON.stringify(plan0.issues));
    assert.equal(plan0.nodes.n5.estimate, null, 'the voice has no price before the script is known');
    assert.equal(plan0.nodes.n8.executions, null, 'how many scenes there are comes from the script');
    assert.ok(plan0.totals.unknownNodes >= 3);

    // step 1: only the planner (the research it needs runs with it)
    reset();
    answers.plan.push(planAnswer());
    const first = await engine.start(id, { mode: 'node', nodeIds: ['n4'], user: STAFF });
    const firstRecord = await engine.whenFinished(id, first);
    assert.equal(firstRecord.status, 'completed', JSON.stringify(firstRecord.nodes).slice(0, 600));
    assert.deepEqual(calls.map((call) => call.kind), ['research', 'plan', 'verify'], 'research, script and check: nothing more');
    assert.equal(eleven.calls.length, 0, 'no voice yet');
    assert.equal(renders.length, 0, 'no scene yet');
    assert.equal(pictures.length, 0, 'no picture yet');
    const planResult = await resultOf(id, 'n4');
    const script = JSON.parse(planResult.variants[0].script.value);
    assert.equal(script.scenes.length, 13, '12 scenes and the sources card');
    assert.deepEqual(script.scenes.filter((item) => item.kind === 'still').map((item) => item.id), ['s3', 's7']);
    assert.equal(planResult.variants[0].narration.items.length, 13);
    near(planResult.cost.usd, USD.plan + USD.verify, 1e-9);

    // the person changes a title in the script and runs everything: the edited script is only checked, with no new model call
    script.scenes[0].on_screen.title = 'Titel 1 geändert';
    script.scenes[0].elements[0].content = 'Titel 1 geändert';
    reset();
    const runId = await engine.start(id, { mode: 'all', user: STAFF, overrides: { n4: { script: JSON.stringify(script) } } });
    const record = await engine.whenFinished(id, runId);
    assert.equal(record.status, 'completed', JSON.stringify(record.nodes).slice(0, 800));
    assert.deepEqual(calls.filter((call) => ['research', 'plan', 'verify'].includes(call.kind)), [], 'the research is kept and the edited script is not planned again');
    assert.equal(writerCalls().length, 13, 'one scene model call for every scene');
    assert.equal(eleven.calls.length, 12, 'twelve voices: the sources card has no narration and costs nothing');
    assert.equal(renders.length, 13, 'one render for every scene');

    // every scene got its own brief and its own voice: the title in the picture is the title of the scene, its length is its voice
    const planned = JSON.parse((await resultOf(id, 'n4')).variants[0].script.value);
    const texts = planned.scenes.map((item) => item.narration);
    const byScene = new Map();
    for (const call of writerCalls()) byScene.set(sceneNumber(call), { call });
    assert.equal(byScene.size, 13, 'every scene was written once, the sources card included');
    assert.match(byScene.get(1).call.options.prompt, /Titel 1 geändert/, 'the edited title is in the brief of scene 1');
    for (let index = 0; index < 12; index += 1) {
      const entry = byScene.get(index + 1);
      assert.ok(entry, `scene ${index + 1} was written`);
      const characters = [...texts[index]].length;
      const expected = cuesLib.sceneDuration(characters * SECONDS_PER_CHAR + 0.1);
      // the voice is measured from the audio (the length of the tone), the scene is that and a pause of 0.4 s, in whole frames
      near(durationOf(entry.call.options.system), expected, 0.12, `scene ${index + 1} is as long as its own voice plus the pause`);
    }
    // the stills (scenes 3 and 7): the picture of the scene is attached to the scene that has it, and to no other
    assert.equal(pictures.length, 2);
    assert.deepEqual(pictures.map((item) => item.prompt), ['Bild der Szene 3', 'Bild der Szene 7'], 'the prompts of the stills, in the order of the scenes');
    assert.ok(pictures.every((item) => item.ratio === '16:9'), 'landscape pictures');
    for (let k = 1; k <= 12; k += 1) {
      const attached = /\{\{asset:\d+\}\} = image/.test(byScene.get(k).call.options.prompt);
      assert.equal(attached, k === 3 || k === 7, `scene ${k}: ${attached ? 'has' : 'has no'} a picture attached`);
    }

    // the cut: as long as the scenes less the overlaps, the voice in it, captions and subtitle file
    const final = (await resultOf(id, 'n9')).variants[0];
    const file = assets.assetFilePath(final.video);
    const info = await media.probe(file);
    assert.deepEqual([info.width, info.height], [1280, 720]);
    assert.equal(info.hasAudio, true);
    const sceneLengths = renders.map((entry) => durationOf(entry.html));
    const total = sceneLengths.reduce((sum, value) => sum + value, 0);
    near(info.duration, total - 12 * (8 / 30), 0.4, 'the scenes one after the other, a crossfade of 8 frames between them');
    const srt = final.subtitles.value;
    assert.match(srt, /^1\n\d\d:\d\d:\d\d,\d\d\d --> /);
    assert.ok((srt.match(/-->/g) || []).length >= 12, 'a caption for the narration of every scene');
    assert.ok(final.captions && JSON.parse(final.captions.value).lines.length >= 12, 'the captions as data');
    const scripts = await standIn.scripts();
    assert.equal(scripts.length, 1, 'the encoder draws the captions once');
    // the music: made once, instrumental, as long as the default film, and under the whole film (the sources card has no voice: only music)
    assert.equal(musicCalls.length, 1, 'one piece of music for the whole film');
    assert.equal(musicCalls[0].instrumental, true);
    assert.equal(musicCalls[0].length, 120);
    assert.match(musicCalls[0].prompt, /no vocals|ohne Gesang/);
    near((await resultOf(id, 'n14')).cost.usd, 0.4, 1e-9, 'two minutes of music at 0.20 USD a minute');
    const quietTail = await loudness(file, info.duration - 3.2, info.duration - 1.4);
    assert.ok(quietTail > 0.01 && quietTail < 0.12, `music is heard under the card without a voice, but quietly: ${quietTail}`);
    // the result nodes
    assert.equal(((await resultOf(id, 'n10')).variants[0].result.items?.[0] || (await resultOf(id, 'n10')).variants[0].result).assetId, final.video.assetId);
    assert.match((await resultOf(id, 'n11')).variants[0].result.items?.[0]?.value || (await resultOf(id, 'n11')).variants[0].result.value, /-->/);
    assert.equal(JSON.parse((await resultOf(id, 'n12')).variants[0].result.items[0].value).scenes.length, 13);
    assert.match((await resultOf(id, 'n13')).variants[0].result.items[0].value, /Agentur/);

    // the money: the voices booked by their characters, the scenes by what the model charged, the pictures by the image model
    const spoken = journal.filter((entry) => entry.type === 'speech');
    assert.equal(spoken.length, 12);
    const voiceTotal = texts.filter(Boolean).reduce((sum, text) => sum + tools.speechEstimateUsd(text, 'eleven_v4'), 0);
    near(spoken.reduce((sum, entry) => sum + entry.cost, 0), voiceTotal, 1e-6, 'the voices are booked by their characters');
    const sceneCost = (await resultOf(id, 'n8')).cost;
    assert.ok(sceneCost && sceneCost.usd > 0, 'the scenes carry the cost of the model');
    const imageCost = (await resultOf(id, 'n7')).cost;
    near(imageCost.usd, 0.08, 1e-9, 'two pictures');

    // the plan after the run (everything before is up to date, so the lists are known): the scenes and the voices have their prices
    const planScenes = await engine.plan(id, { mode: 'all', user: STAFF, overrides: { n8: { quality: 'high' } } });
    assert.equal(planScenes.valid, true, JSON.stringify(planScenes.issues));
    assert.equal(planScenes.nodes.n8.executions, 13, 'one scene model call for every scene');
    near(planScenes.nodes.n8.estimate.usd, 0.1, 1e-9, '0.10 USD per scene');
    const planVoice = await engine.plan(id, { mode: 'all', user: STAFF, overrides: { n5: { model_id: 'eleven_flash_v2_5' } } });
    assert.equal(planVoice.nodes.n5.executions, 13);
    const flashTotal = texts.filter(Boolean).reduce((sum, text) => sum + tools.speechEstimateUsd(text, 'eleven_flash_v2_5'), 0);
    near(planVoice.nodes.n5.estimate.usd * planVoice.nodes.n5.executions, flashTotal, 1e-6, 'the voice is priced by the characters of all scenes and by the model');
    assert.ok(flashTotal < voiceTotal, 'the cheaper model is cheaper');
    assert.deepEqual(await fsp.readdir(store.sessionAssetDir(created.sessionId)).then((names) => names.filter((name) => name.startsWith('.nodes-'))), [], 'no scratch folder is left');
  }

  /* ----- the PDF version: page images, a figure cut out of its page, the title of the document in the sources ----- */
  if (iso.load('lib/documents').binaries().available) {
    reset();
    const created = (await flowStore.createWorkflow({ document: templates.resolveTemplate('explainer-video', { lang: 'de' }), user: STAFF, owner: null })).workflow;
    const id = created.id;
    const pdf = makePdf(
      [
        ['Der Markt für Wärmepumpen wächst jedes Jahr.', 'Im Jahr 2025 wurden 42 000 Geräte verkauft.'].join('\n'),
        ['Die Jahresarbeitszahl liegt bei etwa 4.', 'Das heisst: aus 1 kWh Strom werden 4 kWh Wärme.'].join('\n')
      ],
      { title: 'Marktbericht' }
    );
    const scratch = await assets.createScratchDir(created.sessionId);
    await fsp.writeFile(path.join(scratch, 'upload.pdf'), pdf);
    const value = await assets.saveUploadFile(created.sessionId, { sourceFile: path.join(scratch, 'upload.pdf'), ext: '.pdf', name: 'Marktbericht.pdf' });
    await assets.removeScratchDir(scratch);
    const graph = JSON.parse(JSON.stringify(created.graph));
    graph.nodes.find((node) => node.id === 'n1').params.assets = [{ assetId: value.assetId, sessionId: created.sessionId }];
    Object.assign(graph.nodes.find((node) => node.id === 'n8').params, { resolution: '720p', fps: '30' });
    await flowStore.saveGraph(id, { baseRev: created.rev, graph });
    answers.plan.push(planAnswer({ refs: ['S. 1', 'S. 2'], figure: { scene: 2, page: 2, bbox: [10, 20, 50, 30] } }));
    const runId = await engine.start(id, { mode: 'all', user: STAFF });
    const record = await engine.whenFinished(id, runId);
    assert.equal(record.status, 'completed', JSON.stringify(record.nodes).slice(0, 800));
    // the pages were rendered as images (all of them) and handed to the scenes with their info
    const read = await resultOf(id, 'n2');
    const info = JSON.parse(read.variants[0].info.value);
    assert.equal(info.documents[0].title, 'Marktbericht');
    assert.equal(read.variants[0].pages.items.length, 2, 'both pages as images (page images: all)');
    assert.equal(writerCalls().length, 13);
    // scene 2 got the figure (the cut of page 2), the stills got their pictures, the other scenes got nothing attached
    const attachedTo = (k) => (writerCalls().find((call) => sceneNumber(call) === k).options.prompt.match(/\{\{asset:\d+\}\} = image/g) || []).length;
    assert.equal(attachedTo(2), 1, 'the figure of scene 2');
    assert.match(writerCalls().find((call) => sceneNumber(call) === 2).options.prompt, /a figure cut out of a page of the document/);
    assert.deepEqual([1, 3, 4, 5, 6, 7, 8].map(attachedTo), [0, 1, 0, 0, 0, 1, 0], 'the stills of scenes 3 and 7, nothing else');
    // the source line of the scenes names the document by its title, not by its file name; the app puts it into the code of the scene, the
    // model is never told its text
    const renderOf = (k) => renders.find((entry) => entry.html.includes(`>Titel ${k}</h1>`));
    assert.match(renderOf(1).html, /<div id="oc-source"[^>]*>Marktbericht, S\. 1<\/div>/);
    assert.match(renderOf(2).html, /<div id="oc-source"[^>]*>Marktbericht, S\. 2<\/div>/);
    assert.ok(writerCalls().filter((call) => sceneNumber(call) <= 12).every((call) => !/Marktbericht/.test(call.options.prompt)), 'the model does not see the source line');
    // the closing card of the sources has ONE line for the document, with both pages
    assert.match(writerCalls().find((call) => sceneNumber(call) === 13).options.prompt, /Title: Quellen\nBullets:\n- Marktbericht \(S\. 1, 2\)\n/);
    assert.equal(pictures.length, 2);
    const final = (await resultOf(id, 'n8')).variants[0];
    assert.equal((await media.probe(assets.assetFilePath(final.video))).hasAudio, true);
    assert.equal(JSON.parse((await resultOf(id, 'n11')).variants[0].result.items[0].value).scenes.length, 13);
  } else {
    console.log('poppler not found: the run of the PDF version is skipped');
  }

  /* ----- the presenter version: portrait, intro and outro are the lip-sync clips ----- */
  {
    reset();
    const created = (await flowStore.createWorkflow({ document: templates.resolveTemplate('explainer-video-presenter', { lang: 'de' }), user: STAFF, owner: null })).workflow;
    const id = created.id;
    const photo = await store.saveAsset(created.sessionId, {
      kind: 'upload',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
      ext: '.png',
      prompt: 'presenter'
    });
    const graph = JSON.parse(JSON.stringify(created.graph));
    graph.nodes.find((node) => node.id === 'n14').params.asset = { assetId: photo.id, sessionId: created.sessionId };
    Object.assign(graph.nodes.find((node) => node.id === 'n9').params, { resolution: '720p', fps: '30' });
    await flowStore.saveGraph(id, { baseRev: created.rev, graph });
    answers.plan.push(planAnswer({ presenter: true }));
    const runId = await engine.start(id, { mode: 'all', user: STAFF });
    const record = await engine.whenFinished(id, runId);
    assert.equal(record.status, 'completed', JSON.stringify(record.nodes).slice(0, 800));
    // 12 scenes plus the two lines of the presenter (voices: 12 + 2)
    assert.equal(eleven.calls.length, 14);
    assert.equal(eleven.calls.filter((call) => !('previous_text' in call.body) && !('next_text' in call.body)).length >= 2, true, 'the lines of the presenter are spoken without the scene around them');
    assert.equal(lipsync.length, 2, 'one lip-sync clip for the intro and one for the outro');
    assert.ok(pictures.every((item) => item.ratio === '9:16'), 'portrait pictures');
    assert.ok(renders.every((entry) => sizeOf(entry.html).width === 1080 || sizeOf(entry.html).width < sizeOf(entry.html).height), 'portrait scenes');
    const final = (await resultOf(id, 'n9')).variants[0];
    const file = assets.assetFilePath(final.video);
    const info = await media.probe(file);
    assert.deepEqual([info.width, info.height], [720, 1280], 'a portrait film');
    assert.equal(info.hasAudio, true);
    // the film starts with the intro (its colour) and ends with the outro (the same colour), the scenes are between
    const intro = lipsync[0].seconds;
    const outro = lipsync[1].seconds;
    const colourStart = await media.rgbAt(file, Math.min(0.5, intro / 2));
    const colourEnd = await media.rgbAt(file, info.duration - Math.min(0.5, outro / 2));
    assert.ok(colourStart[1] > colourStart[0] && colourStart[1] > colourStart[2], `the intro is the green clip: ${colourStart}`);
    assert.ok(colourEnd[1] > colourEnd[0] && colourEnd[1] > colourEnd[2], `the outro is the green clip: ${colourEnd}`);
    const middle = await media.rgbAt(file, intro + 2);
    assert.ok(!(middle[1] > middle[0] + 40 && middle[1] > middle[2] + 40), `the scenes are between: ${middle}`);
    const sceneTotal = renders.reduce((sum, entry) => sum + durationOf(entry.html), 0);
    near(info.duration, intro + outro + sceneTotal - 12 * (8 / 30), 0.8, 'intro, scenes and outro one after the other');
    // the lip sync is booked with its price
    assert.ok((await resultOf(id, 'n13')).cost.usd > 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
