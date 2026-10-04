'use strict';

// "Same as input" (WP38d, lib/language-detect.js): the language of a text decided by the code alone.
//   - the word lists: no word in two lists, only words of the language
//   - examples in German, English and Spanish, long and short
//   - short topics without stop words decide nothing ("Git vs GitHub"), abbreviations in capitals are not words
//   - the order of the sources: what the person wrote first, a German brief beats an English PDF
//   - nothing to go on gives English; the same input always gives the same answer
// Pure: no network, no files.

const assert = require('assert/strict');

const detect = require('../lib/language-detect');

const GERMAN = 'Die Wärmepumpe nutzt die Energie der Umgebung und macht daraus Wärme für das Haus. Sie ist effizient, wenn die Vorlauftemperatur niedrig ist.';
const ENGLISH = 'The heat pump takes the energy of the surroundings and turns it into heat for the house. It is efficient when the flow temperature is low.';
const SPANISH = 'La bomba de calor toma la energía del entorno y la convierte en calor para la casa. Es eficiente cuando la temperatura de impulsión es baja.';

function testWordLists() {
  const lists = detect.STOP_WORDS;
  assert.deepEqual(Object.keys(lists).sort(), [...detect.SUPPORTED].sort());
  for (const language of detect.SUPPORTED) {
    assert.ok(lists[language].length >= 60, `${language}: a list that is long enough to tell`);
    assert.equal(new Set(lists[language]).size, lists[language].length, `${language}: no word twice`);
    for (const word of lists[language]) assert.equal(word, word.toLowerCase(), `${language}.${word} is lower case`);
  }
  // no word is in two lists: a word that two languages share says nothing
  for (const a of detect.SUPPORTED) {
    for (const b of detect.SUPPORTED) {
      if (a >= b) continue;
      const shared = lists[a].filter((word) => lists[b].includes(word));
      assert.deepEqual(shared, [], `${a} and ${b} share ${shared.join(', ')}`);
    }
  }
  // the common homographs stay out of every list
  for (const word of ['in', 'an', 'was', 'war', 'es', 'no', 'son', 'hay', 'con', 'sin', 'will', 'also', 'man', 'bin']) {
    for (const language of detect.SUPPORTED) assert.ok(!lists[language].includes(word), `${language} must not list ${word}`);
  }
}

function testExamples() {
  assert.equal(detect.detectLanguage(GERMAN), 'de');
  assert.equal(detect.detectLanguage(ENGLISH), 'en');
  assert.equal(detect.detectLanguage(SPANISH), 'es');
  // topics as people write them
  for (const [text, language] of [
    ['Wie funktioniert Git und GitHub', 'de'],
    ['Wie funktioniert eine Wärmepumpe, und was kostet ihr Betrieb?', 'de'],
    ['How does a heat pump work, and what does it cost to run?', 'en'],
    ['Introduction to the Swiss pension system', 'en'],
    ['¿Cómo funciona una bomba de calor y cuánto cuesta usarla?', 'es'],
    ['Cómo funciona Git y GitHub', 'es'],
    ['Wärmepumpe Kosten Förderung', 'de'],
    ['Qué es la inteligencia artificial para empresas', 'es']
  ]) assert.equal(detect.detectLanguage(text), language, text);
  // a name with a special character is no evidence (review): one letter alone does not tip a topic, nor a name beside an English word
  for (const [text, language] of [
    ['El Niño effects on agriculture', 'en'],
    ['El Niño and La Niña explained', 'en'],
    ['Zürich tourism trends', 'en'],
    ['Gödel incompleteness theorem', 'en'],
    ['Müller', 'en'],
    ['Data protection under the DSGVO für KMU', 'en'],
    ['Wie funktioniert Git', 'de'],
    ['Wie funktioniert Zürich', 'de']
  ]) assert.equal(detect.detectLanguage(text), language, text);
  assert.equal(detect.classify('Zürich tourism trends').strength, 'none', 'a special character alone is not even a weak hint');
  assert.equal(detect.classify('El Niño effects on agriculture').language, null, 'one hint each way: nothing');
  // a special character counts once per word, and not again in a stop word ("für", "über")
  assert.deepEqual(detect.score('für'), { de: 1, en: 0, es: 0 });
  assert.deepEqual(detect.score('über'), { de: 1, en: 0, es: 0 });
  assert.deepEqual(detect.score('Straßenbahnübergänge'), { de: 0, en: 0, es: 0 }, 'a single name');
  assert.deepEqual(detect.score('straßenbahnübergänge'), { de: 1.5, en: 0, es: 0 }, 'a lower case word counts its strongest letter once');
  assert.equal(detect.score('niño').es, 1, 'the n with tilde is one point');
  assert.equal(detect.score('¿qué?').es, 4, 'the inverted question mark stays a strong mark');
  // names with a capital: from two on, and only while no other language speaks
  assert.equal(detect.score('Wärmepumpe Förderung').de, 2);
  assert.equal(detect.score('Wärmepumpe Förderung and').de, 0);
  // the evidence of one text
  assert.equal(detect.classify(GERMAN).strength, 'clear');
  assert.ok(detect.classify(GERMAN).scores.de > 5 && detect.classify(GERMAN).scores.en === 0);
  assert.equal(detect.classify(SPANISH).language, 'es');
  // a German text with an English phrase stays German, an English one with a German word stays English
  assert.equal(detect.detectLanguage('Wie funktioniert der Cache in the cloud und warum ist er wichtig'), 'de');
  assert.equal(detect.detectLanguage('How the Kindergarten model works for the children of the town'), 'en');
  // the special characters carry weight: umlauts for German, the marks and letters of Spanish
  assert.equal(detect.classify('Äpfel Öl Müll').language, 'de');
  assert.equal(detect.classify('España ¡Hola! ¿Qué tal?').language, 'es');
  // the marks of "Read documents" and addresses are not text of the person
  const marked = '=== D1: report.pdf (12 pages) ===\n[p. 1]\nDie Wärmepumpe nutzt Strom.\n[p. 2]\nDer Markt wächst.\nhttps://example.org/the/report/and/the/rest';
  assert.deepEqual(detect.score(marked).en, 0, 'the header, the page marks and the address say nothing about the language');
  assert.equal(detect.detectLanguage(marked), 'de');
}

function testShortTopics() {
  // no stop word, no special character: no evidence, never a coin toss
  for (const text of ['Git vs GitHub', 'GitHub Copilot vs Cursor', 'Kubernetes', 'AI', 'LA Metro', 'UN DE IT', '2026 Q3', 'Git vs. GitHub: Branches & Pull Requests']) {
    const found = detect.classify(text);
    assert.equal(found.language, null, `${text}: no language`);
    assert.equal(found.strength, 'none');
    assert.deepEqual(Object.values(found.scores), [0, 0, 0], text);
  }
  // so the next source is asked
  assert.deepEqual(
    detect.resolveLanguage([{ id: 'topic', text: 'Git vs GitHub' }, { id: 'brief', text: 'Für Einsteiger, ohne Fachbegriffe' }]),
    { language: 'de', source: 'brief', strength: 'clear' }
  );
  assert.deepEqual(
    detect.resolveLanguage([{ id: 'topic', text: 'Git vs GitHub' }, { id: 'notes', text: ENGLISH }]),
    { language: 'en', source: 'notes', strength: 'clear' }
  );
  // one hint is weak: it is not enough while another source is clear ...
  assert.equal(detect.classify('Wie funktioniert Git').strength, 'weak');
  assert.equal(detect.classify('Klimawandel in der Schweiz').strength, 'weak');
  assert.deepEqual(
    detect.resolveLanguage([{ id: 'topic', text: 'Klimawandel in der Schweiz' }, { id: 'text', text: ENGLISH }]),
    { language: 'en', source: 'text', strength: 'clear' }
  );
  // ... but better than nothing when no source is clear
  assert.deepEqual(detect.resolveLanguage([{ id: 'topic', text: 'Wie funktioniert Git' }]), { language: 'de', source: 'topic', strength: 'weak' });
  assert.deepEqual(detect.resolveLanguage([{ id: 'topic', text: 'Git vs GitHub' }, { id: 'brief', text: 'Qué es Git' }]), { language: 'es', source: 'brief', strength: 'weak' });
  // contradicting hints in one source are no evidence (and never a coin toss)
  assert.deepEqual([detect.classify('der und the and').language, detect.classify('der und the and').strength], [null, 'none'], 'two against two');
  assert.equal(detect.classify('der the').language, null, 'one against one');
}

function testOrderOfSources() {
  // a German brief beats an English PDF: the person's own words come first
  const pdf = `=== D1: report.pdf (3 pages) ===\n[p. 1]\n${ENGLISH}\n[p. 2]\n${ENGLISH}`;
  assert.deepEqual(
    detect.resolveLanguage([{ id: 'topic', text: '' }, { id: 'brief', text: 'Für den Gemeinderat, kurz und ohne Fachwörter.' }, { id: 'text', text: pdf }]),
    { language: 'de', source: 'brief', strength: 'clear' }
  );
  // without a brief the PDF decides
  assert.equal(detect.resolveLanguage([{ id: 'topic', text: '' }, { id: 'brief', text: '' }, { id: 'text', text: pdf }]).source, 'text');
  assert.equal(detect.resolveLanguage([{ id: 'brief', text: '  ' }, { id: 'text', text: pdf }]).language, 'en');
  // a German topic beats English notes, and the notes beat the list of sources
  assert.equal(detect.resolveLanguage([{ id: 'topic', text: 'Wie funktioniert Git und GitHub' }, { id: 'notes', text: ENGLISH }]).language, 'de');
  assert.equal(detect.resolveLanguage([{ id: 'notes', text: SPANISH }, { id: 'sources', text: ENGLISH }]).language, 'es');
  // sources without text and values that are not text are skipped
  assert.equal(detect.resolveLanguage([null, { id: 'a' }, { id: 'b', text: 5 }, { id: 'c', text: SPANISH }]).source, 'c');
}

function testNothingToGoOn() {
  for (const input of [[], null, undefined, [{ id: 'topic', text: '' }], [{ id: 'topic', text: '   \n ' }], [{ id: 'topic', text: 'Git vs GitHub' }]]) {
    assert.deepEqual(detect.resolveLanguage(input), { language: 'en', source: null, strength: 'none' });
  }
  assert.equal(detect.detectLanguage(''), 'en');
  assert.equal(detect.detectLanguage(undefined), 'en');
  assert.equal(detect.detectLanguage('   '), 'en');
  // the fallback is only ever one of the supported languages
  assert.equal(detect.resolveLanguage([], { fallback: 'es' }).language, 'es');
  assert.equal(detect.resolveLanguage([], { fallback: 'fr' }).language, 'en');
  // what comes back is always one of the supported languages
  for (const text of [GERMAN, ENGLISH, SPANISH, '', 'こんにちは世界', 'Привет мир', '12345', '??!!']) assert.ok(detect.SUPPORTED.includes(detect.detectLanguage(text)), text);
}

function testSameInputSameAnswer() {
  const sources = [{ id: 'topic', text: 'Git vs GitHub' }, { id: 'brief', text: GERMAN }, { id: 'text', text: ENGLISH }];
  const first = JSON.stringify(detect.resolveLanguage(sources));
  for (let i = 0; i < 50; i += 1) {
    assert.equal(JSON.stringify(detect.resolveLanguage(sources)), first);
    assert.equal(JSON.stringify(detect.resolveLanguage(JSON.parse(JSON.stringify(sources)))), first, 'a copy gives the same');
    detect.detectLanguage(`${SPANISH} ${i}`); // other calls in between change nothing
  }
  // the order of the keys and of the letters' case does not matter
  assert.deepEqual(detect.score(GERMAN), detect.score(GERMAN));
  assert.equal(detect.detectLanguage(GERMAN.toUpperCase()), detect.detectLanguage(GERMAN), 'a title in capitals is still German');
  // a long text is judged by its first part: the end does not flip it
  const long = `${GERMAN} `.repeat(400) + `${ENGLISH} `.repeat(4000);
  assert.equal(detect.detectLanguage(long), 'de');
}

testWordLists();
testExamples();
testShortTopics();
testOrderOfSources();
testNothingToGoOn();
testSameInputSameAnswer();
console.log('test-language-detect.js: ok');
