'use strict';

// The starter workflows of the music video in the HUD style (WP44, part 3): "Music video in the HUD style (your song)" (music-video-hud),
// "Music video in the HUD style (song by ElevenLabs)" (music-video-hud-elevenlabs), "Music video in the HUD style (song by Suno)"
// (music-video-hud-suno) and "Suno song pack" (suno-song-pack). The shape of the files (node types, edges, `requires`, the texts in three
// languages, the order and the prices of the gallery) is checked in test-nodes-templates.js; this test runs them. What is covered:
//   - the two texts that must not drift: the figure Claudia (the default of the field "Figure") and the system prompt of the Suno song
//     pack are the canon texts word for word; the prices in the descriptions are what the price tables of the planner say (a song of 60, 90
//     and 120 seconds; step 1 stays under 1 USD a minute of song), and the music of the second template costs what it says
//   - "Music video in the HUD style (your song)" through the real engine, with the real planner, the real cut, the real parallax node and
//     the real render node (HUD page and finishing): doubles only for what costs money or needs the network (the times of the lyrics,
//     the analysis of the song, the images, the lip sync, the video clips, the depth maps, the language model and the render node itself).
//     Step 1 (the marked outputs) makes the board, the character sheet and the pictures and nothing expensive; step 2 makes the rest from
//     the cache. The pictures use Nano Banana 2.1 with the character sheet as reference, captions are off in the base cut and the karaoke
//     line is off in the render, the lists fit the cut (sung, story and still clips), the style "Kuble" reaches the plan and the render
//   - the second template: the song comes from the idea (plan, then music), the song text goes to the analysis and to the lyric times, the
//     idea goes to the planner, step 1 holds the song and again nothing expensive
//   - the Suno song pack: the system prompt reaches the model word for word, the idea and the singer are in the request
//   - the template with the song by Suno, in the three steps of the app view (the decision of public/nodes/app-mode.js on the plans of the
//     real engine): step 1 makes only the pack and needs no song; step 2 is invalid without the song and valid with it, the pack stays in the
//     cache after the upload, the idea reaches the planner, the pack does not reach the lyric times; step 3 ("Approve and finish") makes the
//     rest without making or paying anything of the steps before again (the still clips, the cut and the render only take note there: the
//     first template renders the same part of the graph for real). Its texts: the pack and the figure are the canon texts, the prices are
//     the ones of the template with your own song, word for word
// A private copy of the app runs in a temp directory (own data folders). The providers are replaced and a fetch guard refuses everything
// except localhost: nothing is paid and nothing leaves the machine. The parts that need ffmpeg are skipped when it is missing.

const assert = require('assert/strict');
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { promisify } = require('util');
const vm = require('vm');

const { createIsolatedApp } = require('./support/isolated-app');
const { toneWav } = require('./support/explainer-media');
const { makeSong, goodAnswer } = require('./support/hud-plan-fixtures');

const execFileAsync = promisify(execFile);
const STAFF = 'staff1@staff.example.com';
const NANO_BANANA = 'google/gemini-nano-banana-2.1';

// The figure Claudia (E of the prompt book): the default of the field "Figure", word for word.
const CLAUDIA = `NAME: Claudia
FULL: a 28-year-old Caucasian American woman with a grown-up angular face, defined cheekbones and a strong jawline, pale skin and light freckles, a glossy black blunt jaw-length bob with heavy straight bangs and one clay-orange streak through the bangs, a small flat clay-orange eight-pointed star hair clip, a thin headset microphone at her cheek
SHORT: a Caucasian American woman in her late twenties with pale skin and a glossy black blunt bob with heavy straight bangs and one clay-orange streak, a thin headset microphone
LOOKS: editorial pop-star wardrobe that changes per chapter (for example a white cropped puff-sleeve shirt with a black pleated coated-nylon skirt, a liquid-chrome bodysuit, a glossy cobalt-blue patent-leather trench over white satin); the clay-orange streak and the star clip are the only clay accents on her
FACE: a deadpan, curious resting face; when she sings, her mouth opens wide
NEVER: a second Claudia, the word young, a microphone in front of her mouth when she sings
CREDIT: Claudia by anabology (claudia.gallery)`;

// The system prompt of the Suno song pack (F of the prompt book), word for word.
const SUNO_SYSTEM = `You write a complete Suno song pack for an AI pop singer. The user gives an idea and the singer (voice and persona). Answer in plain text with exactly these four blocks and nothing else:

TITLE
<a short title>

STYLE
<one line for Suno's style field, at most 900 characters: genre and sub-genre, BPM, time signature, key (and a lift for the chorus if it helps), the main instruments and sound design, and the vocal delivery of the singer in concrete words, e.g. "deadpan female spoken-word verses, close and dry, clipped and confident, rising into euphoric sung choruses, every word crisp and intelligible">

EXCLUDE
<a comma-separated list for Suno's exclude field, e.g. "rap, rock guitar, lo-fi, male lead vocal, mumbled vocals, big room EDM, dubstep">

LYRICS
<the lyrics for Suno's lyrics field>

Rules for the lyrics:
- The topic is obvious in the first two lines; one listen must be enough. Obscure references belong in the video, not in the words.
- Sections in square brackets: [Intro], [Verse 1], [Pre-Chorus], [Chorus], [Verse 2], [Bridge], [Drop], [Outro]. Sung parts may go in round brackets. Short stage directions in square brackets are allowed, e.g. [darker, the bass drops out].
- Spoken verse lines are natural sentences of 10 to 13 syllables with the stressed words where speech stresses them; couplets rhyme on the last word. Sung hooks have 4 to 8 syllables and repeat.
- Every line gives the video something to show: a number, a place, an object, a thing someone says. Numbers and abbreviations are written the way they are sung ("two thousand and forty-eight", "A G I").
- Length: 1800 to 2400 characters in total (about two and a half minutes; Suno cuts everything after about 3000).
- Write in the language of the idea unless the user asks for another one.
- No real people, brands or song quotes.`;

const near = (actual, expected, tolerance, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} !== ${expected} (±${tolerance})`.trim());

// The decision of the app view (which step is due, which request starts it): the pure functions of public/nodes/app-mode.js, run in a vm
// like in test-nodes-app.js. What they return is cloned to plain data (the vm has its own prototypes).
function loadStageLogic() {
  const ui = { el: () => ({}), icon: () => ({}), T: (key) => key };
  const window = { OCDNodes: { graph: {}, ui, api: {}, run: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'nodes', 'app-mode.js'), 'utf8'), { window, localStorage: undefined, console });
  const raw = window.OCDNodes.appMode;
  const plain = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  return {
    approvalStages: (...args) => plain(raw.approvalStages(...args)),
    previewRequest: (...args) => plain(raw.previewRequest(...args)),
    stageFlow: (...args) => plain(raw.stageFlow(...args))
  };
}

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

// Nothing but localhost may be reached, whatever a code path tries.
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
  return {
    attempts,
    restore() {
      global.fetch = original;
    }
  };
}

// Colours that a pixel can tell apart after the codec: the pictures are named by them, so what the cut shows tells where a clip came from.
const PALETTE = ['ff0000', '00ff00', '0000ff', 'ffff00', 'ff00ff', '00ffff', 'ff8000', '8000ff', '80ff00', '0080ff', 'ff0080', '808080', 'c0c0c0', '804000', '008040'];
const rgbOf = (hex) => [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
function nearestColour(rgb) {
  let best = null;
  for (const hex of PALETTE) {
    const [r, g, b] = rgbOf(hex);
    const distance = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
    if (!best || distance < best.distance) best = { hex, distance };
  }
  return best.hex;
}

/* ---------- main ---------- */

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
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  try {
    await run(iso);
  } finally {
    restoreAll();
    guard.restore();
    await iso.cleanup();
  }
  assert.deepEqual(guard.attempts, [], 'no request left the machine');
  console.log('Musikvideo im HUD-Stil: Vorlagen (Figurentext, Suno-Prompt, Preise), Ablauf durch die Engine, Song von ElevenLabs und Suno-Paket sind korrekt.');
  console.log('test-music-video-hud-template.js: ok');
}

async function run(iso) {
  const store = iso.load('lib/store');
  const assets = iso.load('lib/nodes/assets');
  const llm = iso.load('lib/nodes/llm');
  const costs = iso.load('lib/costs');
  const rendernode = iso.load('lib/rendernode');
  const ffmpegLib = iso.load('lib/ffmpeg');
  const registryModule = iso.load('lib/nodes/registry');
  const nodesBasic = iso.load('lib/nodes/nodes-basic');
  const musicVideoNodes = iso.load('lib/nodes/nodes-music-video');
  const hudNodes = iso.load('lib/nodes/nodes-music-video-hud');
  const editNodes = iso.load('lib/nodes/nodes-edit');
  const planLib = iso.load('lib/music-video-plan');
  const hudPlan = iso.load('lib/music-video-hud/plan');
  const templatesLib = iso.load('lib/nodes/templates');
  const { createRegistry } = registryModule;
  const { createEventBus } = iso.load('lib/nodes/events');
  const { createWorkflowsStore } = iso.load('lib/nodes/workflows-store');
  const { createEngine } = iso.load('lib/nodes/engine');
  const { textValue, numberValue } = iso.load('lib/nodes/types');
  const real = registryModule.registry;

  const resolved = (id, lang = 'en') => templatesLib.resolveTemplate(id, { lang });
  const nodeOf = (doc, id) => doc.graph.nodes.find((node) => node.id === id);

  /* ---------- the texts that must not drift ---------- */

  {
    const hud = resolved('music-video-hud');
    const eleven = resolved('music-video-hud-elevenlabs');
    const suno = resolved('suno-song-pack');
    // the figure: the canon text of Claudia, word for word, in both film templates (also in the German and the Spanish document); the credit is the one wanted
    for (const doc of [hud, eleven, resolved('music-video-hud', 'de'), resolved('music-video-hud-elevenlabs', 'es')]) assert.equal(nodeOf(doc, 'n4').params.figure, CLAUDIA);
    const figure = hudPlan.parseFigure(CLAUDIA);
    assert.deepEqual([figure.name, figure.hasShort, figure.hasFull, figure.credit], ['Claudia', true, true, 'Claudia by anabology (claudia.gallery)']);
    assert.ok(/28-year-old/.test(figure.full) && /late twenties/.test(figure.short), 'an adult in both forms');
    // the system prompt of the pack: word for word, with the four blocks the description promises
    assert.equal(nodeOf(suno, 'n4').params.system, SUNO_SYSTEM);
    assert.equal(nodeOf(suno, 'n4').params.model, 'anthropic/claude-opus-5.5');
    for (const block of ['TITLE', 'STYLE', 'EXCLUDE', 'LYRICS']) assert.match(SUNO_SYSTEM, new RegExp(`^${block}\\n<`, 'm'), `${block} is a block of the answer`);
    for (const lang of ['en', 'de', 'es']) {
      const description = resolved('suno-song-pack', lang).description;
      for (const block of ['TITLE', 'STYLE', 'EXCLUDE', 'LYRICS']) assert.match(description, new RegExp(block), `${lang}: the description names ${block}`);
      assert.match(description, /Suno/);
      assert.match(description, lang === 'en' ? /3 US cents/ : lang === 'de' ? /3 US-Cent/ : /3 centavos/, `${lang}: the price of a pack`);
      assert.match(description, lang === 'en' ? /your song/ : lang === 'de' ? /eigener Song/ : /tu propia canción/, `${lang}: it says where the finished song goes`);
    }
    // 3 cents: the system prompt and the request (idea and singer, some 600 characters) are about 650 tokens in, the answer (a title, a style line
    // of at most 900 characters and lyrics of 1800 to 2400) some 1,300 out; Opus 5.5 costs 4 and 20 USD per million tokens
    {
      const [inPrice, outPrice] = iso.load('lib/explainer-plan').PRICES_PER_MILLION['anthropic/claude-opus-5.5'];
      const tokensIn = Math.ceil((SUNO_SYSTEM.length + 600) / 3.6);
      const usd = (tokensIn * inPrice + 1300 * outPrice) / 1e6;
      assert.ok(usd > 0.02 && usd < 0.04, `a pack costs about 3 US cents (${usd})`);
    }

    // the prices of the descriptions are the prices of the planner at the settings of the templates (every unit that is not sung is a clip, at most
    // 50 units): 5.5 USD a minute of song, 8.5 for 90 seconds, 11.5 for two minutes; step 1 (the character sheet, one picture per unit, the planner)
    // stays under 1 USD a minute
    const prices = hudNodes.hudPrices('anthropic/claude-opus-5.5');
    const system = hudPlan.systemPrompt({ theme: 'hud', hudLanguage: 'en', needShort: false });
    const priced = (seconds, seed) => {
      const song = makeSong({ seconds, seed });
      const grid = hudPlan.planGrid(song.analysis, song.timing, {});
      const prompt = hudPlan.userPrompt({ brief: 'x', style: '', figure, grid });
      const cost = hudPlan.estimateCost({ grid, settings: grid.settings, prices, promptChars: prompt.length + system.length });
      return { seconds, cost, stepOne: cost.parts.sheet + cost.parts.plates + cost.parts.llm };
    };
    for (const name of ['music-video-hud', 'music-video-hud-elevenlabs', 'music-video-hud-suno']) {
      const params = nodeOf(resolved(name, 'en'), 'n4').params;
      assert.deepEqual([params.motion_share, params.max_units], [1, 50], `${name}: every unit moves, at most 50 units (the defaults of the planner)`);
    }
    for (const [seconds, seed, low, high] of [[60, 3, 5.3, 6.1], [90, 3, 8, 9], [90, 7, 8, 9], [120, 3, 11, 12], [120, 7, 11, 12]]) {
      const { cost, stepOne } = priced(seconds, seed);
      assert.ok(cost.total >= low && cost.total <= high, `${seconds} s (seed ${seed}) cost ${cost.total}, the descriptions say between ${low} and ${high}`);
      assert.equal(cost.parts.depth, 0, `${seconds} s: no still, no depth map`);
      near(cost.total / (seconds / 60), 5.5, 0.45, `${seconds} s: about 5.5 USD a minute`);
      assert.ok(stepOne / (seconds / 60) < 1, `${seconds} s: step 1 costs ${stepOne / (seconds / 60)} USD a minute, under 1`);
    }
    // the music of the second template: 90 seconds at 0.20 USD a minute, about 9 USD in all with the film
    {
      const music = iso.load('lib/tools').musicEstimateUsd(90 * 1000);
      near(music, 0.3, 1e-9, '90 seconds of music cost 0.30 USD');
      assert.equal(nodeOf(eleven, 'n28').params.length, 90, 'the song is 90 seconds by default');
      for (const seed of [3, 7, 11]) {
        const { cost, stepOne } = priced(90, seed);
        assert.ok(cost.total + music > 8.4 && cost.total + music < 9.4, `film and music (seed ${seed}): ${cost.total + music}, the descriptions say about 9`);
        // step 1 of this template holds the song too: about 1 USD a minute of song
        near((stepOne + music) / 1.5, 1, 0.15, `step 1 with the song (seed ${seed}) is about 1 USD a minute`);
      }
    }
    for (const lang of ['en', 'de', 'es']) {
      const a = resolved('music-video-hud', lang).description;
      const b = resolved('music-video-hud-elevenlabs', lang).description;
      const rx = (en, de, es) => (lang === 'en' ? en : lang === 'de' ? de : es);
      assert.match(a, rx(/5\.5 US dollars per minute of song/, /5\.5 US-Dollar pro Minute Song/, /5,5 dólares por minuto de canción/), `${lang}: A names the price per minute`);
      assert.match(b, rx(/5\.5 US dollars per minute of song/, /5\.5 US-Dollar pro Minute Song/, /5,5 dólares por minuto de canción/), `${lang}: B names the price per minute`);
      assert.match(b, rx(/about 9 US dollars in all/, /zusammen etwa 9 US-Dollar/, /unos 9 dólares en total/), `${lang}: B names the price with the music`);
      assert.match(b, rx(/0\.20 US dollars per minute/, /0\.20 US-Dollar pro Minute/, /0,20 dólares por minuto/), `${lang}: B names the price of the music`);
      assert.match(b, rx(/90 seconds/, /90 Sekunden/, /90 segundos/), `${lang}: B names the default length`);
      for (const text of [a, b]) {
        assert.match(text, rx(/confirm/, /Bestätigung/, /confirmes/), `${lang}: nothing is charged before the confirmation`);
        assert.match(text, rx(/estimate/, /Schätzung/, /estimación/), `${lang}: the estimate comes before the start`);
        assert.match(text, rx(/board/, /Board/, /tablero/), `${lang}: the board is approved first`);
        assert.match(text, rx(/AI-generated/, /KI-generiert/, /generado con IA/), `${lang}: the end card says that it is AI`);
        assert.match(text, rx(/credits the figure/, /nennt die Figur im Credit/, /da el crédito de la figura/), `${lang}: and credits the figure`);
        assert.match(text, rx(/Nano Banana 2\.1/, /Nano Banana 2\.1/, /Nano Banana 2\.1/));
      }
      assert.match(resolved('suno-song-pack', lang).description, rx(/confirm/, /Bestätigung/, /confirmes/), `${lang}: C charges nothing before the confirmation`);
    }

    // the template with the song by Suno: the figure and the pack are the canon texts (the pack of the Suno song pack, singer included); the
    // description names the price of the pack and takes the prices of the film from the template with your own song word for word (its step 1 is
    // step 2 here)
    for (const lang of ['en', 'de', 'es']) {
      const doc = resolved('music-video-hud-suno', lang);
      assert.equal(nodeOf(doc, 'n4').params.figure, CLAUDIA, `${lang}: the figure`);
      assert.equal(nodeOf(doc, 'n28').params.system, SUNO_SYSTEM, `${lang}: the system prompt of the pack`);
      assert.equal(nodeOf(doc, 'n28').params.model, 'anthropic/claude-opus-5.5');
      assert.equal(nodeOf(doc, 'n26').params.text, nodeOf(suno, 'n2').params.text, `${lang}: the singer of the pack`);
      assert.equal(nodeOf(doc, 'n27').params.template, nodeOf(suno, 'n3').params.template, `${lang}: the request of the pack`);
      const own = resolved('music-video-hud', lang).description;
      const text = doc.description;
      const rx = (en, de, es) => (lang === 'en' ? en : lang === 'de' ? de : es);
      const sentence = (pattern) => {
        const found = pattern.exec(own);
        assert.ok(found, `${lang}: the template with your own song has ${pattern}`);
        return found[0];
      };
      const kept = [
        sentence(rx(/About 5\.5 US dollars per minute of song according to the planner \([^)]*\)\./, /Rund 5\.5 US-Dollar pro Minute Song laut Planer \([^)]*\)\./, /Unos 5,5 dólares por minuto de canción según el planificador \([^)]*\)\./)),
        sentence(rx(/Before each start [^.]*confirm\./, /Vor jedem Start [^.]*berechnet\./, /Antes de cada inicio [^.]*confirmes\./)),
        sentence(rx(/The end card [^.]*figure\./, /Die Endkarte [^.]*Credit\./, /La tarjeta final [^.]*figura\./)),
        sentence(rx(/Step 1 makes the board[^;]*; you approve them before step 2 makes the expensive rest\./, /Schritt 1 macht das Board[^;]*; du gibst sie frei, bevor Schritt 2 den teuren Rest macht\./, /El paso 1 crea el tablero[^;]*; tú los apruebas antes de que el paso 2 haga el resto, que es lo caro\./)).replace(/(Step|step|Schritt|paso) ([12])\b/g, (_match, word, number) => `${word} ${Number(number) + 1}`)
      ];
      for (const part of kept) assert.ok(text.includes(part), `${lang}: the description says word for word: ${part}`);
      assert.match(text, rx(/3 US cents/, /3 US-Cent/, /3 centavos/), `${lang}: the price of the pack`);
      for (const block of ['TITLE', 'STYLE', 'EXCLUDE', 'LYRICS']) assert.match(text, new RegExp(block), `${lang}: the description names ${block}`);
      assert.match(text, /Nano Banana 2\.1/);
      assert.match(text, rx(/your song/, /eigener Song/, /tu propia canción/), `${lang}: it names the template it takes the film from`);
    }
  }

  const bins = ffmpegLib.binaries();
  if (!bins.available) {
    console.log('ffmpeg not found: the runs through the engine are skipped');
    return;
  }

  /* ---------- helpers: ffmpeg, files, assets ---------- */

  const ff = (args) => execFileAsync(bins.ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args]);
  async function probeFile(file) {
    const { stdout } = await execFileAsync(bins.ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file], { maxBuffer: 16 * 1024 * 1024 });
    const data = JSON.parse(stdout);
    const video = data.streams.find((stream) => stream.codec_type === 'video');
    const audio = data.streams.find((stream) => stream.codec_type === 'audio');
    const [num, den] = video ? String(video.avg_frame_rate).split('/').map(Number) : [0, 1];
    return {
      duration: Number(data.format.duration),
      frames: video ? Number(video.nb_read_frames) : 0,
      width: video ? video.width : 0,
      height: video ? video.height : 0,
      fps: video ? num / (den || 1) : 0,
      hasAudio: Boolean(audio)
    };
  }
  // The colour of a picture at a moment of a video (the nearest colour of the palette).
  async function colourAt(file, seconds) {
    const { stdout } = await execFileAsync(
      bins.ffmpeg,
      ['-nostdin', '-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'scale=1:1:flags=area,format=rgb24', '-f', 'rawvideo', '-'],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 }
    );
    assert.equal(stdout.length, 3, `a picture at ${seconds} s of ${path.basename(file)}`);
    return nearestColour([stdout[0], stdout[1], stdout[2]]);
  }

  const workDir = await fsp.mkdtemp(path.join(iso.root, 'hud-template-'));
  let fileCounter = 0;
  const clipCache = new Map();
  // A clip of one colour (and, with `audioFile`, with the sound of a file, as long as the shorter of the two).
  async function colourClip(hex, seconds, { audioFile = null } = {}) {
    const key = `${hex}/${seconds}/${audioFile || ''}`;
    if (clipCache.has(key)) return clipCache.get(key);
    fileCounter += 1;
    const file = path.join(workDir, `clip-${fileCounter}.mp4`);
    const args = ['-f', 'lavfi', '-i', `color=c=0x${hex}:s=160x90:r=24:d=${seconds}`];
    if (audioFile) args.push('-i', audioFile);
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast');
    if (audioFile) args.push('-c:a', 'aac', '-shortest');
    else args.push('-an');
    args.push(file);
    await ff(args);
    clipCache.set(key, file);
    return file;
  }

  async function seedAsset(bytes, ext, owner) {
    const saved = await store.saveAsset(owner, { kind: 'upload', buffer: bytes, ext, prompt: 'seed' });
    return assets.valueFromAsset(owner, saved.id);
  }

  /* ---------- the providers, replaced ---------- */

  // The made-up song of 36 seconds (3 sung windows and 8 story units, no still: every unit moves at the settings of the templates): short, because
  // the base cut is 1080p and the render finishes it for real. The good answer for it needs no second request, in either style. The chain of the
  // stills (depth maps, still clips) runs on empty lists and makes nothing
  const SONG = makeSong({ seconds: 36, seed: 1 });
  const GRID = hudPlan.planGrid(SONG.analysis, SONG.timing, {});
  const STATS = GRID.stats;
  assert.deepEqual([STATS.sung, STATS.story, STATS.still], [3, 8, 0], 'the song of the test');
  const FIGURE = hudPlan.parseFigure(CLAUDIA);
  const LYRICS = SONG.timing.lines.map((line) => line.text).join('\n');

  // no entry goes into the cost journal of the copy
  patch(costs, 'recordCost', async (entry) => entry);

  // The language model: the planner gets a good answer for the grid of the song, the Suno pack a made-up pack
  const llmCalls = [];
  const LLM_USD = 0.25;
  const SUNO_PACK = 'TITLE\nMoth Parade\n\nSTYLE\nelectroclash techno, 128 BPM\n\nEXCLUDE\nrap, lo-fi\n\nLYRICS\n[Verse 1]\ntest line one\ntest line two';
  patch(llm, 'completeText', async (options) => {
    llmCalls.push(options);
    if (options.system === SUNO_SYSTEM) return { text: SUNO_PACK, usd: 0.03 };
    return { text: JSON.stringify(goodAnswer(GRID, FIGURE)), usd: LLM_USD };
  });

  // The render node: a job is a plain page of the length the page says (the render itself is tested in test-music-video-hud.js)
  const submits = [];
  patch(rendernode, 'enabled', () => true);
  patch(rendernode, 'listConfiguredNodes', () => [{ id: 'rn1', name: 'Render 1', enabled: true }]);
  patch(rendernode, 'submit', async (html, quality, files, format, fps) => {
    submits.push({ html, quality, files, format, fps, jobId: `job-${submits.length + 1}` });
    return { jobId: `job-${submits.length}`, nodeId: 'rn1' };
  });
  const durationOf = (html) => Number(/data-duration="([\d.]+)"/.exec(html)[1]);
  let renderCounter = 0;
  async function fakeWait(ctx, job) {
    const entry = submits.find((item) => item.jobId === job.jobId);
    assert.ok(entry, `a render was sent for ${job.jobId}`);
    const frames = Math.ceil(durationOf(entry.html) * 24 - 1e-9);
    renderCounter += 1;
    const file = path.join(store.sessionAssetDir(ctx.sessionId), `fake-render-${renderCounter}.mp4`);
    await ff(['-f', 'lavfi', '-i', 'color=c=0x336699:s=320x180:r=24', '-frames:v', String(frames), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', file]);
    await store.completeAssetFile(ctx.sessionId, job.assetId, file, { cost: 0, duration: frames / 24, ext: '.mp4', kind: 'video' });
    return [job.assetId];
  }

  // The nodes: the real ones everywhere but at the providers
  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  musicVideoNodes.registerAll(registry);
  hudNodes.registerAll(registry);
  editNodes.registerAll(registry);
  registry.register(real.get('llm.chat'));
  // What the doubles and the wrappers saw
  const seen = { beats: [], timing: [], sheet: [], image: { n9: [], n10: [], n11: [] }, video: [], lipsync: [], depth: [], edit: [], render: [], musicPlan: [], music: [] };
  const clearSeen = () => {
    for (const key of ['beats', 'timing', 'sheet', 'video', 'lipsync', 'depth', 'edit', 'render', 'musicPlan', 'music']) seen[key].length = 0;
    for (const key of Object.keys(seen.image)) seen.image[key].length = 0;
    llmCalls.length = 0;
    submits.length = 0;
  };
  // `priced` keeps the price table of the real definition (the plan then prices the node)
  const double = (type, execute, { priced = false } = {}) => {
    if (registry.get(type)) registry.unregister(type);
    registry.register({ ...real.get(type), available: () => true, prepare: undefined, validate: undefined, cost: priced ? real.get(type).cost : undefined, execute });
  };
  // a wrapper: the real node runs, the test sees what went in
  const wrap = (type, before, { changeCtx = null } = {}) => {
    const def = registry.get(type);
    registry.unregister(type);
    registry.register({
      ...def,
      available: () => true,
      execute: async (ctx, inputs, params) => {
        before(ctx, inputs, params);
        return def.execute(changeCtx ? changeCtx(ctx) : ctx, inputs, params);
      }
    });
  };
  const scratchFile = async (ctx, name) => path.join(await assets.createScratchDir(ctx.sessionId), name);
  const keepFile = async (ctx, file, options) => {
    const value = await ctx.saveOutputFile({ sourceFile: file, ...options });
    await assets.removeScratchDir(path.dirname(file));
    return value;
  };
  const pictureOf = async (ctx, name, { colour, size, prompt }) => {
    const file = await scratchFile(ctx, name);
    await ff(['-f', 'lavfi', '-i', `color=c=${colour}:s=${size}`, '-frames:v', '1', file]);
    return keepFile(ctx, file, { kind: 'image', ext: '.png', prompt, cost: 0 });
  };
  // the colour of a picture: by the number of the unit that the plate prompt names ("scene number 7")
  const colourOfPrompt = (text) => PALETTE[Number(/scene number (\d+) /.exec(text)[1]) % PALETTE.length];
  const colourOfImage = new Map();

  // the analysis and the times of the song (ElevenLabs and the analysis of the audio are tested elsewhere; the planner gets the made-up song)
  double('audio.beats', async (_ctx, inputs) => {
    seen.beats.push({ plan: inputs.plan ? inputs.plan.value : null });
    return { variants: [{ analysis: textValue(JSON.stringify(SONG.analysis)), bpm: numberValue(SONG.analysis.bpm) }] };
  });
  double('audio.lyrics_timing', async (_ctx, inputs, params) => {
    seen.timing.push({ lyrics: inputs.lyrics ? inputs.lyrics.value : null, method: params.method });
    return { variants: [{ timing: textValue(JSON.stringify(SONG.timing)), lyrics: textValue(SONG.timing.lines.map((line) => line.text).join('\n')) }] };
  });
  double('image.generate', async (ctx, inputs, params) => {
    seen.sheet.push({ prompt: inputs.prompt.value, model: params.model, aspect: params.aspect_ratio, count: params.count });
    return { variants: [{ image: await pictureOf(ctx, 'sheet.png', { colour: 'gray', size: '48x64', prompt: inputs.prompt.value }) }] };
  });
  double('image.edit', async (ctx, inputs, params) => {
    const prompt = inputs.prompt.value;
    const hex = colourOfPrompt(prompt);
    const value = await pictureOf(ctx, 'plate.png', { colour: `0x${hex}`, size: '64x36', prompt });
    colourOfImage.set(value.assetId, hex);
    const references = inputs.images.type === 'list' ? inputs.images.items : [inputs.images];
    seen.image[ctx.nodeId][ctx.itemIndex ?? 0] = { prompt, hex, references: references.map((item) => item.assetId), model: params.model, aspect: params.aspect_ratio, count: params.count };
    return { variants: [{ image: value }] };
  });
  double(
    'fal.h3_video',
    async (ctx, inputs, params) => {
      const hex = colourOfImage.get(inputs.first_frame.assetId);
      const clip = await colourClip(hex, params.duration);
      const file = await scratchFile(ctx, 'clip.mp4');
      await fsp.copyFile(clip, file);
      const value = await keepFile(ctx, file, { kind: 'video', ext: '.mp4', prompt: inputs.prompt.value, cost: 0, duration: params.duration });
      seen.video[ctx.itemIndex ?? 0] = { motion: inputs.prompt.value, hex, duration: params.duration, model: params.model, resolution: params.resolution };
      return { variants: [{ video: value }] };
    },
    { priced: true }
  );
  double(
    'fal.depth_map',
    async (ctx, inputs, params) => {
      if (params.enabled === false) return { variants: [{}] };
      const file = await scratchFile(ctx, 'depth.png');
      await ff(['-f', 'lavfi', '-i', 'color=c=white:s=32x36,format=gray', '-f', 'lavfi', '-i', 'color=c=black:s=32x36,format=gray', '-filter_complex', 'hstack', '-frames:v', '1', file]);
      seen.depth[ctx.itemIndex ?? 0] = { image: inputs.image.assetId };
      return { variants: [{ depth: await keepFile(ctx, file, { kind: 'image', ext: '.png', prompt: 'depth map', cost: 0 }) }] };
    },
    { priced: true }
  );
  double('fal.h3_lipsync', async (ctx, inputs) => {
    const hex = colourOfImage.get(inputs.image.assetId);
    const slice = assets.assetFilePath(inputs.audio);
    const length = (await probeFile(slice)).duration;
    const clip = await colourClip(hex, Math.round(length * 100) / 100, { audioFile: slice });
    const file = await scratchFile(ctx, 'lipsync.mp4');
    await fsp.copyFile(clip, file);
    const value = await keepFile(ctx, file, { kind: 'video', ext: '.mp4', prompt: 'lip sync', cost: 0, duration: length });
    seen.lipsync[ctx.itemIndex ?? 0] = { hex, sliceSeconds: length };
    return { variants: [{ video: value }] };
  });
  // the song of the second template: ElevenLabs writes a plan, then the music (a tone as long as the made-up song)
  const SONG_PLAN = '+ electroclash techno, deadpan female vocals\n- rap, male vocals\n[Verse 1 | 20 s]\n' + LYRICS.split('\n').slice(0, 4).join('\n') + '\n[Chorus | 20 s]\n' + LYRICS.split('\n').slice(4, 8).join('\n');
  double('audio.music_plan', async (_ctx, inputs, params) => {
    seen.musicPlan.push({ prompt: inputs.prompt.value, length: params.length });
    return { variants: [{ plan: textValue(SONG_PLAN) }] };
  });
  double('audio.music', async (ctx, inputs, params) => {
    seen.music.push({ plan: inputs.plan ? inputs.plan.value : null, params: { ...params } });
    const file = await scratchFile(ctx, 'music.wav');
    await fsp.writeFile(file, toneWav(SONG.seconds + 2, 330));
    return { variants: [{ audio: await keepFile(ctx, file, { kind: 'audio', ext: '.wav', prompt: 'music', cost: 0, duration: SONG.seconds + 2 }) }] };
  });
  // the cut and the render run for real; the wrappers only look
  const lengthOf = (value) => (!value ? 0 : value.type === 'list' ? value.items.length : 1);
  wrap('music_video.edit', (_ctx, inputs, params) => {
    seen.edit.push({ params: { ...params }, connected: Object.keys(inputs).sort(), story: lengthOf(inputs.story), performance: lengthOf(inputs.performance), stills: lengthOf(inputs.still_clips) });
  });
  wrap(
    'music_video.hud_render',
    (_ctx, inputs, params) => {
      seen.render.push({ params: { ...params }, graphics: inputs.graphics.value });
    },
    { changeCtx: (ctx) => ({ ...ctx, waitForJob: (job) => fakeWait(ctx, job) }) }
  );

  const bus = createEventBus();
  const flowStore = createWorkflowsStore({ dir: path.join(iso.root, 'data', 'workflows-hud-template'), registry, events: bus });
  const engineConfig = { imageModel: 'openai/gpt-image-2', videoModel: 'bytedance/seedance-2.5', defaultBrain: 'vendor/default-brain', brainModels: ['vendor/default-brain'] };
  const engine = createEngine({ store: flowStore, registry, events: bus, getConfig: () => engineConfig, limits: { jobPollMs: 20 } });

  const refOf = (value, owner) => ({ assetId: value.assetId, sessionId: owner });
  async function startWorkflow(id, setParams) {
    const created = await flowStore.createWorkflow({ document: resolved(id, 'en'), user: STAFF, owner: null });
    const workflow = created.workflow;
    const graph = JSON.parse(JSON.stringify(workflow.graph));
    const set = (nodeId, params) => Object.assign(graph.nodes.find((node) => node.id === nodeId).params, params);
    await setParams({ set, workflow });
    await flowStore.saveGraph(workflow.id, { baseRev: workflow.rev, graph });
    return workflow;
  }
  const resultOf = async (workflow, nodeId) => (await flowStore.readResults(workflow.id)).nodes[nodeId]?.history[0];
  const outputOf = async (workflow, nodeId, port) => (await resultOf(workflow, nodeId)).variants[0][port];
  const finish = async (workflow, request) => {
    const runId = await engine.start(workflow.id, { user: STAFF, ...request });
    const record = await engine.whenFinished(workflow.id, runId);
    assert.equal(record.status, 'completed', JSON.stringify(record.nodes).slice(0, 800));
    return record;
  };
  // the marked outputs of the app: step 1 of the approval flow makes exactly these and what they need
  const approveTargets = (workflow) => workflow.app.outputs.filter((entry) => entry.approve === true).map((entry) => entry.node);
  const step1 = (workflow, overrides = {}) => finish(workflow, { mode: 'selection', nodeIds: approveTargets(workflow), overrides });
  const step2 = (workflow, overrides = {}) => finish(workflow, { mode: 'all', overrides });
  // what an output node holds: the list of what was connected (a list of pictures stays a list inside), flattened to the values
  const leaves = (value) => (value.type === 'list' ? value.items.flatMap(leaves) : [value]);
  const shown = async (workflow, nodeId) => leaves((await resultOf(workflow, nodeId)).variants[0].result);

  /* ---------- "Music video in the HUD style (your song)" ---------- */

  {
    const workflow = await startWorkflow('music-video-hud', async ({ set, workflow: wf }) => {
      const upload = await seedAsset(toneWav(SONG.seconds + 2, 330), '.wav', wf.sessionId);
      set('n1', { asset: refOf(upload, wf.sessionId) });
      set('n3', { lyrics: LYRICS });
      set('n4', { brief: 'A woman and a light that stays on.' });
    });
    assert.deepEqual(approveTargets(workflow), ['n20', 'n21', 'n22', 'n23', 'n24'], 'the board, the character sheet and the three picture lists are shown first');
    const owner = workflow.sessionId;
    const fileOf = (value) => path.join(store.sessionAssetDir(owner), value.file);

    // 0. before anything ran: valid, the prices are unknown (the lists come from the plan), the planner has no price yet
    {
      const plan0 = await engine.plan(workflow.id, { mode: 'all', user: STAFF });
      assert.equal(plan0.valid, true, JSON.stringify(plan0.issues));
      assert.equal(plan0.nodes.n4.estimate, null, 'the cost of the planner depends on the song');
      assert.equal(plan0.nodes.n9.executions, null, 'how many pictures there are comes from the plan');
      assert.ok(plan0.totals.unknownNodes >= 5);
    }

    // 1. step 1: only the marked outputs and what they need. The planner, the character sheet and one picture per unit; nothing expensive
    clearSeen();
    await step1(workflow);
    {
      assert.equal(seen.timing.length, 1);
      assert.equal(seen.timing[0].lyrics, LYRICS, 'the lyrics of the form reach the times');
      assert.equal(seen.timing[0].method, 'auto');
      assert.equal(llmCalls.length, 1, 'one request to the planner');
      assert.equal(llmCalls[0].system, hudPlan.systemPrompt({ theme: 'hud', hudLanguage: 'en', needShort: false }), 'HUD Blue is the style of the template');
      assert.match(llmCalls[0].prompt, /A woman and a light that stays on\./, 'the idea reaches the planner');
      assert.match(llmCalls[0].prompt, /glossy black blunt/, 'and the figure Claudia, the default');
      // nothing expensive ran: no lip sync, no clip, no depth map, no cut, no render
      assert.deepEqual([seen.lipsync.length, seen.video.length, seen.depth.length, seen.edit.length, seen.render.length, submits.length], [0, 0, 0, 0, 0, 0], 'step 1 stops before the expensive part');
      // the board with the estimate of the whole film
      const [boardValue] = await shown(workflow, 'n20');
      assert.equal(boardValue.type, 'text');
      const board = boardValue.value;
      assert.match(board, /^TREATMENT\n/);
      assert.match(board, /estimate \d+\.\d\d USD$/m, 'the estimate is on the board');
      // the character sheet: the sheet prompt of the planner, a portrait, Nano Banana 2.1
      assert.equal(seen.sheet.length, 1);
      assert.deepEqual([seen.sheet[0].prompt, seen.sheet[0].model, seen.sheet[0].aspect, seen.sheet[0].count], [hudPlan.sheetPrompt(FIGURE), NANO_BANANA, '3:4', 1]);
      // the pictures: one per unit, Nano Banana 2.1, 16:9, the sheet as the reference, the prefix says what the sheet is
      const sheetValue = (await resultOf(workflow, 'n5')).variants[0].image;
      for (const [nodeId, count] of [['n9', STATS.sung], ['n10', STATS.story], ['n11', STATS.still]]) {
        const items = seen.image[nodeId];
        assert.equal(items.length, count, `${nodeId}: one picture per unit`);
        for (const item of items) {
          assert.deepEqual([item.model, item.aspect, item.count], [NANO_BANANA, '16:9', 1], `${nodeId}: Nano Banana 2.1, 16:9, one picture`);
          assert.deepEqual(item.references, [sheetValue.assetId], `${nodeId}: the character sheet is the reference`);
          assert.ok(item.prompt.startsWith('The attached image is the character sheet of the main person.'), `${nodeId}: the prefix`);
          assert.ok(item.prompt.includes(FIGURE.full) || item.prompt.includes(FIGURE.short), `${nodeId}: the plate names the figure itself`);
        }
      }
      // the lists of the outputs
      for (const [nodeId, count] of [['n22', STATS.sung], ['n23', STATS.story], ['n24', STATS.still]]) {
        const values = await shown(workflow, nodeId);
        assert.equal(values.length, count, `${nodeId}: the list of the pictures`);
        assert.ok(values.every((item) => item.type === 'image'));
      }
      assert.deepEqual((await shown(workflow, 'n21')).map((item) => item.type), ['image'], 'the character sheet');
      // the approval flow knows where it is: the marked outputs are done, the rest is not
      const planNow = await engine.plan(workflow.id, { mode: 'all', user: STAFF });
      for (const nodeId of approveTargets(workflow)) assert.equal(planNow.nodes[nodeId].status, 'cached', `${nodeId} is up to date after step 1`);
      for (const nodeId of ['n12', 'n13', 'n14', 'n15', 'n16', 'n17', 'n18', 'n19']) assert.notEqual(planNow.nodes[nodeId].status, 'cached', `${nodeId} is still to do`);
      // and the estimate for the rest is known now (the lists have their lengths)
      assert.equal(planNow.nodes.n12.executions, STATS.sung);
      assert.equal(planNow.nodes.n13.executions, STATS.story);
      assert.equal(planNow.nodes.n14.executions, STATS.still);
    }

    // 2. the style of the form: HUD Blue is the default, "Kuble" reaches the planner and the plan (still step 1: nothing expensive)
    {
      const hudGraphics = JSON.parse((await outputOf(workflow, 'n4', 'graphics')).value);
      assert.ok(hudGraphics.theme === undefined || hudGraphics.theme === 'hud', 'HUD Blue by default');
      const sheets = seen.sheet.length;
      const pictures = seen.image.n9.length + seen.image.n10.length + seen.image.n11.length;
      llmCalls.length = 0;
      await step1(workflow, { n4: { theme: 'kuble' } });
      assert.equal(llmCalls.length, 1, 'the planner asks again for the other style');
      assert.equal(llmCalls[0].system, hudPlan.systemPrompt({ theme: 'kuble', hudLanguage: 'en', needShort: false }), 'the planner is told the style');
      const kuble = JSON.parse((await outputOf(workflow, 'n4', 'graphics')).value);
      assert.equal(kuble.theme, 'kuble', 'the style lands in the plan');
      assert.equal(seen.sheet.length, sheets, 'the character sheet is not made again');
      assert.equal(seen.image.n9.length + seen.image.n10.length + seen.image.n11.length, pictures, 'nor are the pictures: the same prompts');
      assert.deepEqual([seen.lipsync.length, seen.video.length, seen.depth.length, submits.length], [0, 0, 0, 0]);
    }

    // 3. step 2 with the values of the form (Kuble): the rest, with the pictures from the cache
    const picturesBefore = seen.image.n9.length + seen.image.n10.length + seen.image.n11.length;
    const sheetsBefore = seen.sheet.length;
    const callsBefore = llmCalls.length;
    await step2(workflow, { n4: { theme: 'kuble' } });
    {
      assert.equal(seen.sheet.length, sheetsBefore, 'the character sheet is not made again');
      assert.equal(seen.image.n9.length + seen.image.n10.length + seen.image.n11.length, picturesBefore, 'nor are the pictures');
      assert.equal(llmCalls.length, callsBefore, 'nor the plan');
      // the expensive part: one clip per unit, by kind
      assert.equal(seen.lipsync.length, STATS.sung);
      assert.equal(seen.video.length, STATS.story);
      assert.equal(seen.depth.length, STATS.still);
      for (const video of seen.video) assert.deepEqual([video.model, video.resolution, video.duration], ['turbo', '768P', 5], 'the story clips: H3 Max turbo, 768P, 5 s');
      // the lists fit the cut: sung, story and still clips as many as the plan says
      assert.equal(seen.edit.length, 1);
      assert.deepEqual([seen.edit[0].performance, seen.edit[0].story, seen.edit[0].stills], [STATS.sung, STATS.story, STATS.still]);
      assert.deepEqual(seen.edit[0].connected, ['performance', 'shots', 'song', 'still_clips', 'story'], 'no captions go into the base cut');
      assert.deepEqual(
        [seen.edit[0].params.captions, seen.edit[0].params.transition, seen.edit[0].params.resolution, seen.edit[0].params.fps, seen.edit[0].params.fade_out],
        ['off', 'cut', '1080p', '24', 0],
        'hard cuts, 1080p, 24 frames per second, no captions, no fade'
      );
      // the base cut: 1080p at 24 frames per second, as long as the plan, every unit shows its own picture
      const shots = planLib.parseShots((await outputOf(workflow, 'n4', 'shots')).value);
      assert.equal(shots.shots.length, GRID.units.length);
      assert.deepEqual([shots.performance, shots.story, shots.still], [STATS.sung, STATS.story, STATS.still]);
      const baseCut = fileOf((await resultOf(workflow, 'n16')).variants[0].video);
      const info = await probeFile(baseCut);
      assert.deepEqual([info.width, info.height], [1920, 1080]);
      near(info.fps, 24, 0.01, 'frames per second of the base cut');
      near(info.duration, GRID.duration, 0.15, 'as long as the plan');
      assert.equal(info.hasAudio, true);
      for (const shot of shots.shots) {
        const expected = PALETTE[shot.index % PALETTE.length];
        assert.equal(await colourAt(baseCut, (shot.start + shot.end) / 2), expected, `unit ${shot.index} (${shot.kind}) shows its own picture`);
      }
      // the render: the style of the plan (auto) takes Kuble, no karaoke, the beat effects strong (WP45), standard quality; the pages carry the
      // style, the switch and the effects
      assert.equal(seen.render.length, 1);
      assert.deepEqual(
        [seen.render[0].params.theme, seen.render[0].params.karaoke, seen.render[0].params.effects, seen.render[0].params.quality, seen.render[0].params.endcard],
        ['auto', false, 'strong', 'standard', true]
      );
      assert.equal(seen.render[0].graphics, (await outputOf(workflow, 'n4', 'graphics')).value, 'the render draws the plan as it is');
      assert.equal(JSON.parse(seen.render[0].graphics).theme, 'kuble');
      assert.ok(submits.length >= 1);
      for (const submit of submits) {
        assert.match(submit.html, /data-theme="kuble"/, 'auto takes Kuble from the plan');
        assert.match(submit.html, /"options":\{"karaoke":false,"endcard":true\}/, 'the karaoke line is off');
        assert.match(submit.html, /<div id="fx"><div id="cam">/, 'the beat effects are on');
        assert.equal(submit.fps, 24);
      }
      // the film and the contact sheet
      const [film, ...otherFilms] = await shown(workflow, 'n18');
      assert.deepEqual([film.type, otherFilms.length], ['video', 0]);
      const filmInfo = await probeFile(fileOf(film));
      assert.equal(filmInfo.hasAudio, true);
      assert.ok(filmInfo.duration > GRID.duration, 'the end card is behind the song');
      assert.deepEqual((await shown(workflow, 'n19')).map((item) => item.type), ['image'], 'the contact sheet');
    }
  }

  /* ---------- "Music video in the HUD style (song by ElevenLabs)": graph and ports ---------- */

  {
    const IDEA = 'A woman and a light that stays on, for the test.';
    const workflow = await startWorkflow('music-video-hud-elevenlabs', async ({ set }) => {
      set('n25', { prompt: IDEA });
    });
    assert.deepEqual(approveTargets(workflow), ['n29', 'n20', 'n21', 'n22', 'n23', 'n24'], 'the song is shown with the board, the character sheet and the pictures');
    clearSeen();
    await step1(workflow);
    // the request for the song: the idea and the voice, 90 seconds
    assert.equal(seen.musicPlan.length, 1);
    assert.ok(seen.musicPlan[0].prompt.startsWith(IDEA));
    assert.match(seen.musicPlan[0].prompt, /Voice and sound: Electroclash techno/);
    assert.equal(seen.musicPlan[0].length, 90);
    // the song text feeds the music, the analysis (names the sections) and the lyric times (better times)
    assert.equal(seen.music.length, 1);
    assert.equal(seen.music[0].plan, SONG_PLAN);
    assert.equal(seen.beats[0].plan, SONG_PLAN);
    assert.equal(seen.timing[0].lyrics, SONG_PLAN);
    // the idea feeds the planner too
    assert.equal(llmCalls.length, 1);
    assert.match(llmCalls[0].prompt, new RegExp(IDEA.replace(/[.]/g, '\\.')));
    // the song is a result of step 1, the film is not started
    assert.deepEqual((await shown(workflow, 'n29')).map((item) => item.type), ['audio'], 'the song');
    assert.deepEqual([seen.lipsync.length, seen.video.length, seen.depth.length, seen.edit.length, seen.render.length], [0, 0, 0, 0, 0]);
    assert.equal(seen.sheet.length, 1);
    assert.equal(seen.image.n9.length + seen.image.n10.length + seen.image.n11.length, STATS.sung + STATS.story + STATS.still);
    // the chain of the film is the one of the first template: the same nodes with the same parameters
    const first = resolved('music-video-hud');
    const second = resolved('music-video-hud-elevenlabs');
    for (let number = 2; number <= 24; number += 1) {
      const a = nodeOf(first, `n${number}`);
      const b = nodeOf(second, `n${number}`);
      assert.deepEqual({ type: b.type, params: b.params, title: b.title }, { type: a.type, params: a.params, title: a.title }, `n${number} is the same in both`);
    }
  }

  /* ---------- the Suno song pack ---------- */

  {
    const workflow = await startWorkflow('suno-song-pack', async ({ set }) => {
      set('n1', { prompt: 'A song about a light that stays on' });
    });
    assert.deepEqual(approveTargets(workflow), [], 'nothing to approve: one answer');
    clearSeen();
    await finish(workflow, { mode: 'all' });
    assert.equal(llmCalls.length, 1);
    assert.equal(llmCalls[0].system, SUNO_SYSTEM, 'the system prompt reaches the model word for word');
    assert.equal(llmCalls[0].model, 'anthropic/claude-opus-5.5');
    assert.match(llmCalls[0].prompt, /^IDEA\nA song about a light that stays on\n\nSINGER \(voice and persona\)\nClaudia, an adult AI pop singer/);
    const [pack, ...more] = await shown(workflow, 'n5');
    assert.deepEqual([pack.type, more.length], ['text', 0]);
    assert.equal(pack.value, SUNO_PACK, 'the answer is the output');
    for (const block of ['TITLE', 'STYLE', 'EXCLUDE', 'LYRICS']) assert.match(pack.value, new RegExp(`^${block}$`, 'm'));
  }

  /* ---------- "Music video in the HUD style (song by Suno)": the three steps of the app view ---------- */

  {
    const IDEA = 'A song about a light that stays on, for the Suno test.';
    const stageLogic = loadStageLogic();
    const workflow = await startWorkflow('music-video-hud-suno', async ({ set }) => {
      set('n25', { prompt: IDEA });
    });
    const owner = workflow.sessionId;
    const stages = stageLogic.approvalStages(workflow.app.outputs, (nodeId) => workflow.graph.nodes.some((node) => node.id === nodeId));
    assert.deepEqual(stages, [['n29'], ['n20', 'n21', 'n22', 'n23', 'n24']], 'the pack is step 1, the board, the sheet and the pictures step 2');
    // what the app view does before a click: the plan of every stage and of everything for the values of the form, then the decision
    const decide = async (overrides) => {
      const results = await flowStore.readResults(workflow.id);
      const hasResult = (nodeId) => Boolean(results.nodes[nodeId] && results.nodes[nodeId].selected);
      const previews = [];
      for (const targets of stages) previews.push(await engine.plan(workflow.id, { ...stageLogic.previewRequest({ targets, overrides }), user: STAFF }));
      const all = await engine.plan(workflow.id, { mode: 'all', force: false, overrides, user: STAFF });
      return { previews, all, flow: stageLogic.stageFlow({ stages, overrides, previews, all, hasResult }) };
    };
    const statuses = (record) => Object.fromEntries(Object.entries(record.nodes).map(([nodeId, entry]) => [nodeId, entry.status]));
    const errorsOf = (plan) => plan.issues.filter((issue) => issue.level === 'error').map((issue) => [issue.nodeId, issue.code]);
    // the form: the song field is empty until the person made the song at Suno
    const noSong = { n1: { asset: null } };

    // 1. step 1 of 3: only the pack; it needs no song (the board does)
    clearSeen();
    let state = await decide(noSong);
    assert.deepEqual([state.flow.index, state.flow.total, state.flow.done], [0, 3, false]);
    assert.deepEqual(state.flow.request, { mode: 'node', nodeIds: ['n29'], force: false, overrides: noSong });
    assert.equal(state.previews[0].valid, true, 'step 1 runs without the song');
    assert.deepEqual([...state.previews[0].order].sort(), ['n25', 'n26', 'n27', 'n28', 'n29'], 'the idea, the singer, the request, the language model and the pack');
    assert.deepEqual(errorsOf(state.previews[1]), [['n1', 'no_asset']], 'step 2 needs the song');
    const first = await finish(workflow, state.flow.request);
    assert.deepEqual(statuses(first), { n25: 'done', n26: 'done', n27: 'done', n28: 'done', n29: 'done' });
    assert.equal(llmCalls.length, 1, 'one answer of the language model');
    assert.equal(llmCalls[0].system, SUNO_SYSTEM, 'the system prompt of the pack, word for word');
    assert.equal(llmCalls[0].model, 'anthropic/claude-opus-5.5');
    assert.match(llmCalls[0].prompt, new RegExp(`^IDEA\\n${IDEA.replace(/[.]/g, '\\.')}\\n\\nSINGER \\(voice and persona\\)\\nClaudia, an adult AI pop singer`), 'the idea and the singer');
    const [packValue, ...morePacks] = await shown(workflow, 'n29');
    assert.deepEqual([packValue.type, packValue.value, morePacks.length], ['text', SUNO_PACK, 0], 'the pack is the result of step 1');
    assert.deepEqual([seen.timing.length, seen.beats.length, seen.sheet.length, seen.lipsync.length, seen.video.length, seen.edit.length, submits.length], [0, 0, 0, 0, 0, 0, 0], 'nothing of the film ran');

    // 2. step 2 is due; without the song its request is invalid: the app view names the field, the engine refuses it, nothing runs
    state = await decide(noSong);
    assert.deepEqual([state.flow.index, state.flow.request], [1, { mode: 'selection', nodeIds: ['n20', 'n21', 'n22', 'n23', 'n24'], force: false, overrides: noSong }]);
    assert.equal(state.previews[1].valid, false);
    assert.deepEqual(errorsOf(state.previews[1]), [['n1', 'no_asset']]);
    assert.ok(state.previews[1].order.includes('n1'), 'the plan of step 2 holds the node of the song field: the app view checks that field');
    await assert.rejects(engine.start(workflow.id, { ...state.flow.request, user: STAFF }), (error) => Array.isArray(error.issues) && error.issues.some((issue) => issue.code === 'no_asset'));
    assert.equal(seen.timing.length, 0);

    // 3. the song from Suno is uploaded: the pack stays in the cache, step 2 is valid now
    const upload = await seedAsset(toneWav(SONG.seconds + 2, 330), '.wav', owner);
    const withSong = { n1: { asset: refOf(upload, owner) } };
    state = await decide(withSong);
    assert.deepEqual([state.previews[0].nodes.n28.status, state.previews[0].nodes.n29.status], ['cached', 'cached'], 'the pack stays in the cache after the upload');
    assert.deepEqual([state.flow.index, state.previews[1].valid], [1, true]);
    assert.ok(state.previews[1].order.includes('n25') && !state.previews[1].order.includes('n28'), 'the idea goes into the film, the pack does not');
    clearSeen();
    const second = await finish(workflow, state.flow.request);
    assert.equal(second.nodes.n28, undefined, 'the pack is not part of step 2');
    assert.equal(llmCalls.length, 1, 'one request: the planner, not the pack again');
    assert.notEqual(llmCalls[0].system, SUNO_SYSTEM);
    assert.match(llmCalls[0].prompt, new RegExp(IDEA.replace(/[.]/g, '\\.')), 'the idea reaches the planner');
    assert.equal(seen.timing.length, 1);
    assert.ok([null, ''].includes(seen.timing[0].lyrics), 'the pack does not go to the lyric times (Suno may change words)');
    assert.equal(seen.sheet.length, 1);
    assert.equal(seen.image.n9.length + seen.image.n10.length + seen.image.n11.length, STATS.sung + STATS.story + STATS.still);
    assert.deepEqual([seen.lipsync.length, seen.video.length, seen.depth.length, seen.edit.length, seen.render.length, submits.length], [0, 0, 0, 0, 0, 0], 'step 2 stops before the expensive part');
    assert.match((await shown(workflow, 'n20'))[0].value, /^TREATMENT\n/, 'the board');

    // 4. step 3 ("Approve and finish"): the rest. The plan counts only what is left: the pack and the planner are not paid again
    state = await decide(withSong);
    assert.deepEqual([state.flow.index, state.flow.request], [2, { mode: 'all', force: false, overrides: withSong }]);
    for (const nodeId of ['n28', 'n4', 'n5', 'n9', 'n10', 'n11']) assert.equal(state.all.nodes[nodeId].status, 'cached', `${nodeId} comes from the cache`);
    for (const nodeId of ['n28', 'n4']) {
      assert.deepEqual([state.all.nodes[nodeId].paid, state.all.nodes[nodeId].estimate], [true, null], `${nodeId} is paid, but not counted in the estimate of step 3`);
    }
    assert.equal(state.all.totals.paidNodes, Object.values(state.all.nodes).filter((entry) => entry.paid && entry.status !== 'cached').length);
    clearSeen();
    // The still clips, the cut and the render ran for real with template 1 above, on the same part of the graph (test-nodes-templates.js
    // holds it equal). Here they only take note and hand on a short clip, so the second film costs no ffmpeg time at 1080p; the rest of
    // their definition (ports, checks, price) stays, and so do the plan and the cache.
    const realDefs = ['image.to_video', 'music_video.edit', 'music_video.hud_render'].map((type) => registry.get(type));
    const standIn = (def, note = () => {}) => {
      registry.unregister(def.type);
      registry.register({
        ...def,
        execute: async (ctx, inputs, params) => {
          note(inputs, params);
          const file = await scratchFile(ctx, 'clip.mp4');
          await fsp.copyFile(await colourClip('336699', 1), file);
          const variant = { video: await keepFile(ctx, file, { kind: 'video', ext: '.mp4', prompt: def.type, cost: 0, duration: 1 }) };
          if (def.outputs.some((port) => port.id === 'sheet')) variant.sheet = await pictureOf(ctx, 'sheet.png', { colour: 'gray', size: '64x36', prompt: 'contact sheet' });
          return { variants: [variant] };
        }
      });
    };
    const [stillDef, cutDef, renderDef] = realDefs;
    standIn(stillDef);
    standIn(cutDef, (inputs, params) => seen.edit.push({ params: { ...params }, connected: Object.keys(inputs).sort(), story: lengthOf(inputs.story), performance: lengthOf(inputs.performance), stills: lengthOf(inputs.still_clips) }));
    standIn(renderDef, (inputs, params) => seen.render.push({ params: { ...params }, graphics: inputs.graphics.value }));
    let third;
    try {
      third = await finish(workflow, state.flow.request);
    } finally {
      for (const def of realDefs) {
        registry.unregister(def.type);
        registry.register(def);
      }
    }
    for (const nodeId of ['n25', 'n26', 'n27', 'n28', 'n29', 'n4', 'n5', 'n9', 'n10', 'n11', 'n20']) assert.equal(third.nodes[nodeId].status, 'cached', `${nodeId} is not made again`);
    assert.equal(llmCalls.length, 0, 'no second answer for the pack or the plan');
    assert.deepEqual([seen.sheet.length, seen.image.n9.length + seen.image.n10.length + seen.image.n11.length], [0, 0], 'no picture is made again');
    assert.deepEqual([seen.lipsync.length, seen.video.length, seen.depth.length, seen.edit.length, seen.render.length], [STATS.sung, STATS.story, STATS.still, 1, 1], 'the expensive part');
    assert.deepEqual([seen.edit[0].connected, seen.edit[0].performance, seen.edit[0].story, seen.edit[0].stills], [['performance', 'shots', 'song', 'still_clips', 'story'], STATS.sung, STATS.story, STATS.still], 'the cut gets a clip for every unit');
    assert.equal(seen.render[0].graphics, (await outputOf(workflow, 'n4', 'graphics')).value, 'the render draws the plan of step 2');
    const [film] = await shown(workflow, 'n18');
    assert.equal(film.type, 'video', 'the music video');
    assert.deepEqual((await shown(workflow, 'n19')).map((item) => item.type), ['image'], 'the contact sheet');

    // 5. everything is up to date: "Run again" begins at step 1, forced (a new pack); a new song brings step 2 back, the pack stays
    state = await decide(withSong);
    assert.deepEqual([state.flow.index, state.flow.done, state.flow.request.force, [...state.flow.request.nodeIds].sort()], [0, true, true, ['n25', 'n26', 'n27', 'n28', 'n29']]);
    const take2 = await seedAsset(toneWav(SONG.seconds + 2, 440), '.wav', owner);
    state = await decide({ n1: { asset: refOf(take2, owner) } });
    assert.deepEqual([state.flow.index, state.previews[0].nodes.n29.status], [1, 'cached'], 'another song: step 2 again, not step 1');
  }
}

main().catch((err) => {
  restoreAll();
  console.error(err);
  process.exit(1);
});
