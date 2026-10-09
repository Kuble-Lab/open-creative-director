'use strict';

// The plan of a music video (lib/music-video-plan.js, WP34): the cut grid (boundaries on beats, lengths, at most 50 scenes, the
// scenes for the singer), what the language model is asked, how its answer is checked (JSON, a prompt for every scene), the simple
// prompts that replace what it did not deliver, and the shots JSON that the cutting node reads. Invented song data; no model is called.
// WP44 (the HUD planner): the bars and hits of an analysis with the fallback for old analyses, and the kind "still" of the shots JSON.

const assert = require('assert/strict');

const plan = require('../lib/music-video-plan');

/* ---------- invented data ---------- */

const BPM = 82;
const PERIOD = 60 / BPM;

function makeAnalysis({ duration = 120, sections, beats = true } = {}) {
  const parts = sections || [
    { name: 'Intro', start: 0, end: 15, energy: 0.3 },
    { name: 'Verse 1', start: 15, end: 45, energy: 0.6 },
    { name: 'Chorus', start: 45, end: 80, energy: 0.9 },
    { name: 'Verse 2', start: 80, end: 105, energy: 0.6 },
    { name: 'Outro', start: 105, end: 120, energy: 0.2 }
  ];
  const grid = [];
  if (beats) for (let time = 0.3; time < duration; time += PERIOD) grid.push(Math.round(time * 1000) / 1000);
  const energy = Array.from({ length: Math.ceil(duration) }, (_unused, second) => (parts.find((part) => second >= part.start && second < part.end) || parts[parts.length - 1]).energy);
  return { version: 1, duration, bpm: BPM, beats: grid, sections: parts, energy };
}

// lines of three seconds (the fifth of every five two seconds shorter), starting at the given seconds
const LINE_STARTS = [16, 19.4, 22.8, 26.2, 31, 34.5, 38, 41.5, 46, 49.5, 53, 56.5, 60, 63.5, 67, 70.5, 81, 84.5, 88, 91.5, 106, 109];
function makeTiming(starts = LINE_STARTS) {
  return {
    version: 1,
    lines: starts.map((start, index) => ({ text: `Invented line number ${index + 1}`, start, end: start + (index % 5 === 4 ? 2.2 : 3) }))
  };
}

const ANALYSIS = makeAnalysis();
const TIMING = makeTiming();
const SUNG_ZONES = TIMING.lines;

function sungShare(start, end) {
  let sung = 0;
  for (const line of SUNG_ZONES) sung += Math.max(0, Math.min(end, line.end) - Math.max(start, line.start));
  return sung / (end - start);
}

// The invariants of every grid.
function checkGrid(result, duration, { clip = 5, stretch = 1.25 } = {}) {
  const scenes = result.scenes;
  assert.ok(scenes.length >= 1 && scenes.length <= 50, `${scenes.length} scenes`);
  assert.equal(scenes[0].start, 0, 'the first scene starts with the song');
  assert.equal(scenes[scenes.length - 1].end, duration, 'the last scene ends with the song');
  scenes.forEach((scene, index) => {
    assert.equal(scene.index, index);
    assert.ok(scene.end > scene.start);
    assert.equal(scene.duration, Math.round((scene.end - scene.start) * 1000) / 1000);
    if (index > 0) assert.equal(scene.start, scenes[index - 1].end, `scene ${index} follows scene ${index - 1} exactly`);
    assert.ok(scene.duration >= 1.5 - 1e-9 || scenes.length === 1, `scene ${index} lasts ${scene.duration} s`);
    assert.ok(['story', 'performance'].includes(scene.kind));
    assert.equal(typeof scene.section, 'string');
    if (scene.kind === 'story') assert.ok(scene.duration <= clip * stretch + 0.01 || result.warnings.includes('SCENES_LONGER_THAN_CLIP'), `story scene ${index} lasts ${scene.duration} s`);
  });
}

/* ---------- the cut grid ---------- */

function testGridModes() {
  for (const cutOn of ['lines', 'beats', 'sections']) {
    const result = plan.planScenes(ANALYSIS, TIMING, { shotsPerMinute: 14, performanceShare: 0.3, cutOn, clipSeconds: 5 });
    assert.equal(result.cutOn, cutOn);
    checkGrid(result, 120);
    // about 14 scenes a minute: 28 for two minutes, a few more or less with the boundaries that must stay
    assert.ok(result.scenes.length >= 22 && result.scenes.length <= 34, `${cutOn}: ${result.scenes.length} scenes`);
    // the scenes for the singer: windows of the sung lines of at least 5 s, mostly sung
    const singers = result.scenes.filter((scene) => scene.kind === 'performance');
    assert.ok(singers.length >= 5 && singers.length <= 9, `${cutOn}: ${singers.length} scenes for the singer`);
    for (const scene of singers) {
      assert.ok(scene.duration >= 5 - 1e-9 && scene.duration <= 10 + 1e-9, `singer scene of ${scene.duration} s`);
      assert.ok(sungShare(scene.start, scene.end) >= 0.7 - 1e-9, `singer scene ${scene.start}-${scene.end} is sung only ${Math.round(sungShare(scene.start, scene.end) * 100)} %`);
      assert.ok(scene.line && scene.line.startsWith('Invented line'), 'it knows its lyric lines');
      // it begins within a moment of a line start and ends exactly at a line end
      assert.ok(SUNG_ZONES.some((line) => Math.abs(line.start - scene.start) <= 0.11), `begins at a line: ${scene.start}`);
      assert.ok(SUNG_ZONES.some((line) => Math.abs(line.end - scene.end) <= 0.002), `ends at a line: ${scene.end}`);
    }
    // no two of them touch: a story scene lies between
    result.scenes.forEach((scene, index) => {
      if (index > 0 && scene.kind === 'performance') assert.equal(result.scenes[index - 1].kind, 'story');
    });
    // the section boundaries are cuts (a window may take one, then the window edge is within a scene of it)
    for (const boundary of [15, 45, 80, 105]) {
      const near = result.scenes.some((scene) => Math.abs(scene.start - boundary) <= 1.6 || Math.abs(scene.end - boundary) <= 1.6);
      assert.ok(near, `${cutOn}: a cut near the section boundary at ${boundary} s`);
    }
    assert.equal(result.scenes.find((scene) => scene.start === 0).section, 'Intro');
    assert.equal(result.scenes[result.scenes.length - 1].section, 'Outro');
  }
}

function testCutsOnBeats() {
  const result = plan.planScenes(ANALYSIS, TIMING, { cutOn: 'beats', performanceShare: 0 });
  checkGrid(result, 120);
  assert.equal(result.scenes.filter((scene) => scene.kind === 'performance').length, 0);
  const beats = ANALYSIS.beats;
  const sections = [15, 45, 80, 105];
  let onBeat = 0;
  let inner = 0;
  for (const scene of result.scenes.slice(1)) {
    if (sections.some((boundary) => Math.abs(boundary - scene.start) < 0.002)) continue;
    inner += 1;
    if (beats.some((beat) => Math.abs(beat - scene.start) <= 0.002)) onBeat += 1;
  }
  assert.ok(inner >= 15);
  assert.ok(onBeat / inner >= 0.8, `${onBeat} of ${inner} inner cuts are on a beat`);
  // cut on sections: no snapping to beats, the scenes of a part are of equal length
  const bySections = plan.planScenes(ANALYSIS, null, { cutOn: 'sections', performanceShare: 0 });
  checkGrid(bySections, 120);
  const verse = bySections.scenes.filter((scene) => scene.section === 'Verse 1');
  assert.ok(verse.length >= 5);
  const lengths = verse.map((scene) => scene.duration);
  assert.ok(Math.max(...lengths) - Math.min(...lengths) < 0.05, `equal parts: ${lengths}`);
  // cut on lines: the scenes begin at the lines
  const byLines = plan.planScenes(ANALYSIS, TIMING, { cutOn: 'lines', performanceShare: 0 });
  checkGrid(byLines, 120);
  const starts = TIMING.lines.map((line) => line.start);
  const atLines = byLines.scenes.filter((scene) => starts.some((start) => Math.abs(start - scene.start) <= 0.002));
  assert.ok(atLines.length >= 14, `${atLines.length} scenes begin at a lyric line`);
  const atLinesBeats = plan.planScenes(ANALYSIS, TIMING, { cutOn: 'beats', performanceShare: 0 }).scenes.filter((scene) => starts.some((start) => Math.abs(start - scene.start) <= 0.002));
  assert.ok(atLines.length > atLinesBeats.length);
}

function testDensity() {
  const count = (shotsPerMinute, clipSeconds = 5) => plan.planScenes(ANALYSIS, null, { shotsPerMinute, performanceShare: 0, cutOn: 'beats', clipSeconds }).scenes.length;
  assert.ok(count(20) > count(14) && count(14) > count(12), `${count(12)} < ${count(14)} < ${count(20)}`);
  // more scenes than the engine takes are never made: 30 a minute for ten minutes would be 300
  const long = plan.planScenes(makeAnalysis({ duration: 600, sections: [{ name: 'All', start: 0, end: 600, energy: 0.5 }] }), null, { shotsPerMinute: 30, clipSeconds: 5, performanceShare: 0 });
  assert.equal(long.scenes.length, 50);
  assert.ok(long.warnings.includes('SCENES_LONGER_THAN_CLIP'));
  checkGrid(long, 600);
  assert.ok(Math.max(...long.scenes.map((scene) => scene.duration)) <= 12.5);
  // fewer than a clip's length is never asked for: 6 a minute with clips of 5 s still means a scene about every 5 s
  const slow = plan.planScenes(ANALYSIS, null, { shotsPerMinute: 6, clipSeconds: 5, performanceShare: 0, cutOn: 'beats' });
  checkGrid(slow, 120);
  assert.ok(slow.scenes.length >= 24);
  // a longer clip allows longer scenes
  const longer = plan.planScenes(ANALYSIS, null, { shotsPerMinute: 6, clipSeconds: 10, performanceShare: 0, cutOn: 'beats' });
  checkGrid(longer, 120, { clip: 10 });
  assert.ok(longer.scenes.length < slow.scenes.length);
  // a very short song is one scene or a few, never an empty plan
  const short = plan.planScenes(makeAnalysis({ duration: 3, sections: [{ name: 'Song', start: 0, end: 3, energy: 0.5 }] }), null, {});
  assert.ok(short.scenes.length >= 1 && short.scenes.length <= 2);
  assert.equal(short.scenes[short.scenes.length - 1].end, 3);
  // no beats, no sections, no energy: the grid still stands
  const bare = plan.planScenes({ duration: 60 }, null, {});
  checkGrid(bare, 60);
  assert.equal(bare.scenes[0].section, 'Song');
}

function testPerformanceShare() {
  const kinds = (options, timing = TIMING) => plan.planScenes(ANALYSIS, timing, { cutOn: 'lines', ...options }).scenes.filter((scene) => scene.kind === 'performance').length;
  assert.equal(kinds({ performanceShare: 0 }), 0, 'share 0: no scene for the singer, nothing breaks');
  const few = kinds({ performanceShare: 0.1 });
  const some = kinds({ performanceShare: 0.3 });
  assert.ok(few >= 1 && few < some, `${few} < ${some}`);
  // the share counts the scenes: 0.3 of about 28
  assert.ok(some >= 6 && some <= 9, `${some}`);
  // more than the song has lines for are not made up
  assert.ok(kinds({ performanceShare: 1 }) >= some && kinds({ performanceShare: 1 }) <= 11);
  // the loudest parts and the choruses come first: with a small share the singer is in the chorus
  const one = plan.planScenes(ANALYSIS, TIMING, { cutOn: 'lines', performanceShare: 0.04 });
  const first = one.scenes.filter((scene) => scene.kind === 'performance');
  assert.equal(first.length, 1);
  assert.equal(first[0].section, 'Chorus');
  // spread over the song, not all in one part
  const spread = plan.planScenes(ANALYSIS, TIMING, { cutOn: 'lines', performanceShare: 0.3 }).scenes.filter((scene) => scene.kind === 'performance');
  assert.ok(new Set(spread.map((scene) => scene.section)).size >= 3, 'in at least three parts');
  // without lyric times: warned, no scene for the singer, and "lines" becomes "beats"
  const none = plan.planScenes(ANALYSIS, null, { cutOn: 'lines', performanceShare: 0.5 });
  assert.ok(none.warnings.includes('NO_TIMING') && none.warnings.includes('NO_LYRICS_FOR_PERFORMANCE'));
  assert.equal(none.cutOn, 'beats');
  assert.equal(none.scenes.filter((scene) => scene.kind === 'performance').length, 0);
  checkGrid(none, 120);
  // timing with no line (an instrumental song): the same
  for (const empty of [{ lines: [] }, '{"lines":[]}', 'not json', {}]) {
    const result = plan.planScenes(ANALYSIS, empty, { cutOn: 'lines', performanceShare: 0.5 });
    assert.equal(result.scenes.filter((scene) => scene.kind === 'performance').length, 0, JSON.stringify(empty));
    assert.ok(result.warnings.includes('NO_LYRICS_FOR_PERFORMANCE') || result.warnings.includes('NO_TIMING'));
  }
  // lines that are too short for the lip sync (shorter than 5 s together, far apart) give no window
  const sparse = makeTiming([10, 40, 70, 100]);
  sparse.lines.forEach((line) => {
    line.end = line.start + 2;
  });
  const sparseResult = plan.planScenes(ANALYSIS, sparse, { cutOn: 'beats', performanceShare: 0.5 });
  assert.equal(sparseResult.scenes.filter((scene) => scene.kind === 'performance').length, 0);
  assert.ok(sparseResult.warnings.includes('NO_LYRICS_FOR_PERFORMANCE'));
  // a single long line is a window of its own; lines at the very start or end of the song leave no sliver
  const edges = plan.planScenes(ANALYSIS, makeTiming([0.2, 6.5, 110.8]).lines && { lines: [{ text: 'a', start: 0.2, end: 6 }, { text: 'b', start: 112.8, end: 119.9 }] }, { cutOn: 'lines', performanceShare: 0.5 });
  checkGrid(edges, 120);
  const ends = edges.scenes.filter((scene) => scene.kind === 'performance');
  assert.equal(ends.length, 2);
  assert.equal(ends[0].start, 0);
  assert.equal(ends[1].end, 120);
  // overlapping or reversed lines are put in order
  const messy = plan.planScenes(ANALYSIS, { lines: [{ text: 'b', start: 30, end: 36 }, { text: 'a', start: 20, end: 26 }, { text: 'bad', start: 'x', end: 3 }, { text: 'c', start: 35, end: 41 }] }, { cutOn: 'lines', performanceShare: 0.5 });
  checkGrid(messy, 120);
}

// The lines of real songs are two bars long: 4 to 5 s at 100 to 120 BPM, with a short pause between them. A line alone is too short for the
// lip sync (5 s), two with their pause are about 8.5 s: the windows have to take both.
function testWindowsOfRealLines() {
  const linesFrom = (first, length, gap, until) => {
    const lines = [];
    for (let start = first; start + length <= until; start += length + gap) lines.push({ text: `Invented line number ${lines.length + 1}`, start: Math.round(start * 1000) / 1000, end: Math.round((start + length) * 1000) / 1000 });
    return { version: 1, lines };
  };
  const windowsOf = (timing) => {
    const result = plan.planScenes(ANALYSIS, timing, { shotsPerMinute: 14, performanceShare: 0.5, cutOn: 'lines', clipSeconds: 5 });
    checkGrid(result, 120);
    const singers = result.scenes.filter((scene) => scene.kind === 'performance');
    for (const scene of singers) {
      assert.ok(scene.duration >= 5.05 - 1e-6 && scene.duration <= 10 + 1e-9, `a window of ${scene.duration} s`);
      let sung = 0;
      for (const line of timing.lines) {
        const inside = line.start >= scene.start - 0.002 && line.end <= scene.end + 0.002;
        const outside = line.end <= scene.start + 0.002 || line.start >= scene.end - 0.002;
        assert.ok(inside || outside, `a line is cut by the window ${scene.start}-${scene.end}: ${line.start}-${line.end}`);
        if (inside) sung += line.end - line.start;
        // a window that reached into a pause keeps its distance from the line next to it
        if (outside && line.end <= scene.start + 0.002) assert.ok(scene.start - line.end >= 0.1 - 0.002 || scene.start === 0, `margin before ${scene.start}`);
        if (outside && line.start >= scene.end - 0.002) assert.ok(line.start - scene.end >= 0.1 - 0.002 || scene.end === 120, `margin after ${scene.end}`);
      }
      assert.ok(sung / scene.duration >= 0.7 - 1e-9, `window ${scene.start}-${scene.end} is sung ${Math.round((sung / scene.duration) * 100)} %`);
    }
    return singers;
  };
  // 100 BPM: lines of 4.8 s with 0.8 s pause: one line and a little of its pause
  const slow = windowsOf(linesFrom(10, 4.8, 0.8, 110));
  assert.ok(slow.length >= 3, `${slow.length} windows for 4.8 s lines`);
  assert.ok(slow.every((scene) => scene.duration < 5.2), 'a line and the pause behind it, no second line');
  // 120 BPM: lines of 4 s with 0.3 s pause: one line cannot reach 5 s, two of them are about 8.5 s
  const pairs = windowsOf(linesFrom(10, 4, 0.3, 110));
  assert.ok(pairs.length >= 3, `${pairs.length} windows for 4 s lines`);
  assert.ok(pairs.filter((scene) => scene.duration > 8 && scene.duration <= 10).length >= 3, 'two lines each');
  assert.ok(pairs.every((scene) => scene.duration <= 10), 'none longer than 10 s');
  // lines of 4.2 s with 0.6 s pause: one line takes the pause before and behind it
  const reaching = windowsOf(linesFrom(10, 4.2, 0.6, 110));
  assert.ok(reaching.length >= 3, `${reaching.length} windows for 4.2 s lines`);
  assert.ok(reaching.every((scene) => scene.duration < 5.2));
  // a short line with a long pause is not mostly sung, however much room it has: no window
  const sparse = plan.planScenes(ANALYSIS, linesFrom(10, 3, 4, 110), { cutOn: 'lines', performanceShare: 0.5 });
  assert.equal(sparse.scenes.filter((scene) => scene.kind === 'performance').length, 0);
  assert.ok(sparse.warnings.includes('NO_LYRICS_FOR_PERFORMANCE'));
  // a line at the very end of the song reaches into the pause before it (and the last moments of the song)
  const last = plan.planScenes(ANALYSIS, { lines: [{ text: 'a', start: 115.5, end: 119.9 }] }, { cutOn: 'lines', performanceShare: 0.5 });
  checkGrid(last, 120);
  const end = last.scenes.filter((scene) => scene.kind === 'performance');
  assert.equal(end.length, 1);
  assert.equal(end[0].end, 120);
  assert.ok(end[0].duration >= 5.05 - 1e-6);
}

function testErrors() {
  for (const bad of [null, undefined, '', 'not json', '{}', { duration: 0 }, { duration: 'x' }]) {
    assert.throws(() => plan.planScenes(bad, null, {}), (err) => err.code === 'MUSICVIDEO_ANALYSIS_INVALID', JSON.stringify(bad));
  }
  // the analysis as text, as the node passes it on
  const fromText = plan.planScenes(JSON.stringify(ANALYSIS), JSON.stringify(TIMING), { cutOn: 'lines' });
  checkGrid(fromText, 120);
  // options out of range are held to it
  const wild = plan.planScenes(ANALYSIS, TIMING, { shotsPerMinute: 1000, performanceShare: 7, cutOn: 'nonsense', clipSeconds: 0 });
  checkGrid(wild, 120);
  assert.ok(wild.scenes.length >= 30 && wild.scenes.length <= 50, `the limit of the engine: ${wild.scenes.length}`);
  assert.equal(wild.cutOn, 'lines');
}

/* ---------- what the model is told and what it says ---------- */

function testPrompts() {
  const result = plan.planScenes(ANALYSIS, TIMING, { cutOn: 'lines', performanceShare: 0.3 });
  const system = plan.systemPrompt();
  assert.match(system, /JSON/);
  assert.match(system, /performance/);
  assert.match(system, /lip-synced/);
  const user = plan.userPrompt({ brief: 'A lonely lighthouse keeper.', style: 'grainy 16mm film', characters: 'Mara: grey coat, red scarf', aspectRatio: '9:16', plan: result });
  assert.match(user, /A lonely lighthouse keeper/);
  assert.match(user, /grainy 16mm film/);
  assert.match(user, /Mara: grey coat/);
  assert.match(user, /9:16/);
  assert.match(user, /Chorus \(45-80 s\)/);
  assert.match(user, /82 BPM/);
  const rows = plan.sceneRows(result);
  assert.equal(rows.length, result.scenes.length);
  assert.ok(rows.every((row, index) => row.index === index && ['story', 'performance'].includes(row.kind) && ['low', 'medium', 'high'].includes(row.energy)));
  assert.ok(rows.some((row) => row.lyrics), 'the lyrics are there for the scenes that have them');
  assert.ok(rows.find((row) => row.section === 'Chorus').energy === 'high');
  assert.ok(rows.find((row) => row.section === 'Intro').energy === 'low');
  for (const row of rows) assert.ok(user.includes(JSON.stringify(row)));
  // optional parts stay out
  const bare = plan.userPrompt({ brief: 'b', aspectRatio: '16:9', plan: result });
  assert.doesNotMatch(bare, /Style:|Characters:|previous answer/);
  // the second attempt names the problems
  const second = plan.userPrompt({ brief: 'b', aspectRatio: '16:9', plan: result, problems: ['Scene 3 is missing.', 'The list has 4 entries but there are 5 scenes.'] });
  assert.match(second, /previous answer/);
  assert.match(second, /- Scene 3 is missing\./);
}

function answerFor(scenes, change = (entry) => entry) {
  return JSON.stringify({
    scenes: scenes.map((scene) =>
      change({
        index: scene.index,
        image_prompt: `A ${scene.kind} image for scene ${scene.index}  with   extra   blanks`,
        motion: scene.kind === 'story' ? `Slow push-in ${scene.index}` : '',
        character: scene.index % 2 ? 'Mara' : ''
      })
    )
  });
}

function testReadContent() {
  const { scenes } = plan.planScenes(ANALYSIS, TIMING, { cutOn: 'lines', performanceShare: 0.3 });
  // a good answer, also in a code fence and with words around it
  for (const wrap of [(text) => text, (text) => `\`\`\`json\n${text}\n\`\`\``, (text) => `Here is the plan:\n${text}\nHope it helps.`]) {
    const good = plan.readContent(wrap(answerFor(scenes)), scenes);
    assert.deepEqual(good.problems, []);
    assert.equal(good.items.length, scenes.length);
    good.items.forEach((item, index) => {
      assert.equal(item.image_prompt, `A ${scenes[index].kind} image for scene ${index} with extra blanks`, 'blanks are collapsed');
      assert.equal(item.motion, scenes[index].kind === 'story' ? `Slow push-in ${index}` : '');
      assert.equal(item.character, index % 2 ? 'Mara' : '');
    });
  }
  // a list at the top
  assert.deepEqual(plan.readContent(JSON.stringify(JSON.parse(answerFor(scenes)).scenes), scenes).problems, []);
  // entries without an index are taken in order
  const noIndex = plan.readContent(answerFor(scenes, (entry) => ({ ...entry, index: undefined })), scenes);
  assert.deepEqual(noIndex.problems, []);
  assert.equal(noIndex.items[3].image_prompt.includes('scene 3'), true);
  // one entry too few: the problem says which scene
  const short = JSON.parse(answerFor(scenes));
  short.scenes.splice(4, 1);
  const missing = plan.readContent(JSON.stringify(short), scenes);
  assert.ok(missing.problems.some((problem) => problem.includes(`${short.scenes.length} entries but there are ${scenes.length} scenes`)));
  assert.ok(missing.problems.some((problem) => problem.includes('Scene 4 is missing')));
  assert.equal(missing.items[4], null);
  assert.ok(missing.items[3] && missing.items[5], 'the others are kept');
  // an entry without a prompt, a story scene without motion, a twin, an index that does not exist
  const flawed = JSON.parse(answerFor(scenes));
  flawed.scenes[1].image_prompt = '  ';
  const storyIndex = scenes.findIndex((scene, index) => scene.kind === 'story' && index > 2);
  flawed.scenes[storyIndex].motion = '';
  flawed.scenes[6] = { ...flawed.scenes[5] };
  flawed.scenes.push({ index: 999, image_prompt: 'x', motion: 'y' });
  const result = plan.readContent(JSON.stringify(flawed), scenes);
  assert.ok(result.problems.some((problem) => problem.includes('Scene 1 has no image_prompt')));
  assert.ok(result.problems.some((problem) => problem.includes(`Scene ${storyIndex} (story) has no motion`)));
  assert.ok(result.problems.some((problem) => problem.includes('appears twice')));
  assert.ok(result.problems.some((problem) => problem.includes('index 999')));
  assert.equal(result.items[1], null);
  // not JSON, or JSON of another shape
  for (const text of ['I cannot do that.', '', '{"scenes": "no"}', '[1, 2]', '{"other": []}']) {
    const bad = plan.readContent(text, scenes);
    assert.ok(bad.problems.length >= 1, JSON.stringify(text));
    assert.ok(bad.items.every((item) => item === null), JSON.stringify(text));
  }
  // very long prompts are cut
  const huge = plan.readContent(answerFor(scenes, (entry) => ({ ...entry, image_prompt: 'word '.repeat(1000) })), scenes);
  assert.ok(huge.items[0].image_prompt.length <= 1500);
  // another spelling of the key
  const camel = plan.readContent(JSON.stringify({ scenes: scenes.map((scene) => ({ index: scene.index, imagePrompt: 'p', motion: 'm' })) }), scenes);
  assert.deepEqual(camel.problems, []);
}

function testFallback() {
  const { scenes } = plan.planScenes(ANALYSIS, TIMING, { cutOn: 'lines', performanceShare: 0.3 });
  const options = { brief: 'A lonely lighthouse keeper', style: 'grainy 16mm film', characters: 'Mara: grey coat' };
  const seen = new Set();
  for (const scene of scenes) {
    const item = plan.fallbackContent(scene, options);
    assert.ok(item.image_prompt.length > 20 && item.image_prompt.length <= 1500);
    assert.match(item.image_prompt, /lighthouse keeper/);
    assert.match(item.image_prompt, /grainy 16mm film/);
    if (scene.kind === 'performance') {
      assert.match(item.image_prompt, /portrait of the singer/);
      assert.equal(item.motion, '');
    } else {
      assert.ok(item.motion.length > 10, 'a story scene has a motion');
      assert.match(item.image_prompt, new RegExp(scene.section));
    }
    seen.add(item.image_prompt);
  }
  assert.ok(seen.size > scenes.length / 2, 'the scenes do not all get the same prompt');
  // nothing given: still a prompt
  const bare = plan.fallbackContent(scenes[0], {});
  assert.ok(bare.image_prompt.length > 10);
}

/* ---------- the shots ---------- */

function testShots() {
  const result = plan.planScenes(ANALYSIS, TIMING, { cutOn: 'lines', performanceShare: 0.3 });
  const contents = result.scenes.map((scene) => plan.fallbackContent(scene, { brief: 'x' }));
  const shots = plan.buildShots(result, contents, { aspectRatio: '9:16', brief: 'x' });
  assert.equal(shots.version, 1);
  assert.equal(shots.aspect_ratio, '9:16');
  assert.equal(shots.duration, 120);
  assert.equal(shots.bpm, BPM);
  assert.equal(shots.shots.length, result.scenes.length);
  const story = shots.shots.filter((shot) => shot.kind === 'story');
  const performance = shots.shots.filter((shot) => shot.kind === 'performance');
  assert.equal(shots.story, story.length);
  assert.equal(shots.performance, performance.length);
  // the clip number counts in each kind, in the order of the scenes
  assert.deepEqual(story.map((shot) => shot.clip), story.map((_unused, index) => index));
  assert.deepEqual(performance.map((shot) => shot.clip), performance.map((_unused, index) => index));
  shots.shots.forEach((shot, index) => {
    assert.equal(shot.index, index);
    assert.equal(shot.prompt, contents[index].image_prompt);
    assert.equal(shot.motion, contents[index].motion);
  });
  // plain data that reads back
  const back = plan.parseShots(JSON.stringify(shots));
  assert.equal(back.shots.length, shots.shots.length);
  assert.equal(back.story, story.length);
  assert.equal(back.performance, performance.length);
  assert.equal(back.aspect_ratio, '9:16');
  // an unknown ratio becomes 16:9
  assert.equal(plan.buildShots(result, contents, { aspectRatio: '4:3' }).aspect_ratio, '16:9');
  // what is not usable is refused with a code
  const bad = (change) => {
    const copy = JSON.parse(JSON.stringify(shots));
    change(copy);
    return JSON.stringify(copy);
  };
  const refuse = (text, message) => assert.throws(() => plan.parseShots(text), (err) => err.code === 'MUSICVIDEO_SHOTS_INVALID' && (!message || message.test(err.message)), message ? String(message) : '');
  refuse('not json');
  refuse('{}');
  refuse('{"shots": []}');
  refuse(null);
  refuse(bad((copy) => { copy.shots[2].start += 1; }), /does not start where/);
  refuse(bad((copy) => { copy.shots[2].kind = 'other'; }), /neither story nor performance/);
  refuse(bad((copy) => { copy.shots[2].clip = -1; }), /valid clip number/);
  refuse(bad((copy) => { copy.shots[3].clip = copy.shots[2].clip; copy.shots[3].kind = copy.shots[2].kind; }), /valid clip number/);
  refuse(bad((copy) => { copy.shots[1].end = copy.shots[1].start; }), /usable times/);
  refuse(bad((copy) => { copy.shots[0].clip = 7; copy.shots[0].kind = 'story'; copy.shots.forEach((shot, index) => { if (index && shot.kind === 'story') shot.clip = index + 100; }); }), /not numbered 0 to/);
  refuse(bad((copy) => { copy.shots = Array.from({ length: 51 }, (_unused, index) => ({ start: index, end: index + 1, kind: 'story', clip: index })); }), /At most 50/);
  // the object itself is accepted too
  assert.equal(plan.parseShots(shots).shots.length, shots.shots.length);
  // all scenes for the singer, or none: the counts are right
  const all = plan.buildShots({ ...result, scenes: result.scenes.map((scene) => ({ ...scene, kind: 'story' })) }, contents, {});
  assert.equal(all.performance, 0);
  assert.equal(all.story, result.scenes.length);
}

// WP44: the bars and the hits of an analysis, with the fallback for an analysis that was made before they came
function testBeatGrid() {
  const beats = ANALYSIS.beats;
  // an analysis of the old kind: the bars are every fourth beat from the first one, no hits, and it says so
  const old = plan.parseBeatGrid(ANALYSIS);
  assert.deepEqual(old.downbeats, beats.filter((_time, index) => index % 4 === 0));
  assert.deepEqual(old.hits, []);
  assert.equal(old.measured, false);
  assert.deepEqual(plan.parseBeatGrid(JSON.stringify(ANALYSIS)), old, 'text or object');
  // with the fields: as they are, in order, inside the song, the strength between 0 and 1
  const given = {
    ...ANALYSIS,
    downbeats: [beats[8], beats[0], beats[4], -1, 500, 'x', null],
    hits: [{ t: 12.5, strength: 0.4 }, { t: 3.2, strength: 1.7 }, { t: 7, strength: -1 }, { t: 7.5 }, { t: 200, strength: 1 }, { t: -1, strength: 1 }, { strength: 1 }, null, 'x', { t: 'x' }]
  };
  const read = plan.parseBeatGrid(given);
  assert.deepEqual(read.downbeats, [beats[0], beats[4], beats[8]]);
  assert.deepEqual(read.hits, [{ t: 3.2, strength: 1 }, { t: 7, strength: 0 }, { t: 7.5, strength: 0.5 }, { t: 12.5, strength: 0.4 }]);
  assert.equal(read.measured, true);
  assert.deepEqual(plan.parseBeatGrid(JSON.stringify(given)), read);
  // no usable bar given: the fallback, but the hits that are there stay
  const empty = plan.parseBeatGrid({ ...ANALYSIS, downbeats: [], hits: [{ t: 5, strength: 0.9 }] });
  assert.deepEqual(empty.downbeats, old.downbeats);
  assert.deepEqual(empty.hits, [{ t: 5, strength: 0.9 }]);
  assert.equal(empty.measured, false);
  // not an array: the same as not there
  assert.deepEqual(plan.parseBeatGrid({ ...ANALYSIS, downbeats: 'a', hits: { t: 1 } }), old);
  // an analysis without beats has no bars; one that cannot be read is null (as with parseAnalysis)
  assert.deepEqual(plan.parseBeatGrid(makeAnalysis({ beats: false })), { downbeats: [], hits: [], measured: false });
  for (const nothing of [null, undefined, '', '{', '[]', 'null', 42, { duration: 0 }, { duration: 'x' }]) assert.equal(plan.parseBeatGrid(nothing), null, String(nothing));
  // the plan reads the analysis as it did: the new fields are not part of what parseAnalysis returns
  assert.deepEqual(Object.keys(plan.parseAnalysis(given)), ['duration', 'bpm', 'beats', 'sections', 'energy']);
}

// WP44: the kind "still" (the plan of the HUD music video): its clips come on a list of their own, numbered 0, 1, 2 ... like those of the other kinds.
// music_video.plan makes none, and what it writes is as it was (no count of stills in its text, which the cutting node reads as 0).
function testStillShots() {
  assert.deepEqual(plan.SHOT_KINDS, ['story', 'performance', 'still']);
  const result = plan.planScenes(ANALYSIS, TIMING, { cutOn: 'lines', performanceShare: 0.3 });
  const contents = result.scenes.map((scene) => plan.fallbackContent(scene, { brief: 'x' }));
  const made = plan.buildShots(result, contents, { aspectRatio: '16:9', brief: 'x' });
  assert.equal('still' in made, false, 'music_video.plan writes no count of stills');
  assert.ok(made.shots.every((shot) => shot.kind !== 'still'));
  assert.equal(plan.parseShots(made).still, 0, 'a plan without stills has none');

  // the first and the third scene of the story become stills; the clips of each kind are numbered again, in the order of the scenes
  const stories = made.shots.filter((shot) => shot.kind === 'story');
  assert.ok(stories.length >= 4);
  const changed = JSON.parse(JSON.stringify(made));
  const kindsAt = new Map([[stories[0].index, 'still'], [stories[2].index, 'still']]);
  let story = 0;
  let performance = 0;
  let still = 0;
  for (const shot of changed.shots) {
    if (kindsAt.has(shot.index)) shot.kind = kindsAt.get(shot.index);
    shot.clip = shot.kind === 'performance' ? performance++ : shot.kind === 'still' ? still++ : story++;
  }
  const back = plan.parseShots(JSON.stringify(changed));
  assert.deepEqual([back.story, back.performance, back.still], [stories.length - 2, made.performance, 2]);
  assert.deepEqual(back.shots.filter((shot) => shot.kind === 'still').map((shot) => shot.clip), [0, 1]);
  assert.equal(back.shots.length, made.shots.length);
  // the numbers are checked for every kind
  const refuse = (change, message) => {
    const copy = JSON.parse(JSON.stringify(changed));
    change(copy);
    assert.throws(() => plan.parseShots(copy), (err) => err.code === 'MUSICVIDEO_SHOTS_INVALID' && message.test(err.message), String(message));
  };
  const stillAt = (copy, nth) => copy.shots.filter((shot) => shot.kind === 'still')[nth];
  refuse((copy) => { stillAt(copy, 1).clip = 0; }, /valid clip number/);
  refuse((copy) => { stillAt(copy, 0).clip = 5; }, /The still clips are not numbered 0 to 1 \(clip 0 is missing\)/);
  refuse((copy) => { stillAt(copy, 0).kind = 'poster'; }, /neither story nor performance nor still/);
  // a kind that is none of them is refused as before (the old text is part of the new one)
  refuse((copy) => { copy.shots[1].kind = 'other'; }, /neither story nor performance/);
  // only stills: the lists of the others are empty
  const onlyStills = { aspect_ratio: '16:9', shots: [{ start: 0, end: 2, kind: 'still', clip: 0 }, { start: 2, end: 4, kind: 'still', clip: 1 }] };
  assert.deepEqual([plan.parseShots(onlyStills).story, plan.parseShots(onlyStills).performance, plan.parseShots(onlyStills).still], [0, 0, 2]);
}

testGridModes();
testCutsOnBeats();
testDensity();
testPerformanceShare();
testWindowsOfRealLines();
testErrors();
testPrompts();
testReadContent();
testFallback();
testShots();
testBeatGrid();
testStillShots();
console.log('test-music-video-plan.js: ok');
