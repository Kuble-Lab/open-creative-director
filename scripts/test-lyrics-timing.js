'use strict';

// The word times of a song (lib/lyrics-timing.js, WP34): the clean-up of what ElevenLabs returns. The fixtures are invented
// (a made-up song) but have the quirks of the real answers of the alignment and of Scribe:
//   - separate entries for every blank and line break
//   - the first word of the alignment reaches from the start of the audio to its real end
//   - held notes at the end of a line (and of the song) last very long
//   - Scribe: its own case and punctuation, a word recognised wrongly, one missing, one extra, a whole line missing
// Nothing here calls ElevenLabs.

const assert = require('assert/strict');

const lyricsTiming = require('../lib/lyrics-timing');

const near = (actual, expected, tolerance = 0.002, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} !== ${expected}`.trim());

const PLAN = [
  '[Intro | 14 s]',
  '+ 90 BPM, soft piano, warm tape hiss',
  '(ahhh)',
  '(hm-mm)',
  '',
  '[Verse | 20 s]',
  '+ low male voice, brushed drums',
  '- shouting',
  'Paper boats on a silver stream',
  'Chasing lanterns through a dream',
  "Every ripple knows my name, don't",
  'Nothing here will stay the same',
  '',
  '[Chorus | 20 s]',
  '+ wide harmonies, strings swell',
  'Sail on, sail on, into the light',
  'Hold the morning, hold it tight',
  '\\+1 for the road',
  '',
  '[Outro | 10 s]',
  '(hm-mm)',
  'So far',
  'So bright'
].join('\n');

const SUNG = [
  'Paper boats on a silver stream',
  'Chasing lanterns through a dream',
  "Every ripple knows my name, don't",
  'Nothing here will stay the same',
  'Sail on, sail on, into the light',
  'Hold the morning, hold it tight',
  '+1 for the road',
  'So far',
  'So bright'
];

// Where each line really begins (seconds); the song itself is 60 s long.
const LINE_STARTS = [14.2, 17.4, 20.6, 24.0, 34.0, 37.5, 40.9, 47.0, 50.5];
const DURATION = 60;
const WORD_SEC = 0.38;
const WORD_GAP = 0.07;

// What was really sung: the words of every line with their times.
function sung(lines = SUNG, starts = LINE_STARTS) {
  return lines.map((text, index) => {
    let at = starts[index];
    const words = text.split(' ').map((word) => {
      const item = { text: word, start: at, end: at + WORD_SEC };
      at += WORD_SEC + WORD_GAP;
      return item;
    });
    return { text, start: words[0].start, end: words[words.length - 1].end, words };
  });
}

// The answer of the forced alignment: the words of the text with an entry for every blank and line break in between. The
// first word starts at 0.58 s (the quirk), the characters tell where it really starts.
function alignmentAnswer(truth, { firstWordWrong = true, withCharacters = true, lastWordEnd = null, heldWordEnd = null } = {}) {
  const words = [];
  const characters = [];
  truth.forEach((line, lineIndex) => {
    line.words.forEach((word, wordIndex) => {
      const entry = { text: word.text, start: word.start, end: word.end, loss: 1.1 };
      if (lineIndex === 0 && wordIndex === 0 && firstWordWrong) entry.start = 0.58;
      if (lineIndex === 3 && wordIndex === line.words.length - 1 && heldWordEnd) entry.end = heldWordEnd;
      if (lineIndex === truth.length - 1 && wordIndex === line.words.length - 1 && lastWordEnd) entry.end = lastWordEnd;
      words.push(entry);
      // the characters of the text, spread over the word (the first one at 0.58 s where the quirk is on)
      [...word.text].forEach((char, charIndex, all) => {
        const at = entry.start === 0.58 && charIndex === 0 ? 0.58 : word.start + (charIndex * WORD_SEC) / all.length;
        characters.push({ text: char, start: at, end: at === 0.58 ? 0.58 : at + WORD_SEC / all.length });
      });
      const last = wordIndex === line.words.length - 1;
      const nextStart = last ? (truth[lineIndex + 1] ? truth[lineIndex + 1].start : entry.end + 0.2) : line.words[wordIndex + 1].start;
      if (!(last && lineIndex === truth.length - 1)) {
        words.push({ text: last ? '\n' : ' ', start: entry.end, end: Math.max(entry.end, last ? entry.end + 0.2 : nextStart), loss: 1 });
      }
    });
  });
  return { words, characters: withCharacters ? characters : [], loss: 1.18 };
}

// Scribe: its own case and punctuation, "spacing" entries between the words, and (options) a word it got wrong, one it
// missed, an extra one, a whole line it missed.
function transcriptAnswer(truth, { wrong = [], missing = [], extra = [], missingLines = [] } = {}) {
  const words = [];
  truth.forEach((line, lineIndex) => {
    if (missingLines.includes(lineIndex)) return;
    line.words.forEach((word, wordIndex) => {
      const key = `${lineIndex}:${wordIndex}`;
      if (missing.includes(key)) return;
      let text = word.text.toLowerCase().replace(/[,]$/, '');
      if (wordIndex === 0) text = text[0].toUpperCase() + text.slice(1);
      if (wordIndex === line.words.length - 1 && lineIndex % 2 === 1) text += '.';
      if (wrong.includes(key)) text = 'banana';
      if (words.length) words.push({ text: ' ', start: words[words.length - 1].end, end: word.start, type: 'spacing' });
      words.push({ text, start: word.start, end: word.end, type: 'word' });
      if (extra.includes(key)) {
        words.push({ text: ' ', start: word.end, end: word.end + 0.02, type: 'spacing' });
        words.push({ text: 'uh', start: word.end + 0.02, end: word.end + 0.2, type: 'word' });
      }
    });
  });
  return { words, text: words.map((word) => word.text).join(''), language: 'eng' };
}

/* ---------- the text that is sung ---------- */

function testSungLines() {
  assert.equal(lyricsTiming.looksLikePlan(PLAN), true);
  assert.equal(lyricsTiming.looksLikePlan('[Chorus]\nla la'), false, 'a marker without a length is no plan');
  assert.equal(lyricsTiming.looksLikePlan('just words\nmore words'), false);
  // a plan: no section lines, no style lines, no (ahhh), an escaped plus stays a song line (without the backslash)
  assert.deepEqual(lyricsTiming.sungLines(PLAN), SUNG);
  // a pasted text: markers and notes in parentheses go, blank lines go, everything else stays (also a leading dash)
  assert.deepEqual(lyricsTiming.sungLines('[Verse 1]\n\n  Walk  on   by \n(oh oh)\n- a line with a dash\r\n[Chorus]\nStay'), ['Walk on by', '- a line with a dash', 'Stay']);
  assert.deepEqual(lyricsTiming.sungLines(''), []);
  assert.deepEqual(lyricsTiming.sungLines(null), []);
  assert.deepEqual(lyricsTiming.sungLines('(ahhh)\n(hm-mm)'), [], 'a text of only notes has nothing to align');
  // a plan with a mistake (no length) still gives its lines
  assert.deepEqual(lyricsTiming.sungLines('[Verse | 20 s]\nOne line\n[Chorus | ]\nTwo lines'), ['One line', 'Two lines']);
  // comparing words
  assert.equal(lyricsTiming.normalise('Zürich,'), 'zurich');
  assert.equal(lyricsTiming.normalise("Don't!"), 'dont');
  assert.equal(lyricsTiming.normalise('Straße'), 'strasse');
  assert.equal(lyricsTiming.normalise('...'), '');
}

/* ---------- the alignment ---------- */

function testAlignment() {
  const truth = sung();
  const answer = alignmentAnswer(truth);
  const timing = lyricsTiming.fromAlignment(answer, lyricsTiming.sungLines(PLAN), { duration: DURATION });
  assert.equal(timing.version, 1);
  assert.equal(timing.source, 'align');
  assert.equal(timing.duration, DURATION);
  assert.equal(timing.loss, 1.18);
  // no entry for a blank or a line break is left, one word per word of the text
  const expectedWords = SUNG.join(' ').split(' ');
  assert.deepEqual(timing.words.map((word) => word.text), expectedWords);
  assert.ok(timing.words.every((word) => word.text.trim() === word.text && word.text !== ''));
  // the lines are the lines of the text, in order, with the times of their words
  assert.deepEqual(timing.lines.map((line) => line.text), SUNG);
  timing.lines.forEach((line, index) => {
    // line 0 begins with the first word, which is found by its second character (one fifth of the word after the real start)
    near(line.start, truth[index].start, index === 0 ? WORD_SEC / 5 + 0.002 : 0.002, `line ${index} start`);
    near(line.end, truth[index].end, 0.002, `line ${index} end`);
    assert.ok(line.end > line.start);
    if (index > 0) assert.ok(line.start >= timing.lines[index - 1].end, `line ${index} follows the one before`);
  });
  // every word knows its line; the times never go backwards and never overlap
  assert.equal(timing.words[0].line, 0);
  assert.equal(timing.words[timing.words.length - 1].line, SUNG.length - 1);
  timing.words.forEach((word, index) => {
    assert.ok(word.end >= word.start);
    if (index > 0) assert.ok(word.start >= timing.words[index - 1].end - 1e-9, `word ${index} starts after the word before`);
  });
  assert.equal(timing.words.filter((word) => word.line === 0).length, 6);

  // the first word starts in the intro: with the characters of the answer its real start is found
  const wrongFirst = alignmentAnswer(truth, { firstWordWrong: true });
  assert.equal(wrongFirst.words[0].start, 0.58, 'the fixture has the quirk');
  near(timing.words[0].start, LINE_STARTS[0] + WORD_SEC / 5, 0.002, 'first word, from the characters: the first one that is not alone in the intro');
  assert.ok(timing.words[0].end - timing.words[0].start < 1);
  // ... and without them the time a word of that length takes counts back from its end
  const noChars = lyricsTiming.fromAlignment(alignmentAlone(truth), SUNG, { duration: DURATION });
  assert.ok(Math.abs(noChars.words[0].start - LINE_STARTS[0]) < 0.8, `first word without characters: ${noChars.words[0].start}`);
  assert.ok(noChars.words[0].start > 13, 'it no longer starts in the intro');
  // a first word that is held really long (contiguous characters) is left alone
  const heldStart = sung(SUNG, LINE_STARTS);
  heldStart[0].words[0].end = heldStart[0].words[0].start + 6;
  heldStart[0].words.slice(1).forEach((word, index) => {
    word.start = heldStart[0].words[0].end + 0.07 + index * (WORD_SEC + WORD_GAP);
    word.end = word.start + WORD_SEC;
  });
  const heldAnswer = alignmentAnswer(heldStart, { firstWordWrong: false });
  // the characters of a held word are spread over its 6 s, none of them is alone
  const heldChars = [...'Paper'].map((char, charIndex) => ({ text: char, start: LINE_STARTS[0] + charIndex * 1.2, end: LINE_STARTS[0] + charIndex * 1.2 + 1.2 }));
  heldAnswer.characters.splice(0, 5, ...heldChars);
  const held = lyricsTiming.fromAlignment(heldAnswer, SUNG, { duration: DURATION });
  near(held.words[0].start, LINE_STARTS[0], 0.002, 'a held first word keeps its start');
  near(held.words[0].end - held.words[0].start, 6, 0.002, 'and its length');
  // an alignment whose first word is right stays as it is
  const right = lyricsTiming.fromAlignment(alignmentAnswer(truth, { firstWordWrong: false }), SUNG, { duration: DURATION });
  near(right.words[0].start, LINE_STARTS[0], 0.002);
}

// the same answer without characters
function alignmentAlone(truth) {
  const answer = alignmentAnswer(truth);
  return { words: answer.words, loss: answer.loss };
}

function testHeldNotes() {
  const truth = sung();
  // the last word of the 4th line is held for 6.9 s, the very last word reaches to the end of the file (60 s)
  const answer = alignmentAnswer(truth, { firstWordWrong: false, heldWordEnd: truth[3].words[truth[3].words.length - 1].start + 6.9, lastWordEnd: 60.4 });
  const timing = lyricsTiming.fromAlignment(answer, SUNG, { duration: DURATION });
  const lastOfFour = truth[3].words[truth[3].words.length - 1];
  // the line is over MAX_LINE_HOLD_SEC after its last word began ...
  assert.equal(lyricsTiming.MAX_LINE_HOLD_SEC, 2);
  near(timing.lines[3].end, lastOfFour.start + 2, 0.002, 'held note: the line ends 2 s after the last word began');
  // ... the words keep what the aligner measured
  const wordOfFour = timing.words.find((word) => word.line === 3 && word.text === 'same');
  near(wordOfFour.end - wordOfFour.start, 6.9, 0.002, 'the word itself is not shortened');
  // nothing reaches beyond the audio: 60.4 s becomes 60 s
  assert.equal(timing.words[timing.words.length - 1].end, DURATION);
  assert.ok(timing.lines[timing.lines.length - 1].end <= DURATION);
  const lastLine = timing.lines[timing.lines.length - 1];
  near(lastLine.end, truth[8].words[1].start + 2, 0.002, 'the last line ends 2 s after its last word began, not at the end of the file');
  // a word that is not held is not touched: the line ends with its word
  near(timing.lines[0].end, truth[0].end, 0.002);
  // without a known length the last word's own end is the end
  const unknown = lyricsTiming.fromAlignment(answer, SUNG, {});
  near(unknown.duration, 60.4, 0.002);
}

function testAlignmentOddities() {
  const truth = sung();
  // the answer has fewer words than the text (the aligner dropped a word): the lines are found by the words that agree
  const answer = alignmentAnswer(truth, { firstWordWrong: false });
  const dropped = answer.words.filter((entry) => entry.text !== 'stream');
  const timing = lyricsTiming.fromAlignment({ words: dropped }, SUNG, { duration: DURATION });
  assert.deepEqual(timing.lines.map((line) => line.text), SUNG, 'every line is kept');
  near(timing.lines[0].start, truth[0].start, 0.002);
  assert.equal(timing.matched, timing.expected - 1, 'one word of the text found no partner');
  // timing entries without usable times are dropped, times that go backwards are held to the word before
  const dirty = lyricsTiming.cleanWords([
    { text: 'one', start: 1, end: 1.4 },
    { text: 'two', start: 'x', end: 2 },
    { text: 'three', start: 0.5, end: 0.9 },
    { text: 'four', start: 2, end: 1.5 },
    null,
    { text: '  ', start: 3, end: 4 },
    { text: '\n', start: 4, end: 4.1 },
    { text: '(music)', start: 5, end: 6, type: 'audio_event' },
    { text: 'five', start: 6, end: 7, type: 'word' }
  ]);
  assert.deepEqual(dirty.map((word) => word.text), ['one', 'three', 'four', 'five']);
  assert.deepEqual(dirty.map((word) => [word.start, word.end]), [[1, 1], [1, 1], [2, 2], [6, 7]]);
  // nothing came back
  assert.deepEqual(lyricsTiming.fromAlignment({ words: [] }, SUNG, { duration: 30 }).lines, []);
  assert.deepEqual(lyricsTiming.fromAlignment(null, SUNG, {}).words, []);
  // an empty text with words: the lines come from the pauses
  const paused = lyricsTiming.fromAlignment(alignmentAnswer(truth, { firstWordWrong: false }), [], { duration: DURATION });
  assert.ok(paused.lines.length >= 2);
}

/* ---------- Scribe ---------- */

function testTranscriptWithText() {
  const truth = sung();
  const answer = transcriptAnswer(truth);
  const timing = lyricsTiming.fromTranscript(answer, SUNG, { duration: DURATION });
  assert.equal(timing.source, 'transcribe');
  assert.deepEqual(timing.lines.map((line) => line.text), SUNG, 'the lines are the lines of the text, in its spelling');
  timing.lines.forEach((line, index) => {
    near(line.start, truth[index].start, 0.002, `line ${index} start`);
    near(line.end, truth[index].end, 0.002, `line ${index} end`);
  });
  assert.equal(timing.words.some((word) => word.text === ''), false);
  assert.equal(timing.matched, timing.expected, 'every word agrees');
  // the spacing entries are gone
  assert.equal(timing.words.length, SUNG.join(' ').split(' ').length);

  // a word recognised wrongly, one missing, one extra: the lines still stand
  const flawed = transcriptAnswer(truth, { wrong: ['1:2'], missing: ['2:3', '0:0'], extra: ['4:2', '8:1'] });
  const tolerant = lyricsTiming.fromTranscript(flawed, SUNG, { duration: DURATION });
  assert.deepEqual(tolerant.lines.map((line) => line.text), SUNG);
  tolerant.lines.forEach((line, index) => {
    near(line.start, truth[index].start, WORD_SEC + WORD_GAP + 0.01, `line ${index} start with mistakes`);
    assert.ok(Math.abs(line.end - truth[index].end) < 1.2, `line ${index} end with mistakes: ${line.end} vs ${truth[index].end}`);
    if (index > 0) assert.ok(line.start >= tolerant.lines[index - 1].end - 1e-9);
  });
  // the missing first word of line 0 is made up by the words around it: the line starts with the second word at the latest
  assert.ok(tolerant.lines[0].start <= truth[0].words[1].start + 0.002);
  assert.ok(tolerant.matched < tolerant.expected);
  assert.ok(tolerant.matched >= tolerant.expected - 4);
  // the words are the words of the text: the extra "uh" is not among them, the wrong "banana" is not either; a word that was not
  // heard is there with a time made up from its neighbours
  assert.deepEqual(tolerant.words.map((word) => word.text), SUNG.join(' ').split(' '));
  const madeUp = tolerant.words.filter((word) => word.estimated);
  assert.deepEqual(madeUp.map((word) => word.text), ['Paper', 'through', 'my'], 'the missing and the wrongly heard words');

  // a whole line not recognised: it gets a stretch between its neighbours and says so
  const lost = lyricsTiming.fromTranscript(transcriptAnswer(truth, { missingLines: [2] }), SUNG, { duration: DURATION });
  assert.deepEqual(lost.lines.map((line) => line.text), SUNG);
  assert.equal(lost.lines[2].estimated, true);
  assert.ok(lost.lines[2].start >= lost.lines[1].end - 1e-9 && lost.lines[2].end <= lost.lines[3].start + 1e-9, 'between the neighbours');
  assert.equal(lost.lines.filter((line) => line.estimated).length, 1);
  const ofLost = lost.words.filter((word) => word.line === 2);
  assert.equal(ofLost.length, 6, 'its words are there, with a time made up between the neighbours');
  assert.ok(ofLost.every((word) => word.estimated === true));
  assert.ok(ofLost.every((word) => word.start >= lost.lines[1].end - 1e-9 && word.end <= lost.lines[3].start + 1e-9));

  // nothing agrees at all (another song): no line can be placed
  const stranger = lyricsTiming.fromTranscript(transcriptAnswer(sung(['alpha beta gamma', 'delta epsilon zeta'], [5, 9])), SUNG, { duration: DURATION });
  assert.deepEqual(stranger.lines, []);
  assert.equal(stranger.matched, 0);
}

function testTranscriptWithoutText() {
  // two verses with a clear pause between the lines (1.4 s), one line with a short pause inside
  const starts = [10, 15, 20, 31];
  const lines = ['Morning comes with golden light', 'Over the hills and far away', 'Hold me close and hold me tight', 'Never let the evening fall'];
  const truth = sung(lines, starts);
  const answer = transcriptAnswer(truth);
  const timing = lyricsTiming.fromTranscript(answer, null, { duration: DURATION });
  assert.equal(timing.source, 'transcribe');
  assert.equal(timing.lines.length, 4, 'the pauses between the lines end them');
  assert.deepEqual(timing.lines.map((line) => line.text), ['Morning comes with golden light', 'Over the hills and far away.', 'Hold me close and hold me tight', 'Never let the evening fall.'], 'in the spelling of Scribe');
  timing.lines.forEach((line, index) => near(line.start, starts[index], 0.002, `line ${index} start`));
  assert.equal(timing.words[0].line, 0);
  assert.equal(timing.words[timing.words.length - 1].line, 3);
  // words with no pause at all are cut into lines of at most 14 words
  const run = [];
  for (let index = 0; index < 30; index += 1) run.push({ text: `w${index}`, start: index * 0.4, end: index * 0.4 + 0.35, type: 'word' });
  const long = lyricsTiming.fromTranscript({ words: run }, null, { duration: 20 });
  assert.ok(long.lines.length >= 3);
  assert.ok(long.lines.every((line) => line.text.split(' ').length <= 14));
  // a pause of 0.5 s after six words also ends a line
  const six = [];
  for (let index = 0; index < 12; index += 1) six.push({ text: `v${index}`, start: index * 0.4 + (index >= 6 ? 0.5 : 0), end: index * 0.4 + 0.3 + (index >= 6 ? 0.5 : 0), type: 'word' });
  assert.equal(lyricsTiming.fromTranscript({ words: six }, null, {}).lines.length, 2);
  // an instrumental song: no words, no lines, no error
  const none = lyricsTiming.fromTranscript({ words: [] }, null, { duration: 90 });
  assert.deepEqual([none.words, none.lines, none.duration], [[], [], 90]);
  // a first word that Scribe got wrong in the same way is also corrected
  const odd = lyricsTiming.fromTranscript({ words: [{ text: 'Hey', start: 0.5, end: 12.2, type: 'word' }, { text: 'you', start: 12.3, end: 12.8, type: 'word' }] }, null, {});
  assert.ok(odd.words[0].start > 11, `first word: ${odd.words[0].start}`);
}

/* ---------- reading and showing ---------- */

function testReadable() {
  assert.equal(lyricsTiming.formatTime(15.84), '0:15.8');
  assert.equal(lyricsTiming.formatTime(76.12), '1:16.1');
  assert.equal(lyricsTiming.formatTime(59.96), '1:00.0');
  assert.equal(lyricsTiming.formatTime(0), '0:00.0');
  assert.equal(lyricsTiming.formatTime(-3), '0:00.0');
  assert.equal(lyricsTiming.formatTime(600), '10:00.0');
  const timing = lyricsTiming.fromAlignment(alignmentAnswer(sung()), SUNG, { duration: DURATION });
  const readable = lyricsTiming.readableLyrics(timing);
  const rows = readable.split('\n');
  assert.equal(rows.length, SUNG.length);
  assert.match(rows[0], /^0:14\.[23]–0:16\.\d Paper boats on a silver stream$/);
  assert.match(rows[4], /^0:34\.0–0:\d\d\.\d Sail on, sail on, into the light$/);
  assert.equal(lyricsTiming.readableLyrics({ lines: [] }), '');
  assert.equal(lyricsTiming.readableLyrics(null), '');
  // what a node passes on as text can be read again
  const back = lyricsTiming.parseTiming(JSON.stringify(timing));
  assert.deepEqual(back.lines, timing.lines);
  assert.deepEqual(back.words.length, timing.words.length);
  assert.equal(back.source, 'align');
  assert.equal(lyricsTiming.parseTiming('not json'), null);
  assert.equal(lyricsTiming.parseTiming('{"words": []}'), null);
  assert.equal(lyricsTiming.parseTiming(''), null);
  assert.equal(lyricsTiming.parseTiming('null'), null);
  // broken entries are dropped, the rest is sorted by time
  const messy = lyricsTiming.parseTiming(JSON.stringify({ lines: [{ text: 'b', start: 5, end: 6 }, { text: 'a', start: 1, end: 2 }, { text: 'x', start: 'no', end: 3 }, { text: 'y', start: 4, end: 3 }] }));
  assert.deepEqual(messy.lines.map((line) => line.text), ['a', 'b']);
}

/* ---------- plain data ---------- */

function testNoMutation() {
  const truth = sung();
  const answer = alignmentAnswer(truth);
  const before = JSON.stringify(answer);
  lyricsTiming.fromAlignment(answer, SUNG, { duration: DURATION });
  assert.equal(JSON.stringify(answer), before, 'the answer of ElevenLabs is not changed');
  const timing = lyricsTiming.fromAlignment(answer, SUNG, { duration: DURATION });
  assert.deepEqual(JSON.parse(JSON.stringify(timing)), timing, 'plain data, safe as JSON');
  // all numbers are rounded to milliseconds
  for (const word of timing.words) {
    assert.equal(Math.round(word.start * 1000) / 1000, word.start);
    assert.equal(Math.round(word.end * 1000) / 1000, word.end);
  }
}

testSungLines();
testAlignment();
testHeldNotes();
testAlignmentOddities();
testTranscriptWithText();
testTranscriptWithoutText();
testReadable();
testNoMutation();
console.log('test-lyrics-timing.js: ok');
