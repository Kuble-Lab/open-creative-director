'use strict';

// "Same as input" (WP38d): which of the supported languages (de, en, es) a text is written in, decided by the code alone, with no model
// call. The planning nodes (research, explainer plan) use it where the language parameter says "auto".
//
// How: it counts stop words (short function words that belong to one of the three languages and to no other of them) and special
// characters (the umlauts and the sharp s for German; n with tilde, inverted question and exclamation mark and accented vowels for
// Spanish). The text of a source is "clear" when the best language has at least CLEAR_MIN points and at least twice as many as the next
// one. Sources are looked at in the order the node gives them (what the person wrote first, documents and notes after that): the first
// source with a clear result decides. A short topic such as "Git vs GitHub" has no stop words and no special characters, so it
// decides nothing and the next source is asked. Only when no source is clear, the first source with a single kind of evidence
// (one hint, nothing against it) decides; with no evidence at all the result is the fallback (English).
// Pure and deterministic: the same texts always give the same language, so a cached result stays valid.

const SUPPORTED = Object.freeze(['de', 'en', 'es']);
const FALLBACK = 'en';
const CLEAR_MIN = 2;
const CLEAR_RATIO = 2;
// a sample is enough; a long document must not make the check slow
const MAX_CHARS = 30000;

// Function words that belong to ONE of the languages. A word that is common in two of them ("in", "an", "was", "war", "es", "no",
// "son", "hay", "con", "sin", "will", "also") is left out on purpose; the test checks that no word is in two lists.
const STOP_WORDS = Object.freeze({
  de: [
    'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines', 'und', 'oder', 'aber', 'nicht', 'ist', 'sind',
    'wird', 'werden', 'wurde', 'wurden', 'haben', 'hatte', 'sein', 'seine', 'mit', 'von', 'vom', 'zum', 'zur', 'zu', 'für', 'auf', 'aus',
    'bei', 'nach', 'über', 'unter', 'vor', 'wie', 'wer', 'wo', 'warum', 'wieso', 'weshalb', 'wann', 'welche', 'welcher', 'welches', 'wenn',
    'dass', 'auch', 'noch', 'nur', 'kann', 'können', 'muss', 'müssen', 'soll', 'sollen', 'ich', 'wir', 'ihr', 'sie', 'sich', 'im', 'um',
    'als', 'mehr', 'sehr', 'diese', 'dieser', 'dieses', 'diesen', 'jede', 'jeder', 'alle', 'keine', 'kein', 'ohne', 'durch', 'gegen',
    'zwischen', 'dann', 'denn', 'weil', 'doch', 'hier', 'dort', 'dabei', 'damit', 'dafür', 'dazu', 'bis', 'gibt', 'mein', 'dein', 'ihre',
    'unser', 'nichts', 'alles', 'etwas', 'immer', 'schon', 'wieder', 'sondern', 'sowie', 'heute', 'jetzt'
  ],
  en: [
    'the', 'and', 'of', 'to', 'is', 'are', 'were', 'be', 'been', 'being', 'that', 'this', 'these', 'those', 'with', 'for', 'from', 'by',
    'on', 'at', 'as', 'it', 'its', 'how', 'what', 'why', 'when', 'where', 'who', 'whom', 'which', 'not', 'or', 'but', 'if', 'you', 'your',
    'we', 'our', 'they', 'their', 'them', 'can', 'would', 'should', 'could', 'has', 'have', 'had', 'do', 'does', 'did', 'about', 'into',
    'than', 'then', 'there', 'between', 'without', 'my', 'his', 'her', 'he', 'she', 'him', 'only', 'more', 'most', 'very', 'just', 'over',
    'after', 'before', 'because', 'while', 'through', 'against', 'during', 'each', 'other'
  ],
  es: [
    'el', 'los', 'las', 'del', 'y', 'en', 'una', 'unos', 'unas', 'que', 'qué', 'por', 'para', 'sobre', 'como', 'cómo', 'cuál', 'cuáles',
    'cuándo', 'dónde', 'quién', 'quiénes', 'porque', 'pero', 'más', 'muy', 'su', 'sus', 'se', 'lo', 'este', 'esta', 'estos', 'estas',
    'ese', 'esa', 'esos', 'esas', 'entre', 'desde', 'hasta', 'también', 'está', 'están', 'ser', 'fue', 'nos', 'ya', 'si', 'sí', 'tu',
    'tus', 'nuestro', 'nuestra', 'cada', 'otro', 'otra', 'otros', 'otras', 'todo', 'todos', 'todas', 'cuando', 'donde', 'mucho', 'poco',
    'ahora', 'aquí', 'así', 'después', 'antes', 'mientras', 'durante', 'según', 'hacia', 'ante', 'bajo'
  ]
});
const WORD_SETS = Object.freeze(Object.fromEntries(SUPPORTED.map((language) => [language, new Set(STOP_WORDS[language])])));

// Points of a character for a language (Swiss High German writes "ss", so the sharp s is rare, but a German text from elsewhere has it).
const CHAR_POINTS = Object.freeze({
  de: { ä: 1, ö: 1, ü: 1, ß: 1.5 },
  es: { ñ: 2, '¿': 3, '¡': 3, á: 0.5, í: 0.5, ó: 0.5, ú: 0.5 }
});

// What does not say anything about the language of the person: addresses, the marks of page and document that "Read documents" puts in
// the text ("=== D1: file.pdf (2 pages) ===", "[p. 3]", "[Seite 3]").
function clean(text) {
  return String(text || '')
    .slice(0, MAX_CHARS)
    .normalize('NFC')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/^=== .* ===$/gm, ' ')
    .replace(/\[(?:p\.|pp\.|s\.|seite|seiten|pág\.|página)\s*\d+(?:\s*[-–]\s*\d+)?\]/gi, ' ');
}

// The points of every language for one text: { de, en, es }.
function score(text) {
  const cleaned = clean(text);
  const points = { de: 0, en: 0, es: 0 };
  // a short word in capitals is an abbreviation ("UN", "LA", "IT", "DE"), not a word of the language
  for (const token of cleaned.match(/\p{L}+/gu) || []) {
    if (token.length <= 3 && token === token.toUpperCase() && token !== token.toLowerCase()) continue;
    const word = token.toLowerCase();
    for (const language of SUPPORTED) if (WORD_SETS[language].has(word)) points[language] += 1;
  }
  const lower = cleaned.toLowerCase();
  for (const language of Object.keys(CHAR_POINTS)) {
    for (const char of lower) {
      const value = CHAR_POINTS[language][char];
      if (value) points[language] += value;
    }
  }
  return points;
}

// { language, strength, scores } of one text. strength: 'clear' (enough points and twice the next language), 'weak' (some points and no
// point for any other language), 'none' (language is null: no or contradicting evidence).
function classify(text) {
  const scores = score(text);
  const ranked = SUPPORTED.map((language) => ({ language, points: scores[language] })).sort((a, b) => b.points - a.points || SUPPORTED.indexOf(a.language) - SUPPORTED.indexOf(b.language));
  const [best, next] = ranked;
  if (best.points >= CLEAR_MIN && best.points >= CLEAR_RATIO * next.points) return { language: best.language, strength: 'clear', scores };
  if (best.points > 0 && next.points === 0) return { language: best.language, strength: 'weak', scores };
  return { language: null, strength: 'none', scores };
}

// The language of the first source that says something. sources: [{ id, text }] in the order of trust (what the person wrote first).
// Returns { language, source, strength } with source the id that decided (null when none did and the fallback was taken).
function resolveLanguage(sources, { fallback = FALLBACK } = {}) {
  const list = (Array.isArray(sources) ? sources : []).filter((source) => source && typeof source.text === 'string' && source.text.trim());
  const results = list.map((source) => ({ id: source.id, ...classify(source.text) }));
  const clear = results.find((result) => result.strength === 'clear');
  if (clear) return { language: clear.language, source: clear.id, strength: 'clear' };
  const weak = results.find((result) => result.strength === 'weak');
  if (weak) return { language: weak.language, source: weak.id, strength: 'weak' };
  return { language: SUPPORTED.includes(fallback) ? fallback : FALLBACK, source: null, strength: 'none' };
}

// The language of one text (the fallback without evidence).
function detectLanguage(text, options) {
  return resolveLanguage([{ id: 'text', text }], options).language;
}

module.exports = {
  SUPPORTED,
  FALLBACK,
  CLEAR_MIN,
  CLEAR_RATIO,
  STOP_WORDS,
  score,
  classify,
  resolveLanguage,
  detectLanguage
};
