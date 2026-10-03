'use strict';

// The two starter workflows of the explainer foundation (WP37a): "Explainer video: script from a PDF" (explainer-script) and
// "Explainer video: script for a topic" (explainer-script-topic).
//   - they load and validate against the registry, the requirements are complete (the PDF one needs Poppler), the gallery data
//   - the graph shapes, the Design App, the texts in German, English and Spanish, the cost named in the description
//   - the price in the plan is unknown before the document is read and known afterwards
//   - they run through the real engine: a real PDF (when Poppler is installed) is read, the planner gets the text with the page marks
//     and the file, the script, the lists and the sources come out; the topic one carries the research and its sources to the planner
// The language model is replaced; nothing is paid and nothing leaves the machine.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');

const { createIsolatedApp } = require('./support/isolated-app');
const { makePdf } = require('./support/pdf');

const STAFF = 'staff1@staff.example.com';

const restorers = [];
function restoreAll() {
  while (restorers.length) restorers.pop()();
}
function patch(target, key, value) {
  const original = target[key];
  target[key] = value;
  restorers.push(() => {
    target[key] = original;
  });
}

const VOCAB = ['Strom', 'Wärme', 'Pumpe', 'Kosten', 'Energie', 'Haus', 'Winter', 'Effizienz', 'Boden', 'Luft', 'Wasser', 'Förderung', 'Technik', 'Preis', 'Jahr', 'Markt'];
const narrationOf = (k, n) => Array.from({ length: n }, (_x, i) => `${VOCAB[(i + k) % VOCAB.length]}${k}`).join(' ') + '.';
const planAnswer = (refs) => ({
  title: 'Wärmepumpen',
  summary: 'Wie sie funktionieren',
  scenes: Array.from({ length: 12 }, (_x, i) => {
    const k = i + 1;
    const words = narrationOf(k, 22).replace(/\./g, '').split(' ');
    return {
      kind: 'motion',
      role: k === 1 ? 'hook' : k === 12 ? 'summary' : 'point',
      narration: narrationOf(k, 22),
      on_screen: { title: `Titel ${k}`, bullets: [`Stichwort ${k}`], numbers: [], quote: null },
      elements: [{ type: 'title', content: `Titel ${k}`, anchor: words[0] }, { type: 'bullet', content: `Stichwort ${k}`, anchor: words[5] }],
      figure: null,
      image_prompt: null,
      clip_prompt: null,
      source_refs: [refs[i % refs.length]]
    };
  }),
  presenter: null
});

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
      GTS_API_TOKEN: ''
    }
  });
  try {
    await run(iso);
  } finally {
    restoreAll();
    global.fetch = realFetch;
    await iso.cleanup();
  }
  assert.deepEqual(attempts, [], 'no request left the machine');
  console.log('test-explainer-templates.js: ok');
}

async function run(iso) {
  const templates = iso.load('lib/nodes/templates');
  const nodeRegistry = iso.load('lib/nodes/registry');
  const documents = iso.load('lib/documents');
  const store = iso.load('lib/store');
  const assets = iso.load('lib/nodes/assets');
  const llm = iso.load('lib/nodes/llm');
  const discovery = iso.load('lib/discovery');
  const costs = iso.load('lib/costs');
  const planLib = iso.load('lib/explainer-plan');
  const { createEventBus } = iso.load('lib/nodes/events');
  const { createWorkflowsStore } = iso.load('lib/nodes/workflows-store');
  const { createEngine } = iso.load('lib/nodes/engine');
  const poppler = documents.binaries().available;
  if (!poppler) console.log('poppler not found: the run of the PDF template is skipped');

  const all = templates.loadTemplates();
  const byId = Object.fromEntries(all.map((template) => [template.id, template]));
  const pdfTemplate = byId['explainer-script'];
  const topicTemplate = byId['explainer-script-topic'];
  assert.ok(pdfTemplate && topicTemplate, 'both templates exist');
  assert.ok(templates.ORDER.includes('explainer-script') && templates.ORDER.includes('explainer-script-topic'));
  for (const template of [pdfTemplate, topicTemplate]) {
    const result = templates.validateTemplate(template);
    assert.ok(result.app.enabled && result.app.inputs.length && result.app.outputs.length);
    assert.ok(template.graph.notes.length >= 1);
  }

  /* ---------- shapes ---------- */

  const types = (template) => template.graph.nodes.map((node) => node.type);
  const wires = (template) => template.graph.edges.map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`);
  assert.deepEqual(types(pdfTemplate), ['input.document', 'doc.read', 'explainer.plan', 'output.result', 'output.result']);
  assert.deepEqual(wires(pdfTemplate), ['n1.documents>n2.documents', 'n2.text>n3.text', 'n2.files>n3.documents', 'n3.script>n4.inputs', 'n3.sources>n5.inputs']);
  assert.deepEqual(pdfTemplate.requires, ['openrouter', 'poppler']);
  assert.deepEqual(types(topicTemplate), ['input.prompt', 'llm.research', 'explainer.plan', 'output.result', 'output.result']);
  assert.deepEqual(wires(topicTemplate), ['n1.prompt>n2.topic', 'n2.notes>n3.notes', 'n2.sources>n3.sources', 'n1.prompt>n3.topic', 'n3.script>n4.inputs', 'n3.sources>n5.inputs']);
  assert.deepEqual(topicTemplate.requires, ['openrouter']);
  for (const template of [pdfTemplate, topicTemplate]) {
    const plan = template.graph.nodes.find((node) => node.type === 'explainer.plan');
    assert.equal(plan.params.model, '', 'Opus 5.5 by default: the node decides by the account');
    assert.equal(plan.params.verify, true);
    assert.equal(plan.params.script, '', 'the script ships empty: phase one');
    assert.equal(plan.params.visual_mode, 'mix');
    assert.equal(plan.params.length_seconds, 120);
    assert.deepEqual(nodeRegistry.registry.normalizeParams(nodeRegistry.registry.get('explainer.plan'), plan.params), plan.params, 'every param is one of the node, with a valid value');
    assert.deepEqual(template.app.inputs.map((entry) => `${entry.node}.${entry.param}`).slice(1), ['n3.brief', 'n3.language', 'n3.length_seconds']);
    assert.deepEqual(template.app.outputs.map((entry) => entry.node), ['n4', 'n5']);
  }
  assert.deepEqual(pdfTemplate.app.inputs[0], { node: 'n1', param: 'assets', label: 'PDF or text file' });
  assert.deepEqual(topicTemplate.app.inputs[0], { node: 'n1', param: 'prompt', label: 'Topic' });
  assert.deepEqual(nodeRegistry.registry.normalizeParams(nodeRegistry.registry.get('doc.read'), pdfTemplate.graph.nodes[1].params), pdfTemplate.graph.nodes[1].params);
  assert.deepEqual(nodeRegistry.registry.normalizeParams(nodeRegistry.registry.get('llm.research'), topicTemplate.graph.nodes[1].params), topicTemplate.graph.nodes[1].params);
  // no restricted node: participants and guests get them
  assert.ok(!templates.usesRestrictedNodes(pdfTemplate.graph) && !templates.usesRestrictedNodes(topicTemplate.graph));

  /* ---------- texts ---------- */

  const resolved = (id, lang) => templates.resolveTemplate(id, { lang });
  assert.equal(resolved('explainer-script', 'en').name, 'Explainer video: script from a PDF');
  assert.equal(resolved('explainer-script', 'de').name, 'Erklärvideo: Skript aus PDF');
  assert.match(resolved('explainer-script', 'es').name, /^Vídeo explicativo: guion/);
  assert.equal(resolved('explainer-script-topic', 'en').name, 'Explainer video: script for a topic');
  assert.equal(resolved('explainer-script-topic', 'de').name, 'Erklärvideo: Skript zu einem Thema');
  assert.match(resolved('explainer-script-topic', 'es').name, /^Vídeo explicativo: guion sobre un tema/);
  for (const lang of ['en', 'de', 'es']) {
    const pdf = resolved('explainer-script', lang);
    const topic = resolved('explainer-script-topic', lang);
    assert.match(pdf.description, /0[.,]35/, `${lang}: the cost of the PDF version is named`);
    assert.match(pdf.description, /0[.,]60/);
    assert.match(topic.description, /0[.,]30/, `${lang}: and that of the topic version`);
    assert.match(topic.description, /0[.,]50/);
    assert.match(pdf.description, /Opus 5\.5/);
    assert.equal(pdf.graph.nodes.find((node) => node.id === 'n3').params.language, lang, `${lang}: the script is written in the language of the person`);
    assert.equal(topic.graph.nodes.find((node) => node.id === 'n2').params.language, lang);
    assert.ok(pdf.graph.notes[0].text.length > 200);
    assert.match(pdf.graph.notes[0].text, lang === 'de' ? /Skript \(bearbeitet\)/ : lang === 'es' ? /Guion \(editado\)/ : /Edited script/, `${lang}: the note names the field of the second step as the node calls it`);
  }
  assert.match(resolved('explainer-script', 'en').description, /confirmation/);
  assert.match(resolved('explainer-script', 'de').description, /Bestätigung/);
  assert.match(resolved('explainer-script', 'es').description, /confirmes/);
  assert.equal(topicTemplate.graph.nodes[0].params.prompt.length > 10, true);
  assert.notEqual(resolved('explainer-script-topic', 'de').graph.nodes[0].params.prompt, topicTemplate.graph.nodes[0].params.prompt, 'the sample topic is translated');

  /* ---------- gallery data ---------- */

  const allOn = Object.fromEntries(templates.REQUIREMENTS.map((key) => [key, () => true]));
  assert.ok(templates.REQUIREMENTS.includes('poppler'));
  const listed = Object.fromEntries(templates.listTemplates({ lang: 'de', checks: allOn }).map((item) => [item.id, item]));
  assert.deepEqual(listed['explainer-script'].requires, ['openrouter', 'poppler']);
  assert.deepEqual(listed['explainer-script'].flow.map((step) => step.map((entry) => `${entry.type}*${entry.count}`)), [['input.document*1'], ['doc.read*1'], ['explainer.plan*1'], ['output.result*2']]);
  assert.deepEqual(listed['explainer-script-topic'].flow.map((step) => step.map((entry) => `${entry.type}*${entry.count}`)), [['input.prompt*1'], ['llm.research*1'], ['explainer.plan*1'], ['output.result*2']]);
  // the price depends on the document and the search: unknown before the run, never invented
  assert.deepEqual(listed['explainer-script'].cost, { kind: 'unknown', usd: 0, credits: 0, paidNodes: 1, providers: ['openrouter'] });
  assert.deepEqual(listed['explainer-script-topic'].cost, { kind: 'unknown', usd: 0, credits: 0, paidNodes: 2, providers: ['openrouter'] });
  assert.equal(listed['explainer-script'].batch, false);
  // availability: no Poppler means the PDF version is not available, the topic version is
  const noPoppler = Object.fromEntries(templates.listTemplates({ lang: 'en', checks: { ...allOn, poppler: () => 'pdftotext/pdftoppm not found (poppler)' } }).map((item) => [item.id, item]));
  assert.equal(noPoppler['explainer-script'].available, false);
  assert.deepEqual(noPoppler['explainer-script'].missing, [{ key: 'poppler', reason: 'pdftotext/pdftoppm not found (poppler)' }]);
  assert.equal(noPoppler['explainer-script-topic'].available, true);
  const noKey = Object.fromEntries(templates.listTemplates({ lang: 'en', checks: { ...allOn, openrouter: () => 'OPENROUTER_API_KEY is not set' } }).map((item) => [item.id, item]));
  assert.equal(noKey['explainer-script'].available, false);
  assert.equal(noKey['explainer-script-topic'].available, false);
  // the real check follows the installation
  const savedDir = process.env.POPPLER_BIN_DIR;
  process.env.POPPLER_BIN_DIR = path.join(iso.root, 'nowhere');
  try {
    assert.equal(templates.REQUIREMENT_CHECKS.poppler(), 'pdftotext/pdftoppm not found (poppler)');
  } finally {
    if (savedDir === undefined) delete process.env.POPPLER_BIN_DIR;
    else process.env.POPPLER_BIN_DIR = savedDir;
  }
  assert.equal(templates.REQUIREMENT_CHECKS.poppler(), poppler ? true : 'pdftotext/pdftoppm not found (poppler)');

  /* ---------- through the real engine ---------- */

  const calls = [];
  const journal = [];
  const answers = { plan: [], research: [] };
  patch(llm, 'completeText', async (options) => {
    const kind = /write the script of an explainer video/.test(options.system) ? 'plan' : /strict fact checker/.test(options.system) ? 'verify' : /careful research assistant/.test(options.system) ? 'research' : 'other';
    calls.push({ kind, options });
    if (kind === 'plan') return { text: JSON.stringify(answers.plan.shift() || planAnswer(['S. 1', 'S. 2'])), usd: 0.3 };
    if (kind === 'research') return answers.research.shift();
    const script = JSON.parse(/Script to check:\n([\s\S]*?)\n\n<data/.exec(options.prompt)[1]);
    return { text: JSON.stringify({ scenes: script.scenes.map((item) => ({ id: item.id, narration: item.narration, bullets: item.on_screen.bullets, numbers: item.on_screen.numbers, quote_ok: true, issues: [] })) }), usd: 0.1 };
  });
  patch(costs, 'recordCost', async (entry) => {
    journal.push(entry);
    return entry;
  });
  patch(discovery, 'brainSupportsFiles', async () => true);

  const bus = createEventBus();
  const flowStore = createWorkflowsStore({ dir: path.join(iso.root, 'data', 'workflows-explainer'), registry: nodeRegistry.registry, events: bus });
  const engine = createEngine({ store: flowStore, registry: nodeRegistry.registry, events: bus, getConfig: () => ({ imageModel: 'openai/gpt-image-2', defaultBrain: 'vendor/default-brain', brainModels: ['vendor/default-brain'] }), limits: { jobPollMs: 20 } });
  const resultOf = async (workflowId, nodeId) => (await flowStore.readResults(workflowId)).nodes[nodeId].history[0];

  // the topic version: research, notes and sources reach the planner
  {
    const created = (await flowStore.createWorkflow({ document: templates.resolveTemplate('explainer-script-topic', { lang: 'en' }), user: STAFF, owner: null })).workflow;
    answers.research.push({
      text: 'Heat pumps reach a seasonal COP of 4 [Agency](https://example.org/a). Running costs fell [Paper](https://example.org/b).',
      usd: 0.05,
      citations: [{ url: 'https://example.org/a', title: 'Agency report' }, { url: 'https://example.org/b', title: 'Paper' }],
      citationSpans: []
    });
    answers.plan.push(planAnswer(['[1]', '[2]']));
    const plan0 = await engine.plan(created.id, { mode: 'all', user: STAFF });
    assert.equal(plan0.valid, true, JSON.stringify(plan0.issues));
    assert.equal(plan0.nodes.n3.estimate, null, 'the planner has no price before the research ran');
    const runId = await engine.start(created.id, { mode: 'all', user: STAFF });
    const record = await engine.whenFinished(created.id, runId);
    assert.equal(record.status, 'completed', JSON.stringify(record.nodes).slice(0, 600));
    assert.deepEqual(calls.map((call) => call.kind), ['research', 'plan', 'verify']);
    assert.deepEqual(calls[0].options.plugins, [{ id: 'web', max_results: 8 }]);
    assert.match(calls[0].options.prompt, /How does a heat pump work/);
    assert.match(calls[1].options.prompt, /Heat pumps reach a seasonal COP of 4 \[1\]\. Running costs fell \[2\]\./);
    assert.match(calls[1].options.prompt, /\[1\] Agency report — https:\/\/example\.org\/a/);
    assert.match(calls[1].options.prompt, /Topic:\nHow does a heat pump work/);
    const planResult = await resultOf(created.id, 'n3');
    const planned = JSON.parse(planResult.variants[0].script.value);
    assert.equal(planned.verified, true);
    assert.deepEqual(planned.sources.map((source) => source.ref), ['[1]', '[2]']);
    assert.ok(Math.abs(planResult.cost.usd - 0.4) < 1e-9, 'plan and check are booked');
    assert.equal((await resultOf(created.id, 'n2')).cost.usd, 0.05);
    assert.equal(planResult.variants[0].narration.items.length, 12);
  }

  if (poppler) {
    calls.length = 0;
    journal.length = 0;
    const created = (await flowStore.createWorkflow({ document: templates.resolveTemplate('explainer-script', { lang: 'de' }), user: STAFF, owner: null })).workflow;
    const sessionId = created.sessionId;
    const pdf = makePdf(
      [
        ['Der Markt für Wärmepumpen wächst jedes Jahr.', 'Im Jahr 2025 wurden 42 000 Geräte verkauft.', 'Die Förderung deckt einen Teil der Kosten.'].join('\n'),
        ['Die Jahresarbeitszahl liegt bei etwa 4.', 'Das heisst: aus 1 kWh Strom werden 4 kWh Wärme.'].join('\n')
      ],
      { title: 'Marktbericht' }
    );
    // through the upload path, which records the size and the number of pages
    const scratch = await assets.createScratchDir(sessionId);
    await fsp.writeFile(path.join(scratch, 'upload.pdf'), pdf);
    const value = await assets.saveUploadFile(sessionId, { sourceFile: path.join(scratch, 'upload.pdf'), ext: '.pdf', name: 'Marktbericht.pdf' });
    await assets.removeScratchDir(scratch);
    const hasInfo = Boolean(documents.binaries().pdfinfo); // the page count of an upload comes from pdfinfo
    if (hasInfo) assert.equal(value.pages, 2);
    const graph = JSON.parse(JSON.stringify(created.graph));
    graph.nodes.find((node) => node.id === 'n1').params.assets = [{ assetId: value.assetId, sessionId }];
    await flowStore.saveGraph(created.id, { baseRev: created.rev, graph });
    // before anything ran the planner has no price; the PDF is not known yet
    const before = await engine.plan(created.id, { mode: 'all', user: STAFF });
    assert.equal(before.valid, true, JSON.stringify(before.issues));
    assert.equal(before.nodes.n3.estimate, null);
    assert.equal(before.nodes.n2.paid, false, 'reading is free');
    assert.equal(before.totals.paidNodes, 1);
    // the run: "Read document" gives the text with marks, the planner gets text and file
    const runId = await engine.start(created.id, { mode: 'all', user: STAFF, overrides: { n3: { language: 'de' } } });
    const record = await engine.whenFinished(created.id, runId);
    assert.equal(record.status, 'completed', JSON.stringify(record.nodes).slice(0, 600));
    const read = await resultOf(created.id, 'n2');
    assert.match(read.variants[0].text.value, /=== D1: Marktbericht\.pdf \(2 pages\) ===\n\[p\. 1\]\nDer Markt für Wärmepumpen wächst/);
    const info = JSON.parse(read.variants[0].info.value);
    assert.equal(info.documents[0].title, 'Marktbericht');
    assert.equal(info.total_pages, 2);
    assert.deepEqual(calls.map((call) => call.kind), ['plan', 'verify']);
    const planCall = calls[0].options;
    assert.equal(planCall.model, 'anthropic/claude-opus-5.5');
    assert.match(planCall.prompt, /Die Förderung deckt einen Teil der Kosten/);
    assert.match(planCall.prompt, /D1 = Marktbericht\.pdf \(2 pages\)/);
    assert.equal(planCall.files.length, 1);
    assert.equal(Buffer.from(planCall.files[0].dataUrl.split(',')[1], 'base64').equals(pdf), true);
    const planResult = await resultOf(created.id, 'n3');
    const planned = JSON.parse(planResult.variants[0].script.value);
    assert.equal(planned.language, 'de');
    assert.deepEqual(planned.sources.map((source) => [source.ref, source.title, source.document, source.page]), [['S. 1', 'Marktbericht', 0, 1], ['S. 2', 'Marktbericht', 0, 2]]);
    assert.equal(planResult.variants[0].sources.value, 'S. 1 — Marktbericht\nS. 2 — Marktbericht');
    // the outputs of the result nodes: script and sources
    assert.equal(JSON.parse((await resultOf(created.id, 'n4')).variants[0].result.items[0].value).version, 1);
    assert.equal((await resultOf(created.id, 'n5')).variants[0].result.items[0].value, 'S. 1 — Marktbericht\nS. 2 — Marktbericht');
    assert.ok(Math.abs(planResult.cost.usd - 0.4) < 1e-9);
    assert.deepEqual(journal.filter((entry) => entry.type === 'brain').length, 0, 'the replaced adapter books nothing itself');
    // now that the PDF is read the planner has a price: 2 pages
    const after = await engine.plan(created.id, { mode: 'node', nodeIds: ['n3'], user: STAFF, force: true });
    if (!hasInfo) assert.equal(after.nodes.n3.estimate, null, 'without a page count the price stays unknown');
    else assert.ok(after.nodes.n3.estimate && after.nodes.n3.estimate.usd > 0, 'the PDF is known now: the planner has a price');
    if (hasInfo) assert.equal(after.nodes.n3.estimate.usd, planLib.estimateUsd({ model: 'anthropic/claude-opus-5.5', pdfPages: 2, textChars: (await resultOf(created.id, 'n2')).variants[0].text.value.length, verify: true }));
    // phase two: the edited script is only checked, no model call, no cost
    calls.length = 0;
    const edited = { ...planned };
    edited.scenes = planned.scenes.map((item, index) => (index === 2 ? { ...item, narration: narrationOf(3, 20) } : item));
    const second = await engine.start(created.id, { mode: 'all', user: STAFF, overrides: { n3: { script: JSON.stringify(edited) } } });
    const secondRecord = await engine.whenFinished(created.id, second);
    assert.equal(secondRecord.status, 'completed', JSON.stringify(secondRecord.nodes).slice(0, 600));
    assert.equal(calls.length, 0, 'no model call for the edited script');
    const secondResult = await resultOf(created.id, 'n3');
    assert.equal(secondResult.cost.usd, 0);
    assert.equal(JSON.parse(secondResult.variants[0].script.value).scenes[2].narration, narrationOf(3, 20));
    assert.ok(planLib.secondsFor(narrationOf(3, 20), 'de') > 0);
  }

  await fsp.rm(path.join(iso.root, 'data', 'workflows-explainer'), { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
