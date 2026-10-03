'use strict';

// Tests for the caption script (lib/captions-ass.js) and the check for the ffmpeg filter `ass` (lib/ffmpeg.js hasFilter). The script is
// read back with a small reader that follows the rules of libass (scripts/support/ass-reader.js: override blocks, \N, \{ \}), so what the
// text field means is checked independently of the code that wrote it. The lyrics here are invented. Burning in for real needs an ffmpeg with libass: that part runs
// only when the filter exists and says so when it is skipped.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const captions = require('../lib/captions-ass');
const ffmpeg = require('../lib/ffmpeg');
const { parseAss, lex, karaokeWords, OWN_BLOCK } = require('./support/ass-reader');

const execFileAsync = promisify(execFile);

/* ---------- the invented song ---------- */

const SONG = {
  version: 1,
  source: 'align',
  duration: 40,
  words: [
    { text: 'Copper', start: 2.0, end: 2.5, line: 0 },
    { text: 'kites', start: 2.5, end: 3.0, line: 0 },
    { text: 'over', start: 3.2, end: 3.6, line: 0 },
    { text: 'the', start: 3.6, end: 3.8, line: 0 },
    // a held note: the word lasts until 8.0, the line is over 2 s after its last word began
    { text: 'bay', start: 3.8, end: 8.0, line: 0 },
    { text: 'Paper', start: 9.0, end: 9.4, line: 1 },
    { text: 'boats', start: 9.4, end: 9.9, line: 1 },
    { text: 'hum', start: 9.9, end: 10.1, line: 1 },
    { text: 'in', start: 10.1, end: 10.2, line: 1 },
    { text: 'the', start: 10.2, end: 10.4, line: 1 },
    { text: 'rain', start: 10.4, end: 11.2, line: 1 },
    // starts 0.4 s after the line before it ends
    { text: 'Velvet', start: 11.6, end: 12.0, line: 2 },
    { text: 'skies', start: 12.0, end: 12.8, line: 2 }
  ],
  lines: [
    { text: 'Copper kites over the bay', start: 2.0, end: 5.8 },
    { text: 'Paper boats hum in the rain', start: 9.0, end: 10.9 },
    { text: 'Velvet skies', start: 11.6, end: 12.8 }
  ]
};

const dims = { width: 1280, height: 720 };

function build(extra = {}, timing = SONG) {
  return captions.buildAss({ timing: JSON.stringify(timing), ...dims, ...extra });
}

/* ---------- pieces of the format ---------- */

function testFormatPieces() {
  assert.equal(captions.assTime(0), '0:00:00.00');
  assert.equal(captions.assTime(75.4), '0:01:15.40');
  assert.equal(captions.assTime(3600), '1:00:00.00');
  assert.equal(captions.assTime(59.996), '0:01:00.00', 'rounded to hundredths, carried into the minute');
  assert.equal(captions.assTime(-3), '0:00:00.00', 'never negative');
  assert.equal(captions.centis(2.5), 250);
  assert.equal(captions.centis(0.126), 13, 'rounded to hundredths');

  assert.deepEqual(captions.parseColor('#ffd400', '#000000'), { r: 255, g: 212, b: 0, opacity: 255 });
  assert.deepEqual(captions.parseColor('ff8800', '#000000'), { r: 255, g: 136, b: 0, opacity: 255 }, 'the # is optional');
  assert.deepEqual(captions.parseColor('#ff880080', '#000000'), { r: 255, g: 136, b: 0, opacity: 128 });
  assert.deepEqual(captions.parseColor('red', '#102030'), { r: 16, g: 32, b: 48, opacity: 255 }, 'no colour: the fallback');
  assert.equal(captions.assColor({ r: 255, g: 212, b: 0, opacity: 255 }), '&H0000D4FF', 'BGR, alpha 00 is opaque');
  assert.equal(captions.assColor({ r: 1, g: 2, b: 3, opacity: 0 }), '&HFF030201');
  assert.equal(captions.assTagColor({ r: 255, g: 212, b: 0, opacity: 255 }), '&H00D4FF&');

  // the filter value: escaped for the option and again for the graph
  assert.equal(captions.assFilter('/tmp/a/captions.ass'), 'ass=filename=/tmp/a/captions.ass');
  assert.equal(captions.assFilter('/tmp/a b/captions.ass'), 'ass=filename=/tmp/a b/captions.ass', 'blanks need no escape in an argument');
  assert.equal(captions.assFilter('C:\\media\\x.ass'), 'ass=filename=C\\\\:\\\\\\\\media\\\\\\\\x.ass');
  assert.equal(captions.assFilter("/tmp/it's.ass"), "ass=filename=/tmp/it\\\\\\'s.ass");
  assert.equal(captions.assFilter('/tmp/a,b;c=d[e].ass'), 'ass=filename=/tmp/a\\,b\\;c\\=d\\[e\\].ass');
  assert.throws(() => captions.assFilter(''), /script file/);

  assert.equal(captions.FONT_FAMILIES['dejavu-sans'], 'DejaVu Sans');
  assert.equal(captions.DEFAULT_FONT, 'dejavu-sans');
  for (const id of captions.FONTS) assert.ok(captions.FONT_FAMILIES[id], `${id} has a family name`);
  for (const family of ['DejaVu Sans', 'Liberation Sans', 'Noto Sans']) {
    assert.ok(Object.values(captions.FONT_FAMILIES).includes(family), `${family} is in the list`);
  }
}

/* ---------- escaping ---------- */

function testEscaping() {
  const cases = [
    ['plain words', 'plain words'],
    ['{', '{'],
    ['}', '}'],
    ['{\\an8}top', '{∖an8}top'],
    ['a}b{c', 'a}b{c'],
    ['\\N', '∖N'],
    ['\\n', '∖n'],
    ['\\h', '∖h'],
    ['\\{', '∖{'],
    ['back\\slash', 'back∖slash'],
    ['two\nlines', 'two\nlines'],
    ['crlf\r\nbreak', 'crlf\nbreak'],
    ['cr\rbreak', 'cr\nbreak'],
    ['separator\u2028here', 'separator\nhere'],
    ['tab\there', 'tab here'],
    ['bell\u0007gone', 'bellgone'],
    ['', '']
  ];
  for (const [input, expected] of cases) {
    const escaped = captions.escapeText(input);
    const read = lex(escaped);
    assert.equal(read.blocks.length, 0, `no override block comes out of ${JSON.stringify(input)}`);
    assert.equal(read.visible, expected, `${JSON.stringify(input)} reads back as the text it was`);
  }
  assert.equal(captions.escapeText('{x}'), '\\{x\\}', 'braces are written as the literal forms');
  assert.equal(captions.escapeText(null), '');
  assert.equal(captions.escapeText(undefined), '');
}

/* ---------- the header and the style ---------- */

function testHeaderAndStyle() {
  const result = build();
  const ass = parseAss(result.text);
  assert.equal(ass.info.PlayResX, '1280');
  assert.equal(ass.info.PlayResY, '720');
  assert.equal(ass.info.ScriptType, 'v4.00+');
  assert.equal(ass.info.WrapStyle, '0');
  assert.equal(ass.info.ScaledBorderAndShadow, 'yes');
  assert.equal(ass.info['YCbCr Matrix'], 'None', 'the colours are not converted by the player');
  assert.equal(ass.style.Name, 'Default');
  assert.equal(ass.style.Fontname, 'DejaVu Sans');
  assert.equal(ass.style.Fontsize, '43', '6 % of 720');
  assert.equal(ass.style.Bold, '-1');
  assert.equal(ass.style.BorderStyle, '1');
  assert.equal(ass.style.Alignment, '2');
  assert.equal(ass.style.MarginV, '43', '6 % of the height from the bottom edge');
  assert.equal(ass.style.MarginL, '64');
  assert.equal(ass.style.MarginR, '64');
  assert.equal(ass.style.Outline, '3.4', '8 % of the size');
  // karaoke: unsung = secondary (the base colour), sung = primary (the highlight)
  assert.equal(ass.style.PrimaryColour, '&H0000D4FF');
  assert.equal(ass.style.SecondaryColour, '&H00FFFFFF');
  assert.equal(ass.style.OutlineColour, '&H00000000');

  // the other styles keep the base colour as the primary one
  for (const style of ['words', 'lines']) {
    const other = parseAss(build({ style }).text).style;
    assert.equal(other.PrimaryColour, '&H00FFFFFF', style);
    assert.equal(other.SecondaryColour, '&H0000D4FF', style);
  }

  // positions
  const bottom = parseAss(build({ position: 'bottom' }).text).style;
  const top = parseAss(build({ position: 'top' }).text).style;
  const middle = parseAss(build({ position: 'middle' }).text).style;
  assert.deepEqual([bottom.Alignment, top.Alignment, middle.Alignment], ['2', '8', '5']);
  assert.deepEqual([bottom.MarginV, top.MarginV, middle.MarginV], ['43', '43', '0']);
  assert.equal(parseAss(build({ position: 'nowhere' }).text).style.Alignment, '2', 'an unknown position is the bottom');

  // size, colours, outline, font
  const sized = parseAss(build({ sizePercent: 10, width: 1920, height: 1080, color: '#112233', highlightColor: '#aabbcc', outlineColor: '#ff000080', outlinePercent: 15, font: 'liberation-sans' }).text);
  assert.equal(sized.info.PlayResX, '1920');
  assert.equal(sized.info.PlayResY, '1080');
  assert.equal(sized.style.Fontsize, '108', '10 % of 1080');
  assert.equal(sized.style.Fontname, 'Liberation Sans');
  assert.equal(sized.style.PrimaryColour, '&H00CCBBAA');
  assert.equal(sized.style.SecondaryColour, '&H00332211');
  assert.equal(sized.style.OutlineColour, '&H7F0000FF', 'the alpha of the outline colour counts, inverted');
  assert.equal(sized.style.Outline, '16.2', '15 % of 108');
  assert.equal(parseAss(build({ sizePercent: 99 }).text).style.Fontsize, String(Math.round(720 * 0.15)), 'the size is limited to 15 %');
  assert.equal(parseAss(build({ sizePercent: 0.5 }).text).style.Fontsize, String(Math.round(720 * 0.02)), 'and to at least 2 %');
  assert.equal(parseAss(build({ outlinePercent: 0 }).text).style.Outline, '0.0', 'no outline');
  assert.equal(parseAss(build({ font: 'Noto Sans' }).text).style.Fontname, 'Noto Sans', 'the family name works as well as the id');
  assert.equal(parseAss(build({ font: 'Comic Chaos' }).text).style.Fontname, 'DejaVu Sans', 'an unknown family is the default');
  for (const id of captions.FONTS) assert.equal(parseAss(build({ font: id }).text).style.Fontname, captions.FONT_FAMILIES[id]);

  // a picture that is higher than wide gets the same size in pixels as a landscape one of the same width would need
  const portrait = parseAss(build({ width: 720, height: 1280 }).text);
  assert.equal(portrait.info.PlayResX, '720');
  assert.equal(portrait.info.PlayResY, '1280');
  assert.equal(portrait.style.Fontsize, String(Math.round((1280 * 6 * (720 / 1280)) / 100)), 'automatic size scales with the width');

  assert.throws(() => captions.buildAss({ timing: JSON.stringify(SONG) }), /size of the video/);
  assert.throws(() => captions.buildAss({ timing: JSON.stringify(SONG), width: 0, height: 100 }), /size of the video/);
}

/* ---------- karaoke ---------- */

function testKaraoke() {
  const result = build({ style: 'karaoke' });
  const ass = parseAss(result.text);
  assert.equal(result.events, 3, 'one event per line');
  assert.equal(result.lines, 3);
  assert.equal(ass.events.length, 3);

  // times: the line shows 0.4 s before its first word and 0.4 s after the end of its last
  const first = ass.events[0];
  assert.equal(first.start, 160, '2.0 - 0.4');
  assert.equal(first.end, 620, 'line end 5.8 + 0.4: a held note does not hold the line');
  assert.equal(ass.events[1].start, 860, '9.0 - 0.4');
  assert.equal(ass.events[1].end, 1125, '10.9 + 0.4 would run into the third line, which begins at 11.6 - 0.4 = 11.2 ...');
  assert.equal(ass.events[2].start, 1125, '... so the two share the time between their words (the middle of 10.9 and 11.6)');
  assert.equal(ass.events[2].end, 1320, '12.8 + 0.4');

  // the fill of every word: counted from the start of the event
  const base = first.start;
  const words = karaokeWords(first.text);
  assert.deepEqual(words.map((word) => word.text), ['Copper', 'kites', 'over', 'the', 'bay']);
  const wanted = [
    [200, 250],
    [250, 300],
    [320, 360],
    [360, 380],
    [380, 580] // the held note stops at the end of the line: 5.8
  ];
  words.forEach((word, index) => {
    assert.equal(word.from + base, wanted[index][0], `${word.text} begins to fill at its time`);
    assert.equal(word.to + base, wanted[index][1], `${word.text} is full at the end of its time`);
  });
  // the pause before "over" is an empty \k part of 0.2 s, in the same block as the \kf of the word
  assert.ok(first.text.includes('{\\k20\\kf40}over'), first.text);
  assert.ok(first.text.startsWith('{\\k40\\kf50}Copper '), 'the lead-in is a pause before the first word');

  // all blocks are ours; the plain text is the line
  for (const event of ass.events) {
    const read = lex(event.text);
    for (const block of read.blocks) assert.match(block, OWN_BLOCK);
  }
  assert.equal(lex(first.text).visible, 'Copper kites over the bay');
  assert.equal(lex(ass.events[1].text).visible, 'Paper boats hum in the rain');

  // the sums hold for every event and the words keep their order
  ass.events.forEach((event, number) => {
    const read = karaokeWords(event.text);
    let previousEnd = 0;
    for (const word of read) {
      assert.ok(word.from >= previousEnd, `event ${number}: ${word.text} does not begin before the word before it ends`);
      assert.ok(word.to >= word.from);
      previousEnd = word.to;
    }
    assert.ok(event.start + previousEnd <= event.end + 1, `event ${number}: the fill ends within the event`);
  });

  // the layout is the same in the three styles (same event times for karaoke and lines)
  const lines = parseAss(build({ style: 'lines' }).text);
  assert.deepEqual(lines.events.map((event) => [event.start, event.end]), ass.events.map((event) => [event.start, event.end]));
}

function testKaraokeWithoutWordTimes() {
  // lines only: the words of a line share its time evenly
  const timing = { version: 1, lines: [{ text: 'one two three four', start: 10, end: 14 }, { text: 'five six', start: 15, end: 16 }] };
  const result = build({ style: 'karaoke' }, timing);
  const ass = parseAss(result.text);
  assert.equal(ass.events.length, 2);
  const base = ass.events[0].start;
  const words = karaokeWords(ass.events[0].text);
  assert.deepEqual(words.map((word) => word.text), ['one', 'two', 'three', 'four']);
  words.forEach((word, index) => {
    assert.equal(word.from + base, 1000 + index * 100, `word ${index + 1} starts a second after the one before`);
    assert.equal(word.to + base, 1100 + index * 100);
  });
  const second = karaokeWords(ass.events[1].text);
  assert.deepEqual(second.map((word) => word.text), ['five', 'six']);
  assert.equal(second[1].to - second[0].from, 100, 'the two words share one second');

  // the same in the style that lights one word after the other
  const single = parseAss(build({ style: 'words' }, timing).text);
  const lit = single.events.filter((event) => event.text.includes('\\1c')).map((event) => lex(event.text).visible);
  assert.equal(lit.length, 6, 'every word is lit in turn');

  // the words are in the timing but not in the lines: they are found by their time, or by their line number
  const mixed = {
    version: 1,
    words: [
      { text: 'late', start: 21, end: 21.4, line: 1 },
      { text: 'night', start: 21.4, end: 22, line: 1 },
      { text: 'early', start: 10, end: 10.5, line: 0 }
    ],
    lines: [
      { text: 'early', start: 10, end: 10.6 },
      { text: 'late night', start: 21, end: 22.2 }
    ]
  };
  const found = parseAss(build({ style: 'karaoke' }, mixed).text);
  assert.deepEqual(karaokeWords(found.events[1].text).map((word) => word.text), ['late', 'night']);
  const lateBase = found.events[1].start;
  assert.equal(karaokeWords(found.events[1].text)[1].from + lateBase, 2140, 'the times come from the word list');

  // words with lines inside the line (words?: [...])
  const nested = { version: 1, lines: [{ text: 'a b', start: 1, end: 2, words: [{ text: 'a', start: 1, end: 1.3 }, { text: 'b', start: 1.5, end: 2 }] }] };
  const nestedAss = parseAss(build({ style: 'karaoke' }, nested).text);
  const nestedWords = karaokeWords(nestedAss.events[0].text);
  assert.equal(nestedWords[0].to - nestedWords[0].from, 30);
  assert.equal(nestedWords[1].from - nestedWords[0].to, 20, 'the pause between the words is kept');

  // no lines at all, only words: the lines come from the pauses between them
  const wordsOnly = {
    version: 1,
    words: [
      { text: 'first', start: 5, end: 5.4 },
      { text: 'part', start: 5.4, end: 5.8 },
      { text: 'second', start: 9, end: 9.5 },
      { text: 'part', start: 9.5, end: 10 }
    ]
  };
  const made = parseAss(build({ style: 'lines' }, wordsOnly).text);
  assert.equal(made.events.length, 2, 'a pause of more than a second starts a new line');
  assert.equal(lex(made.events[0].text).visible, 'first part');
  assert.equal(lex(made.events[1].text).visible, 'second part');
}

/* ---------- words and lines ---------- */

function testWordsStyle() {
  const result = build({ style: 'words' });
  const ass = parseAss(result.text);
  assert.ok(result.events > 3, 'several events per line');
  const own = (event) => lex(event.text);
  const seenOrder = [];
  for (const event of ass.events) {
    const read = own(event);
    for (const block of read.blocks) assert.match(block, OWN_BLOCK);
    assert.ok(event.end > event.start, 'every event has a length');
    const lit = read.segments.filter((segment) => segment.tags && segment.tags.startsWith('\\1c'));
    assert.ok(lit.length <= 1, 'at most one word is lit');
    assert.ok(read.blocks.filter((block) => block.startsWith('\\1c')).every((block) => block === '\\1c&H00D4FF&'), 'in the highlight colour');
    if (lit.length) seenOrder.push(lit[0].text);
  }
  assert.deepEqual(seenOrder, ['Copper', 'kites', 'over', 'the', 'bay', 'Paper', 'boats', 'hum', 'in', 'the', 'rain', 'Velvet', 'skies'], 'every word is lit once, in order');

  // the first line: continuous coverage from 1.6 to 6.2
  const firstLine = ass.events.filter((event) => event.start < 700);
  assert.equal(firstLine[0].start, 160);
  assert.equal(firstLine[firstLine.length - 1].end, 620);
  for (let index = 1; index < firstLine.length; index += 1) {
    assert.equal(firstLine[index].start, firstLine[index - 1].end, 'no gap, no overlap inside a line');
  }
  // the lead-in has no highlight, "Copper" is lit when it is sung
  assert.ok(!firstLine[0].text.includes('\\1c'));
  assert.deepEqual([firstLine[1].start, firstLine[1].end], [200, 250]);
  assert.ok(firstLine[1].text.startsWith('{\\1c&H00D4FF&}Copper{\\r} kites'));
  // "kites" ends at 3.0, "over" begins at 3.2: a short pause keeps the light on the word until the next one
  const kites = firstLine.find((event) => event.text.includes('}kites{'));
  assert.deepEqual([kites.start, kites.end], [250, 320]);
  // "bay" is held to the end of the line (5.8), then the line stays 0.4 s unlit
  const bay = firstLine.find((event) => event.text.includes('}bay{'));
  assert.deepEqual([bay.start, bay.end], [380, 580]);
  const tail = firstLine[firstLine.length - 1];
  assert.deepEqual([tail.start, tail.end], [580, 620]);
  assert.ok(!tail.text.includes('\\1c'));

  // a long pause between two words takes the light off the word before it
  const gap = { version: 1, lines: [{ text: 'low high', start: 4, end: 7, words: [{ text: 'low', start: 4, end: 4.5 }, { text: 'high', start: 6.5, end: 7 }] }] };
  const gapped = parseAss(build({ style: 'words' }, gap).text).events;
  const unlit = gapped.filter((event) => !event.text.includes('\\1c'));
  assert.ok(unlit.some((event) => event.start === 450 && event.end === 650), 'unlit from the end of "low" to the start of "high"');
}

function testLinesStyle() {
  const result = build({ style: 'lines' });
  const ass = parseAss(result.text);
  assert.equal(ass.events.length, 3);
  assert.deepEqual(ass.events.map((event) => lex(event.text).visible), ['Copper kites over the bay', 'Paper boats hum in the rain', 'Velvet skies']);
  for (const event of ass.events) assert.ok(!event.text.includes('{'), 'no tags in the style that shows whole lines');
}

/* ---------- time: offset, lead-in, hold, cut ---------- */

function testTimes() {
  const shifted = parseAss(build({ style: 'lines', offset: 10 }).text).events;
  assert.equal(shifted[0].start, 1160);
  assert.equal(shifted[0].end, 1620);
  const earlier = parseAss(build({ style: 'lines', offset: -1.5 }).text).events;
  assert.equal(earlier[0].start, 10, '2.0 - 0.4 - 1.5');
  // a line that would begin before the start of the film begins at 0; one that ends before is gone
  const clipped = parseAss(build({ style: 'lines', offset: -2.2 }).text).events;
  assert.equal(clipped[0].start, 0);
  assert.equal(clipped.length, 3);
  const gone = parseAss(build({ style: 'lines', offset: -6.5 }).text).events;
  assert.equal(gone.length, 2, 'the first line ended at 5.8 + 0.4 - 6.5 < 0');
  assert.equal(gone[0].start, 210, '9.0 - 0.4 - 6.5');

  const quick = parseAss(build({ style: 'lines', leadIn: 0, hold: 0 }).text).events;
  assert.deepEqual([quick[0].start, quick[0].end], [200, 580]);
  const long = parseAss(build({ style: 'lines', leadIn: 1, hold: 1 }).text).events;
  assert.equal(long[0].start, 100);
  for (let index = 1; index < long.length; index += 1) assert.ok(long[index].start >= long[index - 1].end, 'two lines are never shown together by accident');

  // lines that follow each other closely share the pause between the words
  const close = {
    version: 1,
    lines: [
      { text: 'one', start: 10, end: 10.5, words: [{ text: 'one', start: 10, end: 10.5 }] },
      { text: 'two', start: 10.9, end: 11.4, words: [{ text: 'two', start: 10.9, end: 11.4 }] }
    ]
  };
  const shared = parseAss(build({ style: 'lines' }, close).text).events;
  assert.equal(shared[0].end, shared[1].start, 'the second begins when the first ends');
  assert.equal(shared[0].end, 1070, 'at the middle between 10.5 and 10.9 (10.7)');
  assert.ok(shared[0].end >= 1050 && shared[1].start <= 1090, 'neither word is cut');

  // duration: what lies beyond the film is dropped
  const cut = parseAss(build({ style: 'lines', duration: 9.5 }).text).events;
  assert.equal(cut.length, 2, 'the third line begins after 9.5');
  assert.equal(cut[1].end, 950, 'and the second ends with the film');
  assert.equal(parseAss(build({ style: 'lines', duration: 1 }).text).events.length, 0);
}

/* ---------- wrapping ---------- */

function testWrapping() {
  assert.deepEqual(captions.wrapTokens(['a', 'b'], 10), [['a', 'b']]);
  const sixty = ['alpha', 'bravo', 'delta', 'gamma', 'sigma', 'omega', 'kappa', 'lambda', 'theta', 'zeta']; // 59 characters
  const rows = captions.wrapTokens(sixty, 36);
  assert.equal(rows.flat().join(' '), sixty.join(' '), 'no word is lost or moved');
  assert.equal(rows.length, 2);
  for (const row of rows) assert.ok(row.join(' ').length <= 36, `${row.join(' ')} fits`);
  assert.ok(Math.abs(rows[0].join(' ').length - rows[1].join(' ').length) <= 4, 'about the same length');
  // the fewest rows, even when a greedy split leaves a last row that does not fit
  const lantern = 'We carry copper lanterns across the quiet silver bay tonight'.split(' ');
  const three = captions.wrapTokens(lantern, 30);
  assert.equal(three.length, 3);
  for (const row of three) assert.ok(row.join(' ').length <= 30, `${row.join(' ')} fits`);
  assert.equal(three.flat().join(' '), lantern.join(' '));
  assert.deepEqual(captions.wrapTokens([], 10), [[]]);
  assert.deepEqual(captions.wrapTokens(['averyveryverylongword', 'x'], 8), [['averyveryverylongword'], ['x']], 'a word that is too long stays whole in a row of its own');
  assert.equal(captions.wrapTokens(['a'], 0).length, 1);

  // in the script: the break is \N and the karaoke fill runs on across it
  const longLine = {
    version: 1,
    lines: [{ text: 'We carry copper lanterns across the quiet silver bay tonight', start: 5, end: 11 }]
  };
  const narrow = parseAss(build({ style: 'karaoke', maxChars: 30 }, longLine).text);
  const text = narrow.events[0].text;
  assert.ok(text.includes('\\N'), 'a long line is broken');
  const read = lex(text);
  const parts = read.visible.split('\n');
  assert.ok(parts.length >= 2);
  for (const part of parts) assert.ok(part.length <= 30, `"${part}" is at most 30 characters`);
  assert.equal(parts.join(' '), 'We carry copper lanterns across the quiet silver bay tonight');
  const wordsAcross = karaokeWords(text);
  assert.equal(wordsAcross.length, 10);
  for (let index = 1; index < wordsAcross.length; index += 1) assert.ok(wordsAcross[index].from >= wordsAcross[index - 1].to, 'the fill continues across the break');
  // the same in the other styles
  const wordsStyle = parseAss(build({ style: 'words', maxChars: 30 }, longLine).text);
  for (const event of wordsStyle.events) assert.equal(lex(event.text).visible, read.visible, 'every event has the same rows');
  const linesStyle = parseAss(build({ style: 'lines', maxChars: 30 }, longLine).text);
  assert.equal(lex(linesStyle.events[0].text).visible, read.visible);

  // the default limit follows the picture: narrower pictures and bigger letters give shorter rows
  const wide = build({ width: 1920, height: 1080 }).maxChars;
  const portrait = build({ width: 720, height: 1280 }).maxChars;
  const big = build({ sizePercent: 12 }).maxChars;
  assert.ok(wide > portrait, `${wide} > ${portrait}`);
  assert.ok(build().maxChars > big, 'bigger letters, shorter rows');
  assert.ok(build({ uppercase: true }).maxChars < build().maxChars, 'capital letters are wider');
  assert.equal(build({ maxChars: 20 }).maxChars, 20);
}

/* ---------- case and escaping inside a script ---------- */

function testUppercaseAndTags() {
  const upper = parseAss(build({ style: 'lines', uppercase: true }).text).events;
  assert.equal(lex(upper[0].text).visible, 'COPPER KITES OVER THE BAY');
  assert.equal(lex(parseAss(build({ style: 'lines' }).text).events[0].text).visible, 'Copper kites over the bay', 'case is kept by default');

  const tricky = {
    version: 1,
    lines: [
      {
        text: '{\\an8} Say {hello} \\N world\\ \\h',
        start: 3,
        end: 6,
        words: [
          { text: '{\\an8}', start: 3, end: 3.5 },
          { text: 'Say', start: 3.5, end: 4 },
          { text: '{hello}', start: 4, end: 4.5 },
          { text: '\\N', start: 4.5, end: 5 },
          { text: 'world\\', start: 5, end: 5.5 },
          { text: '\\h', start: 5.5, end: 6 }
        ]
      }
    ]
  };
  const expected = '{\\an8} Say {hello} \\N world\\ \\h'.replace(/\\/g, '∖');
  for (const style of ['karaoke', 'words', 'lines']) {
    const events = parseAss(build({ style, maxChars: 200 }, tricky).text).events;
    assert.ok(events.length >= 1, style);
    for (const event of events) {
      const read = lex(event.text);
      for (const block of read.blocks) assert.match(block, OWN_BLOCK, `${style}: only our own tags`);
      assert.equal(read.visible, expected, `${style}: the text is the line, braces and backslashes included`);
    }
  }
  // text with a line break in a lyric becomes blanks in the line (a word never holds a break)
  const broken = parseAss(build({ style: 'lines' }, { version: 1, lines: [{ text: 'one\ntwo', start: 1, end: 2 }] }).text).events;
  assert.equal(lex(broken[0].text).visible, 'one two');
}

/* ---------- nothing to show ---------- */

function testEmpty() {
  const emptyLines = captions.buildAss({ timing: JSON.stringify({ version: 1, source: 'align', duration: 30, words: [], lines: [] }), ...dims });
  assert.equal(emptyLines.events, 0);
  assert.equal(emptyLines.lines, 0);
  const ass = parseAss(emptyLines.text);
  assert.equal(ass.events.length, 0);
  assert.equal(ass.info.PlayResX, '1280', 'the script is still a valid script');
  for (const timing of [null, undefined, '', 'not json', '{"lines": 5}', '[]', '{}', 42]) {
    assert.equal(captions.buildAss({ timing, ...dims }).events, 0, `${JSON.stringify(timing)} gives no event`);
  }
  // lines with nothing to sing are dropped
  const blank = captions.buildAss({ timing: { version: 1, lines: [{ text: '   ', start: 1, end: 2 }, { text: '', start: 3, end: 4 }] }, ...dims });
  assert.equal(blank.events, 0);
  // a timing passed as an object works as well as one passed as text
  assert.equal(captions.buildAss({ timing: SONG, ...dims }).events, 3);
  // broken items are skipped, not fatal
  const rough = { version: 1, lines: [{ text: 'fine', start: 1, end: 2 }, { text: 'bad', start: 'x', end: 2 }, { start: 1, end: 2 }, null, { text: 'back', start: 5, end: 4 }] };
  assert.equal(captions.buildAss({ timing: rough, ...dims }).events, 1);
}

/* ---------- the filter check ---------- */

async function testHasFilter() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-captions-filter-'));
  const original = process.env.FFMPEG_PATH;
  const fake = (name, withAss) => {
    const file = path.join(dir, name);
    const body = [
      '#!/bin/sh',
      'echo run >> "$0.count"',
      'if [ "$1" = "-hide_banner" ] && [ "$2" = "-filters" ]; then',
      "cat <<'LIST'",
      'Filters:',
      '  T.. = Timeline support',
      '  .S. = Slice threading',
      '  ..C = Command support',
      '  A = Audio input/output',
      '  V = Video input/output',
      '  N = Dynamic number and/or type of input/output',
      '  | = Source or sink filter',
      ' ... abench            A->A       Benchmark part of a filtergraph.',
      ' TSC overlay           VV->V      Overlay a video source on top of the input.',
      ' .S. showwaves         A->V       Convert input audio to a video output.',
      ' ..  anullsrc          |->A       Null audio source, return empty audio frames.',
      withAss ? ' T.C ass               V->V       Render ASS subtitles onto input video using the libass library.' : ' T.C assx              V->V       Not the filter you look for.',
      'LIST',
      'fi'
    ];
    return fsp.writeFile(file, `${body.join('\n')}\n`, { mode: 0o755 }).then(() => file);
  };
  try {
    const withAss = await fake('ffmpeg-with-ass', true);
    const withoutAss = await fake('ffmpeg-without-ass', false);
    ffmpeg.resetFilterCache();
    assert.equal(ffmpeg.hasFilter('ass', { ffmpegPath: withAss }), true);
    assert.equal(ffmpeg.hasFilter('ass', { ffmpegPath: withoutAss }), false, 'a filter whose name only starts with "ass" is not "ass"');
    assert.equal(ffmpeg.hasFilter('overlay', { ffmpegPath: withoutAss }), true);
    assert.equal(ffmpeg.hasFilter('showwaves', { ffmpegPath: withoutAss }), true);
    assert.equal(ffmpeg.hasFilter('anullsrc', { ffmpegPath: withoutAss }), true, 'sources are listed too');
    assert.equal(ffmpeg.hasFilter('nope', { ffmpegPath: withAss }), false);
    assert.equal(ffmpeg.hasFilter('T', { ffmpegPath: withAss }), false, 'the legend is not a filter');
    assert.equal(ffmpeg.listFilters(withAss).size, 5);
    // read once per binary
    const countOf = async (file) => (await fsp.readFile(`${file}.count`, 'utf8')).split('\n').filter(Boolean).length;
    assert.equal(await countOf(withAss), 1, 'the list of a binary is read once');
    assert.equal(await countOf(withoutAss), 1);
    ffmpeg.resetFilterCache();
    assert.equal(ffmpeg.hasFilter('ass', { ffmpegPath: withAss }), true);
    assert.equal(await countOf(withAss), 2, 'after a reset it is read again');

    // the binary of the environment is used without a path
    process.env.FFMPEG_PATH = withAss;
    ffmpeg.resetFilterCache();
    assert.equal(ffmpeg.hasFilter('ass'), true);
    process.env.FFMPEG_PATH = withoutAss;
    ffmpeg.resetFilterCache();
    assert.equal(ffmpeg.hasFilter('ass'), false);

    // an ffmpeg that cannot be run, or does not exist, has no filters and is not remembered
    const broken = path.join(dir, 'ffmpeg-broken');
    await fsp.writeFile(broken, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    assert.equal(ffmpeg.hasFilter('ass', { ffmpegPath: broken }), false);
    assert.equal(ffmpeg.hasFilter('ass', { ffmpegPath: path.join(dir, 'missing') }), false);
    process.env.FFMPEG_PATH = path.join(dir, 'missing');
    assert.equal(ffmpeg.hasFilter('ass'), false, 'no binary, no filter');
  } finally {
    if (original === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = original;
    ffmpeg.resetFilterCache();
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ---------- the real ffmpeg ---------- */

async function ff(args) {
  await execFileAsync(ffmpeg.binaries().ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args]);
}

// Number of pixels of a frame that are close to a colour, in the whole frame and in the upper half
async function countPixels(file, time, colors) {
  const { width, height } = { width: 320, height: 180 };
  const { stdout } = await execFileAsync(
    ffmpeg.binaries().ffmpeg,
    ['-nostdin', '-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 }
  );
  assert.equal(stdout.length, width * height * 3);
  const result = colors.map(() => ({ all: 0, top: 0 }));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 3;
      colors.forEach((color, index) => {
        const distance = Math.abs(stdout[at] - color[0]) + Math.abs(stdout[at + 1] - color[1]) + Math.abs(stdout[at + 2] - color[2]);
        if (distance <= 60) {
          result[index].all += 1;
          if (y < height / 2) result[index].top += 1;
        }
      });
    }
  }
  return result;
}

// The filter value reaches ffmpeg unchanged for awkward paths. `movie` reads its file name the way `ass` does, so a picture that is
// read through a path full of special characters proves the escaping without needing libass.
async function testFilterPathEscaping(dir) {
  const names = ['plain.mp4', 'with space.mp4', "it's here.mp4", 'colon:name.mp4', 'brackets[1],semi;eq=1.mp4'];
  if (process.platform !== 'win32') names.push('back\\slash.mp4');
  for (const name of names) {
    const file = path.join(dir, name);
    await ff(['-f', 'lavfi', '-i', 'color=c=0x336699:s=64x36:r=5', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
    const graph = `${captions.assFilter(file).replace(/^ass=/, 'movie=')}[v]`;
    const out = path.join(dir, 'escape-check.png');
    await ff(['-filter_complex', graph, '-map', '[v]', '-frames:v', '1', out]);
    const stat = await fsp.stat(out);
    assert.ok(stat.size > 0, `the file ${JSON.stringify(name)} is found through the escaped filter value`);
    await fsp.rm(out, { force: true });
  }
}

async function testBurnIn(dir) {
  if (!ffmpeg.hasFilter('ass')) {
    console.log('SKIP burn-in: this ffmpeg has no libass (filter "ass"); the script is checked above, the picture was not');
    return;
  }
  const size = '320x180';
  const base = path.join(dir, 'black.mp4');
  await ff(['-f', 'lavfi', '-i', `color=c=0x000000:s=${size}:r=25`, '-t', '16', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', base]);

  // a font must exist, or libass draws nothing; look with a script that is known to be good
  const probeScript = path.join(dir, 'probe.ass');
  const probe = captions.buildAss({ timing: { version: 1, lines: [{ text: 'MMMM MMMM', start: 1, end: 3 }] }, width: 320, height: 180, style: 'lines', sizePercent: 15, color: '#ffffff' });
  await fsp.writeFile(probeScript, probe.text);
  const probed = path.join(dir, 'probe.mp4');
  await ff(['-i', base, '-vf', captions.assFilter(probeScript), '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', probed]);
  const [probeWhite] = await countPixels(probed, 2, [[255, 255, 255]]);
  if (probeWhite.all < 50) {
    console.log('SKIP burn-in: libass found no font on this machine, nothing is drawn even for a plain script');
    return;
  }

  const timing = { version: 1, lines: [{ text: 'MMMMMM MMMMMM', start: 2, end: 10, words: [{ text: 'MMMMMM', start: 2, end: 6 }, { text: 'MMMMMM', start: 6, end: 10 }] }] };
  const WHITE = [255, 255, 255];
  const YELLOW = [255, 212, 0];
  for (const position of ['bottom', 'top', 'middle']) {
    const script = path.join(dir, `karaoke-${position}.ass`);
    const made = captions.buildAss({ timing, width: 320, height: 180, style: 'karaoke', position, sizePercent: 12 });
    await fsp.writeFile(script, made.text);
    const out = path.join(dir, `karaoke-${position}.mp4`);
    await ff(['-i', base, '-vf', captions.assFilter(script), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
    const before = (await countPixels(out, 0.5, [WHITE, YELLOW]));
    assert.equal(before[0].all + before[1].all, 0, `${position}: nothing before the lead-in`);
    const early = await countPixels(out, 1.8, [WHITE, YELLOW]);
    assert.ok(early[0].all > 40 && early[1].all === 0, `${position}: the line stands in the base colour before the first word`);
    const middle = await countPixels(out, 6, [WHITE, YELLOW]);
    assert.ok(middle[0].all > 40 && middle[1].all > 40, `${position}: first word filled, second not yet`);
    const late = await countPixels(out, 10.1, [WHITE, YELLOW]);
    assert.ok(late[1].all > middle[1].all && late[0].all < middle[0].all, `${position}: the fill has moved on`);
    const after = await countPixels(out, 11.5, [WHITE, YELLOW]);
    assert.equal(after[0].all + after[1].all, 0, `${position}: gone after the hold`);
    const total = middle[0].all + middle[1].all;
    const upper = middle[0].top + middle[1].top;
    if (position === 'top') assert.ok(upper > total * 0.9, 'top: the text is in the upper half');
    if (position === 'bottom') assert.ok(upper < total * 0.1, 'bottom: the text is in the lower half');
  }
}

async function testWithFfmpeg() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-captions-'));
  try {
    await testFilterPathEscaping(dir);
    await testBurnIn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  testFormatPieces();
  testEscaping();
  testHeaderAndStyle();
  testKaraoke();
  testKaraokeWithoutWordTimes();
  testWordsStyle();
  testLinesStyle();
  testTimes();
  testWrapping();
  testUppercaseAndTags();
  testEmpty();
  await testHasFilter();
  if (!ffmpeg.binaries().available) {
    console.log('SKIP ffmpeg is missing (only the script was tested)');
  } else {
    await testWithFfmpeg();
  }
  console.log('test-captions-ass.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
