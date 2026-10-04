'use strict';

// Tests for captions in other scripts than Latin (WP35, lib/captions-ass.js and lib/captions-fonts.js): the width of a character in
// columns, the wrapping of Japanese and Chinese between characters with the rules of kinsoku, mixed widths, Hebrew and Arabic in logical
// order with the style `words` instead of karaoke (the reason is shown with libass where this machine has it), and the warning about a
// missing font (a fake `fc-list` in the PATH). The texts are invented. The script is read back with scripts/support/ass-reader.js.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const captions = require('../lib/captions-ass');
const fonts = require('../lib/captions-fonts');
const ffmpeg = require('../lib/ffmpeg');
const edit = require('../lib/nodes/nodes-edit');
const { parseAss, karaokeWords, rowsOf, markedRows, encodingOf } = require('./support/ass-reader');
const { createEditHarness } = require('./support/edit-harness');
const { createFakeFfmpeg } = require('./support/fake-ffmpeg');

const execFileAsync = promisify(execFile);

// An independent idea of "wide", so that the width the code computes is not checked against itself
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\uac00-\ud7a3\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/u;
const independentColumns = (text) => [...text].reduce((sum, char) => sum + (/\p{M}/u.test(char) ? 0 : WIDE.test(char) ? 2 : 1), 0);
const NO_START = [...'、。，．）」』】〉》！？…ー'];
const NO_END = [...'（「『【〈《'];

const JA = '今日はとても良い天気ですので、散歩に出かけましょう。「楽しい」一日になりますように…';
const ZH = '今天天气非常好，所以我们去公园散步。“快乐”的一天，一定会很美好！';
const HE = 'שלום עולם גדול ויפה';
const AR = 'مرحبا بالعالم الكبير والجميل';

const lineTiming = (text, start = 1, end = 7, words = null) => ({ version: 1, lines: [{ text, start, end, ...(words ? { words } : {}) }] });
const build = (timing, options = {}) => captions.buildAss({ timing, width: 1280, height: 720, ...options });
const dialogues = (made) => parseAss(made.text).events;
const joinRows = (rows) => rows.map((row) => row.map((unit) => unit.text).join(''));
// the rows as they are shown: a space where the unit says so
const visible = (rows) => rows.map((row) => row.map((unit, index) => (index > 0 && unit.gap ? ' ' : '') + unit.text).join(''));

/* ---------- width in columns ---------- */

function testColumns() {
  assert.equal(captions.columns('abc'), 3);
  assert.equal(captions.columns('日本語'), 6, 'Chinese and Japanese characters take two columns');
  assert.equal(captions.columns('Ａ１'), 4, 'fullwidth forms take two');
  assert.equal(captions.columns('ｱｲ'), 2, 'halfwidth katakana take one');
  assert.equal(captions.columns('Hello世界'), 9, 'mixed: 5 + 4');
  assert.equal(captions.columns('é'), 1, 'a combining mark takes none');
  assert.equal(captions.columns('שָׁלוֹם'), 4, 'the points of Hebrew take none');
  assert.equal(captions.columns('مَرْحَبًا'), 5, 'the marks of Arabic take none');
  assert.equal(captions.columns('が'), 2, 'the voicing mark of kana takes none');
  assert.equal(captions.columns(''), 0);
  for (const text of [JA, ZH, 'Hello 世界 foo', '안녕하세요 world', HE, AR]) assert.equal(captions.columns(text), independentColumns(text), text);
  assert.equal(captions.columns('안녕'), 4, 'Hangul syllables are wide');
}

/* ---------- Japanese and Chinese: between characters, kinsoku ---------- */

function checkRows(rows, limit, label) {
  rows.forEach((row, index) => {
    assert.ok(row.length > 0, `${label}: row ${index} is not empty`);
    const text = row.map((unit) => unit.text).join('');
    assert.ok(independentColumns(text) <= limit, `${label}: row ${index} "${text}" has ${independentColumns(text)} columns, the limit is ${limit}`);
    if (index > 0) assert.ok(!NO_START.includes([...text][0]), `${label}: row ${index} "${text}" starts with a closing mark`);
    if (index < rows.length - 1) assert.ok(!NO_END.includes([...text].at(-1)), `${label}: row ${index} "${text}" ends with an opening bracket`);
  });
}

function testCjkWrapping() {
  for (const [name, text] of [['ja', JA], ['zh', ZH]]) {
    for (let limit = 8; limit <= 60; limit += 1) {
      const rows = captions.wrapLine([text], limit);
      assert.equal(joinRows(rows).join(''), text, `${name} ${limit}: no character is lost or moved`);
      checkRows(rows, limit, `${name} ${limit}`);
      // the rows are about equally long: no row is shorter than half of the longest (the last one of a short line may be)
      if (rows.length > 1) {
        const widths = joinRows(rows).map(independentColumns);
        assert.ok(Math.min(...widths) >= Math.max(...widths) / 2 - 2, `${name} ${limit}: balanced ${widths}`);
      }
      assert.ok(rows.length <= Math.ceil(independentColumns(text) / (limit - 2)), `${name} ${limit}: not many more rows than the width needs (${rows.length})`);
    }
  }

  // one word without spaces is cut after any character, and the pieces keep the word they belong to
  const rows = captions.wrapLine(['日本語の文章です'], 8);
  assert.deepEqual(joinRows(rows), ['日本語の', '文章です'], 'cut between characters, 4 per row of 8 columns');
  assert.ok(rows.flat().every((unit) => unit.word === 0));
  const shares = rows.flat().map((unit) => [unit.from, unit.to]);
  assert.equal(shares[0][0], 0);
  assert.equal(shares.at(-1)[1], 1);
  shares.slice(1).forEach(([from], index) => assert.ok(Math.abs(from - shares[index][1]) < 1e-12, 'the pieces follow each other without a gap'));

  // kinsoku in single cases: the mark that may not start a row is taken to the row before it
  const early = joinRows(captions.wrapLine(['あいうえ、おかきく'], 8));
  assert.ok(early.length >= 2 && early.slice(1).every((row) => !row.startsWith('、')), `the comma does not start a row: ${early}`);
  const comma = captions.wrapLine(['あいうえお、かきくけこ'], 10);
  assert.ok(!comma[1][0].text.startsWith('、'), 'a comma does not start a row');
  const bracket = captions.wrapLine(['あいうえ「おかき」くけこ'], 10);
  assert.ok(!joinRows(bracket)[0].endsWith('「'), 'an opening bracket does not end a row');
  const sound = captions.wrapLine(['あいうえおーかきくけ'], 10);
  assert.ok(!sound[1][0].text.startsWith('ー'), 'the prolonged sound mark does not start a row');
  const dots = captions.wrapLine(['あいうえお……かきくけこ'], 10);
  assert.ok(!['…'].includes(dots[1][0].text), 'an ellipsis does not start a row');
  assert.equal(joinRows(dots).join(''), 'あいうえお……かきくけこ');
  // a closing mark after a closing mark: both stay with the text before
  const double = captions.wrapLine(['あいうえ。」おかきくけ'], 10);
  checkRows(double, 10, 'double');

  // the whole set of the order
  for (const mark of NO_START) {
    const wrapped = captions.wrapLine([`あいうえおかきくけ${mark}さしすせそ`], 18);
    checkRows(wrapped, 18, `no start ${mark}`);
  }
  for (const mark of NO_END) {
    const wrapped = captions.wrapLine([`あいうえおかきくけ${mark}さしすせそ`], 20);
    checkRows(wrapped, 20, `no end ${mark}`);
  }

  // Latin text is wrapped as before and is never cut inside a word (kinsoku applies only where a line has such characters)
  const latin = captions.wrapLine(['averyveryverylongword', 'x', ')', 'tail'], 8);
  assert.deepEqual(visible(latin), ['averyveryverylongword', 'x ) tail'], 'a long Latin word stands alone and the rest is 8 columns; the words keep their spaces and kinsoku does not apply');
  assert.deepEqual(captions.wrapTokens(['averyveryverylongword', 'x'], 8), [['averyveryverylongword'], ['x']]);
}

/* ---------- mixed widths ---------- */

function testMixedWidth() {
  // a space between two words of Latin letters stays; between a word and one of Chinese characters there is none
  const mixed = captions.wrapLine(['Hello', '世界', 'foo', 'bar'], 40);
  assert.deepEqual(visible(mixed), ['Hello世界foo bar']);
  const korean = captions.wrapLine(['안녕하세요', 'world', '여러분'], 40);
  assert.deepEqual(visible(korean), ['안녕하세요 world 여러분'], 'Korean is written with spaces: they stay');

  // the limit is in columns: ten Latin letters and five wide characters are equally long
  assert.equal(captions.wrapLine(['abcdefghij', 'あいうえお'], 12).length, 2, '10 + 1 + 10 columns do not fit 12');
  assert.equal(captions.wrapLine(['あいうえお', 'あいうえお'], 20).length, 1, 'two Japanese words of 10 columns fit 20: no space between them');
  assert.deepEqual(visible(captions.wrapLine(['abc', 'あいうえお'], 13)), ['abcあいうえお'], '3 + 10 columns: no space before a wide character');
  assert.deepEqual(visible(captions.wrapLine(['Hello', 'world', '2024年', 'の', '春'], 14)), ['Hello world', '2024年の春'], 'rows by columns: a number and its unit stay together');

  // in a script: a line of mostly wide characters has more room (the columns of the automatic limit count a letter, a wide character fills two)
  const wide = build(lineTiming(JA), { style: 'lines' });
  const latinLine = build(lineTiming('Today the weather is very nice so we take a walk and have a happy day with all of our friends'), { style: 'lines' });
  assert.ok(wide.maxChars > 0 && wide.maxChars === latinLine.maxChars, 'the option of the limit is the same');
  const wideRows = rowsOf(dialogues(wide)[0].text);
  assert.ok(wideRows.length <= 2, `${wideRows.length} rows for a Japanese line that is 41 characters wide`);
  for (const row of wideRows) assert.ok(independentColumns(row) <= wide.maxChars * (0.68 / 0.5), `row "${row}" fits the picture`);
  // an explicit limit is a limit in columns and is not scaled
  const explicit = build(lineTiming(JA), { style: 'lines', maxChars: 20 });
  for (const row of rowsOf(dialogues(explicit)[0].text)) assert.ok(independentColumns(row) <= 20, `explicit limit: "${row}"`);
}

/* ---------- the script of Japanese and Chinese ---------- */

function testCjkScript() {
  // karaoke: a line without the times of its words is one word; it is filled piece by piece over the time of the line
  const made = build(lineTiming(JA), { style: 'karaoke' });
  assert.equal(made.events, 1);
  assert.deepEqual(made.scripts, ['ja']);
  assert.equal(made.rtl, false);
  assert.deepEqual(made.notes, []);
  const event = dialogues(made)[0];
  const rows = rowsOf(event.text);
  assert.equal(rows.join(''), JA, 'the text is the lyric, in order');
  assert.ok(rows.length >= 2);
  for (const row of rows) assert.ok(independentColumns(row) <= made.maxChars * (0.68 / 0.5));
  const pieces = karaokeWords(event.text);
  assert.equal(pieces.map((piece) => piece.text).join(''), JA, 'every character has a part of its own');
  assert.equal(pieces.length, [...JA].length);
  assert.equal(pieces[0].from, 40, 'the first piece starts after the lead-in (0.4 s)');
  for (let index = 1; index < pieces.length; index += 1) assert.ok(pieces[index].from >= pieces[index - 1].to - 1, 'the pieces follow each other');
  // the line is sung from 1.0 s to 7.0 s (600 hundredths): the pieces cover it, a character as long as its width
  const sung = pieces.at(-1).to - pieces[0].from;
  assert.ok(Math.abs(sung - 600) <= pieces.length, `the pieces fill the 6 s of the line (${sung})`);
  const widths = [...JA].map((char) => independentColumns(char));
  const total = widths.reduce((a, b) => a + b, 0);
  pieces.forEach((piece, index) => assert.ok(Math.abs(piece.to - piece.from - (600 * widths[index]) / total) <= 2, `piece ${index} has its share`));

  // the words of the timing come as they are: no space is put between characters of two words
  const words = [{ text: '今日は', start: 1, end: 2 }, { text: '天気が', start: 2, end: 3 }, { text: 'いい', start: 3, end: 4 }, { text: 'ですね', start: 4, end: 5 }];
  const spoken = build(lineTiming('今日は 天気が いい ですね', 1, 5, words), { style: 'lines' });
  assert.deepEqual(rowsOf(dialogues(spoken)[0].text), ['今日は天気がいいですね'], 'no spaces between Japanese words');
  const latinWords = [{ text: 'Hello', start: 1, end: 2 }, { text: 'big', start: 2, end: 3 }, { text: 'world', start: 3, end: 4 }];
  assert.deepEqual(rowsOf(dialogues(build(lineTiming('Hello big world', 1, 4, latinWords), { style: 'lines' }))[0].text), ['Hello big world'], 'Latin words keep their spaces');

  // karaoke over words: each word is filled over its time, a word that is cut fills its pieces one after the other
  const long = [{ text: '日本語の文章がここにあります', start: 1, end: 4 }, { text: 'そして', start: 4, end: 5 }];
  const cut = build(lineTiming('日本語の文章がここにあります そして', 1, 5, long), { style: 'karaoke', maxChars: 12 });
  const cutEvent = dialogues(cut)[0];
  assert.ok(rowsOf(cutEvent.text).length >= 2);
  const cutPieces = karaokeWords(cutEvent.text);
  const first = cutPieces.filter((piece) => '日本語の文章がここにあります'.includes(piece.text) && piece.text !== '').slice(0, 14);
  assert.equal(first.map((piece) => piece.text).join(''), '日本語の文章がここにあります');
  const span = first.at(-1).to - first[0].from;
  assert.ok(Math.abs(span - 300) <= 3, `the cut word is filled over its 3 s (${span})`);
  const next = cutPieces.find((piece) => piece.text === 'そ');
  assert.ok(next.from >= first.at(-1).to - 1, 'the next word follows the cut one');

  // words: a word that is cut is marked over all of its pieces
  const marked = build(lineTiming('日本語の文章がここにあります そして', 1, 5, long), { style: 'words', maxChars: 12 });
  const events = dialogues(marked);
  const duringFirst = events.find((item) => item.start === 100);
  assert.ok(duringFirst, 'an event from 1.0 s on');
  const marks = markedRows(duringFirst.text);
  assert.equal(marks.flat().join(''), '日本語の文章がここにあります', 'the whole first word is marked');
  assert.ok(marks.filter((row) => row.length).length >= 2, 'the marks run over the rows');
  const rest = rowsOf(duringFirst.text).join('');
  assert.equal(rest, '日本語の文章がここにありますそして');

  // Chinese with fullwidth punctuation
  const zh = build(lineTiming(ZH), { style: 'lines', maxChars: 16 });
  assert.deepEqual(zh.scripts, ['zh']);
  const zhRows = rowsOf(dialogues(zh)[0].text);
  assert.equal(zhRows.join(''), ZH);
  zhRows.forEach((row, index) => {
    assert.ok(independentColumns(row) <= 16, row);
    if (index > 0) assert.ok(!NO_START.includes([...row][0]) && !'”，。！'.includes([...row][0]), `no mark starts "${row}"`);
  });

  // upper case does not touch it
  assert.equal(rowsOf(dialogues(build(lineTiming(JA), { style: 'lines', uppercase: true }))[0].text).join(''), JA);
  // the Latin script is as before
  const old = build(lineTiming('Copper kites over the bay'), { style: 'karaoke' });
  assert.deepEqual(old.scripts, []);
  assert.deepEqual(old.notes, []);
  assert.equal(encodingOf(old.text), 1);
}

/* ---------- right to left ---------- */

function hebrewTiming() {
  const words = HE.split(' ').map((text, index) => ({ text, start: 1 + index, end: 2 + index }));
  return lineTiming(HE, 1, 5, words);
}

function testRtl() {
  for (const [name, text, id] of [['he', HE, 'he'], ['ar', AR, 'ar']]) {
    const tokens = text.split(' ');
    const timing = lineTiming(text, 1, 1 + tokens.length, tokens.map((token, index) => ({ text: token, start: 1 + index, end: 2 + index })));
    for (const style of ['karaoke', 'words']) {
      const made = build(timing, { style });
      assert.equal(made.rtl, true, `${name}: right to left`);
      assert.deepEqual(made.scripts, [id]);
      assert.equal(made.style, 'words', `${name} ${style}: the style of the script is words`);
      assert.equal(parseAss(made.text).style.PrimaryColour, '&H00FFFFFF', `${name}: the base colour is the primary one (the style of karaoke has the highlight there)`);
      assert.equal(encodingOf(made.text), -1, `${name}: libass detects the direction of the line`);
      // the text stays in logical order: the rows read the words as they are spoken
      const all = dialogues(made);
      for (const item of all) assert.equal(rowsOf(item.text).join(' '), text, `${name}: logical order, not reversed`);
      // one event per stretch: the sung word is marked in each, in the order of the words
      const marked = all.map((item) => markedRows(item.text).flat().join('')).filter(Boolean);
      assert.deepEqual(marked, tokens, `${name}: the words are marked one after the other`);
      assert.ok(!all.some((item) => /\\kf?\d/.test(item.text)), `${name}: no karaoke tags`);
    }
    const asked = build(timing, { style: 'karaoke' });
    assert.equal(asked.notes.length, 1);
    assert.match(asked.notes[0], /Right-to-left/);
    assert.match(asked.notes[0], /"words"/);
    assert.equal(build(timing, { style: 'words' }).notes.length, 0, 'nothing to say where words was asked for');
    assert.equal(build(timing, { style: 'lines' }).notes.length, 0);
    assert.equal(build(timing, { style: 'lines' }).style, 'lines');
    assert.equal(encodingOf(build(timing, { style: 'lines' }).text), -1);
  }

  // wrapped: the rows keep the order of the words, the first row holds the first words
  const long = 'שלום עולם גדול ויפה מאוד היום בבוקר כאן אצלנו בעיר';
  const longTokens = long.split(' ');
  const wrapped = build(lineTiming(long, 1, 11, longTokens.map((token, index) => ({ text: token, start: 1 + index, end: 2 + index }))), { style: 'karaoke', maxChars: 20 });
  const rows = rowsOf(dialogues(wrapped)[0].text);
  assert.ok(rows.length >= 2);
  assert.equal(rows.join(' '), long);
  for (const row of rows) assert.ok(independentColumns(row) <= 20, row);

  // a mixed line stays in logical order (libass puts it in order); the script is right to left because it holds such text
  const mixed = build(lineTiming('Hello שלום world', 1, 4, [{ text: 'Hello', start: 1, end: 2 }, { text: 'שלום', start: 2, end: 3 }, { text: 'world', start: 3, end: 4 }]), { style: 'karaoke' });
  assert.equal(mixed.rtl, true);
  const mixedEvents = dialogues(mixed);
  for (const item of mixedEvents) assert.equal(rowsOf(item.text).join(' '), 'Hello שלום world', 'logical order');
  assert.deepEqual(mixedEvents.map((item) => markedRows(item.text).flat().join('')).filter(Boolean), ['Hello', 'שלום', 'world']);

  // one right-to-left line is enough for the whole script (one style holds for all of it)
  const both = build({ version: 1, lines: [{ text: 'Copper kites', start: 1, end: 3 }, { text: HE, start: 4, end: 7 }] }, { style: 'karaoke' });
  assert.equal(both.style, 'words');
  assert.equal(both.rtl, true);
  // no right-to-left text: karaoke stays and the encoding is the default
  const latin = build(lineTiming('Copper kites over the bay', 1, 4, [{ text: 'Copper', start: 1, end: 2 }, { text: 'kites', start: 2, end: 3 }, { text: 'over', start: 3, end: 3.5 }]), { style: 'karaoke' });
  assert.equal(latin.style, 'karaoke');
  assert.equal(latin.rtl, false);
  assert.equal(encodingOf(latin.text), 1);
  assert.equal(parseAss(latin.text).style.PrimaryColour, '&H0000D4FF', 'karaoke: the highlight colour is the primary one');
  assert.equal(captions.hasRtl('abc'), false);
  assert.equal(captions.hasRtl(HE), true);
  assert.equal(captions.hasRtl(AR), true);
  assert.equal(captions.hasRtl('日本'), false);
}

function testScriptsOf() {
  assert.deepEqual(captions.scriptsOf('Hello world'), []);
  assert.deepEqual(captions.scriptsOf('今日はいい天気'), ['ja'], 'kana make it Japanese');
  assert.deepEqual(captions.scriptsOf('今天天气好'), ['zh'], 'Han letters alone are taken as Chinese');
  assert.deepEqual(captions.scriptsOf('안녕하세요'), ['ko']);
  assert.deepEqual(captions.scriptsOf('안녕 大韓民國'), ['ko'], 'hanja with Hangul are Korean');
  assert.deepEqual(captions.scriptsOf(HE), ['he']);
  assert.deepEqual(captions.scriptsOf(AR), ['ar']);
  assert.deepEqual(captions.scriptsOf('hello שלום مرحبا こんにちは'), ['ja', 'ar', 'he']);
  assert.deepEqual(captions.scriptsOf(null), []);
}

/* ---------- the picture, where libass is: why karaoke is not used for right to left ---------- */

async function testLibassPicture() {
  if (!ffmpeg.binaries().available || !ffmpeg.hasFilter('ass')) {
    console.log('SKIP picture: this ffmpeg has no libass (filter "ass"); the scripts were checked, the way libass draws right-to-left text was not');
    return;
  }
  const hebrewFonts = await fonts.fcList('he').catch(() => '');
  if (!hebrewFonts.trim()) {
    console.log('SKIP picture: fontconfig has no font for Hebrew on this machine; the scripts were checked, the way libass draws right-to-left text was not');
    return;
  }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-captions-rtl-'));
  try {
    const width = 640;
    const height = 360;
    const base = path.join(dir, 'black.mp4');
    const ff = (args) => execFileAsync(ffmpeg.binaries().ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args], { maxBuffer: 16 * 1024 * 1024 });
    await ff(['-f', 'lavfi', '-i', `color=c=0x000000:s=${width}x${height}:r=25`, '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', base]);
    // the extent in x of the pixels of a colour in a frame at a time
    const extent = async (file, time, color) => {
      const { stdout } = await execFileAsync(
        ffmpeg.binaries().ffmpeg,
        ['-nostdin', '-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
        { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 }
      );
      let low = Infinity;
      let high = -Infinity;
      let count = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const at = (y * width + x) * 3;
          if (Math.abs(stdout[at] - color[0]) + Math.abs(stdout[at + 1] - color[1]) + Math.abs(stdout[at + 2] - color[2]) <= 60) {
            low = Math.min(low, x);
            high = Math.max(high, x);
            count += 1;
          }
        }
      }
      return { low, high, count };
    };
    const render = async (name, text) => {
      const script = path.join(dir, `${name}.ass`);
      await fsp.writeFile(script, text);
      const out = path.join(dir, `${name}.mp4`);
      await ff(['-i', base, '-vf', captions.assFilter(script), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
      return out;
    };
    const WHITE = [255, 255, 255];
    const YELLOW = [255, 212, 0];
    const words = ['שלום', 'עולם', 'גדול'].map((text, index) => ({ text, start: 1 + index * 2, end: 3 + index * 2 }));
    const timing = lineTiming('שלום עולם גדול', 1, 7, words);

    // 1. the style `words`, with the encoding of the script: the first word stands on the right, the next one to its left
    const made = build(timing, { style: 'words', width, height, sizePercent: 14 });
    assert.equal(encodingOf(made.text), -1);
    const clip = await render('words', made.text);
    const firstWord = await extent(clip, 2, YELLOW); // 1 s - 3 s: the first word is marked
    const secondWord = await extent(clip, 4, YELLOW);
    const thirdWord = await extent(clip, 6, YELLOW);
    assert.ok(firstWord.count > 50 && secondWord.count > 50 && thirdWord.count > 50, 'each word is marked in its time');
    assert.ok(firstWord.low > secondWord.high - 5 && secondWord.low > thirdWord.high - 5, `Hebrew reads from the right: the first word stands right of the second, and that right of the third (${JSON.stringify([firstWord, secondWord, thirdWord])})`);

    // 2. the same line with the default encoding (what the script had before): libass lays the words out from the left
    const before = build(timing, { style: 'words', width, height, sizePercent: 14 }).text.replace(/,-1\n/, ',1\n');
    assert.notEqual(before, made.text);
    const old = await render('words-default', before);
    const oldFirst = await extent(old, 2, YELLOW);
    const oldThird = await extent(old, 6, YELLOW);
    assert.ok(oldFirst.high < oldThird.low + 5, `with the default encoding the first word stands left: this is why the script sets the encoding (${JSON.stringify([oldFirst, oldThird])})`);

    // 3. karaoke over one Hebrew word (a line of one word, so the fill is easy to see): libass fills from the left edge, whatever the direction
    const one = lineTiming('שלום', 1, 5, [{ text: 'שלום', start: 1, end: 5 }]);
    const karaokeScript = build(one, { style: 'karaoke', width, height, sizePercent: 20 });
    assert.equal(karaokeScript.style, 'words', 'karaoke is replaced');
    // the script that karaoke would have been: made for Latin text (so no replacement), with the Hebrew word put in
    const latinKaraoke = build(lineTiming('MMMM', 1, 5, [{ text: 'MMMM', start: 1, end: 5 }]), { style: 'karaoke', width, height, sizePercent: 20 }).text.replace('MMMM', 'שלום').replace(/,1\n/, ',-1\n');
    const karaokeClip = await render('karaoke', latinKaraoke);
    const half = 3; // the middle of the fill
    const filled = await extent(karaokeClip, half, YELLOW);
    const rest = await extent(karaokeClip, half, WHITE);
    assert.ok(filled.count > 30 && rest.count > 30, 'half of the word is filled');
    assert.ok(filled.low <= rest.low + 8, `the fill starts at the left edge (${JSON.stringify([filled, rest])}); the first letter of a Hebrew word is on the right, so the fill runs the wrong way`);
    assert.ok(filled.high < rest.high, 'the filled part is left of the rest');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ---------- fonts ---------- */

async function withPath(dir, fn) {
  const original = process.env.PATH;
  process.env.PATH = dir;
  try {
    return await fn();
  } finally {
    process.env.PATH = original;
  }
}

async function testFonts() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-fclist-'));
  try {
    // a fake fc-list: it has a font for Chinese and for Hebrew only, and records what it was asked
    const record = path.join(dir, 'asked.txt');
    const fake = path.join(dir, 'fc-list');
    await fsp.writeFile(
      fake,
      `#!/bin/sh\necho "$@" >> '${record}'\ncase "$1" in\n  :lang=zh) echo "Fake Sans CJK";;\n  :lang=he) echo "Fake Sans Hebrew";;\n  *) ;;\nesac\n`,
      { mode: 0o755 }
    );
    const original = process.env.PATH;
    const withFake = (fn) => withPath(`${dir}${path.delimiter}${original}`, fn);

    assert.deepEqual(await withFake(() => fonts.fontWarnings([])), [], 'no script, no question');
    assert.deepEqual(await withFake(() => fonts.fontWarnings(undefined)), []);
    assert.deepEqual(await withFake(() => fonts.fontWarnings(['zh', 'he'])), [], 'a font is there for both');
    const warnings = await withFake(() => fonts.fontWarnings(['ja', 'zh', 'ko', 'ar', 'he']));
    assert.equal(warnings.length, 3, 'Japanese, Korean and Arabic have none');
    assert.match(warnings[0], /Japanese/);
    assert.match(warnings[0], /:lang=ja/);
    assert.match(warnings[0], /fonts-noto-cjk/);
    assert.match(warnings[1], /Korean/);
    assert.match(warnings[1], /fonts-noto-cjk/);
    assert.match(warnings[2], /Arabic/);
    assert.match(warnings[2], /fonts-noto-core/);
    assert.ok(!warnings.some((text) => /Hebrew|Chinese/.test(text)));
    const asked = (await fsp.readFile(record, 'utf8')).split('\n').filter(Boolean);
    assert.ok(asked.includes(':lang=ja family') && asked.includes(':lang=ar family'), `fc-list was asked for the languages: ${asked}`);

    // a machine without fc-list: the warning says it could not be checked, and nothing throws
    const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-nopath-'));
    try {
      const missing = await withPath(empty, () => fonts.fontWarnings(['ja']));
      assert.equal(missing.length, 1);
      assert.match(missing[0], /fc-list is not available/);
      assert.match(missing[0], /fonts-noto-cjk/);
    } finally {
      await fsp.rm(empty, { recursive: true, force: true });
    }

    // the injected list
    assert.deepEqual(await fonts.fontWarnings(['he'], { list: async () => 'Some Font\n' }), []);
    assert.equal((await fonts.fontWarnings(['he'], { list: async () => '  \n' })).length, 1);
    assert.deepEqual(await fonts.fontWarnings(['xx']), [], 'an unknown script is not asked about');

    // the notes of a script: the notes of the script and the warnings
    const script = build(timing('ja+he'), { style: 'karaoke' });
    assert.deepEqual(script.scripts, ['ja', 'he']);
    const notes = await withFake(() => fonts.captionNotes(script));
    assert.equal(notes.length, 2, 'the note about right to left and the warning about Japanese');
    assert.match(notes[0], /Right-to-left/);
    assert.match(notes[1], /Japanese/);
    assert.deepEqual(await fonts.captionNotes(null), []);
    assert.deepEqual(await withFake(() => fonts.captionNotes(build(lineTiming('Copper kites'), { style: 'karaoke' }))), [], 'Latin text: nothing');

    await testNodeLog(dir, record, withFake);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function timing(kind) {
  if (kind === 'ja+he') return { version: 1, lines: [{ text: '今日はいい天気', start: 1, end: 3 }, { text: HE, start: 4, end: 7 }] };
  throw new Error(kind);
}

// The node "Burn in captions" puts these sentences in its log and still makes the captions
async function testNodeLog(dir, record, withFake) {
  if (!ffmpeg.binaries().available) {
    console.log('SKIP node log: ffmpeg is missing');
    return;
  }
  const h = await createEditHarness({ prefix: 'ocd-captions-scripts-' });
  const original = process.env.FFMPEG_PATH;
  try {
    await h.ff(['-f', 'lavfi', '-i', 'color=c=0x000000:s=320x180:r=25', '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', h.src('clip.mp4')]);
    const clip = await h.upload('clip.mp4', '.mp4');
    const fake = await createFakeFfmpeg(h.dir, { filters: ['ass'], name: 'ffmpeg-record' });
    process.env.FFMPEG_PATH = fake.file;
    ffmpeg.resetFilterCache();
    const definition = h.def('video.captions');
    const runWith = async (timingValue, raw) => {
      const logs = [];
      const ctx = { ...h.makeCtx(), log: (line) => logs.push(line) };
      const result = await definition.execute(ctx, { video: clip, timing: { type: 'text', value: JSON.stringify(timingValue) } }, h.params('video.captions', raw));
      return { logs, result };
    };

    await fsp.writeFile(record, '');
    const hebrew = await withFake(() => runWith({ version: 1, lines: [{ text: HE, start: 1, end: 4 }] }, { style: 'karaoke' }));
    assert.equal(hebrew.result.variants.length, 1, 'the captions are made');
    assert.ok(hebrew.logs.some((line) => /Right-to-left/.test(line)), `the log names the style that was used: ${hebrew.logs}`);
    assert.ok(!hebrew.logs.some((line) => /font/i.test(line)), 'a font for Hebrew exists in the fake');
    const [call] = await fake.calls();
    assert.match(call.ass, /,-1\n/, 'the script of the call has the encoding -1');
    assert.ok(!/\\kf/.test(call.ass), 'no karaoke fill');

    await fake.reset();
    const japanese = await withFake(() => runWith({ version: 1, lines: [{ text: JA, start: 1, end: 4 }] }, { style: 'karaoke' }));
    assert.equal(japanese.result.variants.length, 1, 'the missing font does not stop the captions');
    assert.equal(japanese.logs.filter((line) => /Japanese/.test(line)).length, 1, `one warning: ${japanese.logs}`);
    assert.match(japanese.logs.find((line) => /Japanese/.test(line)), /fonts-noto-cjk/);
    assert.equal((await fake.calls()).length, 1, 'ffmpeg ran');
    assert.ok(!japanese.logs.some((line) => /Right-to-left/.test(line)));

    await fake.reset();
    const latin = await withFake(() => runWith({ version: 1, lines: [{ text: 'Copper kites over the bay', start: 1, end: 4 }] }, { style: 'karaoke' }));
    assert.deepEqual(latin.logs, [], 'Latin text: the log has nothing to add');
  } finally {
    if (original === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = original;
    ffmpeg.resetFilterCache();
    await fsp.rm(h.dir, { recursive: true, force: true });
    await Promise.all(h.created.map((id) => h.workflows.deleteWorkflow?.(id).catch(() => {})));
  }
}

async function main() {
  testColumns();
  testCjkWrapping();
  testMixedWidth();
  testCjkScript();
  testRtl();
  testScriptsOf();
  await testLibassPicture();
  await testFonts();
  console.log('test-captions-scripts.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
