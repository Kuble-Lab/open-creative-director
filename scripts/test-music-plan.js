'use strict';

// The readable plan format of the music nodes (public/nodes/music-plan.js): reading, writing, the round trip, the limits
// of the Music API, errors with line numbers (and their texts in German, English and Spanish), escapes and the translation
// from and to the composition plans of the API (sections for music_v1, chunks for music_v2 and music_v2_5). Pure module,
// no network.

const assert = require('assert/strict');

const plan = require('../public/nodes/music-plan');
const { rows } = require('../public/nodes/i18n-nodes');

const EXAMPLE = `+ indie pop, warm female vocals, 100 bpm
- autotune

[Verse 1 | 20 s]
+ soft acoustic guitar
First line of the verse
Second line

[Chorus | 0:15]
Line of the chorus`;

const strip = (parsed) => JSON.parse(JSON.stringify(parsed.plan));
const codes = (text) => plan.parse(text).errors.map((error) => `${error.code}@${error.line}`);

function testReading() {
  const parsed = plan.parse(EXAMPLE);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(strip(parsed), {
    positive: ['indie pop', 'warm female vocals', '100 bpm'],
    negative: ['autotune'],
    sections: [
      { name: 'Verse 1', durationMs: 20000, positive: ['soft acoustic guitar'], negative: [], lines: ['First line of the verse', 'Second line'] },
      { name: 'Chorus', durationMs: 15000, positive: [], negative: [], lines: ['Line of the chorus'] }
    ]
  });
  assert.equal(plan.totalMs(parsed.plan), 35000);
  assert.equal(plan.lengthOfText(EXAMPLE), 35000);
  // several style lines add up, blank lines and surrounding spaces are ignored, CRLF and a BOM do not matter
  const loose = plan.parse('﻿  + a ,b\r\n+ c\r\n\r\n  [Verse|3s]  \r\n   La   \r\n\r\n   \r\n');
  assert.deepEqual(loose.errors, []);
  assert.deepEqual(strip(loose), { positive: ['a', 'b', 'c'], negative: [], sections: [{ name: 'Verse', durationMs: 3000, positive: [], negative: [], lines: ['La'] }] });
  // a section without lines (instrumental) and a name with a bar in it
  const named = plan.parse('[Solo | A | 10 s]');
  assert.deepEqual(named.errors, []);
  assert.deepEqual(strip(named).sections, [{ name: 'Solo | A', durationMs: 10000, positive: [], negative: [], lines: [] }]);
  // no name at all (a chunk plan may have none)
  assert.deepEqual(strip(plan.parse('[| 8 s]\nla')).sections[0], { name: '', durationMs: 8000, positive: [], negative: [], lines: ['la'] });
}

function testDurations() {
  for (const [text, ms] of [['20 s', 20000], ['20s', 20000], ['0:20', 20000], ['1:05', 65000], ['12.5 s', 12500], ['12,5s', 12500], ['0:12.5', 12500], ['2:00', 120000], ['3 S', 3000]]) {
    assert.equal(plan.parseDuration(text), ms, text);
  }
  for (const text of ['20', 's', '', 'abc', '1:75', '-5 s', '20 min', '1:2:3']) assert.equal(plan.parseDuration(text), null, text);
  assert.equal(plan.formatDuration(20000), '20 s');
  assert.equal(plan.formatDuration(12500), '12.5 s');
  assert.equal(plan.formatDuration(65000), '65 s');
  assert.equal(plan.formatDuration(3001), '3.001 s');
}

function testEscapes() {
  const parsed = plan.parse('[Verse | 10 s]\n\\+ one plus\n\\- one minus\n\\[not a header]\n\\\\ a backslash\n\\n stays\n+ real style');
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.plan.sections[0].lines, ['+ one plus', '- one minus', '[not a header]', '\\ a backslash', '\\n stays']);
  assert.deepEqual(parsed.plan.sections[0].positive, ['real style']);
  const text = plan.stringify(parsed.plan);
  assert.equal(text, '[Verse | 10 s]\n+ real style\n\\+ one plus\n\\- one minus\n\\[not a header]\n\\\\ a backslash\n\\\\n stays');
  assert.deepEqual(strip(plan.parse(text)), strip(parsed));
}

function testRoundTrip() {
  // text -> plan -> text is the same for canonical text
  const canonical = plan.stringify(plan.parse(EXAMPLE).plan);
  assert.equal(canonical, EXAMPLE.replace('[Chorus | 0:15]', '[Chorus | 15 s]'));
  assert.equal(plan.stringify(plan.parse(canonical).plan), canonical);
  // plan -> text -> plan is the same plan, for lines that look like syntax, odd names and half seconds
  const tricky = {
    positive: ['pop', 'a b'],
    negative: ['x'],
    sections: [
      { name: 'A [1]', durationMs: 12500, positive: ['s1'], negative: ['n1'], lines: ['+x', '-y', '[z]', '\\w', '{guitar solo}', '(ooh)', 'ÄÖÜ é €'] },
      { name: '', durationMs: 3000, positive: [], negative: [], lines: [] },
      { name: 'B | C', durationMs: 120000, positive: [], negative: [], lines: ['last'] }
    ]
  };
  const text = plan.stringify(tricky);
  const back = plan.parse(text);
  assert.deepEqual(back.errors, []);
  assert.deepEqual(strip(back), tricky);
  assert.equal(plan.stringify(back.plan), text);
  // an empty plan writes nothing, global styles alone are fine as text
  assert.equal(plan.stringify({ positive: [], negative: [], sections: [] }), '');
  assert.equal(plan.stringify({ positive: ['a'], negative: [], sections: [] }), '+ a');
}

function testLimits() {
  const section = (extra = '', body = 'la') => `[S | ${extra || '10 s'}]\n${body}`;
  assert.deepEqual(codes(section('3 s')), []);
  assert.deepEqual(codes(section('120 s')), []);
  assert.deepEqual(codes(section('2.999 s')), ['MUSIC_PLAN_DURATION_RANGE@1']);
  assert.deepEqual(codes(section('2:01')), ['MUSIC_PLAN_DURATION_RANGE@1']);
  // 30 lines of 200 characters are the most
  assert.deepEqual(codes(section('', Array(30).fill('x'.repeat(200)).join('\n'))), []);
  const tooMany = plan.parse(section('', Array(31).fill('la').join('\n'))).errors;
  assert.deepEqual(tooMany.map((e) => [e.code, e.line, e.data.max, e.data.count]), [['MUSIC_PLAN_LINES_MAX', 1, 30, 31]]);
  const tooLong = plan.parse(`[S | 10 s]\nok\n${'x'.repeat(201)}`).errors;
  assert.deepEqual(tooLong.map((e) => [e.code, e.line, e.data.count]), [['MUSIC_PLAN_LINE_CHARS', 3, 201]]);
  assert.deepEqual(codes(`[S | 10 s]\n${'😀'.repeat(200)}`), [], 'characters, not UTF-16 units');
  assert.deepEqual(codes(`[${'n'.repeat(100)} | 10 s]`), []);
  assert.deepEqual(codes(`[${'n'.repeat(101)} | 10 s]`), ['MUSIC_PLAN_NAME_CHARS@1']);
  // the whole song: 10 minutes; the error sits on the section that goes over
  const sections = (count, seconds) => Array.from({ length: count }, (_, i) => `[P${i} | ${seconds} s]`).join('\n');
  assert.deepEqual(codes(sections(10, 60)), []);
  assert.deepEqual(codes(`${sections(10, 60)}\n[Over | 3 s]`), ['MUSIC_PLAN_TOTAL_MAX@11']);
  assert.deepEqual(codes(sections(6, 120)), ['MUSIC_PLAN_TOTAL_MAX@6'], 'reported once');
  // 30 sections are the most
  assert.deepEqual(codes(sections(30, 10)), []);
  assert.deepEqual(codes(sections(31, 10)), ['MUSIC_PLAN_SECTIONS_MAX@31']);
  // 50 styles per list
  assert.deepEqual(codes(`+ ${Array.from({ length: 50 }, (_, i) => `s${i}`).join(', ')}\n[S | 10 s]`), []);
  assert.deepEqual(codes(`\n+ ${Array.from({ length: 51 }, (_, i) => `s${i}`).join(', ')}\n[S | 10 s]`), ['MUSIC_PLAN_STYLES_MAX@2']);
  assert.deepEqual(codes(`[S | 10 s]\n- ${Array.from({ length: 51 }, (_, i) => `s${i}`).join(', ')}`), ['MUSIC_PLAN_STYLES_MAX@2']);
  // a chunk plan has no global styles: they count with the first chunk
  const twenty = (prefix) => Array.from({ length: 30 }, (_, i) => `${prefix}${i}`).join(', ');
  const merged = plan.parse(`+ ${twenty('g')}\n[S | 10 s]\n+ ${twenty('l')}`);
  assert.deepEqual(merged.errors, []);
  assert.deepEqual(plan.validate(merged.plan, merged.positions, { model: 'music_v2_5' }).map((e) => [e.code, e.line]), [['MUSIC_PLAN_STYLES_MAX', 3]]);
  assert.deepEqual(plan.validate(merged.plan, merged.positions, { model: 'music_v1' }), []);
  assert.equal(plan.LIMITS.maxLengthMs, 600000);
}

// Chunk models (music_v2, music_v2_5): the API allows 30 lines in a chunk text, and the section name is one of them.
function testChunkLimits() {
  const body = (count) => Array(count).fill('la').join('\n');
  const chunks = (text, model = 'music_v2_5') => plan.parse(text, { model }).errors.map((e) => `${e.code}@${e.line}`);
  // named section: 29 song lines fit (29 + the name line = 30), 30 do not
  assert.deepEqual(chunks(`[S | 10 s]\n${body(29)}`), []);
  assert.deepEqual(chunks(`[S | 10 s]\n${body(30)}`), ['MUSIC_PLAN_LINES_MAX_CHUNK@1']);
  const error = plan.parse(`[S | 10 s]\n${body(30)}`, { model: 'music_v2' }).errors[0];
  assert.deepEqual([error.data.max, error.data.count], [29, 30]);
  assert.match(error.message, /^Line 1: With this model the section line counts as one of 30 lines, so a named section has 29 song lines at most \(this one: 30\)\.$/);
  // what toApi sends really stays within 30 lines
  const accepted = plan.parse(`[S | 10 s]\n${body(29)}`).plan;
  assert.equal(plan.toApi(accepted, 'music_v2_5').chunks[0].text.split('\n').length, 30);
  // 31 lines of a named section: the same code (the limit of the model), not the plain one
  assert.deepEqual(chunks(`[S | 10 s]\n${body(31)}`), ['MUSIC_PLAN_LINES_MAX_CHUNK@1']);
  // a nameless section has no name line: 30 song lines fit
  assert.deepEqual(chunks(`[| 10 s]\n${body(30)}`), []);
  assert.deepEqual(chunks(`[| 10 s]\n${body(31)}`), ['MUSIC_PLAN_LINES_MAX@1']);
  // music_v1 has no name line in the lines: 30 song lines fit, and no model means no model rule
  assert.deepEqual(chunks(`[S | 10 s]\n${body(30)}`, 'music_v1'), []);
  assert.deepEqual(plan.parse(`[S | 10 s]\n${body(30)}`).errors, []);
  // validate() with the model gives the same
  const parsed = plan.parse(`[S | 10 s]\n${body(30)}`);
  assert.deepEqual(plan.validate(parsed.plan, parsed.positions, { model: 'music_v2_5' }).map((e) => [e.code, e.line]), [['MUSIC_PLAN_LINES_MAX_CHUNK', 1]]);

  // a nameless section whose first song line starts with "[": a chunk text would read the line as the name
  const nameless = '[| 10 s]\n\\[Intro]\nx';
  assert.equal(plan.parse(nameless).plan.sections[0].lines[0], '[Intro]', 'the text format itself is fine');
  assert.deepEqual(chunks(nameless), ['MUSIC_PLAN_NAME_NEEDED@2']);
  assert.deepEqual(chunks(nameless, 'music_v1'), [], 'music_v1 keeps the lines apart from the name');
  assert.deepEqual(chunks('[| 10 s]\nx\n\\[Intro]'), [], 'only the first line is read as a name');
  assert.deepEqual(chunks('[Verse | 10 s]\n\\[Intro]\nx'), [], 'with a name the first line is a line');
  // without the rule the round trip would change the name: 'Intro' instead of a line
  const lost = plan.fromApi(plan.toApi(plan.parse(nameless).plan, 'music_v2_5'));
  assert.equal(lost.sections[0].name, 'Intro');
}

// Misuse must not crash: one line with very many styles is counted, not spread into a call.
function testHugeInput() {
  const many = Array.from({ length: 150000 }, (_, i) => `s${i}`).join(',');
  const started = Date.now();
  const wide = plan.parse(`+ ${many}\n[S | 10 s]\nla`);
  assert.deepEqual(wide.errors.map((e) => `${e.code}@${e.line}`), ['MUSIC_PLAN_STYLES_MAX@1']);
  assert.equal(wide.plan.positive.length, 150000);
  const local = plan.parse(`[S | 10 s]\n- ${many}`);
  assert.deepEqual(local.errors.map((e) => `${e.code}@${e.line}`), ['MUSIC_PLAN_STYLES_MAX@2']);
  assert.equal(plan.parse(`+ ${many}\n[S | 10 s]`, { model: 'music_v2_5' }).errors[0].code, 'MUSIC_PLAN_STYLES_MAX');
  assert.ok(Date.now() - started < 5000, 'quick');
}

function testSyntaxErrors() {
  assert.deepEqual(codes(''), ['MUSIC_PLAN_EMPTY@null']);
  assert.deepEqual(codes('+ a, b'), ['MUSIC_PLAN_EMPTY@null']);
  assert.deepEqual(codes('\n\nla la\n[Verse | 10 s]\nlo'), ['MUSIC_PLAN_TEXT_OUTSIDE@3']);
  assert.deepEqual(codes('la\nle\n[Verse | 10 s]'), ['MUSIC_PLAN_TEXT_OUTSIDE@1'], 'reported once');
  assert.deepEqual(codes('[Verse | 10 s'), ['MUSIC_PLAN_BAD_HEADER@1']);
  assert.deepEqual(codes('[Verse]'), ['MUSIC_PLAN_DURATION_MISSING@1']);
  assert.deepEqual(codes('[Verse | ]'), ['MUSIC_PLAN_DURATION_MISSING@1']);
  assert.deepEqual(codes('[A | 10 s]\n\n[Verse | soon]'), ['MUSIC_PLAN_DURATION_BAD@3']);
  const bad = plan.parse('[A | 10 s]\nla\n[B | x]\nlo');
  assert.equal(bad.errors[0].data.text, 'x');
  assert.equal(bad.errors[0].data.line, 3);
  assert.equal(bad.plan.sections.length, 2, 'the plan is read as far as possible');
  // several problems: sorted by line
  assert.deepEqual(codes('[A | 1 s]\nla\n[B | zz]\n[C | 10 s]\n' + 'x'.repeat(201)), ['MUSIC_PLAN_DURATION_RANGE@1', 'MUSIC_PLAN_DURATION_BAD@3', 'MUSIC_PLAN_LINE_CHARS@5']);
  // English fallback sentence with the line
  assert.equal(plan.parse('[A | 1 s]').errors[0].message, 'Line 1: A section lasts 3 to 120 seconds (this one: 1 s).');
  assert.equal(plan.parse('').errors[0].message, 'The plan has no section. Start one with a line such as [Verse | 20 s].');
  assert.equal(plan.parse('').errors[0].line, null);
  // the English fallback of the total length names minutes, not seconds divided by 60 twice
  const long = plan.parse(Array.from({ length: 6 }, () => '[A | 120 s]').join('\n')).errors[0];
  assert.equal(long.message, 'Line 6: The song may last 10 minutes at most.');
}

// Every error has a text in German, English and Spanish (nodes.issue.<code>) that names the line and every value it
// needs; the sharp s is never used.
function testErrorTexts() {
  const dictionary = { de: {}, en: {}, es: {} };
  for (const row of rows) {
    dictionary.de[row[0]] = row[1];
    dictionary.en[row[0]] = row[2];
    dictionary.es[row[0]] = row[3];
  }
  const samples = {
    MUSIC_PLAN_EMPTY: '',
    MUSIC_PLAN_TEXT_OUTSIDE: 'la',
    MUSIC_PLAN_BAD_HEADER: '[A | 10 s',
    MUSIC_PLAN_DURATION_MISSING: '[A]',
    MUSIC_PLAN_DURATION_BAD: '[A | x]',
    MUSIC_PLAN_DURATION_RANGE: '[A | 1 s]',
    MUSIC_PLAN_TOTAL_MAX: Array.from({ length: 6 }, () => '[A | 120 s]').join('\n'),
    MUSIC_PLAN_SECTIONS_MAX: Array.from({ length: 31 }, () => '[A | 3 s]').join('\n'),
    MUSIC_PLAN_LINES_MAX: `[A | 10 s]\n${Array(31).fill('la').join('\n')}`,
    MUSIC_PLAN_LINES_MAX_CHUNK: [`[A | 10 s]\n${Array(30).fill('la').join('\n')}`, { model: 'music_v2_5' }],
    MUSIC_PLAN_NAME_NEEDED: [`[| 10 s]\n\\[Intro]\nla`, { model: 'music_v2' }],
    MUSIC_PLAN_LINE_CHARS: `[A | 10 s]\n${'x'.repeat(201)}`,
    MUSIC_PLAN_NAME_CHARS: `[${'n'.repeat(101)} | 10 s]`,
    MUSIC_PLAN_STYLES_MAX: `+ ${Array.from({ length: 51 }, (_, i) => `s${i}`).join(', ')}\n[A | 10 s]`
  };
  assert.deepEqual(Object.keys(samples).sort(), [...plan.ERROR_CODES].sort(), 'a sample for every error code');
  for (const [code, sample] of Object.entries(samples)) {
    const [text, options] = Array.isArray(sample) ? sample : [sample, undefined];
    const error = plan.parse(text, options).errors.find((item) => item.code === code);
    assert.ok(error, `${code} is reported for its sample`);
    for (const lang of ['de', 'en', 'es']) {
      const template = dictionary[lang][`nodes.issue.${code}`];
      assert.ok(template, `${lang}: nodes.issue.${code}`);
      assert.equal(template.includes('ß'), false, `${lang}.${code}`);
      const needed = [...template.matchAll(/\{([a-zA-Z]+)\}/g)].map((match) => match[1]);
      for (const name of needed) assert.ok(name in error.data, `${lang}.${code} needs ${name}, the error has ${Object.keys(error.data)}`);
      if (error.line) assert.ok(needed.includes('line'), `${lang}.${code} names the line`);
      const shown = template.replace(/\{([a-zA-Z]+)\}/g, (_, name) => String(error.data[name]));
      if (error.line) assert.match(shown, new RegExp(`\\b${error.line}\\b`), `${lang}.${code}: ${shown}`);
      assert.doesNotMatch(shown, /[{}]/, `${lang}.${code}: ${shown}`);
    }
  }
  assert.match(dictionary.de['nodes.issue.MUSIC_PLAN_LINES_MAX'], /^Zeile \{line\}/);
  assert.match(dictionary.en['nodes.issue.MUSIC_PLAN_LINES_MAX'], /^Line \{line\}/);
  assert.match(dictionary.es['nodes.issue.MUSIC_PLAN_LINES_MAX'], /^Línea \{line\}/);
}

function testApiShapes() {
  const parsed = plan.parse(EXAMPLE).plan;
  // music_v1: global styles and sections
  const v1 = plan.toApi(parsed, 'music_v1');
  assert.deepEqual(v1, {
    positive_global_styles: ['indie pop', 'warm female vocals', '100 bpm'],
    negative_global_styles: ['autotune'],
    sections: [
      { section_name: 'Verse 1', positive_local_styles: ['soft acoustic guitar'], negative_local_styles: [], duration_ms: 20000, lines: ['First line of the verse', 'Second line'] },
      { section_name: 'Chorus', positive_local_styles: [], negative_local_styles: [], duration_ms: 15000, lines: ['Line of the chorus'] }
    ]
  });
  assert.deepEqual(plan.fromApi(v1), parsed, 'v1 keeps everything: the round trip through the API shape is lossless');
  // music_v2 and music_v2_5: chunks; the global styles go to the front of the first chunk
  for (const model of ['music_v2', 'music_v2_5']) {
    const chunks = plan.toApi(parsed, model);
    assert.deepEqual(chunks, {
      chunks: [
        { text: '[Verse 1]\nFirst line of the verse\nSecond line', duration_ms: 20000, positive_styles: ['indie pop', 'warm female vocals', '100 bpm', 'soft acoustic guitar'], negative_styles: ['autotune'] },
        { text: '[Chorus]\nLine of the chorus', duration_ms: 15000, positive_styles: [], negative_styles: [] }
      ]
    });
    const back = plan.fromApi(chunks);
    assert.deepEqual(back.positive, []);
    assert.deepEqual(back.sections[0].positive, ['indie pop', 'warm female vocals', '100 bpm', 'soft acoustic guitar']);
    // from then on it is stable: chunks -> text -> chunks is the same
    assert.deepEqual(plan.toApi(plan.parse(plan.stringify(back)).plan, model), chunks);
  }
  assert.equal(plan.shapeOf('music_v1'), 'sections');
  assert.equal(plan.shapeOf('music_v2'), 'chunks');
  assert.equal(plan.shapeOf('music_v2_5'), 'chunks');
  // sections without a name get one (the API wants 1 to 100 characters); chunks without a header have none
  const unnamed = plan.parse('[| 5 s]\nla').plan;
  assert.equal(plan.toApi(unnamed, 'music_v1').sections[0].section_name, 'Part 1');
  assert.equal(plan.toApi(unnamed, 'music_v2_5').chunks[0].text, 'la');
  assert.equal(plan.toApi(plan.parse('[| 5 s]').plan, 'music_v2_5').chunks[0].text, '');
}

function testFromApi() {
  // the example of the docs (camelCase of the SDKs) and the raw REST shape (snake_case) read the same
  const sdk = plan.fromApi({
    chunks: [{ text: '[Intro]', durationMs: 3000, positiveStyles: ['electronic', 'fast-paced'], negativeStyles: ['soft pads', 'melodic vocals'], contextAdherence: 'high' }]
  });
  assert.deepEqual(sdk, { positive: [], negative: [], sections: [{ name: 'Intro', durationMs: 3000, positive: ['electronic', 'fast-paced'], negative: ['soft pads', 'melodic vocals'], lines: [] }] });
  const rest = plan.fromApi({ chunks: [{ text: '[Intro]', duration_ms: 3000, positive_styles: ['electronic', 'fast-paced'], negative_styles: ['soft pads', 'melodic vocals'] }] });
  assert.deepEqual(rest, sdk);
  // a chunk without a header, multi-line text, inline directions and sounds stay lines; blank lines go; negative styles are optional
  const free = plan.fromApi({ chunks: [{ text: 'first\n\n  {scratching}  \n(ooh)', duration_ms: 5000, positive_styles: ['hip hop'] }] });
  assert.deepEqual(free.sections[0], { name: '', durationMs: 5000, positive: ['hip hop'], negative: [], lines: ['first', '{scratching}', '(ooh)'] });
  // styles with a comma and names with line breaks are made safe for the text format
  const messy = plan.fromApi({ positive_global_styles: ['pop, rock'], negative_global_styles: [], sections: [{ section_name: 'Verse\n1', positive_local_styles: [], negative_local_styles: [], duration_ms: 4000, lines: ['a\nb', ' '] }] });
  assert.deepEqual(messy.positive, ['pop', 'rock']);
  assert.deepEqual(messy.sections[0], { name: 'Verse 1', durationMs: 4000, positive: [], negative: [], lines: ['a', 'b'] });
  assert.deepEqual(plan.parse(plan.stringify(messy)).errors, []);
  // something else
  assert.throws(() => plan.fromApi({ hello: 1 }), (error) => error.code === 'MUSIC_PLAN_SHAPE');
  assert.throws(() => plan.fromApi(null), (error) => error.code === 'MUSIC_PLAN_SHAPE');
}

for (const test of [testReading, testDurations, testEscapes, testRoundTrip, testLimits, testChunkLimits, testHugeInput, testSyntaxErrors, testErrorTexts, testApiShapes, testFromApi]) {
  test();
  console.log(`ok ${test.name}`);
}
console.log('test-music-plan.js: ok');
