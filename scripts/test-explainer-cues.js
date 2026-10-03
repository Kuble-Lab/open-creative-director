'use strict';

// The timing of a scene of an explainer video (WP37b, lib/explainer-cues.js). Pure: no network, no files.
//   - the length of a scene: voice + 0.4 s, rounded up to a whole frame, and the frame arithmetic itself
//   - word times from the character times of ElevenLabs (punctuation stays on the word, no-break spaces, gaps, order)
//   - the lines of the subtitles and the timing JSON in the format of audio.lyrics_timing (words name their lines)
//   - the cues of the elements: found, found as a similar word, found by its first strong word, not found (spread evenly),
//     without an anchor, the minimum time, the order, an anchor that is said earlier, a scene without words, the latest time

const assert = require('assert/strict');
const cues = require('../lib/explainer-cues');

const near = (actual, expected, tolerance = 0.0005, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} !== ${expected}`.trim());

// the alignment of a text as ElevenLabs gives it: every character with a start and an end (0.06 s per character, no pauses)
function alignmentOf(text, { step = 0.06, offset = 0 } = {}) {
  const characters = [...text];
  return {
    characters,
    starts: characters.map((_c, index) => offset + index * step),
    ends: characters.map((_c, index) => offset + (index + 1) * step)
  };
}

// words with a time each: one second per word, from 0.5 s
const wordsAt = (list, { first = 0.5, step = 1 } = {}) => list.map((text, index) => ({ text, start: first + index * step, end: first + index * step + step * 0.8 }));

function testFrames() {
  assert.equal(cues.FPS, 30);
  assert.equal(cues.frameExact(4.4), 4.4, 'a whole number of frames stays (132.00000000000003 is not 133)');
  near(cues.frameExact(5.84), 176 / 30, 1e-9);
  assert.equal(cues.frameExact(0), 0);
  assert.equal(cues.frameExact(-1), 0);
  assert.equal(cues.frameExact('x'), 0);
  assert.equal(cues.sceneDuration(5.44), 5.867, 'voice 5.44 + 0.4 = 5.84 -> 176 frames');
  assert.equal(cues.sceneDuration(3.6), 4);
  assert.equal(cues.sceneDuration(4), 4.4);
  assert.equal(cues.sceneDuration(0), 0.4, 'no voice: the pause alone');
  for (const voice of [1.234, 7.77, 11.1, 3.3333, 9.99]) {
    const seconds = cues.sceneDuration(voice);
    near(seconds * 30, Math.round(seconds * 30), 0.02, `${voice}: a whole number of frames`);
    assert.ok(seconds >= voice + 0.4 - 0.001 && seconds < voice + 0.4 + 1 / 30 + 1e-9, `${voice}: voice + 0.4 s, up to one frame more`);
  }
}

function testWordsFromAlignment() {
  const text = 'Der Lindensee ist gesunken.';
  const words = cues.wordsFromAlignment(alignmentOf(text));
  assert.deepEqual(words.map((word) => word.text), ['Der', 'Lindensee', 'ist', 'gesunken.'], 'punctuation stays on its word');
  near(words[0].start, 0);
  near(words[0].end, 0.18);
  near(words[1].start, 4 * 0.06, 0.0005, 'the start of the first character of the word');
  near(words[1].end, 13 * 0.06);
  near(words[3].end, text.length * 0.06);
  // no-break space, line break and tab separate words too
  const odd = cues.wordsFromAlignment(alignmentOf('a b\nc\td'));
  assert.deepEqual(odd.map((word) => word.text), ['a', 'b', 'c', 'd']);
  // a pause inside the speech: the end of a word is the end of its last character, the start of the next one its own
  const gap = cues.wordsFromAlignment({ characters: [...'ab cd'], starts: [0, 0.1, 0.2, 1.0, 1.1], ends: [0.1, 0.2, 0.3, 1.1, 1.2] });
  near(gap[0].end, 0.2);
  near(gap[1].start, 1.0);
  // a character without a time takes that of its neighbour; times never run backwards
  const holes = cues.wordsFromAlignment({ characters: [...'ab cd'], starts: [0, null, 0.2, 0.1, 0.4], ends: [0.1, null, 0.3, 0.2, 0.5] });
  assert.equal(holes.length, 2);
  assert.ok(holes[1].start >= holes[0].start, 'no backwards step');
  assert.deepEqual(cues.wordsFromAlignment(null), []);
  assert.deepEqual(cues.wordsFromAlignment({}), []);
  assert.deepEqual(cues.wordsFromAlignment({ characters: [], starts: [], ends: [] }), []);
  assert.deepEqual(cues.wordsFromAlignment(alignmentOf('   ')), []);
  // umlauts and digits are single characters: nothing is split
  assert.deepEqual(cues.wordsFromAlignment(alignmentOf('Wärme 55 cm')).map((word) => word.text), ['Wärme', '55', 'cm']);
}

function testTimingJson() {
  const text = 'Das ist der erste Satz. Und hier kommt der zweite Satz, der etwas länger ist als der erste.';
  const words = cues.wordsFromAlignment(alignmentOf(text));
  const timing = cues.timingOf(words, 6.5);
  assert.equal(timing.version, 1);
  assert.equal(timing.source, 'speech');
  assert.equal(timing.duration, 6.5);
  assert.equal(timing.words.length, words.length);
  assert.ok(timing.lines.length >= 2, 'a full stop ends a line');
  assert.equal(timing.lines[0].text, 'Das ist der erste Satz.');
  // every word names its line and the lines cover the words in order
  let line = 0;
  for (const word of timing.words) {
    assert.ok(Number.isInteger(word.line), 'a word names its line');
    assert.ok(word.line === line || word.line === line + 1, 'lines follow in order');
    line = word.line;
  }
  assert.equal(timing.lines.map((entry) => entry.text).join(' '), words.map((word) => word.text).join(' '));
  for (const entry of timing.lines) assert.ok(entry.end >= entry.start);
  // the line breaking: nine words or 56 characters at most
  for (const entry of timing.lines) {
    assert.ok(entry.text.split(' ').length <= cues.LINE_WORDS, entry.text);
  }
  const long = cues.timingOf(cues.wordsFromAlignment(alignmentOf(Array.from({ length: 30 }, (_x, i) => `wort${i}`).join(' '))), 10);
  assert.ok(long.lines.length >= 3);
  for (const entry of long.lines) assert.ok(entry.text.length <= cues.LINE_CHARS + 10 && entry.text.split(' ').length <= cues.LINE_WORDS, entry.text);
  // a comma in the second half is the better place to break
  const comma = cues.timingOf(wordsAt('eins zwei drei vier fünf sechs, sieben acht neun zehn elf zwölf'.split(' ')), 14);
  assert.equal(comma.lines[0].text.endsWith('sechs,'), true, comma.lines[0].text);
  // no duration given: the end of the last word
  assert.equal(cues.timingOf(wordsAt(['a', 'b']), 0).duration, 2.3);
  // silence: no words
  assert.deepEqual(cues.silentTiming(4), { version: 1, source: 'silence', duration: 4, words: [], lines: [] });
  assert.equal(cues.silentTiming().duration, 4);
  // parse: back from JSON text
  const parsed = cues.parseTiming(JSON.stringify(timing));
  assert.equal(parsed.words.length, words.length);
  assert.equal(parsed.duration, 6.5);
  assert.deepEqual(cues.parseTiming(JSON.stringify(cues.silentTiming(4))), { words: [], duration: 4 });
  assert.equal(cues.parseTiming('not json'), null);
  assert.equal(cues.parseTiming('{"a":1}'), null);
  assert.equal(cues.parseTiming('null'), null);
  assert.equal(cues.parseTiming(JSON.stringify({ words: [{ text: 'a', start: 'x', end: 1 }, { text: 'b', start: 0, end: 1 }] })).words.length, 1, 'a word without a time is dropped');
}

function testAnchors() {
  const spoken = cues.spokenTokens('Der Pegel lag 2026 bei 412,30 Metern über dem Meer.');
  assert.deepEqual(spoken, ['der', 'pegel', 'lag', '2026', 'bei', '41230', 'metern', 'über', 'dem', 'meer']);
  assert.deepEqual(cues.spokenTokens('Grundlagen-Kurs'), ['grundlagenkurs']);
  assert.deepEqual(cues.findAnchor('Pegel', spoken, 0), { index: 1, how: 'exact' });
  assert.deepEqual(cues.findAnchor('412,30 Metern', spoken, 0), { index: 5, how: 'exact' }, 'a phrase, a number with a comma is one word');
  assert.deepEqual(cues.findAnchor('pegel lag', spoken, 0), { index: 1, how: 'exact' });
  assert.deepEqual(cues.findAnchor('Metern', spoken, 0), { index: 6, how: 'exact' });
  assert.equal(cues.findAnchor('Pegel', spoken, 2).index, -1, 'searched from the position on');
  assert.deepEqual(cues.findAnchor('Meter', spoken, 0), { index: 6, how: 'similar' }, 'Meter ~ Metern');
  assert.deepEqual(cues.findAnchor('Wärmepumpen', ['die', 'wärmepumpe', 'läuft'], 0), { index: 1, how: 'similar' });
  assert.equal(cues.findAnchor('Pegelstand sinkt', spoken, 0).how, 'first word', 'neither word for word nor similar: the first strong word of the phrase counts');
  assert.equal(cues.findAnchor('', spoken, 0).index, -1);
  assert.equal(cues.findAnchor('Zebra', spoken, 0).index, -1);
  assert.equal(cues.similar('million', 'millionen'), true);
  assert.equal(cues.similar('an', 'ant'), false, 'too short for a similar word');
  assert.equal(cues.similar('wärmepumpe', 'wärmepumpen'), true);
  assert.equal(cues.similar('strom', 'storm'), false);
}

function testCues() {
  const voice = 'Seit 2020 ist der Lindensee deutlich gesunken, vor allem im Sommer, und die Prognose bleibt düster.';
  const words = cues.wordsFromAlignment(alignmentOf(voice, { offset: 0.3 }));
  const timing = { words, duration: words[words.length - 1].end };
  const start = (word) => words.find((entry) => entry.text.replace(/[.,]/g, '') === word).start;
  const duration = cues.sceneDuration(timing.duration);

  // found: the start of the anchor word minus 0.15 s
  const found = cues.cuesFor(
    [
      { id: 'e1', type: 'title', content: 'Lindensee', anchor: 'Lindensee' },
      { id: 'e2', type: 'bullet', content: 'Sommer', anchor: 'Sommer' },
      { id: 'e3', type: 'bullet', content: 'Prognose', anchor: 'Prognose' }
    ],
    timing,
    duration
  );
  assert.equal(found.cues.length, 3);
  assert.deepEqual(found.cues.map((cue) => cue.id), ['e1', 'e2', 'e3'], 'one cue per element, in the order of the elements');
  assert.deepEqual(found.cues.map((cue) => cue.found), [true, true, true]);
  near(found.cues[0].at, start('Lindensee') - 0.15, 0.002);
  near(found.cues[1].at, start('Sommer') - 0.15, 0.002);
  near(found.cues[2].at, start('Prognose') - 0.15, 0.002);
  assert.deepEqual(found.notes, []);
  assert.equal(found.cues[1].anchor, 'Sommer');
  assert.equal(found.cues[1].type, 'bullet');

  // the minimum: the first word of the voice is said at 0.3 s, 0.15 s earlier would be 0.15 s: not below 0.2 s
  const first = cues.cuesFor([{ id: 'e1', type: 'title', content: 'Seit', anchor: 'Seit' }], timing, duration);
  assert.equal(first.cues[0].at, 0.2, 'never earlier than 0.2 s');
  const atZero = cues.cuesFor([{ id: 'e1', type: 'title', content: 'x', anchor: 'a' }], { words: [{ text: 'a', start: 0, end: 0.2 }], duration: 1 }, 1.4);
  assert.equal(atZero.cues[0].at, 0.2);

  // found as a similar word: Lindenseen ~ Lindensee, with a note
  const similar = cues.cuesFor([{ id: 'e1', type: 'title', content: 'x', anchor: 'Lindenseen' }], timing, duration);
  assert.equal(similar.cues[0].found, true);
  near(similar.cues[0].at, start('Lindensee') - 0.15, 0.002);
  assert.match(similar.notes[0], /e1.*similar/);

  // found by its first strong word: the phrase "Lindensee schrumpft" is not there word for word, but its first word is
  const strong = cues.cuesFor([{ id: 'e1', type: 'title', content: 'x', anchor: 'Lindensee schrumpft' }], timing, duration);
  assert.equal(strong.cues[0].found, true, 'the first strong word of the phrase counts');
  near(strong.cues[0].at, start('Lindensee') - 0.15, 0.002);

  // not found: spread evenly between the neighbours
  const spread = cues.cuesFor(
    [
      { id: 'e1', type: 'title', content: 'x', anchor: 'Seit' },
      { id: 'e2', type: 'bullet', content: 'x', anchor: 'Zebra' },
      { id: 'e3', type: 'bullet', content: 'x', anchor: '' },
      { id: 'e4', type: 'bullet', content: 'x', anchor: 'Prognose' }
    ],
    timing,
    duration
  );
  assert.deepEqual(spread.cues.map((cue) => cue.found), [true, false, false, true]);
  const low = spread.cues[0].at;
  const high = spread.cues[3].at;
  near(spread.cues[1].at, low + (high - low) / 3, 0.002, 'a third of the way');
  near(spread.cues[2].at, low + ((high - low) * 2) / 3, 0.002, 'two thirds of the way');
  assert.equal(spread.notes.length, 2);
  assert.match(spread.notes[0], /e2: the anchor "Zebra" is not in the narration/);
  assert.match(spread.notes[1], /e3: no anchor/);

  // nothing found at all: spread over the scene, in order, inside it
  const none = cues.cuesFor(
    [1, 2, 3].map((n) => ({ id: `e${n}`, type: 'bullet', content: 'x', anchor: 'Zebra' })),
    timing,
    duration
  );
  assert.ok(none.cues.every((cue) => cue.found === false));
  assert.equal(none.cues[0].at, 0.2);
  for (let index = 1; index < 3; index += 1) assert.ok(none.cues[index].at > none.cues[index - 1].at);
  assert.ok(none.cues[2].at < duration - 0.29);

  // the order: an anchor that is said before the element before it comes together with that one
  const order = cues.cuesFor(
    [
      { id: 'e1', type: 'bullet', content: 'x', anchor: 'Prognose' },
      { id: 'e2', type: 'bullet', content: 'x', anchor: 'Lindensee' }
    ],
    timing,
    duration
  );
  assert.equal(order.cues[1].at, order.cues[0].at, 'the second does not come before the first');
  assert.match(order.notes[0], /e2.*said before/);
  // never a backwards step, whatever the anchors are
  const mixed = cues.cuesFor(
    ['Sommer', 'Seit', 'Prognose', 'Lindensee', 'düster'].map((anchor, index) => ({ id: `e${index + 1}`, type: 'bullet', content: 'x', anchor })),
    timing,
    duration
  );
  for (let index = 1; index < mixed.cues.length; index += 1) assert.ok(mixed.cues[index].at >= mixed.cues[index - 1].at, `step ${index}`);

  // the same anchor twice: the second one is found after the first
  const twice = cues.cuesFor(
    [
      { id: 'e1', type: 'bullet', content: 'x', anchor: 'der' },
      { id: 'e2', type: 'bullet', content: 'x', anchor: 'die' }
    ],
    { words: wordsAt(['der', 'Hund', 'und', 'die', 'Katze']), duration: 6 },
    6.4
  );
  assert.ok(twice.cues[1].at > twice.cues[0].at);

  // the latest time: a word at the very end is not later than 0.3 s before the end of the scene
  const late = cues.cuesFor([{ id: 'e1', type: 'bullet', content: 'x', anchor: 'Ende' }], { words: wordsAt(['Alles', 'zum', 'Ende'], { first: 0.5, step: 1.5 }), duration: 5 }, 5.4);
  assert.ok(late.cues[0].at <= 5.4 - 0.3 + 1e-9);

  // a scene without words (the sources card): staggered from 0.3 s
  const silent = cues.cuesFor(
    [1, 2, 3].map((n) => ({ id: `e${n}`, type: 'bullet', content: 'x', anchor: '' })),
    { words: [], duration: 4 },
    4.4
  );
  assert.deepEqual(silent.cues.map((cue) => cue.at), [0.3, 0.65, 1], 'one after the other, 0.35 s apart');
  assert.ok(silent.cues.every((cue) => cue.found === false));
  assert.deepEqual(cues.cuesFor([1, 2].map((n) => ({ id: `e${n}`, type: 'bullet', anchor: '' })), null, 4.4).cues.map((cue) => cue.at), [0.3, 0.65], 'no timing at all counts as silence');
  assert.deepEqual(cues.cuesFor([], timing, duration), { cues: [], notes: [] });
  assert.deepEqual(cues.cuesFor(null, timing, duration), { cues: [], notes: [] });
}

testFrames();
testWordsFromAlignment();
testTimingJson();
testAnchors();
testCues();
console.log('test-explainer-cues.js: ok');
