'use strict';

// The advertising spot ("Story spot"): lib/ad-spot-plan.js (the times, the script, the lists, the sound), lib/ad-spot-endcard.js (the end
// card), the four nodes of lib/nodes/nodes-ad-spot.js and the two templates. No network and nothing paid: the language model is a script,
// Suno a double, and the sound and the cut run on a real ffmpeg with clips made on the spot (that part is skipped without ffmpeg).
//   plan       the number of shots, the times (the hook short, the sum exact), the script of a plan with and without a jingle, the lists
//   node       ad.plan with a scripted model: the outputs, the one that stays empty, one repair round, an edited script without a call
//   music      ad.music: a pack goes to Suno, nothing gives an empty output; the price
//   endcard    the document of the end card: the contract of the render node, the words of the claim, the logo, escaped text
//   film       ad.soundtrack and "Cut to the beat" with the shots of the plan: the film is exactly as long as planned and ends on the card
//   templates  both templates: the wiring of the switch, landscape and portrait differ only in the format

const assert = require('assert/strict');

const planLib = require('../lib/ad-spot-plan');
const endcardLib = require('../lib/ad-spot-endcard');
const adNodes = require('../lib/nodes/nodes-ad-spot');
const musicVideoNodes = require('../lib/nodes/nodes-music-video');
const templates = require('../lib/nodes/templates');
const ffmpeg = require('../lib/ffmpeg');
const { createEditHarness } = require('./support/edit-harness');

const sum = (values) => Math.round(values.reduce((total, value) => total + value, 0) * 1000) / 1000;
const errorOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
};

const SETTINGS = { lengthSeconds: 15, format: 'landscape', language: 'de', tone: 'bold', music: 'instrumental', productImages: 0 };
const shot = (role, seconds, n) => ({
  role,
  seconds,
  image_prompt: `Shot ${n}: a woman in her thirties with a yellow raincoat holds a cold can of peach iced tea on a sunny roof terrace, soft afternoon light, 35mm lens, wide framing, warm colours, photoreal advertising photography`,
  motion: 'She lifts the can and smiles while the camera slowly pushes in',
  on_screen: n === 1 ? 'Sommer in der Dose' : ''
});
const answer = (extra = {}) => ({
  concept: 'Ein Schluck, und der Nachmittag wird Sommer.',
  shots: [shot('hook', 2, 1), shot('problem', 3, 2), shot('product', 4, 3), shot('payoff', 3, 4)],
  voiceover: 'Der Nachmittag zieht sich. Bis Aurora kommt: echter Pfirsich, null Zucker. Schmeckt nach Sommer.',
  claim: 'Schmeckt nach Sommer.',
  cta: 'Jetzt probieren',
  url: 'aurora-tea.example',
  music_prompt: 'Bright, light summer pop with claps and a plucked guitar, 110 BPM, instrumental',
  ...extra
});
const JINGLE = { title: 'Aurora', style: 'Sunny indie pop, 112 BPM, female voice, the singing starts at once', exclude: 'rap, heavy drums', lyrics: '[Hook]\nAurora, Aurora, schmeckt nach Sommer\n[End]\nAurora' };

function scriptedModel(steps) {
  const calls = [];
  const ask = async (_ctx, params, options) => {
    calls.push({ params, options });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    return { text: typeof step === 'string' ? step : JSON.stringify(step), usd: 0.05 };
  };
  return { ask, calls };
}

/* ---------- plan ---------- */

function testPlan() {
  assert.equal(planLib.shotCount(15), 4);
  assert.equal(planLib.shotCount(30), 9);
  assert.equal(planLib.endcardSeconds(6), 2);
  assert.equal(planLib.endcardSeconds(15), 3);
  assert.equal(planLib.endcardSeconds(30), 4);
  // the times: the sum is the body of the film, the hook stays short, a second pass changes nothing
  for (const [wishes, total] of [[[2, 3, 4, 3], 12], [[5, 5, 5, 5], 12], [[1, 1, 1, 1], 12], [[9, 2, 2, 2, 2, 2, 2, 2, 2], 26], [['x', null, 3], 9]]) {
    const seconds = planLib.shotSeconds(wishes, total);
    assert.equal(sum(seconds), total, `${JSON.stringify(wishes)} sums to ${total}`);
    assert.ok(seconds[0] <= 2.5 || seconds.length < 3, `the hook is short: ${seconds}`);
    assert.deepEqual(planLib.shotSeconds(seconds, total), seconds, 'the times are stable');
  }

  const built = planLib.buildScript(answer(), SETTINGS);
  assert.equal(built.hasErrors, false, JSON.stringify(built.issues));
  const script = built.script;
  assert.equal(script.kind, 'ad-spot');
  assert.equal(script.shots.length, 4);
  assert.equal(script.shots[0].role, 'hook');
  assert.equal(script.shots[0].start, 0);
  assert.equal(script.shots[3].end, 12, 'the shots end where the end card starts');
  assert.deepEqual(script.endcard, { seconds: 3, start: 12, claim: 'Schmeckt nach Sommer.', cta: 'Jetzt probieren', url: 'aurora-tea.example' });
  assert.equal(script.jingle, null);

  const lists = planLib.outputsOf(script, { productImages: 0 });
  assert.equal(lists.imagePrompts.length, 4);
  assert.equal(lists.motionPrompts.length, 4);
  assert.ok(lists.musicPrompt && !lists.jinglePack, 'instrumental: a description of the music and no pack');
  assert.ok(lists.voiceover.includes('Aurora'));
  assert.ok(lists.storyboard.includes('Schmeckt nach Sommer.'));
  // the shots for "Cut to the beat": the story clips in order, then the card as the only still, no gap
  const cut = lists.shots;
  assert.deepEqual(cut.shots.map((item) => `${item.kind}${item.clip}`), ['story0', 'story1', 'story2', 'story3', 'still0']);
  cut.shots.forEach((item, index) => assert.equal(item.start, index ? cut.shots[index - 1].end : 0));
  assert.equal(cut.shots[4].end, 15);
  assert.equal(cut.duration, 15);
  assert.deepEqual([cut.story, cut.performance, cut.still], [4, 0, 1]);

  // a jingle: the pack instead of the description, and the voice only says the closing line on the card
  const sung = planLib.buildScript(answer({ jingle: JINGLE, voiceover: 'Aurora. Schmeckt nach Sommer.', music_prompt: '' }), { ...SETTINGS, music: 'jingle' });
  assert.equal(sung.hasErrors, false, JSON.stringify(sung.issues));
  const sungLists = planLib.outputsOf(sung.script, { productImages: 0 });
  assert.ok(!sungLists.musicPrompt);
  for (const block of ['TITLE', 'STYLE', 'EXCLUDE', 'LYRICS']) assert.ok(sungLists.jinglePack.includes(block), `the pack has ${block}`);
  assert.ok(sung.script.voiceover.at >= 12, 'the closing line is spoken on the end card');
  assert.equal(sungLists.shots.music, 'jingle');

  // too many words are an error for the repair round and are cut, never sped up beyond what a voice can do
  const long = planLib.buildScript(answer({ voiceover: Array.from({ length: 80 }, () => 'Wort').join(' ') }), SETTINGS);
  assert.ok(long.issues.some((issue) => issue.code === 'VOICEOVER_TOO_LONG'));
  assert.ok(long.script.voiceover.words <= Math.ceil(long.script.voiceover.budget * planLib.LIMITS.voiceTolerance));
  // no spoken words: the voice says the claim, so the speech node never gets an empty text
  const silent = planLib.buildScript(answer({ voiceover: '' }), SETTINGS);
  assert.equal(silent.script.voiceover.text, 'Schmeckt nach Sommer.');
  // German of Switzerland: no sharp s in what is spoken or shown
  const sharp = planLib.buildScript(answer({ claim: 'Grosser Spaß, weißer Pfirsich' }), SETTINGS);
  assert.equal(sharp.script.endcard.claim.includes('ß'), false);
  assert.equal(planLib.buildScript('nothing', SETTINGS).script, null);
  assert.equal(planLib.buildScript({ shots: [] }, SETTINGS).script, null);

  // an edited script: the text of the output can go back in, and its own length wins over the setting
  const again = planLib.parseScriptText(JSON.stringify(script), { lengthSeconds: 30, format: 'portrait', music: 'instrumental' });
  assert.equal(again.error, undefined);
  assert.equal(again.script.length_seconds, 15);
  assert.equal(again.script.format, 'landscape');
  const edited = JSON.parse(JSON.stringify(script));
  edited.endcard.claim = 'Sommer zum Trinken.';
  assert.equal(planLib.parseScriptText(JSON.stringify(edited), SETTINGS).script.endcard.claim, 'Sommer zum Trinken.');
  assert.ok(planLib.parseScriptText('{"kind":"other"}', SETTINGS).error);
  assert.ok(planLib.parseScriptText('not json', SETTINGS).error);
}

/* ---------- ad.plan ---------- */

async function testPlanNode() {
  const logs = [];
  const ctx = { sessionId: 's1', user: 'tester', uiLang: 'de', config: {}, signal: new AbortController().signal, log: (line) => logs.push(line) };
  const model = scriptedModel([answer()]);
  const node = adNodes.createPlanDefinition({ ask: model.ask });
  const params = { model: 'test/model', brief: '', length_seconds: 15, format: 'landscape', language: 'de', tone: 'bold', music: 'instrumental', script: '' };
  const inputs = { brief: { type: 'text', value: 'Aurora, ein Eistee mit echtem Pfirsich. Schmeckt nach Sommer.' } };

  const result = await node.execute(ctx, inputs, params);
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].options.json, true);
  assert.ok(model.calls[0].options.system.includes('exactly 4 shots'));
  const variant = result.variants[0];
  assert.deepEqual(Object.keys(variant).sort(), ['image_prompts', 'motion_prompts', 'music_prompt', 'script', 'shots', 'storyboard', 'voiceover']);
  assert.equal(variant.image_prompts.items.length, 4);
  assert.equal(variant.motion_prompts.items.length, 4);
  assert.deepEqual(adNodes.planEmptyOutputs(params), ['jingle_pack'], 'the output that stays empty is declared');
  assert.deepEqual(adNodes.planEmptyOutputs({ music: 'jingle' }), ['music_prompt']);
  assert.deepEqual(adNodes.planEmptyOutputs({ music: 'none' }), ['music_prompt', 'jingle_pack']);
  assert.equal(result.cost.usd, 0.05);

  // the jingle: the other output is filled
  const sung = scriptedModel([answer({ jingle: JINGLE, voiceover: 'Aurora. Schmeckt nach Sommer.' })]);
  const sungResult = await adNodes.createPlanDefinition({ ask: sung.ask }).execute(ctx, inputs, { ...params, music: 'jingle' });
  assert.ok(sungResult.variants[0].jingle_pack && !sungResult.variants[0].music_prompt);

  // a plan with problems is sent back once with the list of problems; the second answer is used
  const repair = scriptedModel([answer({ shots: [shot('hook', 2, 1)], claim: '' }), answer()]);
  const repaired = await adNodes.createPlanDefinition({ ask: repair.ask }).execute(ctx, inputs, params);
  assert.equal(repair.calls.length, 2);
  assert.ok(repair.calls[1].options.prompt.includes('exactly 4'), 'the second request names the problem');
  assert.equal(JSON.parse(repaired.variants[0].script.value).shots.length, 4);
  assert.equal(repaired.cost.usd, 0.1);
  // nothing usable in both rounds
  const broken = scriptedModel(['I cannot do that']);
  assert.equal((await errorOf(adNodes.createPlanDefinition({ ask: broken.ask }).execute(ctx, inputs, params))).code, 'AD_PLAN_INVALID');
  assert.equal(broken.calls.length, 2);

  // an edited script: checked and handed on without a call, the changed words arrive
  const edited = JSON.parse(variant.script.value);
  edited.endcard.claim = 'Sommer zum Trinken.';
  const quiet = scriptedModel([answer()]);
  const fromScript = await adNodes.createPlanDefinition({ ask: quiet.ask }).execute(ctx, {}, { ...params, script: JSON.stringify(edited) });
  assert.equal(quiet.calls.length, 0);
  assert.equal(fromScript.cost.usd, 0);
  assert.ok(fromScript.variants[0].storyboard.value.includes('Sommer zum Trinken.'));
  // the switch and the script must agree, or the wrong output would be filled
  const mismatch = await errorOf(node.execute(ctx, {}, { ...params, music: 'jingle', script: JSON.stringify(edited) }));
  assert.equal(mismatch.code, 'AD_SCRIPT_MUSIC');
  assert.deepEqual(mismatch.data, { planned: 'instrumental', chosen: 'jingle' });
  assert.equal((await errorOf(node.execute(ctx, {}, { ...params, script: '{"kind":"x"}' }))).code, 'AD_SCRIPT_INVALID');
  assert.equal((await errorOf(node.execute(ctx, {}, params))).code, 'AD_NO_BRIEF');

  // the checks before a run
  assert.deepEqual(node.validate(params, { brief: { connected: true } }), []);
  assert.equal(node.validate(params, { brief: { connected: false } })[0].code, 'AD_NO_BRIEF');
  assert.equal(node.validate({ ...params, music: 'jingle', script: JSON.stringify(edited) }, {})[0].code, 'AD_SCRIPT_MUSIC');
}

/* ---------- ad.music ---------- */

async function testMusicNode() {
  const made = [];
  const node = adNodes.createMusicDefinition({
    makeSongs: async (_ctx, pack, options) => {
      made.push({ pack, options });
      return [{ audio: { type: 'audio', assetId: 'song1' } }];
    }
  });
  assert.equal(node.provider, 'elevenlabs');
  const ctx = { sessionId: 's1', user: 'tester', signal: new AbortController().signal, log: () => {} };
  const params = { length: 15, model: '', version: 2, allow_download_credit: true };
  const sung = await node.execute(ctx, { pack: { type: 'text', value: 'TITLE\nAurora\nSTYLE\npop\nLYRICS\nla' } }, params);
  assert.deepEqual(sung.variants, [{ audio: { type: 'audio', assetId: 'song1' } }]);
  assert.deepEqual(made[0].options, { takes: 1, version: 2, allow_download_credit: true });
  assert.equal(sung.cost.usd, 0, 'Suno bills its own credits: the app charges nothing');
  // a plan without music: the output stays empty and the sound is made without it
  const none = await node.execute(ctx, {}, params);
  assert.deepEqual(none.variants, [{}]);
  assert.equal(made.length, 1);
  // the checks and the price
  assert.equal(node.validate(params, {})[0].code, 'AD_MUSIC_SOURCE');
  assert.deepEqual(node.validate(params, { pack: { connected: true } }), []);
  assert.deepEqual(node.cost.estimate(params, { inputs: { pack: { value: 'TITLE' } }, connected: new Set(['pack']) }), { usd: 0 });
  assert.equal(node.cost.estimate(params, { inputs: {}, connected: new Set(['prompt', 'pack']) }), null, 'before the plan ran the price is unknown');
  const instrumental = node.cost.estimate(params, { inputs: { prompt: { value: 'summer pop' }, shots: { value: JSON.stringify({ duration: 30 }) } }, connected: new Set(['prompt', 'shots']) });
  const shorter = node.cost.estimate(params, { inputs: { prompt: { value: 'summer pop' } }, connected: new Set(['prompt']) });
  const usd = (value) => (typeof value === 'number' ? value : value.usd);
  assert.ok(usd(instrumental) > usd(shorter) && usd(shorter) > 0, 'the music is priced by the length of the film');
}

/* ---------- the end card ---------- */

function testEndcard() {
  const html = endcardLib.endcardHtml({ format: 'portrait', duration: 3, claim: 'Schmeckt nach <Sommer> & mehr', cta: 'Jetzt probieren', url: 'aurora-tea.example', name: 'Aurora', logo: true });
  assert.match(html, /id="main-composition" data-composition-id="main" data-width="1080" data-height="1920" data-start="0" data-duration="2\.999"/);
  assert.ok(html.includes("window.__timelines['main'] = tl;"));
  assert.ok(html.includes('<img id="logo" src="{{asset:1}}"'));
  assert.ok(html.includes('&lt;Sommer&gt;') && html.includes('&amp;') && !html.includes('<Sommer>'), 'the claim is text, never markup');
  assert.equal((html.match(/class="w"/g) || []).length, 5, 'one span per word of the claim');
  assert.ok(html.includes('Jetzt probieren') && html.includes('aurora-tea.example'));
  // without a logo the name of the brand stands above the claim; without a claim the name is the headline
  const named = endcardLib.endcardHtml({ claim: 'Schmeckt nach Sommer.', name: 'Aurora' });
  assert.ok(named.includes('<div id="name">Aurora</div>') && !named.includes('{{asset:1}}'));
  const bare = endcardLib.endcardHtml({ name: 'Aurora' });
  assert.ok(!bare.includes('id="name"') && bare.includes('>Aurora</span>'));
  assert.ok(!bare.includes('id="cta"') && !bare.includes('id="url"'));
  // a long claim is set in at most three lines that fit the width
  const lines = endcardLib.claimLines('Der frischeste Eistee den dieser lange Sommer je gesehen hat', { available: 900, size: 110 });
  assert.ok(lines.length <= 3 && lines.flat().length === 10);
  assert.deepEqual(endcardLib.sizeOf('square').format, 'square');
  assert.deepEqual(endcardLib.sizeOf('whatever').format, 'landscape');
}

/* ---------- the sound and the cut on a real ffmpeg ---------- */

async function testFilm() {
  if (!ffmpeg.binaries().available) {
    console.log('   skipped: ffmpeg is not installed');
    return;
  }
  const h = await createEditHarness({
    prefix: 'ocd-ad-spot-',
    extraRegister: (registry) => {
      adNodes.registerAll(registry);
      musicVideoNodes.registerAll(registry);
    }
  });
  try {
    const script = planLib.buildScript(answer(), SETTINGS).script;
    const shots = { type: 'text', value: JSON.stringify(planLib.cutShots(script)) };
    // four clips of 5 s as a video model delivers them (one colour each), the card in blue, a voice and music that is too long
    const colours = ['red', 'green', 'yellow', 'white'];
    const clips = [];
    for (const [index, colour] of colours.entries()) {
      await h.ff(['-f', 'lavfi', '-i', `color=c=${colour}:s=320x180:r=24:d=5`, '-pix_fmt', 'yuv420p', h.src(`clip${index}.mp4`)]);
      clips.push(await h.upload(`clip${index}.mp4`, '.mp4'));
    }
    await h.ff(['-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=3', '-pix_fmt', 'yuv420p', h.src('card.mp4')]);
    const card = await h.upload('card.mp4', '.mp4');
    await h.ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=7', h.src('voice.mp3')]);
    await h.ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=40', h.src('music.mp3')]);
    const voice = await h.upload('voice.mp3', '.mp3');
    const music = await h.upload('music.mp3', '.mp3');

    const sound = await h.run('ad.soundtrack', { shots, voice, music });
    const soundInfo = await h.probe(await h.fileOf(sound.audio));
    assert.ok(Math.abs(soundInfo.duration - 15) < 0.06, `the sound is as long as the film: ${soundInfo.duration}`);
    // the same without music (a plan with "none") and without a voice
    for (const inputs of [{ shots, voice }, { shots, music }]) {
      const only = await h.run('ad.soundtrack', inputs);
      assert.ok(Math.abs((await h.probe(await h.fileOf(only.audio))).duration - 15) < 0.06);
    }

    const film = await h.run('music_video.edit', { song: sound.audio, shots, story: { type: 'list', base: 'video', items: clips }, still_clips: { type: 'list', base: 'video', items: [card] } }, { resolution: '720p', fps: '30', fade_out: 0 });
    const file = await h.fileOf(film.video);
    const info = await h.probe(file);
    assert.ok(Math.abs(info.duration - 15) < 0.08, `the film is as long as planned: ${info.duration}`);
    assert.ok(info.hasAudio);
    assert.deepEqual([info.width, info.height], [1280, 720]);
    // the hook is on screen at the start, the end card for the last three seconds
    const pixel = async (time) => {
      const frame = await h.frame(file, time, 4, 4);
      return [frame[0], frame[1], frame[2]];
    };
    const first = await pixel(0.5);
    assert.ok(first[0] > 180 && first[1] < 90 && first[2] < 90, `the first shot is the hook: ${first}`);
    for (const time of [12.4, 14.5]) {
      const last = await pixel(time);
      assert.ok(last[2] > 180 && last[0] < 90 && last[1] < 90, `the end card is on screen at ${time} s: ${last}`);
    }
    const before = await pixel(11.5);
    assert.ok(before[0] > 180 && before[1] > 180 && before[2] > 180, `the last shot runs up to the card: ${before}`);
  } finally {
    await h.cleanup();
  }
}

/* ---------- the templates ---------- */

function testTemplates() {
  const all = templates.loadTemplates({ refresh: true });
  const landscape = all.find((item) => item.id === 'ad-spot');
  const portrait = all.find((item) => item.id === 'ad-spot-portrait');
  assert.ok(landscape && portrait);
  for (const template of [landscape, portrait]) templates.validateTemplate(template);
  const links = (template) => template.graph.edges.map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`);
  const wiring = links(landscape);
  // the switch: both outputs of the planner go to the one music node; the sound gets voice and music; the cut gets the clips and the card
  for (const link of ['n4.music_prompt>n8.prompt', 'n4.jingle_pack>n8.pack', 'n7.audio>n9.voice', 'n8.audio>n9.music', 'n9.audio>n11.song', 'n4.shots>n11.shots', 'n6.video>n11.story', 'n10.video>n11.still_clips', 'n2.items>n5.images', 'n2.items>n4.product', 'n3.logo>n10.logo', 'n3.voice>n7.voice']) {
    assert.ok(wiring.includes(link), `the template connects ${link}`);
  }
  assert.deepEqual(links(portrait), wiring);
  const paramsOf = (template) => Object.fromEntries(template.graph.nodes.map((node) => [node.id, node.params]));
  const differing = Object.entries(paramsOf(landscape)).filter(([id, params]) => JSON.stringify(params) !== JSON.stringify(paramsOf(portrait)[id])).map(([id]) => id);
  assert.deepEqual(differing, ['n4', 'n5', 'n6'], 'only the format of the plan and the aspect ratio of pictures and clips differ');
  assert.equal(paramsOf(portrait).n4.format, 'portrait');
  assert.equal(paramsOf(portrait).n5.aspect_ratio, '9:16');
  assert.equal(paramsOf(portrait).n6.aspect_ratio, '9:16');
  // the form: the brief, the photos, the length and the switch; the storyboard and the pictures are approved before the clips
  for (const template of [landscape, portrait]) {
    assert.deepEqual(template.app.inputs.map((entry) => `${entry.node}.${entry.param}`), ['n1.prompt', 'n2.assets', 'n3.branding', 'n4.length_seconds', 'n4.music', 'n4.tone', 'n4.language', 'n7.voice_id']);
    assert.deepEqual(template.app.outputs.map((entry) => [entry.node, entry.approve]), [['n12', undefined], ['n13', true], ['n14', 2]]);
    for (const lang of ['de', 'es']) {
      const strings = template.i18n[lang];
      for (const [key, value] of Object.entries(strings)) {
        assert.ok(String(value).trim(), `${template.id} ${lang} ${key}`);
        assert.equal(String(value).includes('ß'), false, `${template.id} ${lang} ${key} has no sharp s`);
      }
      for (const key of ['app.hint.n13', 'app.hint.n14']) assert.ok(strings[key].length <= 300, `${template.id} ${lang} ${key} fits the hint`);
      for (const entry of template.app.inputs) assert.ok(strings[`app.input.${entry.node}.${entry.param}`], `${template.id} ${lang}: label of ${entry.node}.${entry.param}`);
    }
  }
  const order = [...templates.ORDER];
  assert.equal(order.indexOf('ad-spot-portrait'), order.indexOf('ad-spot') + 1);
  assert.equal(order.indexOf('ad-spot'), order.indexOf('image-to-ad') + 1);
}

(async () => {
  for (const test of [testPlan, testPlanNode, testMusicNode, testEndcard, testFilm, testTemplates]) {
    await test();
    console.log(`ok ${test.name}`);
  }
  console.log('test-ad-spot.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
