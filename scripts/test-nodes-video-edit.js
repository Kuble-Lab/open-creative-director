'use strict';

// The node "Edit video with references" (fal.video_edit, lib/nodes/nodes-fal.js, WP40): an existing video is edited with
// Kling O3 (references), Wan Replace (one person) or Gemini Omni (text only). What is covered:
//   - the definition: ports, options, defaults, which options show for which model
//   - the prompt in the language of the person: "Bild 1" / "Image 1" / "Imagen 1" and "Video" / "Vídeo" become @Element1 or @Image1
//     and @Video1, in both roles of the images
//   - the input of each endpoint (Kling per quality with elements or style images and keep_audio, Wan, Gemini Omni: exactly
//     { video_url, prompt, resolution })
//   - the checks BEFORE anything is uploaded or paid, each with a stable code and a message that says what to do: too long, too
//     short, too small, too large, format, size, too many images, an image too small, Wan without exactly one image, Gemini Omni
//     with images / without a prompt / over 10 s, a prompt that mentions an image that is not there
//   - "Cut to the allowed length": the first 15 s (Kling) or 10 s (Gemini Omni), sent as an upload of the node (fake ffmpeg for the
//     arguments, real ffmpeg for one real cut), nothing left behind
//   - the price per model, quality and resolution, in the run and in the plan of the engine
//   - the texts in German, English and Spanish, the template "Replace people in a video", and that existing keys stay as they are
// No network: lib/fal.js upload / submit are replaced by recorders, the job is completed by the test like the poller does.

const assert = require('assert/strict');
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { promisify } = require('util');

const store = require('../lib/store');
const fal = require('../lib/fal');
const ffmpeg = require('../lib/ffmpeg');
const assets = require('../lib/nodes/assets');
const ops = require('../lib/nodes/ffmpeg-ops');
const nodesBasic = require('../lib/nodes/nodes-basic');
const nodesFal = require('../lib/nodes/nodes-fal');
const templates = require('../lib/nodes/templates');
const defaultRegistry = require('../lib/nodes/registry');
const { createRegistry } = defaultRegistry;
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
const { createEngine } = require('../lib/nodes/engine');
const { textValue, listValue } = require('../lib/nodes/types');

const execFileAsync = promisify(execFile);
const MB = 1024 * 1024;
const root = path.resolve(__dirname, '..');
const TYPE = 'fal.video_edit';

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message || ''} ${actual} !== ${expected}`.trim());

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

/* ---------- the texts (no session needed) ---------- */

function loadDictionary() {
  const window = { I18N: { de: {}, en: {}, es: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'nodes', 'i18n-nodes.js'), 'utf8'), { window });
  return window.I18N;
}

const CODES = [
  'VIDEO_EDIT_VIDEO_TOO_LONG',
  'VIDEO_EDIT_VIDEO_TOO_SHORT',
  'VIDEO_EDIT_VIDEO_TOO_SMALL',
  'VIDEO_EDIT_VIDEO_TOO_LARGE',
  'VIDEO_EDIT_VIDEO_FORMAT',
  'VIDEO_EDIT_VIDEO_TOO_HEAVY',
  'VIDEO_EDIT_TOO_MANY_IMAGES',
  'VIDEO_EDIT_IMAGE_TOO_SMALL',
  'VIDEO_EDIT_WAN_IMAGES',
  'VIDEO_EDIT_GEMINI_IMAGES',
  'VIDEO_EDIT_PROMPT_REQUIRED',
  'VIDEO_EDIT_PROMPT_IMAGE',
  'VIDEO_EDIT_WAN_PROMPT',
  'VIDEO_EDIT_FFMPEG_MISSING'
];

const placeholdersOf = (text) => [...new Set((text.match(/\{[a-zA-Z]+\}/g) || []).map((item) => item.slice(1, -1)))];

function testPromptTranslation() {
  const t = nodesFal.translateEditPrompt;
  // the three languages, role "elements" (people and objects): Bild N / Image N / Imagen N -> @ElementN, Video / Vídeo -> @Video1
  assert.equal(t('Ersetze die linke Person im Video durch Bild 1 und die rechte durch Bild 2.', 'elements', 2), 'Ersetze die linke Person im @Video1 durch @Element1 und die rechte durch @Element2.');
  assert.equal(t('Replace the left person in the Video with Image 1 and the right one with Image 2.', 'elements', 2), 'Replace the left person in the @Video1 with @Element1 and the right one with @Element2.');
  assert.equal(t('Sustituye a la persona de la izquierda del Vídeo por la Imagen 1 y a la derecha por la Imagen 2.', 'elements', 2), 'Sustituye a la persona de la izquierda del @Video1 por la @Element1 y a la derecha por la @Element2.');
  // role "style": @ImageN
  assert.equal(t('Ersetze die linke Person im Video durch Bild 1 und die rechte durch Bild 2.', 'style', 2), 'Ersetze die linke Person im @Video1 durch @Image1 und die rechte durch @Image2.');
  assert.equal(t('Replace the left person in the Video with Image 1 and the right one with Image 2.', 'style', 2), 'Replace the left person in the @Video1 with @Image1 and the right one with @Image2.');
  assert.equal(t('Sustituye a la persona de la izquierda del Vídeo por la Imagen 1.', 'style', 1), 'Sustituye a la persona de la izquierda del @Video1 por la @Image1.');
  // any case and spacing for the images; the languages may be mixed
  assert.equal(t('bild 1, IMAGE 2 and imagen3', 'elements', 3), '@Element1, @Element2 and @Element3');
  assert.equal(t('Bild1 und Bild  2', 'style', 2), '@Image1 und @Image2');
  // "Video 1" counts where the 1 ends the phrase; in "im Video 2 Personen" the 2 belongs to the people
  assert.equal(t('Verändere Video 1.', 'elements', 0), 'Verändere @Video1.');
  assert.equal(t('Ersetze im Video 2 Personen durch Bild 1.', 'elements', 1), 'Ersetze im @Video1 2 Personen durch @Element1.');
  assert.equal(t('Replace 2 people in the Video, not in the video game', 'elements', 0), 'Replace 2 people in the @Video1, not in the video game', 'only the capital V is the video');
  // words that only contain the words are left alone
  assert.equal(t('Bilder, Imaginary Images, Videos, Videoclip, Bildung', 'elements', 2), 'Bilder, Imaginary Images, Videos, Videoclip, Bildung');
  // a name the model knows already stays
  assert.equal(t('@Element1 in @Video1 mit @Image2', 'elements', 2), '@Element1 in @Video1 mit @Image2');
  // a prompt without any word of it is sent as it is
  assert.equal(t('Make it rain', 'elements', 2), 'Make it rain');
  // an image that is not connected: nothing is paid for a prompt that points at nothing
  assert.throws(() => t('Ersetze durch Bild 3', 'elements', 2), (err) => err.code === 'VIDEO_EDIT_PROMPT_IMAGE' && err.data.n === 3 && err.data.count === 2 && /image 3/.test(err.message));
  assert.throws(() => t('Replace with Image 1', 'elements', 0), (err) => err.code === 'VIDEO_EDIT_PROMPT_IMAGE' && err.data.count === 0);
  assert.throws(() => t('Image 0', 'elements', 2), (err) => err.code === 'VIDEO_EDIT_PROMPT_IMAGE');
}

function testTexts() {
  const dict = loadDictionary();
  for (const lang of ['de', 'en', 'es']) {
    const d = dict[lang];
    for (const key of ['label', 'keywords', 'help', 'example', 'tip.1', 'tip.2', 'tip.3']) assert.ok(d[`nodes.type.${TYPE}.${key}`], `${lang}: ${key}`);
    assert.equal(d[`nodes.type.${TYPE}.tip.4`], undefined, 'three tips at most');
    for (const key of ['video.in', 'video.out', 'images', 'prompt']) assert.ok(d[`nodes.portdesc.${TYPE}.${key}`], `${lang}: port ${key}`);
    for (const key of ['image_role', 'keep_audio', 'wan_resolution', 'cut_to_limit']) assert.ok(d[`nodes.param.${key}`], `${lang}: param ${key}`);
    for (const key of ['kling_o3', 'wan_replace', 'gemini_omni', 'elements', 'pro', 'quality.4k', 'resolution.4k']) assert.ok(d[`nodes.option.${key}`], `${lang}: option ${key}`);
    for (const code of CODES) {
      const text = d[`nodes.issue.${code}`];
      assert.ok(typeof text === 'string' && text.trim(), `${lang}: ${code}`);
      assert.equal(text.includes('ß'), false, `${lang}.${code}: no sharp s`);
    }
  }
  const de = dict.de;
  const en = dict.en;
  const es = dict.es;
  // the names of the node as the person reads them
  assert.equal(de[`nodes.type.${TYPE}.label`], 'Video mit Referenzen bearbeiten');
  assert.equal(en[`nodes.type.${TYPE}.label`], 'Edit video with references');
  assert.equal(es[`nodes.type.${TYPE}.label`], 'Editar vídeo con referencias');
  assert.equal(de['nodes.option.kling_o3'], 'Kling O3');
  assert.equal(de['nodes.option.wan_replace'], 'Wan Replace (eine Person)');
  assert.equal(de['nodes.option.gemini_omni'], 'Gemini Omni (nur Text)');
  assert.equal(en['nodes.option.gemini_omni'], 'Gemini Omni (text only)');
  assert.equal(es['nodes.option.gemini_omni'], 'Gemini Omni (solo texto)');
  assert.equal(de['nodes.option.elements'], 'Personen/Objekte');
  assert.equal(de['nodes.option.style'], 'Stil');
  assert.equal(de['nodes.param.image_role'], 'Rolle der Bilder');
  assert.equal(de['nodes.param.keep_audio'], 'Originalton behalten');
  assert.equal(de['nodes.param.cut_to_limit'], 'Auf die erlaubte Länge kürzen');
  assert.equal(de['nodes.issue.VIDEO_EDIT_GEMINI_IMAGES'], 'Gemini Omni nimmt keine Bilder. Trenne die Bilder oder wähle Kling O3.');
  // a message that names a node names it the way the node is called in that language
  const nodeLabel = (lang, type) => dict[lang][`nodes.type.${type}.label`];
  for (const [code, types] of [
    ['VIDEO_EDIT_VIDEO_TOO_LONG', ['video.trim']],
    ['VIDEO_EDIT_VIDEO_TOO_SMALL', ['video.resize']],
    ['VIDEO_EDIT_VIDEO_TOO_LARGE', ['video.resize']],
    ['VIDEO_EDIT_VIDEO_FORMAT', ['video.trim']],
    ['VIDEO_EDIT_VIDEO_TOO_HEAVY', ['video.resize']],
    ['VIDEO_EDIT_IMAGE_TOO_SMALL', ['image.resize']]
  ]) {
    for (const lang of ['de', 'en', 'es']) {
      for (const type of types) assert.ok(dict[lang][`nodes.issue.${code}`].includes(nodeLabel(lang, type)), `${lang}.${code} names “${nodeLabel(lang, type)}”`);
    }
  }
  for (const lang of ['de', 'en', 'es']) assert.ok(dict[lang]['nodes.issue.VIDEO_EDIT_VIDEO_TOO_LONG'].includes(dict[lang]['nodes.param.cut_to_limit']), `${lang}: the length message names the switch`);
  // the same placeholders in every language
  for (const code of CODES) {
    const expected = placeholdersOf(de[`nodes.issue.${code}`]).sort().join(',');
    for (const lang of ['en', 'es']) assert.equal(placeholdersOf(dict[lang][`nodes.issue.${code}`]).sort().join(','), expected, `${lang}.${code} placeholders`);
  }
  // the help says when to use which model, in every language
  for (const lang of ['de', 'en', 'es']) {
    const all = [dict[lang][`nodes.type.${TYPE}.help`], dict[lang][`nodes.type.${TYPE}.example`], ...[1, 2, 3].map((n) => dict[lang][`nodes.type.${TYPE}.tip.${n}`])].join(' ');
    for (const fact of ['Kling O3', 'Wan', 'Gemini Omni', '0.14', '0.08', '0.03', '15', '10', '720']) assert.ok(all.includes(fact), `${lang}: the help names ${fact}`);
    assert.match(all, /H3 Max/, `${lang}: the help says what H3 Max reference video is`);
    assert.match(all, lang === 'de' ? /Englische Prompts/ : lang === 'en' ? /English prompts/ : /prompts en inglés/, `${lang}: English prompts often work better`);
  }
  // none of the keys of this node is written twice (a second entry would silently replace the first)
  const source = fs.readFileSync(path.join(root, 'public', 'nodes', 'i18n-nodes.js'), 'utf8');
  const keys = [...source.matchAll(/^\s*\['(nodes\.[^']+)'/gm)].map((match) => match[1]);
  for (const key of keys.filter((item) => item.includes('video_edit') || item.includes('VIDEO_EDIT'))) assert.equal(keys.filter((item) => item === key).length, 1, `${key} once`);
  for (const key of ['nodes.param.image_role', 'nodes.param.keep_audio', 'nodes.param.wan_resolution', 'nodes.param.cut_to_limit', 'nodes.option.kling_o3', 'nodes.option.wan_replace', 'nodes.option.gemini_omni', 'nodes.option.elements', 'nodes.option.pro', 'nodes.option.quality.4k', 'nodes.option.resolution.4k']) {
    assert.equal(keys.filter((item) => item === key).length, 1, `${key} once`);
  }
  // the old keys of the neighbours are where they were
  assert.equal(de['nodes.type.fal.h3_reference.label'], 'H3 Max Referenz-Video');
  assert.equal(de['nodes.type.fal.video_segment.label'], 'Video segmentieren');
  assert.equal(de['nodes.param.quality'], 'Qualität');
  assert.equal(de['nodes.option.standard'], 'Standard');
  return dict;
}

/* ---------- the template ---------- */

function testTemplate() {
  const template = templates.loadTemplates().find((item) => item.id === 'replace-people-in-video');
  assert.ok(template, 'the template exists');
  const result = templates.validateTemplate(template);
  assert.deepEqual(template.requires, ['fal']);
  const types = result.graph.nodes.map((node) => node.type);
  assert.deepEqual(types, ['input.video', 'input.image', 'input.image', TYPE, 'output.result']);
  const edit = template.graph.nodes.find((node) => node.type === TYPE);
  assert.equal(edit.params.model, 'kling_o3');
  assert.equal(edit.params.image_role, 'elements');
  assert.equal(edit.params.cut_to_limit, false, 'the switch ships off, like the node');
  assert.deepEqual(defaultRegistry.normalizeParams(defaultRegistry.get(TYPE), edit.params), edit.params, 'every param is one of the node, with a valid value');
  // video, then the two images in the order of the numbers in the prompt
  assert.deepEqual(template.graph.edges.map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`), ['n1.video>n4.video', 'n2.image>n4.images', 'n3.image>n4.images', 'n4.video>n5.inputs']);
  assert.deepEqual(template.app.inputs.map((entry) => `${entry.node}.${entry.param}`), ['n1.asset', 'n2.asset', 'n3.asset', 'n4.prompt']);
  assert.equal(template.app.outputs[0].node, 'n5');
  assert.ok(templates.ORDER.includes('replace-people-in-video'));

  const consent = { en: /agreed/, de: /zugestimmt|einverstanden/, es: /consentimiento|aceptado/ };
  const names = { en: 'Replace people in a video', de: 'Personen im Video ersetzen', es: 'Reemplazar personas en un vídeo' };
  for (const lang of ['en', 'de', 'es']) {
    const doc = templates.resolveTemplate('replace-people-in-video', { lang });
    assert.equal(doc.name, names[lang]);
    // the hint to use only people who agreed: in the description, the note and the description of the app
    assert.match(doc.description, consent[lang], `${lang}: description`);
    assert.match(doc.graph.notes[0].text, consent[lang], `${lang}: note`);
    assert.match(doc.app.description, consent[lang], `${lang}: app`);
    // the prompt speaks of the images in the language of the template and the node turns it into the names of the model
    const prompt = doc.graph.nodes.find((node) => node.id === 'n4').params.prompt;
    assert.match(prompt, lang === 'de' ? /Bild 1.*Bild 2/ : lang === 'en' ? /Image 1.*Image 2/ : /Imagen 1.*Imagen 2/, `${lang}: prompt`);
    const sent = nodesFal.translateEditPrompt(prompt, 'elements', 2);
    assert.match(sent, /@Element1/);
    assert.match(sent, /@Element2/);
    assert.match(sent, /@Video1/);
    assert.equal(/\b(Bild|Image|Imagen)\s*\d|Vídeo|Video\b/.test(sent.replace(/@Video1|@Element\d/g, '')), false, `${lang}: nothing is left of the words of the person: ${sent}`);
    assert.equal(JSON.stringify(doc).includes('ß'), false, `${lang}: no sharp s`);
  }
  assert.equal(JSON.stringify(template).includes('ß'), false);
  // the gallery: it needs the fal.ai key and shows no price (the length of the video decides)
  const listed = templates.listTemplates({ lang: 'de' }).find((item) => item.id === 'replace-people-in-video');
  assert.deepEqual(listed.requires, ['fal']);
  assert.equal(listed.cost.kind, 'unknown');
  assert.deepEqual(listed.nodeTypes, ['input.video', 'input.image', TYPE, 'output.result']);
}

/* ---------- the node itself ---------- */

async function main() {
  testPromptTranslation();
  const dict = testTexts();
  testTemplate();

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-nodes-video-edit-'));
  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  nodesFal.registerAll(registry);
  const sessions = [];
  const created = [];
  const bus = createEventBus();
  const wfStore = createWorkflowsStore({ dir: path.join(tmpDir, 'workflows'), registry, events: bus });
  const realBinaries = ffmpeg.binaries();
  const realRunProcess = ffmpeg.runProcess;

  try {
    const session = await store.createSession();
    sessions.push(session.id);
    const sessionId = session.id;

    /* ---------- recorders and helpers ---------- */

    const falCalls = { upload: [], submit: [] };
    let requestCounter = 0;
    const uploadedCopies = [];
    patch(fal, 'hasKey', () => true);
    patch(fal, 'uploadFile', async (file, options) => {
      falCalls.upload.push({ file: path.basename(file), contentType: options.contentType, fileName: options.fileName });
      if (path.basename(file) === 'trimmed-video.mp4') {
        const copy = path.join(tmpDir, `uploaded-${uploadedCopies.length}.mp4`);
        await fsp.copyFile(file, copy);
        uploadedCopies.push(copy);
      }
      return { url: `https://v3b.fal.media/files/${path.basename(file)}`, size: 4, contentType: options.contentType, fileName: options.fileName };
    });
    patch(fal, 'submit', async (endpoint, input) => {
      falCalls.submit.push({ endpoint, input: JSON.parse(JSON.stringify(input)) });
      requestCounter += 1;
      return {
        requestId: `req-${requestCounter}`,
        statusUrl: `https://queue.fal.run/${endpoint}/requests/req-${requestCounter}/status`,
        responseUrl: `https://queue.fal.run/${endpoint}/requests/req-${requestCounter}`
      };
    });
    const resetCalls = () => {
      falCalls.upload.length = 0;
      falCalls.submit.length = 0;
    };
    const nothingSent = (message) => assert.deepEqual([falCalls.upload.length, falCalls.submit.length], [0, 0], message || 'nothing uploaded, nothing queued');

    // ffprobe: measured values come from this table (by file name); ffmpeg: a fake that writes the cut file, or the real one
    let probing = true;
    let fakeCut = true;
    const probes = new Map();
    const cuts = [];
    // `binariesQueue` answers the next calls one by one (true = found): ffprobe found for the video, ffmpeg gone by the time of the cut
    const binariesQueue = [];
    patch(ffmpeg, 'binaries', () => {
      const found = binariesQueue.length ? binariesQueue.shift() : probing;
      return found ? { available: true, ffmpeg: realBinaries.ffmpeg || 'ffmpeg', ffprobe: realBinaries.ffprobe || 'ffprobe' } : { available: false };
    });
    patch(ops, 'probeMedia', async (file) => {
      const probe = probes.get(path.basename(file));
      if (!probe) throw new Error('unreadable file');
      return probe;
    });
    patch(ffmpeg, 'runProcess', async (command, args, options) => {
      if (!fakeCut) return realRunProcess(command, args, options);
      cuts.push(args.slice());
      await fsp.writeFile(args[args.length - 1], 'cut video');
      return { stdout: '', stderr: '' };
    });

    let assetCounter = 0;
    async function media(kind, ext, { duration, width = 0, height = 0, bytes = 'data', size, content } = {}) {
      assetCounter += 1;
      const saved = await store.saveAsset(sessionId, { kind: 'upload', buffer: content || Buffer.from(`${bytes}${assetCounter}`), ext, prompt: 'seed' });
      if (size) {
        const handle = await fsp.open(path.join(store.sessionAssetDir(sessionId), saved.file), 'w');
        await handle.truncate(size);
        await handle.close();
      }
      probes.set(saved.file, {
        video: kind === 'audio' ? null : { codec: 'x', width, height, fps: 25 },
        audio: kind === 'image' ? null : { codec: 'x', sampleRate: 44100, channels: 2, channelLayout: 'stereo' },
        duration: duration ?? null
      });
      return assets.valueFromAsset(sessionId, saved.id);
    }
    const image = (options = {}) => media('image', '.png', { width: 1024, height: 1024, ...options });
    const video = (options = {}) => media('video', '.mp4', { duration: 10, width: 1280, height: 720, ...options });
    const urlOf = (value) => `https://v3b.fal.media/files/${value.file}`;

    let nextCompletion = { cost: 0.4 };
    const ctx = (overrides = {}) => {
      const controller = new AbortController();
      return {
        workflowId: 'wf-test',
        runId: 'r-test',
        nodeId: 'n1',
        sessionId,
        user: 'tester',
        config: {},
        signal: controller.signal,
        toolCtx: { nodeView: true, sessionId, config: {}, user: 'tester', emit() {} },
        log(line) {
          logs.push(line);
        },
        waitForJob: async (job) => {
          await store.completeAsset(sessionId, job.assetId, Buffer.from('fake-mp4'), nextCompletion.cost);
          await store.mutateSession(sessionId, (s) => {
            const target = s.jobs.find((entry) => entry.assetId === job.assetId);
            target.status = 'completed';
            target.resultAssetIds = [job.assetId];
          });
          return [job.assetId];
        },
        saveOutputFile: (options) => assets.saveOutputFile(sessionId, options),
        withLocalSlot: (fn) => fn(),
        ...overrides
      };
    };
    const logs = [];
    const def = registry.get(TYPE);
    const normalised = (rawParams) => registry.normalizeParams(def, rawParams);
    const run = (inputs, rawParams = {}) => def.execute(ctx(), inputs, normalised(rawParams));
    const plan = (inputs, rawParams = {}) => nodesFal.planVideoEdit(ctx(), inputs, normalised(rawParams));
    const lastSubmit = () => falCalls.submit[falCalls.submit.length - 1];
    const text = textValue;
    const scratchLeftovers = async () => (await fsp.readdir(store.sessionAssetDir(sessionId))).filter((name) => name.startsWith(assets.SCRATCH_PREFIX));

    // a refusal: its stable code and data, the message says what to do, and NOTHING was uploaded or queued
    async function refused(inputs, rawParams, code, { data, message } = {}) {
      resetCalls();
      await assert.rejects(run(inputs, rawParams), (err) => {
        assert.equal(err.code, code, `${code}: ${err.message}`);
        if (data) for (const [key, value] of Object.entries(data)) assert.deepEqual(err.data[key], value, `${code}.${key}`);
        if (message) assert.match(err.message, message, code);
        // the interface shows the text of this code in each language: every placeholder has a value
        for (const lang of ['de', 'en', 'es']) {
          for (const name of placeholdersOf(dict[lang][`nodes.issue.${code}`])) assert.ok(err.data && err.data[name] !== undefined, `${lang}.${code}: {${name}} has a value`);
        }
        return true;
      });
      nothingSent(`${code}: nothing sent`);
      assert.deepEqual(await scratchLeftovers(), [], `${code}: no scratch folder left`);
    }

    /* ---------- definition ---------- */
    {
      assert.equal(def.label, 'Edit video with references');
      assert.equal(def.category, 'fal');
      assert.equal(def.paid, true);
      assert.equal(def.experimental, true, 'not verified live yet: the badge');
      assert.deepEqual(def.inputs.map((port) => `${port.id}:${port.type}${port.required ? '*' : ''}${port.multiple ? `+${port.max}` : ''}`), ['video:video*', 'images:image+4', 'prompt:text']);
      assert.deepEqual(def.outputs.map((port) => `${port.id}:${port.type}`), ['video:video']);
      const param = (id) => def.params.find((item) => item.id === id);
      assert.deepEqual(param('model').options, ['kling_o3', 'wan_replace', 'gemini_omni']);
      assert.equal(param('model').default, 'kling_o3');
      assert.deepEqual(param('quality').options, ['standard', 'pro', '4k']);
      assert.equal(param('quality').default, 'standard');
      assert.deepEqual(param('image_role').options, ['elements', 'style']);
      assert.equal(param('image_role').default, 'elements');
      assert.equal(param('keep_audio').default, true, 'the original sound is kept by default');
      assert.deepEqual(param('resolution').options, ['360p', '720p', '1080p', '4k']);
      assert.equal(param('resolution').default, '720p');
      assert.deepEqual(param('wan_resolution').options, ['480p', '580p', '720p']);
      assert.equal(param('wan_resolution').default, '480p');
      assert.equal(param('cut_to_limit').default, false, 'the cut is off by default');
      // which option belongs to which model: no switch for the sound at Gemini Omni (not documented), none for Wan
      assert.deepEqual(param('quality').showIf, { param: 'model', equals: 'kling_o3' });
      assert.deepEqual(param('image_role').showIf, { param: 'model', equals: 'kling_o3' });
      assert.deepEqual(param('keep_audio').showIf, { param: 'model', equals: 'kling_o3' });
      assert.deepEqual(param('resolution').showIf, { param: 'model', equals: 'gemini_omni' });
      assert.deepEqual(param('wan_resolution').showIf, { param: 'model', equals: 'wan_replace' });
      assert.deepEqual(param('prompt').showIf, { param: 'model', in: ['kling_o3', 'gemini_omni'] }, 'Wan takes no prompt: the field is not shown');
      assert.deepEqual(param('cut_to_limit').showIf, { param: 'model', in: ['kling_o3', 'gemini_omni'] }, 'Wan names no limit to cut to');
      // an old node of another type and the keys of the neighbours: unchanged
      assert.ok(defaultRegistry.get('fal.h3_reference') && defaultRegistry.get('fal.model') && defaultRegistry.get('fal.video_segment'));
      assert.ok(defaultRegistry.get(TYPE), 'in the default registry');
      // rights and budget are those of the other fal nodes: open to participants (only Higgsfield nodes are restricted), counted against their budget
      assert.equal(defaultRegistry.isRestricted(defaultRegistry.get(TYPE)), false);
      assert.equal(defaultRegistry.isRestricted(defaultRegistry.get('fal.h3_reference')), false);
      assert.equal(defaultRegistry.get(TYPE).cost.unit, 'usd');
      assert.equal(defaultRegistry.providerOf ? defaultRegistry.providerOf(defaultRegistry.get(TYPE)) : 'fal', 'fal');
      assert.deepEqual(defaultRegistry.get('fal.h3_reference').inputs.map((port) => port.id), ['prompt', 'images', 'videos', 'audios']);
      // the prices
      const prices = nodesFal.PRICES.videoEdit;
      assert.deepEqual(prices.kling.perSecond, { standard: 0.14, pro: 0.14, '4k': 0.42 });
      assert.equal(prices.wan.perSecond, 0.08);
      assert.deepEqual(prices.gemini.perSecond, { '360p': 0.03, '720p': 0.1, '1080p': 0.15, '4k': 0.3 });
      assert.equal(prices.kling.endpoints.standard, 'fal-ai/kling-video/o3/standard/video-to-video/edit');
      assert.equal(prices.kling.endpoints.pro, 'fal-ai/kling-video/o3/pro/video-to-video/edit');
      assert.equal(prices.kling.endpoints['4k'], 'fal-ai/kling-video/o3/4k/video-to-video/edit');
      assert.equal(prices.wan.endpoint, 'fal-ai/wan/v2.2-14b/animate/replace');
      assert.equal(prices.gemini.endpoint, 'google/gemini-omni-flash/v1.1/edit');
      for (const endpoint of [...Object.values(prices.kling.endpoints), prices.wan.endpoint, prices.gemini.endpoint]) assert.ok(fal.isValidEndpointId(endpoint), endpoint);
      // an invalid option is refused by the registry before the node runs
      assert.ok(registry.checkParams(def, { ...normalised({}), model: 'sora' }).length > 0);
    }

    /* ---------- the input per endpoint ---------- */
    {
      resetCalls();
      const clip = await video({ duration: 10 });
      const a = await image();
      const b = await image();
      // Kling O3, people and objects: one element per image, the image is its front view and its one reference
      let out = await run({ video: clip, images: list([a, b]), prompt: text('Ersetze die linke Person im Video durch Bild 1 und die rechte durch Bild 2.') }, {});
      assert.equal(lastSubmit().endpoint, 'fal-ai/kling-video/o3/standard/video-to-video/edit');
      assert.deepEqual(lastSubmit().input, {
        prompt: 'Ersetze die linke Person im @Video1 durch @Element1 und die rechte durch @Element2.',
        keep_audio: true,
        video_url: urlOf(clip),
        elements: [
          { frontal_image_url: urlOf(a), reference_image_urls: [urlOf(a)] },
          { frontal_image_url: urlOf(b), reference_image_urls: [urlOf(b)] }
        ]
      });
      assert.equal(falCalls.upload.length, 3, 'the video and the two images, each once');
      assert.equal(out.variants.length, 1);
      assert.equal(out.variants[0].video.type, 'video');
      assert.deepEqual(out.cost, { usd: 0.4 }, 'the ledger cost written by the poller is reported');
      let job = (await store.readSession(sessionId)).jobs.slice(-1)[0];
      assert.equal(job.endpoint, 'fal-ai/kling-video/o3/standard/video-to-video/edit');
      near(job.costEstimateUsd, 1.4, '10 s at 0.14');
      assert.equal(job.pricing, null, 'the length that was sent decides, not the result');

      // images are sent although the prompt does not mention them; the order is the order of the connections
      resetCalls();
      await run({ video: clip, images: list([b, a]), prompt: text('Make it snow in the Video') }, {});
      assert.deepEqual(lastSubmit().input.elements.map((element) => element.frontal_image_url), [urlOf(b), urlOf(a)]);
      assert.equal(lastSubmit().input.prompt, 'Make it snow in the @Video1');

      // Kling O3, style images: image_urls, @ImageN
      resetCalls();
      await run({ video: clip, images: list([a, b]), prompt: text('Give the Video the look of Image 2, with the light of Image 1') }, { image_role: 'style' });
      assert.deepEqual(lastSubmit().input, {
        prompt: 'Give the @Video1 the look of @Image2, with the light of @Image1',
        keep_audio: true,
        video_url: urlOf(clip),
        image_urls: [urlOf(a), urlOf(b)]
      });

      // Kling O3 without images: only the prompt (no elements, no image_urls); the sound switched off
      resetCalls();
      await run({ video: clip, prompt: text('Make it rain') }, { keep_audio: false });
      assert.deepEqual(lastSubmit().input, { prompt: 'Make it rain', keep_audio: false, video_url: urlOf(clip) });
      assert.equal(falCalls.upload.length, 1);

      // (a prompt typed into the node reaches the node as the input "prompt": the engine does that, see the run through the engine below)

      // the endpoint per quality
      for (const [quality, endpoint, usd] of [
        ['standard', 'fal-ai/kling-video/o3/standard/video-to-video/edit', 1.4],
        ['pro', 'fal-ai/kling-video/o3/pro/video-to-video/edit', 1.4],
        ['4k', 'fal-ai/kling-video/o3/4k/video-to-video/edit', 4.2]
      ]) {
        resetCalls();
        await run({ video: clip, prompt: text('Make it rain') }, { quality });
        assert.equal(lastSubmit().endpoint, endpoint, quality);
        job = (await store.readSession(sessionId)).jobs.slice(-1)[0];
        near(job.costEstimateUsd, usd, `${quality}: 10 s`);
      }

      // Wan Replace: the video and ONE image, the resolution; no prompt (not even a typed or a connected one), no other field
      resetCalls();
      await run({ video: clip, images: a, prompt: text('this text is ignored') }, { model: 'wan_replace' });
      assert.equal(lastSubmit().endpoint, 'fal-ai/wan/v2.2-14b/animate/replace');
      assert.deepEqual(lastSubmit().input, { video_url: urlOf(clip), image_url: urlOf(a), resolution: '480p' });
      job = (await store.readSession(sessionId)).jobs.slice(-1)[0];
      near(job.costEstimateUsd, 0.8, '10 s at 0.08');
      resetCalls();
      await run({ video: clip, images: list([a]) }, { model: 'wan_replace', wan_resolution: '720p' });
      assert.deepEqual(lastSubmit().input, { video_url: urlOf(clip), image_url: urlOf(a), resolution: '720p' }, 'a list of one image is one image');

      // Gemini Omni: exactly { video_url, prompt, resolution }; "Bild 1" is not a placeholder here
      for (const [resolution, usd] of [['360p', 0.3], ['720p', 1], ['1080p', 1.5], ['4k', 3]]) {
        resetCalls();
        await run({ video: clip, prompt: text('Let it snow in the Video') }, { model: 'gemini_omni', resolution });
        assert.equal(lastSubmit().endpoint, 'google/gemini-omni-flash/v1.1/edit');
        assert.deepEqual(lastSubmit().input, { video_url: urlOf(clip), prompt: 'Let it snow in the Video', resolution }, resolution);
        job = (await store.readSession(sessionId)).jobs.slice(-1)[0];
        near(job.costEstimateUsd, usd, `Gemini Omni ${resolution}: 10 s`);
      }
      resetCalls();
      await run({ video: clip, prompt: text('Make it rain') }, { model: 'gemini_omni' });
      assert.deepEqual(lastSubmit().input, { video_url: urlOf(clip), prompt: 'Make it rain', resolution: '720p' }, 'the default resolution is 720p');
    }

    /* ---------- the checks before the run ---------- */
    {
      const fine = await video({ duration: 10 });
      const pic = await image();
      const prompt = text('Make it rain in the Video');

      // length
      await refused({ video: await video({ duration: 16 }), prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_LONG', { data: { model: 'Kling O3', max: 15, found: 16 }, message: /Trim video.*15 s.*Cut to the allowed length/ });
      await refused({ video: await video({ duration: 53 }), prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_LONG', { data: { max: 15, found: 53 } });
      await refused({ video: await video({ duration: 10.5 }), prompt }, { model: 'gemini_omni' }, 'VIDEO_EDIT_VIDEO_TOO_LONG', { data: { model: 'Gemini Omni', max: 10, found: 10.5 } });
      await refused({ video: await video({ duration: 2.5 }), prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_SHORT', { data: { model: 'Kling O3', min: 3, found: 2.5 } });
      await refused({ video: await video({ duration: 0.4 }), prompt }, { model: 'gemini_omni' }, 'VIDEO_EDIT_VIDEO_TOO_SHORT', { data: { min: 1 } });
      // the limits themselves are fine (and a few hundredths over are the rounding of the container)
      for (const [duration, params] of [[3, {}], [15, {}], [15.03, {}], [2.97, {}], [1, { model: 'gemini_omni' }], [10, { model: 'gemini_omni' }], [10.04, { model: 'gemini_omni' }]]) {
        resetCalls();
        await run({ video: await video({ duration }), prompt }, params);
        assert.equal(falCalls.submit.length, 1, `${duration} s is within the limits of ${params.model || 'kling_o3'}`);
      }
      // Wan names no length: a long video passes
      resetCalls();
      await run({ video: await video({ duration: 53 }), images: pic }, { model: 'wan_replace' });
      assert.equal(falCalls.submit.length, 1);

      // resolution (Kling: 720 to 3840 on both sides)
      await refused({ video: await video({ width: 640, height: 360 }), prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_SMALL', { data: { min: 720, width: 640, height: 360 }, message: /Resize video.*720 px/ });
      await refused({ video: await video({ width: 1080, height: 700 }), prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_SMALL', { data: { height: 700 } });
      await refused({ video: await video({ width: 7680, height: 4320 }), prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_LARGE', { data: { max: 3840, width: 7680, height: 4320 }, message: /Resize video.*3840 px/ });
      for (const [width, height] of [[1280, 720], [720, 1280], [3840, 2160], [2160, 3840]]) {
        resetCalls();
        await run({ video: await video({ width, height }), prompt }, {});
        assert.equal(falCalls.submit.length, 1, `${width} x ${height}`);
      }
      // Gemini Omni and Wan name no resolution
      resetCalls();
      await run({ video: await video({ width: 320, height: 180 }), prompt }, { model: 'gemini_omni' });
      await run({ video: await video({ width: 320, height: 180 }), images: pic }, { model: 'wan_replace' });
      assert.equal(falCalls.submit.length, 2);

      // format (Kling: MP4 or MOV) - the app stores MP4 and WebM
      const webm = await media('video', '.webm', { duration: 10, width: 1280, height: 720 });
      await refused({ video: webm, prompt }, {}, 'VIDEO_EDIT_VIDEO_FORMAT', { data: { model: 'Kling O3', format: 'WEBM' }, message: /MP4 or MOV.*Trim video/ });
      resetCalls();
      await run({ video: webm, prompt }, { model: 'gemini_omni' });
      assert.equal(falCalls.upload[0].contentType, 'video/webm', 'Gemini Omni takes WebM');
      // size (the upload limit of 90 MB; Kling says 200 MB)
      await refused({ video: await video({ size: 91 * MB }), prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_HEAVY', { data: { max: 90 }, message: /Resize video/ });

      // images
      await refused({ video: fine, images: list(await Promise.all([1, 2, 3, 4, 5].map(() => image()))), prompt }, {}, 'VIDEO_EDIT_TOO_MANY_IMAGES', { data: { max: 4, count: 5 } });
      resetCalls();
      await run({ video: fine, images: list(await Promise.all([1, 2, 3, 4].map(() => image()))), prompt }, {});
      assert.equal(falCalls.submit.length, 1, 'four images are fine');
      await refused({ video: fine, images: await image({ width: 299, height: 600 }), prompt }, {}, 'VIDEO_EDIT_IMAGE_TOO_SMALL', { data: { n: 1, min: 300, width: 299, height: 600 }, message: /300 x 300.*Resize image/ });
      await refused({ video: fine, images: list([await image(), await image({ width: 640, height: 200 })]), prompt }, {}, 'VIDEO_EDIT_IMAGE_TOO_SMALL', { data: { n: 2 } });
      resetCalls();
      await run({ video: fine, images: await image({ width: 300, height: 300 }), prompt }, {});
      assert.equal(falCalls.submit.length, 1, '300 x 300 is the smallest');
      // the minimum is for people and objects (frontal_image_url); style images have none
      resetCalls();
      await run({ video: fine, images: await image({ width: 100, height: 100 }), prompt }, { image_role: 'style' });
      assert.equal(falCalls.submit.length, 1);
      // an image from another session is refused
      const foreign = { ...(await image()), sessionId: 'someone-else' };
      resetCalls();
      await assert.rejects(run({ video: fine, images: foreign, prompt }, {}), /belongs to another session/);
      nothingSent();

      // Wan Replace: exactly one image
      await refused({ video: fine }, { model: 'wan_replace' }, 'VIDEO_EDIT_WAN_IMAGES', { data: { count: 0 } });
      await refused({ video: fine, images: list([pic, await image()]) }, { model: 'wan_replace' }, 'VIDEO_EDIT_WAN_IMAGES', { data: { count: 2 }, message: /exactly 1 image/ });

      // Gemini Omni: no images, a prompt, at most 10 s
      await refused({ video: fine, images: pic, prompt }, { model: 'gemini_omni' }, 'VIDEO_EDIT_GEMINI_IMAGES', { message: /^Gemini Omni takes no images\. Disconnect the images or choose Kling O3\.$/ });
      await refused({ video: fine }, { model: 'gemini_omni' }, 'VIDEO_EDIT_PROMPT_REQUIRED');
      await refused({ video: fine, prompt: text('   ') }, { model: 'gemini_omni' }, 'VIDEO_EDIT_PROMPT_REQUIRED');
      await refused({ video: fine, prompt: text('   ') }, {}, 'VIDEO_EDIT_PROMPT_REQUIRED');
      await refused({ video: fine }, {}, 'VIDEO_EDIT_PROMPT_REQUIRED', { message: /Kling O3 needs a prompt/ });

      // a prompt that points at an image that is not there
      await refused({ video: fine, images: pic, prompt: text('Replace the person with Image 2') }, {}, 'VIDEO_EDIT_PROMPT_IMAGE', { data: { n: 2, count: 1 } });
      await refused({ video: fine, prompt: text('Replace the person with Image 1') }, {}, 'VIDEO_EDIT_PROMPT_IMAGE', { data: { n: 1, count: 0 } });
      // ... but Gemini Omni has no placeholders: a "Bild 1" in its prompt is just text
      resetCalls();
      await run({ video: fine, prompt: text('Zeige Bild 1') }, { model: 'gemini_omni' });
      assert.equal(lastSubmit().input.prompt, 'Zeige Bild 1');

      // the video is required; the model must exist
      resetCalls();
      await assert.rejects(run({ prompt }, {}), /video: connect the video to edit/);
      await assert.rejects(nodesFal.planVideoEdit(ctx(), { video: fine, prompt }, { ...normalised({}), model: 'sora' }), /model: "sora" is not a valid option/);
      nothingSent();

      // without ffprobe the length and the size of the pictures cannot be read: the checks that need them are skipped, the rest holds
      probing = false;
      resetCalls();
      await run({ video: await video({ duration: null, width: 0, height: 0 }), prompt }, {});
      assert.equal(falCalls.submit.length, 1);
      await refused({ video: fine, images: pic, prompt }, { model: 'gemini_omni' }, 'VIDEO_EDIT_GEMINI_IMAGES');
      probing = true;
    }

    /* ---------- the checks of the node card (before a run, from the connections) ---------- */
    {
      const check = (rawParams, ports) => def.validate(normalised(rawParams), ports);
      const codes = (issues) => issues.map((issue) => `${issue.level || 'error'}:${issue.code}`);
      const wired = (images, prompt) => ({ video: { connected: true, count: 1 }, images: { connected: images > 0, count: images }, prompt: { connected: Boolean(prompt), count: prompt ? 1 : 0 } });
      // Kling: a prompt, at most 4 connections
      assert.deepEqual(codes(check({}, wired(0, false))), ['error:VIDEO_EDIT_PROMPT_REQUIRED']);
      assert.deepEqual(check({ prompt: 'rain' }, wired(2, false)), []);
      assert.deepEqual(check({}, wired(1, true)), [], 'a connected text is a prompt');
      assert.deepEqual(codes(check({ prompt: 'rain' }, wired(5, false))), ['error:VIDEO_EDIT_TOO_MANY_IMAGES']);
      assert.equal(check({ prompt: 'rain' }, wired(5, false))[0].port, 'images');
      assert.deepEqual(check({ prompt: 'rain' }, wired(5, false))[0].data, { max: 4, count: 5 });
      // Gemini Omni: no images, a prompt
      assert.deepEqual(codes(check({ model: 'gemini_omni', prompt: 'rain' }, wired(1, false))), ['error:VIDEO_EDIT_GEMINI_IMAGES']);
      assert.deepEqual(codes(check({ model: 'gemini_omni' }, wired(0, false))), ['error:VIDEO_EDIT_PROMPT_REQUIRED']);
      assert.deepEqual(check({ model: 'gemini_omni', prompt: 'rain' }, wired(0, false)), []);
      // Wan Replace: exactly one image; the prompt is ignored (a warning when a text is connected, no error without one)
      assert.deepEqual(codes(check({ model: 'wan_replace' }, wired(0, false))), ['error:VIDEO_EDIT_WAN_IMAGES']);
      assert.deepEqual(codes(check({ model: 'wan_replace' }, wired(2, false))), ['error:VIDEO_EDIT_WAN_IMAGES']);
      assert.deepEqual(check({ model: 'wan_replace' }, wired(1, false)), []);
      assert.deepEqual(codes(check({ model: 'wan_replace' }, wired(1, true))), ['warning:VIDEO_EDIT_WAN_PROMPT']);
      assert.equal(check({ model: 'wan_replace' }, wired(1, true))[0].port, 'prompt');

      // through the engine: an invalid plan names the code and the input
      const engine = createEngine({ store: wfStore, registry, events: bus, getConfig: () => ({}), limits: { jobPollMs: 20 } });
      const node = (id, type, params = {}, x = 0) => ({ id, type, typeVersion: 1, x, y: 0, params });
      const edge = (id, from, fromPort, to, toPort) => ({ id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
      const { workflow } = await wfStore.createWorkflow({ name: 'video edit plan' });
      created.push(workflow.id);
      const owner = workflow.sessionId;
      const scratch = await assets.createScratchDir(owner);
      await fsp.writeFile(path.join(scratch, 'clip.mp4'), 'not really a video');
      const clip12 = await assets.saveOutputFile(owner, { kind: 'video', ext: '.mp4', sourceFile: path.join(scratch, 'clip.mp4'), duration: 12 });
      await fsp.writeFile(path.join(scratch, 'clip20.mp4'), 'not really a video either');
      const clip20 = await assets.saveOutputFile(owner, { kind: 'video', ext: '.mp4', sourceFile: path.join(scratch, 'clip20.mp4'), duration: 20 });
      await assets.removeScratchDir(scratch);
      const upload = await store.saveAsset(owner, { kind: 'upload', buffer: Buffer.from('mp4'), ext: '.mp4', prompt: 'seed' });
      const portrait = await store.saveAsset(owner, { kind: 'upload', buffer: Buffer.from('png'), ext: '.png', prompt: 'seed' });
      const ref = (assetId) => ({ assetId, sessionId: owner });
      const fileOf = async (assetId) => (await store.readLedger(owner)).find((entry) => entry.id === assetId).file;
      probes.set(await fileOf(clip12.assetId), { video: { codec: 'x', width: 1280, height: 720, fps: 25 }, audio: null, duration: 12 });
      probes.set(await fileOf(clip20.assetId), { video: { codec: 'x', width: 1280, height: 720, fps: 25 }, audio: null, duration: 20 });
      probes.set(await fileOf(upload.id), { video: { codec: 'x', width: 1280, height: 720, fps: 25 }, audio: null, duration: 12 });
      probes.set(portrait.file, { video: { codec: 'x', width: 1024, height: 1024, fps: 1 }, audio: null, duration: null });
      let rev = workflow.rev;
      const useGraph = async (graph) => {
        rev = (await wfStore.saveGraph(workflow.id, { baseRev: rev, graph })).rev;
      };
      const graphWith = (assetId, params, withImage = false) => ({
        nodes: [
          node('v', 'input.video', { asset: ref(assetId) }),
          ...(withImage ? [node('i', 'input.image', { asset: ref(portrait.id) })] : []),
          node('e', TYPE, { prompt: 'Make it rain in the Video', ...params }, 300),
          node('o', 'output.result', { label: 'Clip' }, 600)
        ],
        edges: [edge('e1', 'v', 'video', 'e', 'video'), ...(withImage ? [edge('e2', 'i', 'image', 'e', 'images')] : []), edge('e3', 'e', 'video', 'o', 'inputs')]
      });
      const readyInputs = async (ids) => {
        const runId = await engine.start(workflow.id, { mode: 'node', nodeIds: ids, user: 'tester' });
        assert.equal((await engine.whenFinished(workflow.id, runId)).status, 'completed');
      };

      await useGraph(graphWith(clip12.assetId, { model: 'gemini_omni' }, true));
      let result = await engine.plan(workflow.id, { mode: 'all' });
      assert.equal(result.valid, false);
      const issue = result.issues.find((item) => item.code === 'VIDEO_EDIT_GEMINI_IMAGES');
      assert.ok(issue && issue.nodeId === 'e' && issue.port === 'images', JSON.stringify(result.issues));

      // the plan: price per second times the length of the video that is sent (known once the input node has run)
      await useGraph(graphWith(clip12.assetId, {}));
      result = await engine.plan(workflow.id, { mode: 'all' });
      assert.equal(result.valid, true, JSON.stringify(result.issues));
      assert.equal(result.nodes.e.estimate, null, 'the input node has not run: the length is not known');
      assert.equal(result.totals.unknownNodes, 1);
      await readyInputs(['v']);
      result = await engine.plan(workflow.id, { mode: 'all' });
      near(result.nodes.e.estimate.usd, 1.68, '12 s at 0.14');
      near(result.totals.usd, 1.68, 'the total of the plan');
      assert.equal(result.totals.unknownNodes, 0);
      for (const [overrides, usd] of [
        [{ quality: '4k' }, 5.04],
        [{ quality: 'pro' }, 1.68],
        [{ model: 'gemini_omni' }, 1.2],
        [{ model: 'gemini_omni', resolution: '360p' }, 0.36],
        [{ model: 'gemini_omni', resolution: '1080p' }, 1.8],
        [{ model: 'gemini_omni', resolution: '4k' }, 3.6]
      ]) {
        result = await engine.plan(workflow.id, { mode: 'all', overrides: { e: overrides } });
        near(result.nodes.e.estimate.usd, usd, JSON.stringify(overrides));
      }
      // a video that is too long: the whole length, or the limit of the model where the cut is on
      await useGraph(graphWith(clip20.assetId, {}));
      await readyInputs(['v']);
      result = await engine.plan(workflow.id, { mode: 'all' });
      near(result.nodes.e.estimate.usd, 2.8, '20 s at 0.14 (the run would be refused)');
      result = await engine.plan(workflow.id, { mode: 'all', overrides: { e: { cut_to_limit: true } } });
      near(result.nodes.e.estimate.usd, 2.1, 'cut to 15 s');
      result = await engine.plan(workflow.id, { mode: 'all', overrides: { e: { cut_to_limit: true, model: 'gemini_omni' } } });
      near(result.nodes.e.estimate.usd, 1, 'cut to 10 s at 0.10');
      result = await engine.plan(workflow.id, { mode: 'all', overrides: { e: { cut_to_limit: true, model: 'gemini_omni', resolution: '4k' } } });
      near(result.nodes.e.estimate.usd, 3, 'cut to 10 s at 0.30');
      result = await engine.plan(workflow.id, { mode: 'all', overrides: { e: { cut_to_limit: true, model: 'wan_replace' } } });
      assert.equal(result.valid, false, 'Wan needs its image');
      // an upload carries no length: still unknown after the input node ran
      await useGraph(graphWith(upload.id, {}));
      await readyInputs(['v']);
      result = await engine.plan(workflow.id, { mode: 'all' });
      assert.equal(result.nodes.e.estimate, null, 'an upload has no length');
      assert.equal(result.totals.unknownNodes, 1);
      // the estimate of the card without a connection: unknown, never a guess from an earlier run
      assert.equal(def.cost.estimate(normalised({})), null);
      assert.equal(def.cost.history, false);
      near(def.cost.estimate(normalised({}), { inputs: { video: { type: 'video', duration: 8 } } }), 1.12, '8 s at 0.14');
      near(def.cost.estimate(normalised({ model: 'gemini_omni', resolution: '1080p' }), { inputs: { video: { type: 'video', duration: 8 } } }), 1.2, '8 s at 0.15');
      near(def.cost.estimate(normalised({ model: 'wan_replace' }), { inputs: { video: { type: 'video', duration: 8 } } }), 0.64, '8 s at 0.08');
      near(def.cost.estimate(normalised({ quality: '4k' }), { inputs: { video: { type: 'video', duration: 8 } } }), 3.36, '8 s at 0.42');
      near(def.cost.estimate(normalised({ cut_to_limit: true }), { inputs: { video: { type: 'video', duration: 40 } } }), 2.1, 'cut to 15 s');
      near(def.cost.estimate(normalised({ cut_to_limit: true, model: 'wan_replace' }), { inputs: { video: { type: 'video', duration: 40 } } }), 3.2, 'Wan names no limit: the whole video');
      assert.equal(def.cost.estimate({ ...normalised({}), model: 'sora' }, { inputs: { video: { type: 'video', duration: 8 } } }), null, 'an invalid option has no price');

      // a whole run through the engine: the node runs, the cost of the poller is booked
      await useGraph(graphWith(clip12.assetId, {}, true));
      await readyInputs(['v', 'i']);
      const backing = workflow.sessionId;
      const submitsBefore = falCalls.submit.length;
      const completer = setInterval(async () => {
        let current;
        try {
          current = await store.readSession(backing);
        } catch (_) {
          return;
        }
        for (const entry of current.jobs) {
          if (entry.source !== 'fal' || entry.status !== 'pending') continue;
          await store.completeAsset(backing, entry.assetId, Buffer.from('fake-mp4'), 1.68);
          await store.mutateSession(backing, (s) => {
            const target = s.jobs.find((item) => item.assetId === entry.assetId);
            target.status = 'completed';
            target.resultAssetIds = [entry.assetId];
          });
        }
      }, 10);
      try {
        const runId = await engine.start(workflow.id, { mode: 'all', user: 'tester' });
        const record = await engine.whenFinished(workflow.id, runId);
        assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
        assert.equal(falCalls.submit.length, submitsBefore + 1);
        assert.equal(lastSubmit().endpoint, 'fal-ai/kling-video/o3/standard/video-to-video/edit');
        assert.equal(lastSubmit().input.prompt, 'Make it rain in the @Video1');
        assert.equal(lastSubmit().input.elements.length, 1);
        const results = await wfStore.readResults(workflow.id);
        const variant = results.nodes.e.history[0].variants[0];
        assert.equal(variant.video.type, 'video');
        near(results.nodes.e.history[0].cost.usd, 1.68, 'the cost is booked');
      } finally {
        clearInterval(completer);
      }
      // the run of a refused video says the code, so the card shows it in its language
      await useGraph(graphWith(clip20.assetId, {}));
      await readyInputs(['v']);
      const refusedRun = await engine.start(workflow.id, { mode: 'all', user: 'tester' });
      const refusedRecord = await engine.whenFinished(workflow.id, refusedRun);
      assert.equal(refusedRecord.status, 'failed', JSON.stringify(refusedRecord.nodes));
      assert.equal(refusedRecord.nodes.e.code, 'VIDEO_EDIT_VIDEO_TOO_LONG');
      assert.deepEqual(refusedRecord.nodes.e.data, { model: 'Kling O3', max: 15, found: 20 });
    }

    /* ---------- cut to the allowed length ---------- */
    {
      const pic = await image();
      const prompt = text('Make it rain in the Video');
      // Kling: 20 s -> the first 15 s, uploaded by the node as an MP4; the price is 15 s
      resetCalls();
      cuts.length = 0;
      logs.length = 0;
      const long = await video({ duration: 20 });
      let planned = await plan({ video: long, prompt }, { cut_to_limit: true });
      assert.equal(planned.trimmed, true);
      near(planned.estimateUsd, 2.1, '15 s at 0.14');
      assert.deepEqual(planned.media.filter((entry) => entry.field === 'video_url'), [], 'the video that is sent is the cut one');
      assert.match(planned.input.video_url, /trimmed-video\.mp4$/);
      assert.equal(cuts.length, 1);
      const args = cuts[0];
      assert.equal(args[args.indexOf('-i') + 1], assets.assetFilePath(long), 'the cut starts from the video of the node');
      assert.equal(args[args.indexOf('-t') + 1], '15', 'the first 15 s');
      assert.ok(args.includes('0:a?'), 'with its sound');
      assert.equal(args.includes('-ss'), false, 'from the start');
      assert.ok(logs.some((line) => /first 15 s/.test(line)), 'the run log says so');
      assert.deepEqual(await scratchLeftovers(), [], 'the scratch folder is removed');
      assert.deepEqual(falCalls.upload.map((entry) => `${entry.file}:${entry.contentType}`), ['trimmed-video.mp4:video/mp4']);
      assert.equal(falCalls.submit.length, 0, 'planning queues nothing');

      resetCalls();
      cuts.length = 0;
      await run({ video: long, images: pic, prompt }, { cut_to_limit: true });
      assert.deepEqual(falCalls.upload.map((entry) => entry.file).sort(), [pic.file, 'trimmed-video.mp4'].sort());
      assert.equal(lastSubmit().input.video_url, 'https://v3b.fal.media/files/trimmed-video.mp4');
      assert.equal(lastSubmit().input.elements.length, 1);
      let job = (await store.readSession(sessionId)).jobs.slice(-1)[0];
      near(job.costEstimateUsd, 2.1, 'booked: 15 s, not 20 s');
      assert.deepEqual(await scratchLeftovers(), []);

      // Gemini Omni: the first 10 s
      resetCalls();
      cuts.length = 0;
      await run({ video: long, prompt }, { cut_to_limit: true, model: 'gemini_omni', resolution: '1080p' });
      assert.equal(cuts[0][cuts[0].indexOf('-t') + 1], '10');
      assert.deepEqual(lastSubmit().input, { video_url: 'https://v3b.fal.media/files/trimmed-video.mp4', prompt: 'Make it rain in the Video', resolution: '1080p' });
      job = (await store.readSession(sessionId)).jobs.slice(-1)[0];
      near(job.costEstimateUsd, 1.5, '10 s at 0.15');

      // a video that is not too long is not touched (no ffmpeg run, no extra upload), whatever the switch says
      resetCalls();
      cuts.length = 0;
      const short = await video({ duration: 15 });
      planned = await plan({ video: short, prompt }, { cut_to_limit: true });
      assert.equal(planned.trimmed, false);
      assert.equal(cuts.length, 0);
      assert.equal(falCalls.upload.length, 0);
      assert.equal(planned.media[0].field, 'video_url', 'the video goes up as it is');
      near(planned.estimateUsd, 2.1);
      // the cut makes an MP4: a long WebM can be cut (the other checks look at the file that is sent)
      const longWebm = await media('video', '.webm', { duration: 30, width: 1280, height: 720 });
      resetCalls();
      await run({ video: longWebm, prompt }, { cut_to_limit: true });
      assert.deepEqual(falCalls.upload.map((entry) => entry.file), ['trimmed-video.mp4']);
      // the other rules still hold for a video that is cut
      cuts.length = 0;
      await refused({ video: await video({ duration: 30, width: 640, height: 360 }), prompt }, { cut_to_limit: true }, 'VIDEO_EDIT_VIDEO_TOO_SMALL');
      await refused({ video: long, images: await image({ width: 100, height: 100 }), prompt }, { cut_to_limit: true }, 'VIDEO_EDIT_IMAGE_TOO_SMALL');
      assert.equal(cuts.length, 0, 'nothing is cut for a run that is refused anyway');
      // without the switch the same video is refused and not cut
      await refused({ video: long, prompt }, {}, 'VIDEO_EDIT_VIDEO_TOO_LONG');
      assert.equal(cuts.length, 0);

      // no ffmpeg: said before anything is uploaded
      binariesQueue.push(true, false);
      await refused({ video: long, prompt }, { cut_to_limit: true }, 'VIDEO_EDIT_FFMPEG_MISSING', { message: /ffmpeg and ffprobe are needed/ });
      assert.equal(binariesQueue.length, 0, 'both calls were made: the video was measured, then the cut found no ffmpeg');

      // a failing ffmpeg: a plain message, nothing uploaded, nothing left behind
      patch(ffmpeg, 'runProcess', async () => {
        throw new Error('ffmpeg exited with code 1: Invalid data found');
      });
      resetCalls();
      await assert.rejects(run({ video: long, prompt }, { cut_to_limit: true }), /the video could not be cut to 15 s \(ffmpeg exited with code 1/);
      nothingSent();
      assert.deepEqual(await scratchLeftovers(), []);
      restorers.pop()();
      // a cancelled run does not upload
      const controller = new AbortController();
      controller.abort();
      resetCalls();
      await assert.rejects(def.execute(ctx({ signal: controller.signal }), { video: long, prompt }, normalised({ cut_to_limit: true })));
      nothingSent();
      assert.deepEqual(await scratchLeftovers(), []);
    }

    /* ---------- one real cut with ffmpeg ---------- */
    if (realBinaries.available) {
      const sourceFile = path.join(tmpDir, 'twelve.mp4');
      await execFileAsync(realBinaries.ffmpeg, ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourceFile]);
      const content = await fsp.readFile(sourceFile);
      const twelve = await media('video', '.mp4', { duration: 12, width: 320, height: 180, content });
      fakeCut = false;
      resetCalls();
      uploadedCopies.length = 0;
      await run({ video: twelve, prompt: text('Make it rain') }, { model: 'gemini_omni', cut_to_limit: true });
      fakeCut = true;
      assert.equal(uploadedCopies.length, 1, 'the cut file was uploaded');
      const { stdout } = await execFileAsync(realBinaries.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', uploadedCopies[0]]);
      const data = JSON.parse(stdout);
      const seconds = Number(data.format.duration);
      assert.ok(seconds > 9.8 && seconds < 10.3, `the cut file is about 10 s long (${seconds})`);
      assert.ok(data.streams.some((stream) => stream.codec_type === 'audio'), 'with its sound');
      assert.ok(data.streams.some((stream) => stream.codec_type === 'video' && stream.codec_name === 'h264'), 'as an MP4 with H.264');
      assert.deepEqual(await scratchLeftovers(), [], 'no scratch folder left');
    } else {
      console.log('ffmpeg not found: the real cut is skipped');
    }
  } finally {
    restoreAll();
    for (const id of created) await wfStore.deleteWorkflow(id).catch(() => {});
    for (const id of sessions) await store.deleteSession(id).catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
  console.log('test-nodes-video-edit.js: ok');
}

function list(items) {
  return listValue(items[0].type, items);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
