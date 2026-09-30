'use strict';

// The paste parser shared by the browser and the server (public/email-list.js): addresses out of Excel columns,
// Outlook / Gmail recipient lists, CSV files and free text; lower case, no duplicates, invalid pieces reported.
// No server, no network.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const parser = require('../public/email-list');

const parse = (text) => parser.parse(text);

function testPlainLists() {
  // one per line, comma, semicolon, tab, space and mixtures
  const expected = ['anna@example.com', 'ben@example.org', 'cleo@example.net'];
  for (const text of [
    'anna@example.com\nben@example.org\ncleo@example.net',
    'anna@example.com, ben@example.org, cleo@example.net',
    'anna@example.com; ben@example.org; cleo@example.net',
    'anna@example.com\tben@example.org\tcleo@example.net',
    'anna@example.com ben@example.org  cleo@example.net',
    'anna@example.com,\r\nben@example.org;\r\n\r\ncleo@example.net\r\n',
    '  anna@example.com ,ben@example.org;\tcleo@example.net  '
  ]) {
    assert.deepEqual(parse(text).emails, expected, JSON.stringify(text));
  }
  // lower case, duplicates once, in the order of appearance
  const result = parse('Anna@Example.COM\nben@example.org\nANNA@example.com\nanna@example.com');
  assert.deepEqual(result.emails, ['anna@example.com', 'ben@example.org']);
  assert.equal(result.found, 4);
  assert.equal(result.duplicates, 2);
  assert.deepEqual(result.invalid, []);
}

function testExcel() {
  // copied cells: header row, first name, last name, address, more columns
  const sheet = [
    'Vorname\tNachname\tE-Mail\tFirma',
    'Anna\tMuster\tanna.muster@example.com\tExample AG',
    'Ben\tBeispiel\tben@example.org\t',
    'Cleo\tTest\t\tExample GmbH',
    'Dan\tDoe\tDAN.DOE@Example.NET\tX'
  ].join('\n');
  const result = parse(sheet);
  assert.deepEqual(result.emails, ['anna.muster@example.com', 'ben@example.org', 'dan.doe@example.net']);
  // the row without an address is reported (somebody forgot it), the header row is not
  assert.deepEqual(result.invalid, ['Cleo Test Example GmbH']);
  // one column
  assert.deepEqual(parse('E-Mail\nanna@example.com\nben@example.org\n').emails, ['anna@example.com', 'ben@example.org']);
  assert.deepEqual(parse('E-Mail\nanna@example.com\nben@example.org\n').invalid, []);
  // a column of quoted cells (Numbers, Google Sheets)
  assert.deepEqual(parse('"anna@example.com"\n"ben@example.org"').emails, ['anna@example.com', 'ben@example.org']);
}

function testOutlook() {
  const outlook = 'Anna Muster <anna.muster@example.com>; "Beispiel, Ben" <ben@example.org>; Cleo Test (Extern) <cleo@example.net>;';
  assert.deepEqual(parse(outlook).emails, ['anna.muster@example.com', 'ben@example.org', 'cleo@example.net']);
  assert.deepEqual(parse(outlook).invalid, []);
  // Gmail / Apple Mail: commas between the entries, names with commas in quotes
  const gmail = '"Muster, Anna" <anna@example.com>, Ben Beispiel <ben@example.org>, <cleo@example.net>';
  assert.deepEqual(parse(gmail).emails, ['anna@example.com', 'ben@example.org', 'cleo@example.net']);
  // one entry per line with names in front, name behind in brackets, mailto links
  assert.deepEqual(parse('Anna anna@example.com\nben@example.org (Ben Beispiel)\nmailto:cleo@example.net').emails, [
    'anna@example.com',
    'ben@example.org',
    'cleo@example.net'
  ]);
  assert.deepEqual(parse('<anna@example.com>').emails, ['anna@example.com']);
}

function testCsv() {
  const csv = [
    '"Name","Email","Company"',
    '"Muster, Anna","anna@example.com","Example AG"',
    'Ben Beispiel,ben@example.org,"Firma; Sohn"',
    ',cleo@example.net,',
    'Dan,not-an-address,Example'
  ].join('\r\n');
  const result = parse(csv);
  assert.deepEqual(result.emails, ['anna@example.com', 'ben@example.org', 'cleo@example.net']);
  assert.deepEqual(result.invalid, ['Dan,not-an-address,Example']);
  // semicolon CSV of a Swiss Excel
  assert.deepEqual(parse('Name;E-Mail\nAnna;anna@example.com\nBen;ben@example.org').emails, ['anna@example.com', 'ben@example.org']);
  // with a byte order mark and non-breaking spaces from a web page
  assert.deepEqual(parse('﻿anna@example.com ben@example.org').emails, ['anna@example.com', 'ben@example.org']);
}

function testInvalidPieces() {
  const result = parse('anna@example.com\nkaputt@\n@example.com\nnoch@eins@zwei.com\nohne-at.example.com\nspace @example.com\nx@y\nben@example.org');
  assert.deepEqual(result.emails, ['anna@example.com', 'ben@example.org']);
  assert.ok(result.invalid.includes('kaputt@'));
  assert.ok(result.invalid.includes('@example.com'));
  assert.ok(result.invalid.includes('noch@eins@zwei.com'));
  assert.ok(result.invalid.includes('ohne-at.example.com'));
  assert.ok(result.invalid.includes('x@y'));
  // trailing punctuation of a sentence is not part of the address
  assert.deepEqual(parse('Bitte an anna@example.com, ben@example.org. Danke!').emails, ['anna@example.com', 'ben@example.org']);
  // invalid pieces are listed once
  assert.deepEqual(parse('kaputt@\nkaputt@\nKAPUTT@').invalid, ['kaputt@']);
  // very long junk is cut
  assert.ok(parse('x'.repeat(500)).invalid[0].length <= 120);
  // nothing in, nothing out
  for (const input of ['', '   \n\t ', null, undefined, 42, {}]) {
    assert.deepEqual(parse(input), { emails: [], invalid: [], found: 0, duplicates: 0 });
  }
  // a list of strings is read as lines
  assert.deepEqual(parser.parse(['anna@example.com', 'ben@example.org, cleo@example.net']).emails, ['anna@example.com', 'ben@example.org', 'cleo@example.net']);
}

function testIsValid() {
  for (const good of ['a@example.com', 'first.last+tag@sub.example.co.uk', "o'brien@example.ie", 'ana@bücher.ch', 'x_y-z@ex-ample.com', 'ANNA@EXAMPLE.COM']) {
    assert.equal(parser.isValid(good), true, good);
  }
  for (const bad of ['', 'a', 'a@b', 'a@b.', 'a@.com', '@x.com', 'a b@x.com', 'a@@x.com', 'a..b@x.com', '.a@x.com', 'a.@x.com', 'a@-x.com', 'a@x-.com', 'a@x.c', `${'a'.repeat(65)}@x.com`, `a@${'b'.repeat(250)}.com`, null, 3]) {
    assert.equal(parser.isValid(bad), false, String(bad));
  }
  // agrees with the lenient check of the server: whatever the parser accepts, the server accepts too
  const access = require('../lib/access');
  for (const good of parse('a@example.com b.c+d@sub.example.org o.o@example.ch').emails) assert.equal(access.normalizeEmail(good), good);
}

function testClassify() {
  const parsed = parse('anna@example.com\nben@example.org\ncleo@example.net');
  const { fresh, already } = parser.classify(parsed, ['ben@example.org']);
  assert.deepEqual(fresh, ['anna@example.com', 'cleo@example.net']);
  assert.deepEqual(already, ['ben@example.org']);
  assert.deepEqual(parser.classify(parsed, new Set(['anna@example.com'])).fresh, ['ben@example.org', 'cleo@example.net']);
  assert.deepEqual(parser.classify({ emails: [] }, []), { fresh: [], already: [] });
}

function testScale() {
  // 500 addresses with names, pasted at once, parse quickly
  const lines = Array.from({ length: 500 }, (_, i) => `Person ${i}\tp${i}@example.com`).join('\n');
  const started = Date.now();
  const result = parse(lines);
  assert.equal(result.emails.length, 500);
  assert.ok(Date.now() - started < 500, 'parsing 500 lines is instant');
}

// Loaded as a plain script in the browser: it puts OCEmailList on window and touches nothing else.
function testBrowserLoad() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'email-list.js'), 'utf8');
  const window = {};
  vm.runInNewContext(source, { window }, { filename: 'public/email-list.js' });
  assert.equal(typeof window.OCEmailList.parse, 'function');
  assert.deepEqual([...window.OCEmailList.parse('Anna <ANNA@example.com>').emails], ['anna@example.com']); // arrays of another realm are copied
  assert.deepEqual(Object.keys(window), ['OCEmailList']);
  // no DOM, no network, no storage, no dialogs
  assert.ok(!/document\.|innerHTML|fetch\(|localStorage|alert\(|confirm\(|prompt\(/.test(source));
  // the node module does not pollute the global object
  assert.equal(typeof globalThis.OCEmailList, 'undefined');
}

testPlainLists();
testExcel();
testOutlook();
testCsv();
testInvalidPieces();
testIsValid();
testClassify();
testScale();
testBrowserLoad();
console.log('E-Mail-Liste: Zeilen, Komma, Semikolon, Tabs (Excel), Outlook-Namen, CSV, ungueltige Stuecke, Doppelte und der Einsatz im Browser sind korrekt.');
