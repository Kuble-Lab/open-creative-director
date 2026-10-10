'use strict';

// The whole chain of the template "Event video (aftermovie)" (WP53, package D) through the real engine, in the two steps of the app view:
//   A  three clips with sound (one speaks) and four photos, 16:9, 30 s: step 1 makes the analysis, the music and the plan (the board, the chosen
//      shots) and nothing of step 2; step 2 makes the depth maps, the parallax, the cut and the render from the cache of step 1. The film is
//      1920 x 1080 at 24 fps with sound, the SRT holds the soundbite
//   B  six photos only (upright and wide), 9:16, 30 s, the photos moved with AI (one clip): no video, no soundbite, no speech; the film is
//      1080 x 1920, the SRT is empty
// The real nodes run everywhere but at the providers: the language model (vision and planner) answers from the prompt, ElevenLabs (music and
// speech), the analysis of the beats, the depth maps, the AI clip and the render node itself are doubles. ffmpeg runs for real. A private copy of
// the app runs in a temp directory and a fetch guard refuses everything except localhost: nothing is paid and nothing leaves the machine.

const assert = require('assert/strict');
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { promisify } = require('util');

const { createIsolatedApp } = require('./support/isolated-app');
const { toneWav } = require('./support/explainer-media');

const execFileAsync = promisify(execFile);
const STAFF = 'staff1@staff.example.com';
const BEATS = JSON.parse(fs.readFileSync(path.join(__dirname, 'support', 'event-video', 'beats-60.json'), 'utf8'));
const BRIEF = 'Innovation Day 2026 der Muster AG am 12. März 2026 in Zürich. Anna Muster, CEO, eröffnet den Tag. Danach Workshops und ein Apéro.';
const SPOKEN = 'Willkommen zum Innovation Day. Heute zeigen wir euch, woran wir ein ganzes Jahr gearbeitet haben.'.split(' ');

const restorers = [];
function patch(target, key, value) {
  const original = target[key];
  target[key] = value;
  restorers.push(() => {
    target[key] = original;
  });
}

function guardFetch() {
  const original = global.fetch;
  const attempts = [];
  global.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
      attempts.push(url);
      return Promise.reject(new Error(`network access refused in the test: ${url}`));
    }
    return original(input, init);
  };
  return { attempts, restore: () => (global.fetch = original) };
}

// The analysis of a piece of music of `seconds`: the beats of the fixture up to its end
function beatsFor(seconds) {
  const before = (t) => t < seconds;
  return {
    ...BEATS,
    duration: seconds,
    beats: BEATS.beats.filter(before),
    downbeats: BEATS.downbeats.filter(before),
    hits: BEATS.hits.filter((hit) => before(hit.t)),
    energy: BEATS.energy.slice(0, Math.floor(seconds * 2)),
    sections: BEATS.sections.filter((section) => before(section.start)).map((section) => ({ ...section, end: Math.min(section.end, seconds) }))
  };
}

// What the vision model "sees": the clips speak or applaud, the photos show people
function visionAnswer(prompt, counter) {
  const photo = /^Analyze this photo\./.test(prompt);
  const n = counter.next++;
  return {
    subject: photo ? `guests at the event, photo ${n}` : n === 0 ? 'a speaker on stage at a lectern' : `the audience of the event, clip ${n}`,
    people: photo ? '2-5' : n === 0 ? '1' : 'crowd',
    faces_visible: true,
    emotion: photo ? 'laughing' : n === 0 ? 'focused' : 'cheering',
    action: photo ? 'other' : n === 0 ? 'speech' : 'applause',
    framing: ['wide', 'medium', 'close', 'detail'][n % 4],
    stage: !photo && n === 0,
    text_in_image: [],
    risk: [],
    fit: photo ? ['b_roll'] : n === 0 ? ['speaker'] : ['opener', 'crowd'],
    score: 4
  };
}

// The planner "answers" from its prompt: the units of the list in order, as many per act as the grid asks for (each once), the soundbite of the
// transcript, the texts from the description, one photo with AI and two with parallax when the options ask for them
function planAnswer(system, prompt) {
  const acts = [...system.matchAll(/(hook|arrival|programme|people|peak|close) (\d+) picks?/g)].map((match) => ({ act: match[1], count: Number(match[2]) }));
  const units = [];
  const transcripts = [];
  for (const line of prompt.split('\n')) {
    const scene = /^ {2}(v\d+#\d+) (?!looks like)/.exec(line);
    const photo = /^(p\d+) photo/.exec(line);
    const words = /^ {2}transcript \(\w+\): (.*)$/.exec(line);
    if (scene) units.push(scene[1]);
    else if (photo) units.push(photo[1]);
    else if (words) transcripts.push({ ref: units[units.length - 1].split('#')[0], words: (words[1].match(/(?:^| )\d+ /g) || []).length });
  }
  const queue = units.slice();
  const answer = {
    treatment: 'A bright day of ideas: arrival, the keynote, the people, applause.',
    acts: acts.map(({ act, count }) => ({ act, picks: queue.splice(0, count).map((ref) => ({ ref, why: 'a good moment', slow: false, pair: null })) })),
    soundbites: transcripts.map((item) => ({ ref: item.ref, word_from: 0, word_to: item.words - 1, speaker: 'Anna Muster', role: 'CEO', source: 'description' })),
    title: { text: 'Innovation Day 2026', sub: 'Zürich, 12. März 2026', source: 'description' },
    lower_thirds: transcripts.length ? [{ soundbite: 0, name: 'Anna Muster', role: 'CEO', label: null, source: 'description' }] : [],
    intertitles: [],
    ai_photos: /for AI animation \("ai_photos"\)/.test(system) ? units.filter((ref) => ref.startsWith('p')).slice(0, 1).map((ref) => ({ ref, prompt: 'slow push in, people move a little' })) : [],
    parallax: units.filter((ref) => ref.startsWith('p')).slice(1, 3),
    voiceover: [],
    endcard: { line: 'Danke, Zürich.', sub: null, url: null, source: 'description' }
  };
  return answer;
}

async function main() {
  const guard = guardFetch();
  const iso = await createIsolatedApp({
    env: {
      ADMIN_EMAILS: 'admin@example.com',
      SUPERADMIN_EMAILS: '',
      INTERNAL_EMAIL_DOMAINS: 'staff.example.com',
      OPENROUTER_API_KEY: 'test-openrouter-key-0123456789',
      ELEVENLABS_API_KEY: 'test-elevenlabs-key-0123456789',
      FAL_KEY: 'test-fal-key-0123456789',
      PUBLIC_BASE_URL: '',
      ACCESS_ALLOWLIST_FILE: '',
      ACCESS_ALLOWLIST_ROUTE: '',
      GTS_API_TOKEN: ''
    }
  });
  try {
    await run(iso);
  } finally {
    while (restorers.length) restorers.pop()();
    guard.restore();
    await iso.cleanup();
  }
  assert.deepEqual(guard.attempts, [], 'no request left the machine');
  console.log('test-event-video-chain.js: ok');
}

async function run(iso) {
  const ffmpegLib = iso.load('lib/ffmpeg');
  const bins = ffmpegLib.binaries();
  if (!bins.available) {
    console.log('ffmpeg not found: the chain is skipped');
    return;
  }
  const store = iso.load('lib/store');
  const assets = iso.load('lib/nodes/assets');
  const llm = iso.load('lib/nodes/llm');
  const tools = iso.load('lib/tools');
  const costs = iso.load('lib/costs');
  const rendernode = iso.load('lib/rendernode');
  const registryModule = iso.load('lib/nodes/registry');
  const templatesLib = iso.load('lib/nodes/templates');
  const vision = iso.load('lib/event-video/vision');
  const contract = iso.load('lib/event-video/contract');
  const { createEventBus } = iso.load('lib/nodes/events');
  const { createWorkflowsStore } = iso.load('lib/nodes/workflows-store');
  const { createEngine } = iso.load('lib/nodes/engine');
  const { textValue } = iso.load('lib/nodes/types');
  const real = registryModule.registry;

  const ff = (args) => execFileAsync(bins.ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args], { maxBuffer: 16 * 1024 * 1024 });
  async function probe(file) {
    const { stdout } = await execFileAsync(bins.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { maxBuffer: 16 * 1024 * 1024 });
    const data = JSON.parse(stdout);
    const video = data.streams.find((stream) => stream.codec_type === 'video');
    const [num, den] = String(video.avg_frame_rate).split('/').map(Number);
    return { duration: Number(data.format.duration), width: video.width, height: video.height, fps: num / (den || 1), audio: data.streams.some((stream) => stream.codec_type === 'audio'), codec: video.codec_name };
  }
  const workDir = await fsp.mkdtemp(path.join(iso.root, 'event-chain-'));
  let counter = 0;
  const fileIn = (name) => path.join(workDir, `${++counter}-${name}`);

  /* ---------- the providers, replaced ---------- */

  patch(costs, 'recordCost', async (entry) => entry);
  const seen = { vision: 0, planner: [], music: [], speech: 0, renders: 0, depth: 0, clips: 0 };
  const visionCounter = { next: 0 };
  patch(llm, 'completeText', async (options) => {
    if (options.system === vision.SYSTEM) {
      seen.vision += 1;
      return { text: JSON.stringify(visionAnswer(options.prompt, visionCounter)), usd: 0.006 };
    }
    seen.planner.push(options);
    return { text: JSON.stringify(planAnswer(options.system, options.prompt)), usd: 0.4, model: options.model, usage: { completion_tokens: 4000 } };
  });
  const originalTool = tools.executeTool;
  patch(tools, 'executeTool', async (ctx, name, args) => {
    if (name === 'generate_music') {
      seen.music.push(args);
      const saved = await store.saveAsset(ctx.sessionId, { kind: 'audio', buffer: toneWav(args.length_seconds, 220), ext: '.wav', prompt: args.prompt, cost: 0 });
      return { asset: saved };
    }
    if (name === 'lyrics_timing') {
      seen.speech += 1;
      const words = SPOKEN.map((word, index) => ({ text: word, start: 0.5 + index * 0.27, end: 0.5 + index * 0.27 + 0.24 }));
      return { timing: { words }, language: 'de', costUsd: 0 };
    }
    return originalTool(ctx, name, args);
  });
  // the render node: a job is a plain clip as long as the page says (the pages themselves are tested in test-event-video-render.js)
  const submits = [];
  patch(rendernode, 'enabled', () => true);
  patch(rendernode, 'listConfiguredNodes', () => [{ id: 'rn1', name: 'Render 1', enabled: true }]);
  patch(rendernode, 'submit', async (html, quality, files, format, fps) => {
    submits.push({ html, format, fps, jobId: `job-${submits.length + 1}` });
    return { jobId: `job-${submits.length}`, nodeId: 'rn1' };
  });
  async function fakeWait(ctx, job) {
    const entry = submits.find((item) => item.jobId === job.jobId);
    assert.ok(entry, `a render was sent for ${job.jobId}`);
    const frames = Math.ceil(Number(/data-duration="([\d.]+)"/.exec(entry.html)[1]) * entry.fps - 1e-9);
    seen.renders += 1;
    const size = entry.format === 'portrait' ? '180x320' : entry.format === 'square' ? '240x240' : '320x180';
    const file = path.join(store.sessionAssetDir(ctx.sessionId), `fake-render-${seen.renders}.mp4`);
    await ff(['-f', 'lavfi', '-i', `testsrc2=s=${size}:r=${entry.fps}`, '-frames:v', String(frames), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', file]);
    await store.completeAssetFile(ctx.sessionId, job.assetId, file, { cost: 0, duration: frames / entry.fps, ext: '.mp4', kind: 'video' });
    return [job.assetId];
  }

  const registry = registryModule.createRegistry();
  for (const def of real.list()) registry.register(def);
  const double = (type, execute) => {
    const def = registry.get(type);
    registry.unregister(type);
    registry.register({ ...def, available: () => true, prepare: undefined, execute });
  };
  const scratchFile = async (ctx, name) => path.join(await assets.createScratchDir(ctx.sessionId), name);
  const keepFile = async (ctx, file, options) => {
    const value = await ctx.saveOutputFile({ sourceFile: file, ...options });
    await assets.removeScratchDir(path.dirname(file));
    return value;
  };
  double('audio.beats', async (_ctx, inputs) => {
    const seconds = inputs.audio.duration || 32;
    return { variants: [{ analysis: textValue(JSON.stringify(beatsFor(seconds))) }] };
  });
  double('fal.depth_map', async (ctx) => {
    seen.depth += 1;
    const file = await scratchFile(ctx, 'depth.png');
    await ff(['-f', 'lavfi', '-i', 'color=c=white:s=64x48,format=gray', '-f', 'lavfi', '-i', 'color=c=black:s=64x48,format=gray', '-filter_complex', 'vstack', '-frames:v', '1', file]);
    return { variants: [{ depth: await keepFile(ctx, file, { kind: 'image', ext: '.png', prompt: 'depth map', cost: 0 }) }] };
  });
  double('fal.h3_video', async (ctx, inputs, params) => {
    seen.clips += 1;
    assert.equal(params.prompt_expansion, 'disabled', 'the AI clip keeps the photo as it is');
    assert.ok(inputs.first_frame && inputs.prompt.value.length > 5, 'a photo and a camera prompt');
    const file = await scratchFile(ctx, 'clip.mp4');
    await ff(['-f', 'lavfi', '-i', `testsrc2=s=768x432:r=24:d=${params.duration}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', file]);
    return { variants: [{ video: await keepFile(ctx, file, { kind: 'video', ext: '.mp4', prompt: inputs.prompt.value, cost: 0, duration: params.duration }) }] };
  });
  const renderDef = registry.get('event_video.render');
  registry.unregister('event_video.render');
  registry.register({ ...renderDef, available: () => true, execute: (ctx, inputs, params) => renderDef.execute({ ...ctx, waitForJob: (job) => fakeWait(ctx, job) }, inputs, params) });

  const bus = createEventBus();
  const flowStore = createWorkflowsStore({ dir: path.join(iso.root, 'data', 'workflows-event-chain'), registry, events: bus });
  const engineConfig = { imageModel: 'openai/gpt-image-2', videoModel: 'bytedance/seedance-2.5', defaultBrain: 'anthropic/claude-opus-5.5', brainModels: ['anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5'] };
  const engine = createEngine({ store: flowStore, registry, events: bus, getConfig: () => engineConfig, limits: { jobPollMs: 20 } });

  /* ---------- material ---------- */

  const seed = async (file, ext, owner) => {
    const saved = await store.saveAsset(owner, { kind: 'upload', buffer: await fsp.readFile(file), ext, prompt: 'seed' });
    return { assetId: saved.id, sessionId: owner };
  };
  // Pictures with different shapes, so the analysis does not drop them as duplicates of each other (scene hash, WP53).
  const PATTERNS = ['testsrc2', 'smptebars', 'rgbtestsrc', 'mandelbrot', 'testsrc', 'cellauto', 'pal100bars', 'yuvtestsrc', 'smptehdbars', 'life'];
  const pattern = (index, size, rate, extra = '') => `${PATTERNS[index % PATTERNS.length]}=s=${size}:r=${rate}${extra}`;
  async function clip(index, { speaks }) {
    const file = fileIn(`clip-${index}.mp4`);
    const sound = speaks
      ? ['-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.4:d=8:r=48000', '-af', "volume=eval=frame:volume='0.05+0.95*abs(sin(2*PI*1.5*t))'"]
      : ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=8:sample_rate=48000'];
    await ff(['-f', 'lavfi', '-i', pattern(index, '640x360', 25, ':d=8'), ...sound, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
    return file;
  }
  async function photo(index, { upright }) {
    const file = fileIn(`photo-${index}.jpg`);
    const size = upright ? '480x640' : '640x480';
    await ff(['-f', 'lavfi', '-i', pattern(index + 5, size, 1), '-vf', `hue=h=${index * 50},format=yuvj420p`, '-frames:v', '1', '-q:v', '3', file]);
    return file;
  }

  async function startWorkflow(set) {
    const created = await flowStore.createWorkflow({ document: templatesLib.resolveTemplate('event-video', { lang: 'de' }), user: STAFF, owner: null });
    const workflow = created.workflow;
    const graph = JSON.parse(JSON.stringify(workflow.graph));
    const params = (id, values) => Object.assign(graph.nodes.find((node) => node.id === id).params, values);
    await set({ params, owner: workflow.sessionId });
    await flowStore.saveGraph(workflow.id, { baseRev: workflow.rev, graph });
    return workflow;
  }
  const finish = async (workflow, request) => {
    const runId = await engine.start(workflow.id, { user: STAFF, ...request });
    const record = await engine.whenFinished(workflow.id, runId);
    assert.equal(record.status, 'completed', JSON.stringify(record.nodes).slice(0, 1500));
    return record;
  };
  const resultOf = async (workflow, nodeId) => (await flowStore.readResults(workflow.id)).nodes[nodeId]?.history[0];
  const shown = async (workflow, nodeId) => {
    const leaves = (value) => (value.type === 'list' ? value.items.flatMap(leaves) : [value]);
    return leaves((await resultOf(workflow, nodeId)).variants[0].result);
  };
  const statusOf = (record) => Object.fromEntries(Object.entries(record.nodes).map(([id, entry]) => [id, entry.status]));
  const STEP1 = ['n23', 'n24', 'n25'];

  async function film(workflow, { width, height }) {
    const [video] = await shown(workflow, 'n20');
    assert.equal(video.type, 'video');
    const info = await probe(assets.assetFilePath(video));
    assert.deepEqual([info.width, info.height, Math.round(info.fps), info.audio, info.codec], [width, height, 24, true, 'h264'], 'the format, 24 fps, sound, H.264');
    assert.ok(info.duration > 20 && info.duration <= 31, `a film of about 30 s: ${info.duration}`);
    const [sheet] = await shown(workflow, 'n21');
    assert.equal(sheet.type, 'image', 'the contact sheet');
    const [srt] = await shown(workflow, 'n22');
    assert.equal(srt.type, 'text');
    return { info, srt: srt.value };
  }

  /* ---------- A: clips and photos, 16:9 ---------- */

  {
    const clips = [await clip(0, { speaks: true }), await clip(1, { speaks: false }), await clip(2, { speaks: false })];
    const photos = [];
    for (let index = 0; index < 4; index += 1) photos.push(await photo(index, { upright: index === 1 }));
    const workflow = await startWorkflow(async ({ params, owner }) => {
      params('n1', { assets: await Promise.all(clips.map((file) => seed(file, '.mp4', owner))) });
      params('n2', { assets: await Promise.all(photos.map((file) => seed(file, '.jpg', owner))) });
      params('n3', { prompt: BRIEF });
      params('n0', { length: '30', format: '16:9', event_type: 'conference', mood: 'fresh', language: 'de' });
    });
    // step 1: the analysis, the music and the plan; nothing of step 2
    const first = await finish(workflow, { mode: 'selection', nodeIds: STEP1 });
    const done1 = statusOf(first);
    for (const id of ['n6', 'n7', 'n8', 'n9', 'n10']) assert.equal(done1[id], 'done', `${id} runs in step 1`);
    for (const id of ['n11', 'n12a', 'n12', 'n13', 'n14', 'n15']) assert.equal(done1[id], undefined, `${id} waits for the approval`);
    assert.equal(seen.vision, 7, 'one look per clip and photo');
    assert.equal(seen.speech, 1, 'only the clip that speaks goes to the transcription');
    assert.equal(seen.music.length, 1);
    assert.equal(seen.music[0].length_seconds, 32, 'the music is the film plus 2 s');
    assert.equal(seen.music[0].instrumental, true);
    assert.equal(seen.planner.length, 1, 'one answer of the planner: no second try');
    assert.match(seen.planner[0].prompt, /Innovation Day 2026 der Muster AG/, 'the description reaches the planner');
    assert.match(seen.planner[0].prompt, /transcript \(de\): 0 Willkommen/, 'and the transcript');
    assert.deepEqual([seen.renders, seen.depth, seen.clips], [0, 0, 0]);
    const [board] = await shown(workflow, 'n24');
    assert.match(board.value, /Innovation Day 2026/);
    const [selection] = await shown(workflow, 'n25');
    assert.equal(selection.type, 'image', 'the chosen shots as a contact sheet');
    const [music] = await shown(workflow, 'n23');
    assert.equal(music.type, 'audio');
    const shotsText = (await resultOf(workflow, 'n10')).variants[0].shots.value;
    const shots = JSON.parse(shotsText);
    assert.ok(contract.checkShots(shots).ok, 'the plan keeps the contract');
    assert.ok(shots.shots.some((shot) => shot.kind === 'soundbite'), 'a soundbite');
    assert.ok(shots.shots.some((shot) => shot.kind === 'photo') && shots.shots.some((shot) => shot.kind === 'video'));

    // step 2: the rest, from the cache of step 1
    const second = await finish(workflow, { mode: 'all' });
    const done2 = statusOf(second);
    for (const id of ['n6', 'n7', 'n8', 'n9', 'n10']) assert.equal(done2[id], 'cached', `${id} comes from the cache`);
    assert.equal(seen.planner.length, 1, 'the planner is not asked again');
    assert.equal(seen.depth, 2, 'two depth maps for the parallax');
    assert.equal(seen.clips, 0, 'photos moved by code: no AI clip');
    assert.ok(seen.renders >= 2, `the render node drew ${seen.renders} chunks`);
    const { srt } = await film(workflow, { width: 1920, height: 1080 });
    assert.match(srt, /^1\n\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}\n.*Willkommen/m, 'the SRT holds the soundbite');
    console.log(`ok A: clips and photos, ${shots.shots.length} shots, ${seen.renders} chunks`);
  }

  /* ---------- B: photos only, 9:16, AI ---------- */

  {
    for (const key of Object.keys(seen)) seen[key] = Array.isArray(seen[key]) ? [] : 0;
    visionCounter.next = 0;
    const photos = [];
    for (let index = 0; index < 6; index += 1) photos.push(await photo(10 + index, { upright: index % 2 === 0 }));
    const workflow = await startWorkflow(async ({ params, owner }) => {
      params('n2', { assets: await Promise.all(photos.map((file) => seed(file, '.jpg', owner))) });
      params('n3', { prompt: BRIEF });
      params('n0', { length: '30', format: '9:16', event_type: 'party', mood: 'fast', language: 'de' });
      params('n10', { photo_motion: 'ai', max_ai_photos: 1 });
    });
    const plan = await engine.plan(workflow.id, { mode: 'all', user: STAFF });
    assert.equal(plan.valid, true, JSON.stringify(plan.issues));
    await finish(workflow, { mode: 'selection', nodeIds: STEP1 });
    assert.equal(seen.vision, 6);
    assert.equal(seen.speech, 0, 'no clip, no speech');
    assert.doesNotMatch(seen.planner[0].prompt, /transcript \(/, 'no transcript in the prompt');
    assert.match(seen.planner[0].system, /for AI animation \("ai_photos"\)/, 'the planner may choose photos for AI clips');
    assert.equal(seen.planner.length, 1, 'one answer of the planner: no second try');
    const shots = JSON.parse((await resultOf(workflow, 'n10')).variants[0].shots.value);
    assert.ok(shots.shots.every((shot) => shot.kind !== 'video' && shot.kind !== 'soundbite'), 'only photos (and their AI and parallax clips)');
    await finish(workflow, { mode: 'all' });
    assert.equal(seen.clips, 1, 'one photo animated with AI');
    const { srt } = await film(workflow, { width: 1080, height: 1920 });
    assert.equal(srt.trim(), '', 'no soundbite, no subtitle');
    console.log(`ok B: photos only, ${shots.shots.length} shots, ${seen.renders} chunks`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
