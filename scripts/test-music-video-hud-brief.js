'use strict';

// The brief from the song and the lines of a choir (WP48): lib/music-video-hud/plan.js (writeBrief, runPlanner without an idea, the choir in the grid and in
// the prompts), lib/lyrics-timing.js (the marks), lib/music-video-plan.js (the windows of the older planner), lib/voice-detect.js (Gemini hears who sings), the
// node music_video.hud_plan (the optional idea, its output, the estimate, the check of a connected empty idea), the view of the app and the texts. No network
// and nothing paid: the language model is a script (scripts/support/hud-plan-fixtures.js), Google a fetch double.
//   golden     a run with a given idea and a song without marks is the one of before WP48, byte for byte: the requests to the model, the board, the graphics,
//              the shots and the estimate of three runs, the prompts, the grids of both planners, the timing of a text without marks, the cache keys and the
//              estimate of a node saved before (scripts/support/hud-plan-before-wp48.json, made by scripts/support/hud-plan-prompt-cases.js with the code before)
//   marks      every mark of a choir, sounds in parentheses, the song plan, the alignment and the transcript with lines of a choir, the readers of the format
//   windows    no lip sync window holds a line of a choir and none lies before the first line of the figure, in both planners; units on such lines are clips
//   prompts    the planner and the brief name the lines of a choir; the board lists them, or says why there was no detection
//   brief      an empty field: two calls (the brief, then the plan), the brief is the IDEA of the plan and its output; a given field: one call; a song without
//              lyrics; the language of the brief and of the HUD; the rules of the prompt; a retry after an error, an empty answer and a brief that is too short;
//              HUDPLAN_BRIEF_FAILED with the costs; a fatal error ends it at once
//   estimate   the price of the node with and without the call for the brief, and the part of the brief on the board
//   node       the definition, the check of an idea connected from an empty input node, the field the app view names for it, the key of a saved node
//   voices     the request to Gemini, the strict check of the answer, one retry, the costs, no key, the voice of a line that the model is not sure about
//   texts      the texts of the nodes and of the app in three languages, no sharp s

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const lyricsTiming = require('../lib/lyrics-timing');
const planLib = require('../lib/music-video-plan');
const hudPlan = require('../lib/music-video-hud/plan');
const voiceDetect = require('../lib/voice-detect');
const captionsAss = require('../lib/captions-ass');
const { FIGURE_TEXT, FIGURE_NO_SHORT, makeSong, goodAnswer, scriptedModel } = require('./support/hud-plan-fixtures');
const promptCases = require('./support/hud-plan-prompt-cases');
const BEFORE_WP48 = require('./support/hud-plan-before-wp48.json');

const near = (actual, expected, tolerance, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} !== ${expected} (±${tolerance})`.trim());
const errorOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
};
const round3 = (value) => Math.round(value * 1000) / 1000;

const restorers = [];
function setEnv(name, value) {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restorers.push(() => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  });
}
function restoreAll() {
  while (restorers.length) restorers.pop()();
}

// A brief as the model writes it (made up for the test, in the seven parts of the prompt).
const BRIEF = [
  'Theme: A woman folds paper boats from old receipts and sends them down the city river at night, hoping that one of them reaches the morning.',
  'Arc:',
  '- Intro: rain on a kitchen window, the first boat on the sill, the counter starts at 1.',
  '- Verse 1: she folds boats at the table under one bulb; every line becomes an entry in the log of the boats.',
  '- Chorus 1: the river fills with lantern boats, people on the bridge watch; the choir sings the call while she listens with her eyes closed.',
  '- Verse 2: the boats sink one by one, the log turns red, she folds faster.',
  '- Chorus 2: the whole city sends boats, the counter becomes absurd.',
  '- Outro: one boat drifts into the blue of the dawn.',
  'Machine in the HUD: HARBOUR LOG counts BOATS LAUNCHED (1, 40, 900, 2 MILLION), watched by the night ferry, ticker: tide tables, lost boats, rain radar, bridge traffic.',
  'Look: a yellow raincoat over a grey knit dress, a riverside of wet stone, sodium light turning into the blue of the dawn.',
  'Graphics for the lines: a launch log, a tide chart, a map of the river with markers, a chat with the ferryman, a stopwatch of the night.',
  'End card: STILL AFLOAT, one boat made it to the morning.',
  'Not: no brands, no logos, no real people, no company names, nothing suggestive, no drugs, no blood.'
].join('\n');

const SONG = { seconds: 72, seed: 7 };
// The lines of the made-up song that a choir sings in the tests: the first two (the figure comes in with line 2) and the whole first chorus.
const CHOIR = [0, 1, 4, 5, 6, 7];
const withChoir = (timing, indexes = CHOIR, voices = { source: 'marks', choir: indexes.length }) => ({
  ...timing,
  lines: timing.lines.map((line, at) => (indexes.includes(at) ? { ...line, voice: 'choir' } : line)),
  ...(voices ? { voices } : {})
});
const wordsOf = (line) => ({ start: Math.min(...line.words.map((word) => word.start)), end: Math.max(...line.words.map((word) => word.end)) });

/* ---------- golden: a run with a given idea is the one of before ---------- */

async function testGolden() {
  const now = await promptCases.fingerprints();
  assert.deepEqual(Object.keys(now).sort(), Object.keys(BEFORE_WP48).sort(), 'the cases of before WP48');
  assert.equal(Object.keys(BEFORE_WP48).length, 45);
  for (const [name, print] of Object.entries(BEFORE_WP48)) assert.deepEqual(now[name], print, `${name}: the text of before WP48, byte for byte`);
  const texts = await promptCases.cases();
  // the three runs with a given idea: one request each (the second run and the third ask twice for the answer, as before), never one for a brief
  assert.deepEqual(['a', 'b', 'c'].map((name) => JSON.parse(texts[`planner.${name}.requests`]).length), [1, 2, 2]);
  for (const name of ['a', 'b', 'c']) {
    for (const request of JSON.parse(texts[`planner.${name}.requests`])) assert.ok(request.system.startsWith('You plan a music video') || !request.system.startsWith('You write the brief'), `${name}: no request for a brief`);
    assert.doesNotMatch(texts[`planner.${name}.board`], /^(BRIEF|LYRICS|CHOIR) /m, `${name}: the board of before`);
    assert.equal(JSON.parse(texts[`planner.${name}.cost`]).parts.brief, undefined, `${name}: no part for a brief`);
  }
  // the timing of a text without marks carries no voice
  for (const name of ['timing.alignment', 'timing.transcript', 'timing.pauses']) {
    const timing = JSON.parse(texts[name]);
    assert.equal(timing.voices, undefined, name);
    assert.ok(timing.lines.length && timing.lines.every((line) => line.voice === undefined), name);
  }
  // the grids of a song without marks: no voice either
  for (const name of ['grid.a', 'grid.b', 'grid.c']) {
    const grid = JSON.parse(texts[name]);
    assert.equal(grid.voices, undefined, name);
    assert.ok(grid.lines.every((line) => line.voice === undefined), name);
  }
}

/* ---------- the marks of a choir ---------- */

function testMarks() {
  const lines = (text) => lyricsTiming.markedLines(text).map((line) => (line.voice ? `${line.voice}: ${line.text}` : line.text));
  // a section of its own, up to the next section
  for (const name of ['Chor', 'Choir', 'Coros', 'Backing', 'Backing Vocals', 'Background Vocals', 'choir', 'CHOR 2', 'Backing vocals (Claudia)', 'Background  vocals']) {
    assert.deepEqual(lines(`[Verse 1]\nOne line\n[${name}]\nTwo line\nThree line\n\n[Verse 2]\nFour line`), ['One line', 'choir: Two line', 'choir: Three line', 'Four line'], name);
  }
  // [Chorus], [Refrain], [Hook] and [Coro] (the chorus in Spanish lyric sheets) stay the chorus of the figure, and so does anything that only begins like a mark
  for (const name of ['Chorus', 'Refrain', 'Hook', 'Coro', 'Coro 2', 'Pre-Chorus', 'Chorus 2', 'Post-Chorus', 'Background', 'Choral', 'Coronation']) {
    assert.deepEqual(lines(`[${name}]\nSail on\n[Verse]\nOne line`), ['Sail on', 'One line'], name);
  }
  // a line with "Chor:", "Choir:" or "Coros:" in front: the mark is not sung ("Coro:" is the chorus in Spanish lyric sheets: no mark)
  assert.deepEqual(lines('Paper boats\nChor: Sail on\nchoir:Hold it tight\nCOROS : Ven aquí\nChorus: no mark\nCoro: no mark\nChoir:'), ['Paper boats', 'choir: Sail on', 'choir: Hold it tight', 'choir: Ven aquí', 'Chorus: no mark', 'Coro: no mark']);
  // a whole line in parentheses with words, as Suno writes the backing vocals; a line of sounds is still no sung text
  assert.deepEqual(
    lines('(Claudia, Claudia)\n(ahhh)\n(hm-mm)\n(ooh-ooh)\n(la la la)\n(la-di-da)\n(yeah, yeah)\n(Na na na, hey hey)\n(Whoa-oh)\n(1, 2, 3, 4)\n(oh no)\nHold it tight (yeah)\n( Ven aquí )'),
    ['choir: Claudia, Claudia', 'choir: oh no', 'Hold it tight (yeah)', 'choir: Ven aquí']
  );
  assert.deepEqual(lines('Choir: (ooh)\nChoir: (Sail on)'), ['choir: Sail on'], 'a mark in front of sounds: nothing to sing');
  // a stage direction in parentheses is no sung text either and no mark: dropped as before WP48, so such lyrics still go to Gemini
  const directions = ['(x2)', '(2x)', '(Instrumental)', '(Repeat chorus)', '(Gitarrensolo)', '(guitar solo)', '(solo de guitarra)', '(gesprochen)', '(geflüstert)', '(Spoken word)', '(fade out)', '(Coro)', '(Wiederholung)', '(bis)', '(The end)'];
  assert.deepEqual(lines(['One line', ...directions, 'Two line'].join('\n')), ['One line', 'Two line']);
  assert.equal(lyricsTiming.hasChoirMarks(['One line', ...directions].join('\n')), false);
  assert.deepEqual(lines('(Break it down)\n(Fade away with me)'), ['choir: Break it down', 'choir: Fade away with me'], 'a direction word next to real words: sung');
  assert.deepEqual(lines('[Choir]\n(ahh)\n(Sail on)\nSail away'), ['choir: Sail on', 'choir: Sail away']);
  // a song plan: its sections come from the parser of the plan, a section of a choir is marked like in a pasted text
  assert.deepEqual(lines('[Verse | 20 s]\n+ 100 BPM, warm synths\nOne line\n[Backing Vocals | 8 s]\nTwo line\n[Chorus | 20 s]\nThree line\n(Four line)\n(ahh)'), ['One line', 'choir: Two line', 'Three line', 'choir: Four line']);
  // the texts for the alignment: the lines of the choir too (their words are sung, the lines next to them need them to keep their times)
  assert.deepEqual(lyricsTiming.sungLines('[Choir]\n(Claudia, Claudia)\nChor: Sail on\n[Chorus]\nHold it'), ['Claudia, Claudia', 'Sail on', 'Hold it']);
  assert.equal(lyricsTiming.hasChoirMarks('[Chorus]\nSail on\n(ahhh)\nHold it tight (yeah)'), false);
  assert.equal(lyricsTiming.hasChoirMarks('Sail on\n(Sail on)'), true);
  assert.equal(lyricsTiming.hasChoirMarks(''), false);
  // a text without marks: the lines of before, with no voice
  assert.deepEqual(lyricsTiming.markedLines('[Intro]\n(ahhh)\nOne line\r\n[Chorus]\nTwo line (yeah)'), [{ text: 'One line' }, { text: 'Two line (yeah)' }]);
}

// The alignment and the transcript of a text with lines of a choir: the lines keep their marks and their own words, the timing says how the choir was found;
// the readers of the format (the karaoke of the cut and of the HUD, the two planners) get the same lines, the planners with the mark.
function testAlignment() {
  const text = ['[Verse 1]', 'Paper boats on a silver stream', '(Claudia, Claudia)', 'Chasing lanterns through a dream', '[Choir]', 'Sail on sail on', '[Chorus]', 'Hold the morning tight', 'Coros: ven aquí'].join('\n');
  const marked = lyricsTiming.markedLines(text);
  assert.deepEqual(marked.map((line) => line.voice || 'figure'), ['figure', 'choir', 'figure', 'choir', 'figure', 'choir']);
  // every word of the text in order, as the alignment hears it
  const words = [];
  const starts = [];
  let time = 4;
  for (const line of marked) {
    starts.push(round3(time));
    for (const token of line.text.split(/\s+/)) {
      words.push({ text: token, start: round3(time), end: round3(time + 0.35) });
      time += 0.45;
    }
    time += 1.2;
  }
  const timing = lyricsTiming.fromAlignment({ words, loss: 0.03 }, text, { duration: 40 });
  assert.deepEqual(timing.lines.map((line) => [line.text, line.voice || 'figure']), marked.map((line) => [line.text, line.voice || 'figure']));
  assert.deepEqual(timing.lines.map((line) => line.start), starts, 'every line starts with its own first word: the choir does not shift its neighbours');
  assert.deepEqual(timing.voices, { source: 'marks', choir: 3 });
  assert.equal(timing.matched, undefined, 'every word of the text was heard');
  // the same from the transcript (lower case, no commas)
  const heard = words.map((word) => ({ ...word, text: word.text.toLowerCase().replace(/[,]/g, ''), type: 'word' }));
  const transcript = lyricsTiming.fromTranscript({ words: heard }, text, { duration: 40 });
  assert.deepEqual(transcript.lines.map((line) => line.voice || 'figure'), ['figure', 'choir', 'figure', 'choir', 'figure', 'choir']);
  assert.deepEqual(transcript.voices, { source: 'marks', choir: 3 });
  // the lines given as a list (as the tool hands them on) keep their marks; plain strings are the lines of the figure
  assert.deepEqual(lyricsTiming.fromAlignment({ words }, marked, { duration: 40 }).lines.map((line) => line.voice || 'figure'), ['figure', 'choir', 'figure', 'choir', 'figure', 'choir']);
  assert.ok(lyricsTiming.fromAlignment({ words }, marked.map((line) => line.text), { duration: 40 }).lines.every((line) => line.voice === undefined));
  // the readers: the karaoke shows every sung line, the choir too, as it did
  const plain = { ...timing, lines: timing.lines.map(({ voice, ...line }) => line) };
  delete plain.voices;
  const shown = (value) => captionsAss.collectLines(captionsAss.readTiming(JSON.stringify(value))).map((line) => [line.text, line.start, line.end, line.words.length]);
  assert.deepEqual(shown(timing), shown(plain));
  assert.equal(shown(timing).length, 6);
  // the older planner and the HUD planner read the mark
  assert.deepEqual(planLib.readLines(lyricsTiming.parseTiming(JSON.stringify(timing)), 40).map((line) => line.voice || 'figure'), ['figure', 'choir', 'figure', 'choir', 'figure', 'choir']);
  assert.ok(planLib.readLines(plain, 40).every((line) => !('voice' in line)), 'a line of the figure has no voice field');
}

/* ---------- the windows: the figure does not sing the choir ---------- */

function testWindows() {
  const song = makeSong(SONG);
  const timing = withChoir(song.timing);
  for (const options of [{}, { motionShare: 0.3, maxUnits: 40 }, { motionShare: 0 }, { lipsyncSecondsPerMinute: 40 }]) {
    const label = JSON.stringify(options);
    const plain = hudPlan.planGrid(song.analysis, song.timing, options);
    const grid = hudPlan.planGrid(song.analysis, timing, options);
    assert.deepEqual(grid.lines.filter((line) => line.voice === 'choir').map((line) => line.index), CHOIR, `${label}: the lines keep their mark`);
    assert.deepEqual(grid.lines.map((line) => [line.text, line.start, line.end]), plain.lines.map((line) => [line.text, line.start, line.end]), `${label}: the same lines`);
    const choirLines = grid.lines.filter((line) => line.voice === 'choir');
    const firstOfFigure = grid.lines.find((line) => line.voice !== 'choir');
    const sung = grid.units.filter((unit) => unit.kind === 'performance');
    assert.ok(sung.length >= 1, `${label}: the figure still sings`);
    for (const unit of sung) {
      assert.ok(unit.lines.every((index) => grid.lines[index].voice !== 'choir'), `${label}: unit ${unit.index} holds no line of the choir`);
      for (const line of choirLines) {
        const span = wordsOf(line);
        assert.ok(unit.end <= span.start + 1e-6 || unit.start >= span.end - 1e-6, `${label}: unit ${unit.index} (${unit.start}-${unit.end}) is not sung over line ${line.index} (${span.start}-${span.end})`);
      }
      assert.ok(unit.start >= wordsOf(grid.lines[firstOfFigure.index - 1]).end, `${label}: no window before the first line of the figure`);
    }
    // the units on the lines of the choir are clips, whatever the share of motion
    const onChoir = grid.units.filter((unit) => unit.lines.some((index) => grid.lines[index].voice === 'choir'));
    assert.ok(onChoir.length >= 4 && onChoir.every((unit) => unit.kind === 'story'), `${label}: ${onChoir.map((unit) => unit.kind).join(', ')}`);
    // the grid says how the lines were found
    assert.deepEqual(grid.voices, { source: 'marks' });
    // without the marks the planner would have put the figure on the choir (so the rule is what keeps her off it)
    if (!options.motionShare && !options.lipsyncSecondsPerMinute) {
      assert.ok(plain.units.some((unit) => unit.kind === 'performance' && unit.lines.some((index) => CHOIR.includes(index))), 'the song of the test has windows on the choir without marks');
    }
  }
  // a song the choir sings alone: no window at all, every unit a clip
  const allChoir = hudPlan.planGrid(song.analysis, withChoir(song.timing, song.timing.lines.map((_line, at) => at)), {});
  assert.deepEqual([allChoir.stats.sung, allChoir.warnings], [0, ['NO_WINDOWS']]);
  assert.ok(allChoir.units.every((unit) => unit.kind === 'story'));

  // the older planner (music_video.plan): the same rule for its singer scenes
  const plainScenes = planLib.planScenes(song.analysis, song.timing, { performanceShare: 0.4 }).scenes;
  const scenes = planLib.planScenes(song.analysis, timing, { performanceShare: 0.4 }).scenes;
  const choirSpans = song.timing.lines.filter((_line, at) => CHOIR.includes(at));
  const overlaps = (scene) => choirSpans.some((line) => scene.start < line.end - 1e-6 && scene.end > line.start + 1e-6);
  assert.ok(plainScenes.some((scene) => scene.kind === 'performance' && overlaps(scene)), 'without marks a singer scene lies on the choir');
  const singer = scenes.filter((scene) => scene.kind === 'performance');
  assert.ok(singer.length >= 1);
  assert.ok(singer.every((scene) => !overlaps(scene)), 'no singer scene on a line of the choir');
  assert.ok(singer.every((scene) => scene.start >= song.timing.lines[1].end), 'none before the first line of the figure');
  const lines = planLib.readLines(timing, song.seconds);
  assert.deepEqual(lines.filter((line) => line.voice === 'choir').map((line) => line.text), choirSpans.map((line) => line.text));
}

/* ---------- the prompts and the board name the choir ---------- */

async function testChoirPrompts() {
  const song = makeSong(SONG);
  const figure = hudPlan.parseFigure(FIGURE_TEXT);
  const grid = hudPlan.planGrid(song.analysis, withChoir(song.timing), {});
  const plainGrid = hudPlan.planGrid(song.analysis, song.timing, {});
  const prompt = hudPlan.userPrompt({ brief: 'A made-up film', style: '', figure, grid });
  const rows = prompt.split('\n').filter((row) => /^\d+ \| [\d.]+-[\d.]+ s \| /.test(row) && / \| \d+:/.test(row));
  assert.equal(rows.length, grid.lines.length);
  assert.deepEqual(rows.map((row) => row.endsWith(' | choir')), grid.lines.map((line) => line.voice === 'choir'), 'the rows of the choir end with "choir"');
  assert.match(prompt, /\nCHOIR LINES \(marked "choir" above\): 0, 1, 4 to 7\nA choir or backing voices sing these lines, not the figure\. No sung unit lies on them; in the units on them \([^)]+\) the figure does not sing: the mouth closed, listening, or other singers sing, as the idea suggests\. These lines get their graphics like every other line\.\n\nUNITS /);
  // the prompt of a song without a choir has neither
  const plainPrompt = hudPlan.userPrompt({ brief: 'A made-up film', style: '', figure, grid: plainGrid });
  assert.doesNotMatch(plainPrompt, /choir/i);
  assert.equal(prompt.replace(/ \| choir$/gm, '').replace(/\n\nCHOIR LINES[^]*?(?=\n\nUNITS)/, '').split('\nUNITS')[0], plainPrompt.split('\nUNITS')[0], 'apart from the choir the same lines');
  // the brief names the passages of the choir in its arc
  const briefPrompt = hudPlan.briefUserPrompt({ grid, figure });
  assert.match(briefPrompt, /\n0 \| 8\.0-9\.4 s \| verse 1 \| remember lights timeline \| choir\n/);
  assert.match(briefPrompt, /The lines marked "choir" are sung by a choir or backing voices, not by the figure: name these passages in the arc\./);
  assert.doesNotMatch(hudPlan.briefUserPrompt({ grid: plainGrid, figure }), /choir/);
  assert.match(hudPlan.briefSystemPrompt({}), /name the passages that a choir sings/);
  // the board lists the lines of the choir, by the marks or by Gemini, and says why there was no detection
  const boardOf = async (timing) => {
    const own = hudPlan.planGrid(song.analysis, timing, {});
    const model = scriptedModel([goodAnswer(own, figure)]);
    const result = await hudPlan.runPlanner({ analysis: song.analysis, timing, brief: 'A made-up film', figureText: FIGURE_TEXT, ask: model.ask, prices: {} });
    assert.equal(model.calls.length, 1);
    return result.board.split('\n').filter((row) => row.startsWith('CHOIR '));
  };
  assert.deepEqual(await boardOf(song.timing), [], 'a song without anything about voices: the board of before');
  const [byMarks] = await boardOf(withChoir(song.timing));
  assert.match(byMarks, /^CHOIR {6}the lyrics mark 6 lines as sung by others, not by the figure \(no lip sync, story clips\): 0 «remember lights timeline», 1 «quiet rain door answer midnight», 4 «silver door engine tokens», /);
  const [byGemini] = await boardOf(withChoir(song.timing, CHOIR, { source: 'detect', model: 'gemini-test', choir: 6 }));
  assert.match(byGemini, /^CHOIR {6}Gemini heard 6 lines sung by others.*Wrong\? Mark the lines of a choir in the lyrics \(\[Choir\] above them, or "Choir:" at the start of a line\) and run again; marks always win\.$/);
  assert.deepEqual(await boardOf({ ...song.timing, voices: { source: 'detect', model: 'gemini-test', choir: 0 } }), ['CHOIR      Gemini heard no line sung by others: the figure may sing every line.']);
  const [noKey] = await boardOf({ ...song.timing, voices: { source: 'none', reason: 'no_key' } });
  assert.match(noKey, /^CHOIR {6}no detection of a choir \(GEMINI_API_KEY is not set\): the figure may sing every line; mark the lines of a choir in the lyrics/);
  const [failed] = await boardOf({ ...song.timing, voices: { source: 'none', reason: 'failed' } });
  assert.match(failed, /\(Gemini gave no usable answer\)/);
  const [noCredit] = await boardOf({ ...song.timing, voices: { source: 'none', reason: 'no_credit' } });
  assert.match(noCredit, /\(the prepaid credit of the Gemini key is used up\)/);
  const [refused] = await boardOf({ ...song.timing, voices: { source: 'none', reason: 'key' } });
  assert.match(refused, /\(Google refused the Gemini key\)/);
}

/* ---------- the brief from the song ---------- */

async function testBrief() {
  const song = makeSong(SONG);
  const grid = hudPlan.planGrid(song.analysis, song.timing, {});
  const figure = hudPlan.parseFigure(FIGURE_TEXT);
  const run = async (steps, extra = {}) => {
    const model = scriptedModel(steps, { usd: 0.25 });
    const logs = [];
    const result = await hudPlan.runPlanner({
      analysis: song.analysis,
      timing: 'timing' in extra ? extra.timing : song.timing,
      brief: extra.brief === undefined ? '' : extra.brief,
      figureText: extra.figureText || FIGURE_TEXT,
      style: '',
      theme: extra.theme || 'hud',
      hudLanguage: extra.hudLanguage || 'en',
      briefLanguage: extra.briefLanguage || 'en',
      ask: model.ask,
      log: (line) => logs.push(line),
      prices: promptCases.PRICES,
      fatal: extra.fatal
    });
    return { result, calls: model.calls, logs };
  };

  // the field is empty: the model writes the brief first, then plans with it as the IDEA
  {
    const { result, calls, logs } = await run([BRIEF, goodAnswer(grid, figure)]);
    assert.equal(calls.length, 2, 'two calls: the brief, then the plan');
    const [briefCall, planCall] = calls;
    assert.equal(briefCall.system, hudPlan.briefSystemPrompt({ theme: 'hud', hudLanguage: 'en', briefLanguage: 'en' }));
    assert.equal(briefCall.prompt, hudPlan.briefUserPrompt({ grid, figure }));
    assert.deepEqual([briefCall.maxTokens, briefCall.json, briefCall.reasoningEffort], [hudPlan.BRIEF_MAX_TOKENS, undefined, undefined], 'plain text, its own limit');
    assert.equal(planCall.system, hudPlan.systemPrompt({ theme: 'hud', hudLanguage: 'en', needShort: false }));
    assert.equal(planCall.prompt, hudPlan.userPrompt({ brief: BRIEF, style: '', figure, grid }));
    assert.ok(planCall.prompt.startsWith(`IDEA\n${BRIEF}\n\nSTYLE\n`), 'the brief is the IDEA of the plan');
    assert.deepEqual([result.brief, result.briefWritten], [BRIEF, true]);
    assert.deepEqual(result.briefInfo, { words: BRIEF.split(/\s+/).length, attempts: 1, usd: 0.25, usage: null, model: null });
    assert.deepEqual(result.costs, [0.25, 0.25], 'both calls are paid');
    assert.equal(result.attempts, 1);
    assert.match(result.board, /^BRIEF {6}written by the language model from the lyrics, since the field "Idea" was empty \(the result "Brief": copy it, change it and put it into the field to plan with it\)\n\nTREATMENT\n/);
    assert.ok(logs.some((line) => /^The field "Idea" is empty: the language model wrote the brief from the lyrics \(\d+ words\)\.$/.test(line)), logs.join(' | '));
    // the estimate has a part for the brief, and the board names it
    assert.ok(result.cost.parts.brief > 0.005 && result.cost.parts.brief < 0.05, `${result.cost.parts.brief}`);
    assert.match(result.board, /^ESTIMATE .* \+ language model [\d.]+ \+ brief [\d.]+ = [\d.]+ USD/m);
    // the same plan as with the brief typed into the field, apart from the line on the board and the part of the brief
    const typed = await run([goodAnswer(grid, figure)], { brief: BRIEF });
    assert.equal(typed.calls.length, 1);
    assert.equal(typed.calls[0].prompt, planCall.prompt);
    assert.deepEqual(typed.result.plan, result.plan);
    const sameBoard = (board) => board.replace(/^BRIEF[^\n]*\n\n/, '').replace(/ \+ brief [\d.]+(?= = )/, '').replace(/(estimate|=) [\d.]+ USD/g, '$1 x USD');
    assert.equal(sameBoard(result.board), sameBoard(typed.result.board));
    near(result.cost.total - typed.result.cost.total, result.cost.parts.brief, 1e-9, 'the total grows by the brief');
  }

  // a given field: one call, the brief is the field
  {
    const { result, calls } = await run([goodAnswer(grid, figure)], { brief: '  A woman and a light that stays on.  ' });
    assert.equal(calls.length, 1);
    assert.deepEqual([result.brief, result.briefWritten, result.briefInfo], ['A woman and a light that stays on.', false, null]);
    assert.doesNotMatch(result.board, /^BRIEF/);
    assert.equal(result.cost.parts.brief, undefined);
  }

  // a song without lyrics (an instrumental, an empty transcript): the brief comes from the parts, their energy and the figure, the board says so
  {
    const empty = { version: 1, source: 'transcribe', duration: song.seconds, words: [], lines: [] };
    const bare = hudPlan.planGrid(song.analysis, empty, {});
    assert.deepEqual([bare.lines.length, bare.stats.sung, bare.warnings], [0, 0, ['NO_LINES']]);
    const { result, calls, logs } = await run([BRIEF, goodAnswer(bare, figure)], { timing: empty });
    assert.equal(calls.length, 2);
    assert.match(calls[0].prompt, /\nLYRICS \(index \| time \| part \| line\)\n\(none: the song has no sung line, it is instrumental or no words were recognised; build the film from the parts, their energy and the figure\)\n/);
    assert.match(calls[0].prompt, /lyrics language none/);
    assert.match(calls[1].prompt, /\nLINES \(index, time, section, words with their index\)\n\(none: the song has no sung line; "lines" is an empty list, the graphics are the HUD and the end card\)\n/);
    assert.match(result.board, /^BRIEF {6}written by the language model from the parts of the song, their energy and the figure: the song has no sung line \(instrumental, or no words were recognised\)\n/);
    assert.equal(result.plan.graphics.lines.length, 0);
    assert.equal(result.attempts, 1, 'the plan of a song without lines is complete at once');
    assert.ok(logs.some((line) => /no sung line/.test(line)));
    // with a given idea the board says in one sentence that there are no lines
    const given = await run([goodAnswer(bare, figure)], { timing: empty, brief: 'A film without words' });
    assert.match(given.result.board, /^LYRICS {5}the song has no sung line \(instrumental, or no words were recognised\): no lip sync and no graphics for lines\n\nTREATMENT/);
    // a timing that cannot be read is still an error
    for (const bad of ['nothing', '{"words": []}', '']) {
      const err = await errorOf(run([BRIEF], { timing: bad }));
      assert.equal(err && err.code, 'HUDPLAN_NO_LINES', JSON.stringify(bad));
    }
  }

  // the language of the brief (the person's) and of the words on the screen (the graphics)
  {
    const de = hudPlan.briefSystemPrompt({ theme: 'kuble', hudLanguage: 'es', briefLanguage: 'de' });
    assert.match(de, /- In German \(Swiss High German: always "ss", never the sharp s\), 200 to 300 words/);
    assert.match(de, /\n1\. Thema: [^\n]+\n2\. Bogen: [^\n]+\n3\. Maschine im HUD: [^\n]+\n4\. Look: [^\n]+\n5\. Grafiken zu den Zeilen: [^\n]+\n6\. Schlusskarte: [^\n]+\n7\. Nicht: /);
    assert.match(de, /the end card\) is in Spanish\./);
    assert.match(de, /The look is "Kuble"/);
    const es = hudPlan.briefSystemPrompt({ hudLanguage: 'de', briefLanguage: 'es' });
    assert.match(es, /- In Spanish, 200 to 300 words/);
    assert.match(es, /\n1\. Tema: [^\n]+\n2\. Arco: [^\n]+\n3\. Máquina del HUD: [^\n]+\n4\. Look: [^\n]+\n5\. Gráficos de las líneas: [^\n]+\n6\. Tarjeta final: [^\n]+\n7\. No: /);
    assert.match(es, /is in German \(Swiss High German, always "ss", never the sharp s\)\./);
    const en = hudPlan.briefSystemPrompt({});
    assert.match(en, /- In English, 200 to 300 words/);
    assert.match(en, /\n1\. Theme: one sentence: what the film is about\n2\. Arc: one line per part of the song[^\n]+\n3\. Machine in the HUD: [^\n]+\n4\. Look: [^\n]+\n5\. Graphics for the lines: [^\n]+\n6\. End card: [^\n]+\n7\. Not: what must not appear\n/);
    assert.equal(hudPlan.briefSystemPrompt({ briefLanguage: 'fr' }), en, 'an unknown language is English');
    const { calls } = await run([BRIEF.replace('stone', 'Strasse'), goodAnswer(grid, figure)], { briefLanguage: 'de', hudLanguage: 'de' });
    assert.equal(calls[0].system, hudPlan.briefSystemPrompt({ theme: 'hud', hudLanguage: 'de', briefLanguage: 'de' }));
    // a German brief is written in Swiss High German: the sharp s becomes "ss"
    assert.equal(hudPlan.cleanBrief('Thema: Die Straße, das Maß.', 'de'), 'Thema: Die Strasse, das Mass.');
    assert.equal(hudPlan.cleanBrief('Theme: Straße', 'en'), 'Theme: Straße', 'only the German one');
    // Markdown, fences and long answers are cleaned
    assert.equal(hudPlan.cleanBrief('```text\n# Brief\n**Theme:** a\n\n\n\nArc: b  \n```'), 'Theme: a\n\nArc: b');
    assert.ok(hudPlan.cleanBrief(`${'word '.repeat(3000)}`).length <= 6000);
  }

  // the rules of the prompt: what the model may not show, and the images of the song
  {
    const system = hudPlan.briefSystemPrompt({});
    for (const rule of [
      /No real brands, logos, products, companies or people, and no company name in the picture\./,
      /The figure is always an adult\. Nothing suggestive or explicit\./,
      /No link between the figure and an AI provider, an AI model or a tech company\./,
      /Metaphors of the lyrics such as needle, vein, blood, wound or poison are never shown literally: no drugs, no injections, no violence, no blood\./,
      /takes the images, places, numbers, names and turns of THIS song and builds the story from them; never a generic theme/,
      /Answer with the brief only/
    ]) assert.match(system, rule);
    const user = hudPlan.briefUserPrompt({ grid, figure });
    assert.match(user, /^SONG\nduration 72 s, about 120 BPM, lyrics language English\nparts \(index, name, time, energy\):\n0 intro 0\.0-7\.3 s energy low\n/);
    assert.match(user, /\nLYRICS \(index \| time \| part \| line\)\n0 \| 8\.0-9\.4 s \| verse 1 \| remember lights timeline\n1 \| /);
    assert.match(user, /\nFIGURE\nNAME: Mira\nLOOK: a woman with short copper hair and a grey wool coat\n\nWrite the brief now\.$/);
    // a figure without a short form: the start of the full form
    const noShort = hudPlan.briefUserPrompt({ grid, figure: hudPlan.parseFigure(FIGURE_NO_SHORT) });
    assert.match(noShort, /\nLOOK: \S/);
  }

  // a call that fails is tried once more: after an error, after an empty answer at the limit (with less thinking), after a brief that is too short (told so)
  {
    const failing = await run([new Error('the service is busy'), BRIEF, goodAnswer(grid, figure)]);
    assert.equal(failing.calls.length, 3);
    assert.equal(failing.calls[1].prompt, failing.calls[0].prompt, 'the same request again');
    assert.equal(failing.result.brief, BRIEF);
    assert.equal(failing.result.briefInfo.attempts, 2);
    assert.ok(failing.logs.some((line) => /^Attempt 1 of 2: the language model wrote no brief \(the service is busy\)$/.test(line)), failing.logs.join(' | '));
    const empty = Object.assign(new Error('The model returned an empty answer (finish_reason length)'), { emptyAnswer: true, finishReason: 'length', usd: 0.4 });
    const thinking = await run([empty, BRIEF, goodAnswer(grid, figure)]);
    assert.equal(thinking.calls[1].reasoningEffort, 'low', 'the second try thinks less');
    assert.deepEqual(thinking.result.costs, [0.4, 0.25, 0.25], 'the empty answer is paid all the same');
    const short = await run(['Theme: boats.', BRIEF, goodAnswer(grid, figure)]);
    assert.match(short.calls[1].prompt, /\nYOUR PREVIOUS ANSWER WAS NOT USABLE \(the brief has 2 words, at least 80 are needed\): write the complete brief again\.\n\nWrite the brief now\.$/);
    assert.equal(short.result.brief, BRIEF);
  }

  // two failures: HUDPLAN_BRIEF_FAILED, with what the calls cost; no plan is asked for
  {
    const model = scriptedModel([new Error('the service is busy'), 'Too short.'], { usd: 0.25 });
    const err = await errorOf(hudPlan.runPlanner({ analysis: song.analysis, timing: song.timing, brief: '', figureText: FIGURE_TEXT, ask: model.ask, prices: {} }));
    assert.equal(err && err.code, 'HUDPLAN_BRIEF_FAILED');
    assert.match(err.message, /no usable brief in 2 attempts \(the brief has 2 words, at least 80 are needed\): write the idea into the field, or run the node again$/);
    assert.deepEqual(err.costs, [0.25]);
    assert.deepEqual(err.data, { attempts: 2 });
    assert.equal(model.calls.length, 2, 'nothing after the second try');
    // the end of the run or an exhausted budget ends it at once
    const budget = Object.assign(new Error('The budget is used up'), { name: 'BudgetError' });
    const fatal = await errorOf(run([budget, BRIEF], { fatal: (caught) => caught.name === 'BudgetError' }));
    assert.equal(fatal && fatal.name, 'BudgetError');
  }
}

/* ---------- the price ---------- */

function testEstimate() {
  const registryModule = require('../lib/nodes/registry');
  const hudNodes = require('../lib/nodes/nodes-music-video-hud');
  const explainerPlan = require('../lib/explainer-plan');
  const { textValue } = require('../lib/nodes/types');
  const def = registryModule.registry.get('music_video.hud_plan');
  const song = makeSong(SONG);
  const params = { ...registryModule.registry.normalizeParams(def, {}), model: 'anthropic/claude-opus-5.5', figure: FIGURE_TEXT };
  const inputs = { analysis: textValue(JSON.stringify(song.analysis)), timing: textValue(JSON.stringify(song.timing)) };
  const connected = new Set(['analysis', 'timing']);
  const given = hudNodes.hudPlanEstimate({ ...params, brief: 'A woman and a light that stays on.' }, { inputs, connected });
  const written = hudNodes.hudPlanEstimate({ ...params, brief: '' }, { inputs, connected });
  assert.ok(given && written, 'both are known');
  // the brief: its prompt and its answer at the price of the model, and the plan reads a brief of the usual length
  const grid = hudPlan.planGrid(song.analysis, song.timing, {});
  const figure = hudPlan.parseFigure(FIGURE_TEXT);
  const [inPrice, outPrice] = explainerPlan.PRICES_PER_MILLION['anthropic/claude-opus-5.5'];
  const chars = explainerPlan.CHARS_PER_TOKEN;
  const briefChars = hudPlan.briefSystemPrompt({ theme: 'hud', hudLanguage: 'en', briefLanguage: 'en' }).length + hudPlan.briefUserPrompt({ grid, figure }).length;
  const briefTokens = hudPlan.briefTokens(briefChars, chars);
  const system = hudPlan.systemPrompt({ theme: 'hud', hudLanguage: 'en', needShort: false });
  const planTokens = hudPlan.llmTokens(grid, hudPlan.userPrompt({ brief: '', style: '', figure, grid }).length + system.length + hudPlan.BRIEF_TYPICAL_CHARS, chars);
  near(written.usd, Math.round((((planTokens.input + briefTokens.input) * inPrice + (planTokens.output + briefTokens.output) * outPrice) / 1e6) * 10000) / 10000, 1e-9);
  assert.ok(written.usd - given.usd > 0.02 && written.usd - given.usd < 0.08, `the brief adds a few cents: ${given.usd} -> ${written.usd}`);
  // an idea that comes through a connection is no call for a brief: known when it is there, unknown while the node before has not run
  assert.deepEqual(hudNodes.hudPlanEstimate({ ...params, brief: '' }, { inputs: { ...inputs, brief: textValue('A woman and a light that stays on.') }, connected: new Set([...connected, 'brief']) }), given);
  assert.equal(hudNodes.hudPlanEstimate({ ...params, brief: '' }, { inputs, connected: new Set([...connected, 'brief']) }), null);
  // the language of the brief changes its prompt only a little
  const german = hudNodes.hudPlanEstimate({ ...params, brief: '', brief_language: 'de' }, { inputs, connected });
  near(german.usd, written.usd, 0.002);
  // the board: the part of the brief, only where it was written
  const prices = promptCases.PRICES;
  const promptChars = system.length + hudPlan.userPrompt({ brief: BRIEF, style: '', figure, grid }).length;
  const without = hudPlan.estimateCost({ grid, settings: grid.settings, prices, promptChars });
  const withBrief = hudPlan.estimateCost({ grid, settings: grid.settings, prices, promptChars, briefChars });
  assert.deepEqual(Object.keys(without.parts), ['sheet', 'plates', 'lipsync', 'clips', 'depth', 'llm']);
  assert.deepEqual(Object.keys(withBrief.parts), ['sheet', 'plates', 'lipsync', 'clips', 'depth', 'llm', 'brief']);
  const tokens = hudPlan.briefTokens(briefChars, prices.llm.charsPerToken);
  near(withBrief.parts.brief, (tokens.input * prices.llm.inputPerMillion + tokens.output * prices.llm.outputPerMillion) / 1e6, 1e-9);
  near(withBrief.total - without.total, withBrief.parts.brief, 1e-9);
  const noModel = hudPlan.estimateCost({ grid, settings: grid.settings, prices: { ...prices, llm: null }, promptChars, briefChars });
  assert.equal(noModel.parts.brief, null);
  assert.ok(noModel.unknown.includes('brief'));
}

/* ---------- the node ---------- */

function testNode() {
  const registryModule = require('../lib/nodes/registry');
  const engine = require('../lib/nodes/engine');
  const hudNodes = require('../lib/nodes/nodes-music-video-hud');
  const templates = require('../lib/nodes/templates');
  const real = registryModule.registry;
  const def = real.get('music_video.hud_plan');
  // the idea is optional, the brief that was used is an output, the language of a written brief a setting
  assert.deepEqual(def.inputs.find((port) => port.id === 'brief'), { id: 'brief', type: 'text', param: 'brief' });
  assert.deepEqual(def.outputs.find((port) => port.id === 'brief'), { id: 'brief', type: 'text' });
  const language = def.params.find((param) => param.id === 'brief_language');
  assert.deepEqual([language.kind, language.options, language.default, language.cacheOmitDefault], ['select', ['en', 'de', 'es'], 'en', true]);
  const voices = real.get('audio.lyrics_timing').params.find((param) => param.id === 'voices');
  assert.deepEqual([voices.kind, voices.options, voices.default, voices.cacheOmitDefault], ['select', ['off', 'auto'], 'off', true]);

  // the key of a node saved before WP48: the same, so nothing that was paid runs again; another language of the brief is another key
  const saved = { model: '', brief: '', figure: FIGURE_TEXT, theme: 'hud' };
  const keyOf = (params, inputs = {}) => engine.computeCacheKey(def, engine.effectiveParams(real, def, { id: 'n4', type: def.type, params }), inputs);
  assert.equal(keyOf(saved), keyOf({ ...saved, brief_language: 'en' }), 'the default is no part of the key');
  assert.notEqual(keyOf(saved), keyOf({ ...saved, brief_language: 'de' }));
  const timingDef = real.get('audio.lyrics_timing');
  const timingKey = (params) => engine.computeCacheKey(timingDef, engine.effectiveParams(real, timingDef, { id: 'n3', type: timingDef.type, params }), {});
  assert.equal(timingKey({ lyrics: '', method: 'auto' }), timingKey({ lyrics: '', method: 'auto', voices: 'off' }));
  assert.notEqual(timingKey({ lyrics: '', method: 'auto' }), timingKey({ lyrics: '', method: 'auto', voices: 'auto' }));
  // a param that may not say so
  const { createRegistry } = registryModule;
  const strict = createRegistry();
  assert.throws(() => strict.register({ type: 'test.flag', category: 'utility', label: 'x', execute: async () => ({}), params: [{ id: 'a', kind: 'text', default: '', cacheOmitDefault: 'yes' }] }), /bad cacheOmitDefault/);

  // the idea connected from an input node that is empty: an issue of the plan, before the song is paid; any other connection is none
  const sources = (type, params) => ({ brief: { connected: true, count: 1, sources: [{ node: 'n25', type, params }] } });
  assert.deepEqual(hudNodes.hudPlanValidate({}, sources('input.prompt', { prompt: '   ' })), [
    { level: 'error', code: 'HUDPLAN_IDEA_EMPTY', port: 'brief', message: 'The idea is empty: node n25 delivers no text. Write the idea of the video into it', data: { node: 'n25', field: 'prompt' } }
  ]);
  assert.deepEqual(hudNodes.hudPlanValidate({}, sources('input.text', { text: '' }))[0].data, { node: 'n25', field: 'text' });
  assert.deepEqual(hudNodes.hudPlanValidate({}, sources('input.prompt', { prompt: 'An idea' })), []);
  assert.deepEqual(hudNodes.hudPlanValidate({}, sources('llm.chat', { prompt: '' })), [], 'a text made by another node is not known before the run');
  assert.deepEqual(hudNodes.hudPlanValidate({ brief: '' }, { brief: { connected: false, count: 0, sources: [] } }), [], 'an empty field: the brief comes from the song');

  // through the engine: the template with the song by ElevenLabs refuses an empty idea, the template with your own song plans without it
  const plan = (id, set) => {
    const doc = templates.resolveTemplate(id, { lang: 'de' });
    const graph = JSON.parse(JSON.stringify(doc.graph));
    for (const [nodeId, params] of Object.entries(set)) Object.assign(graph.nodes.find((node) => node.id === nodeId).params, params);
    return { doc, issues: engine.validateGraph({ graph }, real) };
  };
  // (the template for a song by Suno also waits for the upload of the song: an issue of its own, with or without the idea)
  const errors = (id, set) => plan(id, set).issues.filter((issue) => issue.level === 'error').map((issue) => JSON.stringify([issue.nodeId, issue.code, issue.port, issue.data]));
  for (const id of ['music-video-hud-elevenlabs', 'music-video-hud-suno']) {
    const withIdea = errors(id, { n25: { prompt: 'A song about a light' } });
    const empty = errors(id, { n25: { prompt: '' } });
    assert.deepEqual(empty.filter((issue) => !withIdea.includes(issue)).map((issue) => JSON.parse(issue)), [['n4', 'HUDPLAN_IDEA_EMPTY', 'brief', { node: 'n25', field: 'prompt' }]], id);
    assert.ok(withIdea.every((issue) => JSON.parse(issue)[0] !== 'n4'), `${id}: with the idea`);
    assert.equal(empty.length, withIdea.length + 1, id);
  }
  const own = plan('music-video-hud', { n4: { brief: '' } });
  assert.deepEqual(own.issues.filter((issue) => issue.nodeId === 'n4' && issue.level === 'error'), [], 'your own song: the idea may stay empty');

  // the view of the app: the issue names the field of the form («Das Feld «…» ist leer.»), in the three languages
  const window = { OCDNodes: { graph: {}, ui: { el: () => ({}), icon: () => ({}), T: (key) => key }, api: {}, run: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'nodes', 'app-mode.js'), 'utf8'), { window, localStorage: undefined, console });
  const { fieldOfIssue } = window.OCDNodes.appMode;
  const { doc } = plan('music-video-hud-elevenlabs', { n25: { prompt: '' } });
  const fields = doc.app.inputs.map((entry) => ({ node: { id: entry.node }, param: { id: entry.param }, visible: true, label: entry.label }));
  const issue = plan('music-video-hud-elevenlabs', { n25: { prompt: '' } }).issues.find((item) => item.code === 'HUDPLAN_IDEA_EMPTY');
  const field = fieldOfIssue(JSON.parse(JSON.stringify(issue)), fields);
  assert.deepEqual([field.node.id, field.param.id], ['n25', 'prompt']);
  const dictionaries = loadTexts();
  for (const lang of ['de', 'en', 'es']) {
    const label = templates.resolveTemplate('music-video-hud-elevenlabs', { lang }).app.inputs.find((entry) => entry.node === 'n25').label;
    const text = dictionaries[lang]['nodes.app.fieldEmpty'].replace('{field}', label);
    assert.match(text, lang === 'de' ? /^Das Feld «Idee[^»]*» ist leer\./ : lang === 'en' ? /^The field “Idea[^”]*” is empty\./ : /^El campo «Idea[^»]*» está vacío\./, lang);
  }
  // the empty field of the node itself (an engine issue without data.node) names the field too; an issue of another field is not one of the form
  assert.equal(fieldOfIssue({ nodeId: 'n4', code: 'missing_input', data: { field: 'figure' } }, fields).label, doc.app.inputs.find((entry) => entry.node === 'n4' && entry.param === 'figure').label);
  assert.equal(fieldOfIssue({ nodeId: 'n4', code: 'missing_input', data: { field: 'brief' } }, fields), null);
  assert.equal(fieldOfIssue({ nodeId: 'n4', code: 'HUDPLAN_TOO_LONG', data: { seconds: 300 } }, fields), null);
  assert.equal(fieldOfIssue({ nodeId: 'n4', code: 'missing_input', data: { field: 'figure' } }, fields.map((item) => ({ ...item, visible: false }))), null, 'a hidden field is not named');
}

/* ---------- Gemini hears who sings ---------- */

async function testVoices() {
  const KEY = 'test-only-gemini-key-not-real';
  const lines = [
    { text: 'Paper boats on a silver stream', start: 4, end: 6.5 },
    { text: 'Claudia, Claudia', start: 7, end: 8.2 },
    { text: 'Hold the morning tight', start: 9, end: 11 }
  ];
  const audio = Buffer.from('not really aac, the double does not listen');
  const answerOf = (entries, usage = { promptTokenCount: 1200, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 960 }, { modality: 'TEXT', tokenCount: 240 }], candidatesTokenCount: 90, thoughtsTokenCount: 1400 }) => ({
    status: 200,
    body: { candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: JSON.stringify(entries) }] } }], usageMetadata: usage }
  });
  const good = { lines: [{ index: 0, voice: 'lead', confidence: 0.92 }, { index: 1, voice: 'choir', confidence: 0.81 }, { index: 2, voice: 'both', confidence: 0.6 }] };
  const google = (steps) => {
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      const step = steps[Math.min(requests.length - 1, steps.length - 1)];
      if (step instanceof Error) throw step;
      return { status: step.status, text: async () => (typeof step.body === 'string' ? step.body : JSON.stringify(step.body)) };
    };
    return { requests, fetchImpl };
  };
  const usdOf = (audioTokens, textTokens, outputTokens) => Math.round((audioTokens * 1 + textTokens * 0.5 + outputTokens * 3)) / 1e6;

  // without a key nothing is sent
  setEnv('GEMINI_API_KEY', undefined);
  setEnv('GEMINI_VOICES_MODEL', undefined);
  assert.equal(voiceDetect.hasKey(), false);
  const noKey = google([answerOf(good)]);
  const refused = await errorOf(voiceDetect.detectVoices({ audio, lines, fetchImpl: noKey.fetchImpl }));
  assert.deepEqual([refused.code, noKey.requests.length], ['VOICES_NO_KEY', 0]);

  setEnv('GEMINI_API_KEY', KEY);
  assert.equal(voiceDetect.hasKey(), true);
  assert.equal(voiceDetect.model(), voiceDetect.DEFAULT_MODEL);
  assert.match(voiceDetect.DEFAULT_MODEL, /flash/, 'a model of the Flash class');

  // the request: v1beta with the key in the header, the song first (inline, compressed), then the lines with their times; JSON back
  {
    const double = google([answerOf(good)]);
    const found = await voiceDetect.detectVoices({ audio, mime: 'audio/aac', lines, seconds: 12, fetchImpl: double.fetchImpl });
    assert.equal(double.requests.length, 1);
    const [request] = double.requests;
    assert.equal(request.url, `https://generativelanguage.googleapis.com/v1beta/models/${voiceDetect.DEFAULT_MODEL}:generateContent`);
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.headers['x-goog-api-key'], KEY);
    assert.ok(!request.url.includes(KEY), 'the key is not in the address');
    const parts = request.body.contents[0].parts;
    assert.deepEqual(parts[0], { inline_data: { mime_type: 'audio/aac', data: audio.toString('base64') } });
    assert.match(parts[1].text, /^You hear a song\./);
    assert.match(parts[1].text, /\nLINES \(index \| time \| text\)\n0 \| 4\.0-6\.5 s \| Paper boats on a silver stream\n1 \| 7\.0-8\.2 s \| Claudia, Claudia\n2 \| 9\.0-11\.0 s \| Hold the morning tight$/);
    assert.match(parts[1].text, /"lead"[^\n]*\n- "choir"[^\n]*\n- "both"/);
    assert.deepEqual(request.body.generationConfig, { responseMimeType: 'application/json' });
    assert.deepEqual(found.voices, good.lines);
    assert.equal(found.attempts, 1);
    assert.equal(found.model, voiceDetect.DEFAULT_MODEL);
    // the cost from what Google counted: the audio at the audio price, the rest of the prompt at the text price, the answer and the thinking at the output price
    near(found.usd, usdOf(960, 240, 1490), 1e-9);
    assert.deepEqual(found.usage, { input_tokens: 1200, output_tokens: 1490, total_tokens: 2690 });
    // `both` counts as the figure, a choir the model is not sure about too
    assert.deepEqual(found.voices.map(voiceDetect.voiceOf), ['lead', 'choir', 'both']);
    assert.equal(voiceDetect.voiceOf({ index: 1, voice: 'choir', confidence: 0.3 }), 'lead');
    assert.equal(voiceDetect.voiceOf(undefined), 'lead');
  }

  // an answer that is not valid: once more, with the problem told; a second one: no detection (and both are paid)
  {
    const invalid = [
      ['no JSON', 'Sure! Line 0 is the lead.'],
      ['too few', { lines: good.lines.slice(0, 2) }],
      ['an unknown voice', { lines: [{ ...good.lines[0], voice: 'duet' }, good.lines[1], good.lines[2]] }],
      ['a confidence out of range', { lines: [{ ...good.lines[0], confidence: 1.4 }, good.lines[1], good.lines[2]] }],
      ['an index twice', { lines: [good.lines[0], good.lines[0], good.lines[2]] }]
    ];
    for (const [label, entries] of invalid) {
      const double = google([answerOf(entries), answerOf(good)]);
      const found = await voiceDetect.detectVoices({ audio, lines, fetchImpl: double.fetchImpl });
      assert.equal(double.requests.length, 2, label);
      assert.match(double.requests[1].body.contents[0].parts[1].text, /Your previous answer was not valid \([^)]+\)\. Answer again in exactly this format\./, label);
      assert.deepEqual([found.attempts, found.voices.length], [2, 3], label);
      near(found.usd, 2 * usdOf(960, 240, 1490), 1e-9, label);
    }
    const double = google([answerOf('nonsense'), answerOf({ lines: [] })]);
    const err = await errorOf(voiceDetect.detectVoices({ audio, lines, fetchImpl: double.fetchImpl }));
    assert.deepEqual([err.code, double.requests.length], ['VOICES_BAD_ANSWER', 2]);
    near(err.usd, 2 * usdOf(960, 240, 1490), 1e-9, 'what the answers cost');
    // an answer in a code fence is read; the order of the entries does not matter
    const fenced = google([{ status: 200, body: { candidates: [{ content: { parts: [{ text: `\`\`\`json\n${JSON.stringify({ lines: [...good.lines].reverse() })}\n\`\`\`` }] } }] } }]);
    const read = await voiceDetect.detectVoices({ audio, lines, seconds: 12, fetchImpl: fenced.fetchImpl });
    assert.deepEqual(read.voices, good.lines);
    near(read.usd, voiceDetect.estimateUsd(12, 3), 1e-9, 'without usageMetadata the estimate is booked, never nothing');
  }

  // a failure of the service is tried once more; an error of the request is not; the key never appears in a message
  {
    const busy = google([{ status: 429, body: { error: { message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' } } }, answerOf(good)]);
    assert.equal((await voiceDetect.detectVoices({ audio, lines, fetchImpl: busy.fetchImpl })).attempts, 2);
    const network = google([Object.assign(new Error(`connect ECONNRESET with ${KEY}`), { cause: { code: 'ECONNRESET' } }), answerOf(good)]);
    assert.equal((await voiceDetect.detectVoices({ audio, lines, fetchImpl: network.fetchImpl })).attempts, 2);
    const bad = google([{ status: 400, body: { error: { message: `API key not valid: ${KEY}`, status: 'INVALID_ARGUMENT' } } }, answerOf(good)]);
    const err = await errorOf(voiceDetect.detectVoices({ audio, lines, fetchImpl: bad.fetchImpl }));
    assert.deepEqual([err.code, err.status, bad.requests.length, err.summary], ['VOICES_HTTP', 400, 1, 'HTTP 400 INVALID_ARGUMENT']);
    assert.ok(!err.message.includes(KEY) && err.message.includes('[GEMINI_API_KEY]'), err.message);
    const down = google([{ status: 503, body: '<html>unavailable</html>' }]);
    const twice = await errorOf(voiceDetect.detectVoices({ audio, lines, fetchImpl: down.fetchImpl }));
    assert.deepEqual([twice.code, twice.status, down.requests.length, twice.usd], ['VOICES_HTTP', 503, 2, 0]);
    // an answer that does not come: the request is ended after the time, and tried once more
    let hangingCalls = 0;
    const hanging = async (_url, init) => {
      hangingCalls += 1;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    };
    const timeout = await errorOf(voiceDetect.detectVoices({ audio, lines, fetchImpl: hanging, timeoutMs: 20 }));
    assert.deepEqual([timeout.code, hangingCalls], ['VOICES_TIMEOUT', 2]);
  }

  // another model through the environment (the prices stay the ones of the default)
  setEnv('GEMINI_VOICES_MODEL', 'gemini-9-flash-test');
  assert.equal(voiceDetect.model(), 'gemini-9-flash-test');
  setEnv('GEMINI_VOICES_MODEL', 'bad model/../x');
  assert.equal(voiceDetect.model(), voiceDetect.DEFAULT_MODEL);

  // the price of a request: about 2 cents for a song of three minutes
  near(voiceDetect.estimateUsd(180), 0.018, 0.004);
  assert.ok(voiceDetect.estimateUsd(600) > voiceDetect.estimateUsd(180));

  // the song as a small AAC file for listening (with ffmpeg, when there is one)
  const ffmpegLib = require('../lib/ffmpeg');
  if (ffmpegLib.binaries().available) {
    const { toneWav } = require('./support/explainer-media');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocd-voices-test-'));
    try {
      const file = path.join(dir, 'song.wav');
      fs.writeFileSync(file, toneWav(6, 440));
      // the scratch folder of the compression lies in the temporary folder, here the one of the test: nothing of it is left
      setEnv('TMPDIR', dir);
      const { audio: compressed, mime } = await voiceDetect.compressAudio(file);
      assert.equal(mime, 'audio/aac');
      assert.ok(compressed.length > 1000 && compressed.length < fs.statSync(file).size / 4, `${compressed.length} bytes`);
      assert.equal(compressed[0], 0xff, 'an ADTS frame');
      assert.equal(compressed[1] & 0xf0, 0xf0);
      const missing = await errorOf(voiceDetect.compressAudio(path.join(dir, 'nothing.wav')));
      assert.equal(missing.code, 'VOICES_NO_AUDIO');
      assert.deepEqual(fs.readdirSync(dir), ['song.wav'], 'no scratch folder is left');
    } finally {
      restoreAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  restoreAll();
}

/* ---------- the texts ---------- */

function loadTexts() {
  const storage = new Map([['vcd-lang', 'de']]);
  const window = {
    document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
    navigator: { language: 'de-CH' },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'i18n.js'), 'utf8'), { window }, { filename: 'public/i18n.js' });
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'nodes', 'i18n-nodes.js'), 'utf8'), { window }, { filename: 'public/nodes/i18n-nodes.js' });
  return window.I18N;
}

function testTexts() {
  const dictionaries = loadTexts();
  const keys = [
    'nodes.param.brief_language',
    'nodes.param.voices',
    'nodes.option.voices.auto',
    'nodes.option.voices.off',
    'nodes.paramhint.audio.lyrics_timing.lyrics',
    'nodes.portdesc.music_video.hud_plan.brief.in',
    'nodes.portdesc.music_video.hud_plan.brief.out',
    'nodes.issue.HUDPLAN_BRIEF_FAILED',
    'nodes.issue.HUDPLAN_IDEA_EMPTY',
    'nodes.issue.HUDPLAN_NO_BRIEF',
    'nodes.app.fieldEmpty'
  ];
  for (const lang of ['de', 'en', 'es']) {
    for (const key of keys) {
      const value = dictionaries[lang][key];
      assert.ok(typeof value === 'string' && value.trim(), `${lang}: ${key}`);
      assert.ok(!value.includes('ß'), `${lang}: ${key} has a sharp s`);
    }
    // the help of the lyrics names every kind of mark, and that the chorus of the figure stays hers
    const hint = dictionaries[lang]['nodes.paramhint.audio.lyrics_timing.lyrics'];
    for (const part of [lang === 'de' ? '[Chor]' : lang === 'en' ? '[Choir]' : '[Coros]', '[Backing Vocals]', lang === 'de' ? '«Chor:»' : lang === 'en' ? '“Choir:”' : '«Coros:»', '(Claudia, Claudia)', '[Chorus]', '[Refrain]', '[Hook]']) assert.ok(hint.includes(part), `${lang}: the hint names ${part}`);
    assert.ok(dictionaries[lang]['nodes.app.fieldEmpty'].includes('{field}'));
    assert.match(dictionaries[lang]['nodes.type.music_video.hud_plan.help'], lang === 'de' ? /Briefing aus dem Songtext/ : lang === 'en' ? /brief from the lyrics/ : /brief de la letra/);
  }
  assert.match(dictionaries.de['nodes.app.fieldEmpty'], /^Das Feld «\{field\}» ist leer\./);
}

async function main() {
  try {
    await testGolden();
    testMarks();
    testAlignment();
    testWindows();
    await testChoirPrompts();
    await testBrief();
    testEstimate();
    testNode();
    await testVoices();
    testTexts();
  } finally {
    restoreAll();
  }
  console.log('test-music-video-hud-brief.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
