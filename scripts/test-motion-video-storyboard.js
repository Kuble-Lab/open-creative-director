'use strict';

// The template "Motion video with storyboard" (WP43): topic -> plan -> voice, one cheap storyboard picture per scene (Nano Banana 2.1)
// to approve, then the scenes drawn after the pictures with a contact sheet check, cut with voice, music and captions.
//   - it loads and validates, the shape of the graph, the model, the groups, the three languages, the order, the gallery data
//   - step 1 (only the node Storyboard): plan, branding, text template and pictures; no voice, no scene, no render
//   - step 2 (everything): the lists of briefs, timing and pictures have the same length, every scene gets ITS picture as the last image
//     of the writer and the check gets the contact sheet and then the picture; the film is cut with voice, music and captions
//   - the app view takes the same two steps: the output Storyboard is marked for approval (approve: true), and the description and the
//     note of every language say so, naming the button of step 2 as the page labels it
// The language model, ElevenLabs, the render node and the image model are replaced; ffmpeg is real. Nothing is paid and nothing leaves the
// machine. Skipped (after the shape checks) when ffmpeg is missing.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');

const { rows: i18nRows } = require('../public/nodes/i18n-nodes');
const { createIsolatedApp } = require('./support/isolated-app');
const { createAssStandIn } = require('./support/fake-ffmpeg');
const { toneWav, createMedia } = require('./support/explainer-media');

const STAFF = 'staff1@staff.example.com';
const KEY = 'el-secret-key-0123456789';
const GSAP = 'https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js';
const ID = 'motion-video-storyboard';
const SCENES = 6;
const SECONDS_PER_CHAR = 0.02;
const VOCAB = ['pump', 'heat', 'air', 'water', 'cold', 'warm', 'cycle', 'power', 'house', 'winter', 'coil', 'fluid'];
const narrationOf = (k, n) => Array.from({ length: n }, (_x, i) => `${VOCAB[(i + k) % VOCAB.length]}${k}`).join(' ') + '.';

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

// the answer of the planner: no research, so no sources and no closing card; every scene is a motion scene
function planAnswer() {
  return {
    title: 'Heat pumps',
    summary: 'How they work',
    scenes: Array.from({ length: SCENES }, (_x, i) => {
      const k = i + 1;
      const words = narrationOf(k, 18).replace(/\./g, '').split(' ');
      return {
        kind: 'motion',
        role: k === 1 ? 'hook' : k === SCENES ? 'summary' : 'point',
        narration: narrationOf(k, 18),
        on_screen: { title: `Title ${k}`, bullets: [`Point ${k}`], numbers: [], quote: null },
        elements: [{ type: 'title', content: `Title ${k}`, anchor: words[0] }, { type: 'bullet', content: `Point ${k}`, anchor: words[5] }],
        figure: null,
        image_prompt: null,
        clip_prompt: null,
        source_refs: []
      };
    }),
    presenter: null
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
  console.log('test-motion-video-storyboard.js: ok');
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
  const tools = iso.load('lib/tools');
  const imageModels = iso.load('lib/image-models');
  const { createEventBus } = iso.load('lib/nodes/events');
  const { createWorkflowsStore } = iso.load('lib/nodes/workflows-store');
  const { createEngine } = iso.load('lib/nodes/engine');
  const real = nodeRegistry.registry;

  const all = templates.loadTemplates();
  const template = all.find((item) => item.id === ID);
  assert.ok(template, `${ID} exists`);
  assert.equal(templates.ORDER[templates.ORDER.indexOf('typography-video-text') + 1], ID, 'right after the typography videos');
  assert.deepEqual(template.requires, ['openrouter', 'elevenlabs', 'rendernode', 'ffmpeg']);

  /* ---------- shape ---------- */

  const result = templates.validateTemplate(template);
  assert.ok(result.app.enabled);
  const nodeOf = (id) => template.graph.nodes.find((node) => node.id === id);
  const wires = template.graph.edges.map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`);
  assert.deepEqual(
    template.graph.nodes.map((node) => node.type).sort(),
    ['audio.music', 'explainer.edit', 'explainer.plan', 'explainer.scene', 'explainer.voice', 'image.generate', 'input.branding', 'input.prompt', 'input.prompt', 'output.result', 'output.result', 'output.result', 'output.result', 'text.template']
  );
  for (const wire of [
    'n1.prompt>n4.topic', 'n2.prompt>n4.brief', 'n3.brand>n4.brand',
    'n4.narration>n5.narration', 'n4.narration_context>n5.context', 'n3.voice>n5.voice',
    'n4.briefs>n6.a', 'n3.brand>n6.b', 'n6.text>n7.prompt', 'n7.image>n8.inputs',
    'n4.briefs>n9.brief', 'n5.timing>n9.timing', 'n3.brand>n9.brand', 'n4.shots>n9.shots', 'n7.image>n9.reference',
    'n9.video>n10.scenes', 'n5.audio>n10.audio', 'n5.timing>n10.timing', 'n4.shots>n10.shots', 'n14.audio>n10.music',
    'n10.video>n11.inputs', 'n10.subtitles>n12.inputs', 'n4.script>n13.inputs'
  ]) assert.ok(wires.includes(wire), `${wire} is wired`);
  assert.equal(wires.length, 23);
  assert.equal(wires.some((wire) => /\.(image_prompts|sources)>/.test(wire)), false, 'no research and no stills of the planner');
  assert.deepEqual(nodeOf('n4').params, { model: '', topic: '', brief: '', length_seconds: 45, language: 'auto', audience: '', tone: 'factual', visual_mode: 'motion', format: 'landscape', max_still_share: 0.35, clips: false, presenter: 'off', verify: true, script: '' });
  assert.equal(nodeOf('n7').params.model, 'google/gemini-nano-banana-2.1');
  assert.equal(nodeOf('n7').params.aspect_ratio, '16:9');
  assert.equal(nodeOf('n7').params.count, 1);
  assert.deepEqual(nodeOf('n9').params, { model: '', format: 'landscape', quality: 'standard', vision_check: true, max_retries: 2, fallback: true });
  assert.equal(nodeOf('n14').params.length, 45);
  assert.match(nodeOf('n6').params.template, /\{\{a\}\}/);
  assert.match(nodeOf('n6').params.template, /\{\{b\}\}/);
  // Nano Banana 2.1 refused a frame of a real, named person twice with IMAGE_OTHER (live, 2026-10-07); with this line it drew
  // a neutral figure at once
  assert.ok(nodeOf('n6').params.template.includes('Never show a real, named person recognisably: draw people as simple neutral figures'), 'no likeness of real people');
  assert.deepEqual(imageModels.allowedModels({ imageModel: 'openai/gpt-image-2', imageModels: iso.load('lib/config').DEFAULT_CONFIG.imageModels }).includes('google/gemini-nano-banana-2.1'), true, 'the model is on the default list of the server');
  assert.deepEqual(template.graph.groups.map((group) => group.id), ['g1', 'g2']);
  assert.deepEqual(template.app.outputs.map((entry) => entry.label), ['Video', 'Storyboard', 'Script', 'Subtitles']);
  // the app view shows the Storyboard first and asks for the approval before the rest (SPEC §14): the output n8 is marked
  assert.deepEqual(template.app.outputs.filter((entry) => entry.approve === true).map((entry) => entry.node), ['n8']);
  assert.equal(template.app.outputs.find((entry) => entry.node === 'n8').label, 'Storyboard');
  assert.deepEqual(result.app.outputs.filter((entry) => entry.approve === true).map((entry) => entry.node), ['n8'], 'the mark survives the import');
  const approveFinish = (lang) => i18nRows.find((row) => row[0] === 'nodes.app.approveFinish')[{ de: 1, en: 2, es: 3 }[lang]];
  for (const lang of ['en', 'de', 'es']) {
    const doc = templates.resolveTemplate(ID, { lang });
    // the description and the note say that the app view works in two steps, and name the button of step 2 as the page labels it
    assert.deepEqual(doc.app.outputs.filter((entry) => entry.approve === true).map((entry) => entry.node), ['n8'], `${lang}: the localized document keeps the mark`);
    assert.ok(doc.graph.notes[0].text.includes(approveFinish(lang)), `${lang}: the note names the button «${approveFinish(lang)}»`);
    assert.doesNotMatch(doc.graph.notes[0].text, /always runs|läuft immer alles|siempre se ejecuta todo/, `${lang}: the note no longer says the app view runs everything`);
    assert.doesNotMatch(doc.app.description, /node view|Node-Ansicht|vista de nodos|at once|auf einmal|de una vez/, `${lang}: the description no longer sends the person to the node view`);
    assert.match(doc.app.description, { en: /storyboard first/, de: /zuerst das Storyboard/, es: /Primero ves el storyboard/ }[lang], `${lang}: the description names the approval`);
    assert.match(doc.graph.notes[0].text, /▶/, `${lang}: the note names the play button`);
    assert.match(doc.graph.notes[0].text, /Nano Banana 2\.1/, `${lang}: the note names the model`);
    assert.equal(doc.graph.groups.length, 2);
    assert.ok(doc.graph.groups.every((group) => group.title.startsWith('1 · ') || group.title.startsWith('2 · ')), `${lang}: numbered groups`);
  }
  assert.notEqual(templates.resolveTemplate(ID, { lang: 'de' }).graph.nodes[0].params.prompt, nodeOf('n1').params.prompt);
  assert.notEqual(templates.resolveTemplate(ID, { lang: 'es' }).graph.nodes[0].params.prompt, nodeOf('n1').params.prompt);

  const allOn = Object.fromEntries(templates.REQUIREMENTS.map((key) => [key, () => true]));
  const listed = templates.listTemplates({ lang: 'en', checks: allOn }).find((item) => item.id === ID);
  assert.ok(listed.available);
  assert.equal(listed.cost.kind, 'partial', 'only the music has a price beforehand');
  assert.equal(listed.cost.usd, 0.15, '45 s of music at 0.20 USD a minute');
  assert.deepEqual(listed.cost.providers, ['openrouter', 'elevenlabs']);
  const noRender = templates.listTemplates({ lang: 'en', checks: { ...allOn, rendernode: () => 'No render node configured' } }).find((item) => item.id === ID);
  assert.deepEqual(noRender.missing, [{ key: 'rendernode', reason: 'No render node configured' }]);

  /* ---------- the engine, with everything but ffmpeg replaced ---------- */

  const bins = ffmpegLib.binaries();
  if (!bins.available) {
    console.log('ffmpeg not found: the runs through the engine are skipped');
    return;
  }
  const workDir = await fsp.mkdtemp(path.join(iso.root, 'motion-storyboard-'));
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
  const renders = [];
  const durationOf = (text) => Number(/data-duration="([\d.]+)"/.exec(text)[1]);
  const sizeOf = (text) => ({ width: Number(/data-width="(\d+)"/.exec(text)[1]), height: Number(/data-height="(\d+)"/.exec(text)[1]) });
  const kindOf = (system = '') =>
    /write the script of an explainer video/.test(system) ? 'plan' : /strict fact checker/.test(system) ? 'verify' : /^You write ONE scene/.test(system) ? 'writer' : /^You check frames/.test(system) ? 'check' : 'other';
  patch(llm, 'completeText', async (options) => {
    const kind = kindOf(options.system);
    calls.push({ kind, options: JSON.parse(JSON.stringify({ ...options, onReplaced: undefined })) });
    if (kind === 'plan') return { text: JSON.stringify(planAnswer()), usd: 0.3 };
    if (kind === 'verify') {
      const script = JSON.parse(/Script to check:\n([\s\S]*?)\n\n<data/.exec(options.prompt)[1]);
      return { text: JSON.stringify({ scenes: script.scenes.map((item) => ({ id: item.id, narration: item.narration, bullets: item.on_screen.bullets, numbers: item.on_screen.numbers, quote_ok: true, issues: [] })) }), usd: 0.1 };
    }
    if (kind === 'check') return { text: '{"ok": true, "blockers": [], "minor": []}', usd: 0.03 };
    if (kind === 'writer') {
      const duration = durationOf(options.system);
      const { width, height } = sizeOf(options.system);
      return {
        text: `<!doctype html>
<html><head><meta charset="utf-8"><script src="${GSAP}"></script><style>body,html{margin:0;width:${width}px;height:${height}px;overflow:hidden}</style></head>
<body><div id="main-composition" data-composition-id="main" data-width="${width}" data-height="${height}" data-start="0" data-duration="${duration}"><h1 id="t">Title</h1>
<script>const tl = gsap.timeline({paused:true}); tl.from('#t',{opacity:0,duration:0.5},0.3); tl.to({}, {duration:0.01}, ${duration - 0.01}); window.__timelines = window.__timelines || {}; window.__timelines['main'] = tl;</script></div></body></html>`,
        usd: 0.06
      };
    }
    throw new Error(`a model call that the test does not know: ${String(options.system).slice(0, 60)}`);
  });
  patch(costs, 'recordCost', async (entry) => entry);
  patch(discovery, 'brainSupportsFiles', async () => true);

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

  // the image model: a picture per prompt, the colour tells the pictures apart
  const pictures = [];
  const imageDef = real.get('image.generate');
  const imageExecute = async (ctx, inputs, params) => {
    const index = ctx.itemIndex ?? 0;
    const scratch = await assets.createScratchDir(ctx.sessionId);
    const file = path.join(scratch, 'picture.png');
    await media.ff(['-f', 'lavfi', '-i', `color=c=0x${(0x202020 + index * 0x101010).toString(16)}:s=64x36`, '-frames:v', '1', file]);
    const value = await ctx.saveOutputFile({ kind: 'image', ext: '.png', sourceFile: file, prompt: inputs.prompt.value, cost: 0.034 });
    await assets.removeScratchDir(scratch);
    pictures[index] = { prompt: inputs.prompt.value, ratio: params.aspect_ratio, model: params.model, assetId: value.assetId };
    return { variants: [{ image: value }], cost: { usd: 0.034 } };
  };
  const musicCalls = [];
  const musicDef = real.get('audio.music');
  const musicExecute = async (ctx, inputs, params) => {
    const seconds = params.length;
    const scratch = await assets.createScratchDir(ctx.sessionId);
    const file = path.join(scratch, 'music.wav');
    await fsp.writeFile(file, toneWav(seconds, 220, { amplitude: 0.5 }));
    const value = await ctx.saveOutputFile({ kind: 'audio', ext: '.wav', sourceFile: file, prompt: inputs.prompt.value, cost: tools.musicEstimateUsd(seconds * 1000), duration: seconds });
    await assets.removeScratchDir(scratch);
    musicCalls.push({ length: seconds, instrumental: params.instrumental });
    return { variants: [{ audio: value }], cost: { usd: tools.musicEstimateUsd(seconds * 1000) } };
  };

  const registry = nodeRegistry.createRegistry();
  for (const type of real.list ? real.list().map((def) => def.type) : []) {
    if (type === 'image.generate') registry.register({ ...imageDef, available: () => true, prepare: undefined, execute: imageExecute });
    else if (type === 'audio.music') registry.register({ ...musicDef, available: () => true, prepare: undefined, execute: musicExecute });
    else registry.register(real.get(type));
  }
  const bus = createEventBus();
  const flowStore = createWorkflowsStore({ dir: path.join(iso.root, 'data', 'workflows-motion-storyboard'), registry, events: bus });
  const engine = createEngine({
    store: flowStore,
    registry,
    events: bus,
    getConfig: () => ({ imageModel: 'openai/gpt-image-2', imageModels: ['openai/gpt-image-2', 'google/gemini-nano-banana-2.1'], defaultBrain: 'vendor/default-brain', brainModels: ['vendor/default-brain'] }),
    limits: { jobPollMs: 20 }
  });
  const resultOf = async (workflowId, nodeId) => (await flowStore.readResults(workflowId)).nodes[nodeId].history[0];
  const sceneNumber = (call) => Number(/Scene s(\d+)/.exec(call.options.prompt)[1]);

  const created = (await flowStore.createWorkflow({ document: templates.resolveTemplate(ID, { lang: 'en' }), user: STAFF, owner: null })).workflow;
  const id = created.id;
  const graph = JSON.parse(JSON.stringify(created.graph));
  Object.assign(graph.nodes.find((node) => node.id === 'n10').params, { resolution: '720p', fps: '30' });
  await flowStore.saveGraph(id, { baseRev: created.rev, graph });

  const plan0 = await engine.plan(id, { mode: 'all', user: STAFF });
  assert.equal(plan0.valid, true, JSON.stringify(plan0.issues));
  assert.equal(plan0.nodes.n5.estimate, null, 'the voice has no price before the script is known');
  assert.equal(plan0.nodes.n9.executions, null, 'how many scenes there are comes from the script');

  // step 1: only the node Storyboard: the plan, the text template and the pictures
  const first = await engine.start(id, { mode: 'node', nodeIds: ['n8'], user: STAFF });
  const firstRecord = await engine.whenFinished(id, first);
  assert.equal(firstRecord.status, 'completed', JSON.stringify(firstRecord.nodes).slice(0, 600));
  assert.deepEqual(calls.map((call) => call.kind), ['plan'], 'the script only: with no research there is nothing to check its statements against');
  assert.equal(eleven.calls.length, 0, 'no voice yet');
  assert.equal(renders.length, 0, 'no scene yet');
  assert.equal(musicCalls.length, 0, 'no music yet');
  assert.equal(pictures.length, SCENES, 'one picture for every scene');
  const planResult = await resultOf(id, 'n4');
  const script = JSON.parse(planResult.variants[0].script.value);
  assert.equal(script.scenes.length, SCENES, 'no research, so no closing card with the sources');
  assert.equal(planResult.variants[0].briefs.items.length, SCENES);
  const storyboard = await resultOf(id, 'n8');
  assert.equal(storyboard.variants[0].result.items.length, SCENES, 'the result Storyboard holds every picture');
  assert.ok(pictures.every((item) => item.ratio === '16:9' && item.model === 'google/gemini-nano-banana-2.1'));
  for (let index = 0; index < SCENES; index += 1) {
    assert.match(pictures[index].prompt, /^Storyboard key frame for one scene/, 'the template wraps the brief');
    assert.ok(pictures[index].prompt.includes(`Title ${index + 1}`), `picture ${index + 1} is made from the brief of scene ${index + 1}`);
    assert.match(pictures[index].prompt, /Brand profile:\n\S/, 'the brand profile follows');
    assert.match(pictures[index].prompt, /Never show a real, named person recognisably/, 'the rule against likenesses reaches the image model');
  }

  // step 2: everything. The plan and the pictures are kept; the scenes follow the pictures
  calls.length = 0;
  const pictureCount = pictures.length;
  const runId = await engine.start(id, { mode: 'all', user: STAFF });
  const record = await engine.whenFinished(id, runId);
  assert.equal(record.status, 'completed', JSON.stringify(record.nodes).slice(0, 800));
  assert.equal(pictures.length, pictureCount);
  assert.equal(calls.filter((call) => ['plan', 'verify'].includes(call.kind)).length, 0, 'the plan is kept, not asked again');
  const writers = calls.filter((call) => call.kind === 'writer');
  const checks = calls.filter((call) => call.kind === 'check');
  assert.equal(writers.length, SCENES, 'one scene model call for every scene');
  assert.equal(eleven.calls.length, SCENES, 'one voice for every scene');
  assert.equal(renders.length, SCENES);
  assert.equal(checks.length, SCENES, 'the check looks once at every scene (it was fine)');
  const approved = await Promise.all(pictures.map((item) => store.assetDataUrl(created.sessionId, item.assetId)));
  for (const call of writers) {
    const k = sceneNumber(call);
    assert.match(call.options.prompt, /Storyboard: the last image/, `scene ${k}: the prompt names the storyboard frame`);
    assert.equal(call.options.images.length, 1, `scene ${k}: only the frame, no file of the scene`);
    assert.equal(call.options.images[0], approved[k - 1], `scene ${k} gets ITS picture`);
  }
  // the pictures differ, so no scene got the picture of another one
  assert.equal(new Set(writers.map((call) => call.options.images[0])).size, SCENES);
  for (const call of checks) {
    assert.equal(call.options.images.length, 2, 'the contact sheet and then the picture');
    assert.match(call.options.prompt, /contact sheet|tile/i);
  }
  assert.ok(renders.every((entry) => !/storyboard/i.test(entry.html)), 'the picture does not go to the render node');

  // the cut with voice, music and captions
  const final = (await resultOf(id, 'n10')).variants[0];
  const info = await media.probe(assets.assetFilePath(final.video));
  assert.deepEqual([info.width, info.height], [1280, 720]);
  assert.equal(info.hasAudio, true);
  assert.match(final.subtitles.value, /^1\n\d\d:\d\d:\d\d,\d\d\d --> /);
  assert.equal(musicCalls.length, 1);
  assert.equal(musicCalls[0].length, 45);
  assert.equal(musicCalls[0].instrumental, true);
  assert.ok((await resultOf(id, 'n11')).variants[0].result, 'the result Video');
  assert.ok((await resultOf(id, 'n13')).variants[0].result, 'the result Script');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
