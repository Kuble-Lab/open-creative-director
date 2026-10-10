'use strict';

// The template "Event video (aftermovie)" (WP53, package D): lib/nodes/templates/event-video.json, the nodes of the event video in the registry and
// their texts in public/nodes/i18n-nodes.js. No network, nothing paid, no engine run (the whole chain runs in test-event-video-chain.js).
//   graph       the template loads and validates, its shape follows spec §2, requires is complete
//   texts       the template in en/de/es with the same keys, every node, port, setting, option and error code in de/en/es, no sharp s, no
//               name of the maker on screen, the hint about the consent of the people shown
//   steps       two steps: the music, the board and the chosen shots first (analysis, music and plan), then the rest
//   cost        the prices of the description, recomputed from the estimate of the planner with the real prices of the nodes
//   photos      an event of photos only is valid; the plan node refuses an empty description and too little material before anything is paid
//   cache       the cache keys of every node of the other templates are the ones of main (a digest of all of them)

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const registry = require('../lib/nodes/registry');
const templates = require('../lib/nodes/templates');
const engine = require('../lib/nodes/engine');
const contract = require('../lib/event-video/contract');
const plan = require('../lib/event-video/plan');
const styles = require('../lib/event-video/styles');
const eventNodes = require('../lib/nodes/nodes-event-video');
const { rows } = require('../public/nodes/i18n-nodes.js');

const EVENT_TYPES = ['event_video.analyze', 'event_video.style', 'event_video.music', 'event_video.plan', 'event_video.cut', 'event_video.render'];
const LANGS = ['en', 'de', 'es'];
const I18N = Object.fromEntries(LANGS.map((lang, index) => [lang, Object.fromEntries(rows.map((row) => [row[0], row[index === 0 ? 2 : index === 1 ? 1 : 3]]))]));
const template = templates.loadTemplates().find((item) => item.id === 'event-video');
const resolved = (lang) => templates.resolveTemplate('event-video', { lang });
const nodeOf = (doc, id) => doc.graph.nodes.find((node) => node.id === id);
const edgeList = (doc) => doc.graph.edges.map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`);
const strings = (value, out = []) => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => strings(item, out));
  return out;
};

/* ---------- graph ---------- */

function testGraph() {
  assert.ok(template, 'the template is loaded');
  const result = templates.validateTemplate(template);
  assert.equal(result.graph.nodes.length, 23);
  assert.deepEqual(template.requires, ['openrouter', 'ffmpeg', 'elevenlabs', 'fal', 'rendernode']);
  assert.ok(templates.ORDER.includes('event-video'));
  const doc = resolved('en');
  const types = Object.fromEntries(doc.graph.nodes.map((node) => [node.id, node.type]));
  assert.deepEqual(types, {
    n1: 'input.media_list', n2: 'input.media_list', n3: 'input.prompt', n4: 'input.branding', n5: 'input.media_list',
    n0: 'event_video.style', n6: 'event_video.analyze', n7: 'event_video.analyze', n8: 'event_video.music', n9: 'audio.beats', n10: 'event_video.plan',
    n11: 'fal.h3_video', n12a: 'fal.depth_map', n12: 'image.to_video', n13: 'audio.tts', n14: 'event_video.cut', n15: 'event_video.render',
    n20: 'output.result', n21: 'output.result', n22: 'output.result', n23: 'output.result', n24: 'output.result', n25: 'output.result'
  });
  assert.deepEqual([nodeOf(doc, 'n1').params.kind, nodeOf(doc, 'n2').params.kind, nodeOf(doc, 'n5').params.kind], ['video', 'image', 'audio']);
  for (const id of ['n1', 'n2', 'n5']) assert.deepEqual(nodeOf(doc, id).params.assets, [], `${id} starts empty`);
  // the edges of spec §2: the same lists to the analysis, the plan and the cut; the style to the music and the plan, the format to the cut and the render
  const edges = edgeList(doc);
  assert.equal(edges.length, 41);
  for (const edge of [
    'n1.items>n6.media', 'n2.items>n7.media', 'n1.items>n10.videos', 'n2.items>n10.photos', 'n6.info>n10.video_info', 'n7.info>n10.photo_info',
    'n3.prompt>n10.brief', 'n0.style>n8.style', 'n0.style>n10.style', 'n5.items>n8.own', 'n8.audio>n9.audio', 'n8.audio>n10.music', 'n9.analysis>n10.music_analysis',
    'n10.ai_photos>n11.first_frame', 'n10.ai_prompts>n11.prompt', 'n10.parallax_photos>n12a.image', 'n10.parallax_photos>n12.image', 'n12a.depth>n12.depth',
    'n10.vo_lines>n13.text', 'n10.shots>n14.shots', 'n0.format>n14.format', 'n1.items>n14.videos', 'n2.items>n14.photos', 'n11.video>n14.ai_clips',
    'n12.video>n14.parallax_clips', 'n14.video>n15.video', 'n14.nat>n15.nat', 'n10.graphics>n15.graphics', 'n0.format>n15.format', 'n8.audio>n15.music',
    'n13.audio>n15.voice', 'n4.logo>n15.logo', 'n15.video>n20.inputs', 'n15.sheet>n21.inputs', 'n15.subtitles>n22.inputs', 'n8.audio>n23.inputs',
    'n10.board>n24.inputs', 'n10.selection>n25.inputs'
  ]) {
    assert.ok(edges.includes(edge), `edge ${edge}`);
  }
  // cheap and careful defaults: photos moved by code, no voice, AI clips from the photo as it is (no prompt expansion), the voice with Eleven v4
  assert.equal(nodeOf(doc, 'n10').params.photo_motion, 'code');
  assert.equal(nodeOf(doc, 'n10').params.voiceover, false);
  assert.equal(nodeOf(doc, 'n11').params.prompt_expansion, 'disabled');
  assert.equal(nodeOf(doc, 'n11').params.model, 'turbo');
  assert.equal(nodeOf(doc, 'n13').params.model_id, 'eleven_v4');
  assert.deepEqual(nodeOf(doc, 'n0').params, { event_type: 'conference', mood: 'fresh', length: '60', format: '16:9', language: 'en' });
  // the language of the texts follows the language of the interface
  assert.deepEqual(LANGS.map((lang) => nodeOf(resolved(lang), 'n0').params.language), ['en', 'de', 'es']);
  // the app: the fields of spec §2 (both media lists optional, a description, the style, the motion of the photos, the voice, the branding, own music)
  assert.deepEqual(doc.app.inputs.map((entry) => `${entry.node}.${entry.param}`), [
    'n1.assets', 'n2.assets', 'n3.prompt', 'n0.event_type', 'n0.mood', 'n0.length', 'n0.format', 'n10.photo_motion', 'n10.voiceover', 'n0.language', 'n4.branding', 'n5.assets'
  ]);
  assert.deepEqual(doc.app.outputs.map((entry) => entry.node), ['n20', 'n21', 'n22', 'n23', 'n24', 'n25']);
}

/* ---------- texts ---------- */

function testTexts() {
  // the template: German and Spanish translate the same keys, every node title, note and app text
  const de = Object.keys(template.i18n.de).sort();
  assert.deepEqual(Object.keys(template.i18n.es).sort(), de, 'de and es translate the same keys');
  for (const key of ['name', 'description', 'app.title', 'app.description', 'app.hint.n25', 'note.t1', 'note.t2']) assert.ok(de.includes(key), key);
  for (const entry of template.app.inputs) assert.ok(de.includes(`app.input.${entry.node}.${entry.param}`), `the field ${entry.node}.${entry.param}`);
  for (const entry of template.app.outputs) assert.ok(de.includes(`app.output.${entry.node}`), `the output ${entry.node}`);
  assert.equal(resolved('de').name, 'Event-Video (Aftermovie)');
  assert.equal(resolved('es').name, 'Vídeo de evento (aftermovie)');
  // the consent of the people shown: in the description, in the app and at the approval of the chosen shots, in every language
  const consent = { en: /agree/, de: /einverstanden/, es: /de acuerdo/ };
  for (const lang of LANGS) {
    const doc = resolved(lang);
    for (const text of [doc.description, doc.app.description, doc.app.outputs.find((entry) => entry.node === 'n25').hint]) assert.match(text, consent[lang], `${lang}: consent`);
    assert.match(I18N[lang]['nodes.paramhint.event_video.plan.photo_motion'], consent[lang], `${lang}: consent at the motion of the photos`);
  }
  // the nodes: label, keywords (at least three phrases), help, example and a tip; every port, setting and option; every error code of the contract
  const defs = EVENT_TYPES.map((type) => registry.get(type));
  for (const lang of LANGS) {
    const t = I18N[lang];
    for (const def of defs) {
      for (const key of ['label', 'help', 'example', 'tip.1']) assert.ok(t[`nodes.type.${def.type}.${key}`], `${lang}: ${def.type}.${key}`);
      assert.ok(t[`nodes.type.${def.type}.keywords`].split(',').length >= 3, `${lang}: ${def.type} keywords`);
      for (const port of [...def.inputs, ...def.outputs]) assert.ok(t[`nodes.port.${port.id}`], `${lang}: port ${port.id}`);
      for (const param of def.params) {
        assert.ok(t[`nodes.param.${param.id}`], `${lang}: param ${param.id}`);
        if (param.kind !== 'select' || !Array.isArray(param.options)) continue;
        for (const option of [...param.options, ...(param.hiddenOptions || [])]) {
          const value = String(typeof option === 'object' ? option.value : option);
          if (/^[\d.:]+$/.test(value) || /^[a-z]+\/[\w.-]+$/.test(value) || /^music_v/.test(value)) continue;
          assert.ok(t[`nodes.option.${param.id}.${value}`] || t[`nodes.option.${value}`], `${lang}: option ${param.id}.${value}`);
        }
      }
    }
    for (const code of Object.values(contract.ERRORS)) assert.ok(t[`nodes.issue.${code}`], `${lang}: issue ${code}`);
  }
  // festival is read (an alias of party) but not offered
  const style = registry.get('event_video.style');
  const eventType = style.params.find((param) => param.id === 'event_type');
  assert.deepEqual(eventType.options, contract.EVENT_TYPES.slice());
  assert.ok(!eventType.options.includes('festival') && eventType.hiddenOptions.includes('festival'));
  assert.deepEqual(registry.checkParams(style, registry.normalizeParams(style, { event_type: 'festival' })), [], 'festival is a valid value');
  assert.equal(registry.checkParams(style, registry.normalizeParams(style, { event_type: 'rave' })).length, 1, 'an unknown kind is not');
  assert.ok(!registry.publicDescriptor(style).params.find((param) => param.id === 'event_type').options.some((option) => (option.value ?? option) === 'festival'), 'the list of the page shows six kinds');
  // Swiss spelling, and no name of the maker on the screen
  const own = rows.filter((row) => /event_video|EVENT(STYLE|MEDIA|MUSIC|PLAN|CUT|RENDER)_/.test(row[0]));
  assert.ok(own.length >= 100, `${own.length} rows of the event video`);
  for (const text of [...own.flatMap((row) => row.slice(1)), ...strings(template)]) {
    assert.ok(!/ß/.test(text), `no sharp s: ${text.slice(0, 60)}`);
    assert.ok(!/kuble/i.test(text), `no maker on screen: ${text.slice(0, 60)}`);
  }
}

/* ---------- the two steps ---------- */

function loadStageLogic() {
  const ui = { el: () => ({}), icon: () => ({}), T: (key) => key };
  const window = { OCDNodes: { graph: {}, ui, api: {}, run: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'nodes', 'app-mode.js'), 'utf8'), { window, localStorage: undefined, console });
  const raw = window.OCDNodes.appMode;
  const plain = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  return { approvalStages: (...args) => plain(raw.approvalStages(...args)), stageFlow: (...args) => plain(raw.stageFlow(...args)) };
}

function planOf(graph, request) {
  const ready = { ...registry.registry, availability: () => true };
  const workflow = { graph };
  return engine.computePlan({ workflow, results: { nodes: {} }, request: engine.normaliseRequest(request, workflow, ready), registry: ready, limits: engine.resolveLimits() });
}

function testSteps() {
  const logic = loadStageLogic();
  const doc = resolved('de');
  const stages = logic.approvalStages(doc.app.outputs, (id) => doc.graph.nodes.some((node) => node.id === id));
  assert.deepEqual(stages, [['n23', 'n24', 'n25']], 'one stage: the music, the board and the chosen shots');
  const nothing = logic.stageFlow({ stages, overrides: {}, previews: [null], all: null });
  assert.deepEqual([nothing.index, nothing.total, nothing.done, nothing.request.mode], [0, 2, false, 'selection'], 'step 1 of 2');
  const cached = { nodes: { n23: { status: 'cached' }, n24: { status: 'cached' }, n25: { status: 'cached' } } };
  const second = logic.stageFlow({ stages, overrides: {}, previews: [cached], all: { nodes: { n15: { status: 'ready' } } } });
  assert.deepEqual([second.index, second.request.mode], [1, 'all'], 'then "Approve and finish" makes the rest');
  // step 1 runs the analysis, the music and the plan; the AI clips, the depth maps, the voice, the cut and the render wait for the approval
  const graph = JSON.parse(JSON.stringify(doc.graph));
  nodeOf({ graph }, 'n3').params.prompt = 'Innovation Day 2026';
  const first = planOf(graph, { mode: 'selection', nodeIds: stages[0] });
  assert.deepEqual([...first.order].sort(), ['n0', 'n1', 'n10', 'n2', 'n23', 'n24', 'n25', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9'].sort());
  const paidFirst = Object.entries(first.nodes).filter(([, entry]) => entry.paid).map(([id]) => id).sort();
  assert.deepEqual(paidFirst, ['n10', 'n6', 'n7', 'n8'], 'step 1 pays the analysis, the music and the planner');
  const whole = planOf(graph, { mode: 'all' });
  for (const id of ['n11', 'n12a', 'n13', 'n14', 'n15']) assert.ok(whole.order.includes(id) && !first.order.includes(id), `${id} runs in step 2`);
}

/* ---------- the prices of the description ---------- */

function testCostText() {
  const prices = eventNodes.planPrices('anthropic/claude-opus-5.5');
  const cpm = styles.derive(styles.combineStyle({})).cpm;
  const voiceChars = { 30: 360, 60: 720, 90: 1000 };
  const one = (value) => Math.round(value * 10) / 10;
  const rows60 = {};
  for (const length of [30, 60, 90]) {
    const clips = plan.CLIPS_BY_LENGTH[length];
    const e = plan.estimate(
      {
        items: plan.TYPICAL_MATERIAL.videos + plan.TYPICAL_MATERIAL.photos,
        speechSeconds: plan.TYPICAL_MATERIAL.speechSeconds,
        musicSeconds: length + eventNodes.MUSIC_EXTRA_SECONDS,
        picks: Math.round((cpm * length) / 60),
        promptChars: plan.typicalPromptChars(),
        aiClips: clips,
        depthMaps: clips,
        voiceChars: voiceChars[length]
      },
      prices
    );
    const p = e.parts;
    const code = p.vision + p.speech + p.music + p.llm + p.depth;
    const row = { code: one(code), ai: one(p.ai), voice: Math.round(p.voice * 100) / 100, stepOne: one(p.vision + p.speech + p.music + p.llm), max: one(code + p.ai + p.voice + p.llm) };
    if (length === 60) Object.assign(rows60, row);
    assert.equal(row.code, { 30: 0.8, 60: 1.0, 90: 1.2 }[length], `${length} s with the code motion: ${code}`);
    assert.equal(row.ai, { 30: 0.4, 60: 0.8, 90: 1.2 }[length], `${length} s: the AI clips add ${p.ai}`);
  }
  assert.deepEqual(rows60, { code: 1.0, ai: 0.8, voice: 0.06, stepOne: 0.9, max: 2.2 }, 'the numbers of 60 seconds');
  const say = {
    en: [/about 0\.8 US dollars for 30 seconds, 1\.0 for 60 and 1\.2 for 90 seconds/, /adds about 0\.4, 0\.8 or 1\.2/, /voice-over about 0\.06/, /about 0\.9 for 60 seconds/, /At most about 2\.2 for 60 seconds/],
    de: [/etwa 0\.8 US-Dollar für 30 Sekunden, 1\.0 für 60 und 1\.2 für 90 Sekunden/, /etwa 0\.4, 0\.8 oder 1\.2 mehr/, /Sprecherstimme etwa 0\.06/, /etwa 0\.9 für 60 Sekunden/, /Höchstens etwa 2\.2 für 60 Sekunden/],
    es: [/unos 0\.8 dólares para 30 segundos, 1\.0 para 60 y 1\.2 para 90 segundos/, /añade unos 0\.4, 0\.8 o 1\.2/, /voz en off unos 0\.06/, /unos 0\.9 para 60 segundos/, /Como máximo unos 2\.2 para 60 segundos/]
  };
  for (const lang of LANGS) {
    const text = resolved(lang).description;
    for (const pattern of say[lang]) assert.match(text, pattern, `${lang}: ${pattern}`);
    assert.match(text, { en: /nothing is charged before you confirm/, de: /vor deiner Bestätigung wird nichts berechnet/, es: /no se cobra nada antes de que confirmes/ }[lang]);
  }
  // the gallery: the uploads are lists, so each priced node counts once (an analysis, the music at its longest, one AI clip, one depth map)
  assert.deepEqual(templates.costSummary(template), { kind: 'partial', usd: 0.5287, credits: 0, paidNodes: 7, providers: ['openrouter', 'elevenlabs', 'fal'] });
}

/* ---------- an event of photos only ---------- */

function testPhotosOnly() {
  const doc = resolved('de');
  const graph = JSON.parse(JSON.stringify(doc.graph));
  nodeOf({ graph }, 'n2').params.assets = Array.from({ length: 14 }, (_, index) => ({ assetId: `upload-${String(index + 1).padStart(3, '0')}`, sessionId: 'event' }));
  nodeOf({ graph }, 'n3').params.prompt = 'KI Leadership Event, Zürich';
  for (const request of [{ mode: 'all' }, { mode: 'selection', nodeIds: ['n23', 'n24', 'n25'] }]) {
    const result = planOf(graph, request);
    assert.equal(result.valid, true, JSON.stringify(result.issues));
    assert.deepEqual(result.issues.map((issue) => [issue.nodeId, issue.level]), [['n1', 'warning'], ['n5', 'warning']], 'only the empty lists of the videos and the own music are named');
  }
  // the checks of the plan node before anything is paid (data.node and data.field name the field of the form)
  const def = registry.get('event_video.plan');
  const params = registry.normalizeParams(def, {});
  const connect = (sources) => ({ connected: sources.length > 0, count: sources.length, sources });
  const lists = (videos, photos) => ({
    videos: connect(videos ? [{ node: 'n1', type: 'input.media_list', params: { kind: 'video', assets: new Array(videos).fill({ assetId: 'v' }) } }] : []),
    photos: connect([{ node: 'n2', type: 'input.media_list', params: { kind: 'image', assets: new Array(photos).fill({ assetId: 'p' }) } }])
  });
  const brief = (text) => ({ brief: connect([{ node: 'n3', type: 'input.prompt', params: { prompt: text } }]) });
  assert.deepEqual(def.validate(params, { ...brief('Innovation Day'), ...lists(0, 14) }), [], '14 photos and no video');
  assert.deepEqual(def.validate(params, { ...brief('Innovation Day'), ...lists(3, 2) }), [], '3 videos and 2 photos are 5');
  const few = def.validate(params, { ...brief('Innovation Day'), ...lists(0, 4) });
  assert.deepEqual(few.map((issue) => [issue.code, issue.data]), [[contract.ERRORS.EVENTPLAN_NO_MATERIAL, { usable: 4, needed: contract.LIMITS.minUsable }]]);
  const empty = def.validate(params, { ...brief('  '), ...lists(0, 14) });
  assert.deepEqual(empty.map((issue) => [issue.code, issue.port, issue.data]), [[contract.ERRORS.EVENTPLAN_BRIEF_EMPTY, 'brief', { node: 'n3', field: 'prompt' }]]);
  // material that comes from another node is known only when it ran: no count before
  const fromNode = { ...brief('x'), videos: connect([]), photos: connect([{ node: 'n9', type: 'image.generate', params: {} }]) };
  assert.deepEqual(def.validate(params, fromNode), []);
}

/* ---------- the cache keys of the other templates ---------- */

function testOtherCacheKeys() {
  // every node of every other template in every language: type, version and parameters as main has them (WP52a, ac87528). The digest was
  // computed with the code of main; a change here means a node of an existing template would run again
  const lines = [];
  for (const other of templates.loadTemplates()) {
    if (other.id === 'event-video') continue;
    for (const lang of LANGS) {
      for (const node of templates.resolveTemplate(other.id, { lang }).graph.nodes) {
        const def = registry.get(node.type);
        lines.push(`${other.id}/${lang}/${node.id}: ${engine.computeCacheKey(def, registry.normalizeParams(def, node.params || {}), {})}`);
      }
    }
  }
  assert.equal(lines.length, 927);
  assert.equal(crypto.createHash('sha256').update(lines.join('\n')).digest('hex'), 'b1fa95d24bed7fc4fc58116bf4721ad7c5573e5b2d7e718683fada926fc5ac9f');
}

for (const test of [testGraph, testTexts, testSteps, testCostText, testPhotosOnly, testOtherCacheKeys]) {
  test();
  console.log(`ok ${test.name}`);
}
console.log('event video template: ok');
