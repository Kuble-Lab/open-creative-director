'use strict';

// Readable, language-neutral format for the song text and structure of the music nodes (WP30), and the translation to
// and from the composition plans of the ElevenLabs Music API. Pure module (no DOM, no I/O), used by the server
// (lib/elevenlabs.js, lib/tools.js, lib/nodes/nodes-generate.js) and by the node view (check and display).
// UMD: module.exports in Node, window.OCDNodes.musicPlan in the browser.
//
// The text format:
//
//   + indie pop, warm female vocals, 100 bpm      wanted styles (comma separated, several lines add up)
//   - autotune                                     unwanted styles
//                                                  (blank lines are ignored)
//   [Verse 1 | 20 s]                               a section: name and duration (20 s, 20s or 0:20)
//   + soft acoustic guitar                         styles of this section (before the first section: global)
//   First line of the verse                        every other line is a song line
//   Second line
//
//   [Chorus | 0:15]
//   \+ a song line that starts with a plus         \+ \- \[ \\ at the start of a line stand for the character itself
//
// The plan model: { positive: [], negative: [], sections: [{ name, durationMs, positive, negative, lines }] }.
// Models music_v1 know global styles and sections (`sections`); music_v2 and music_v2_5 know chunks only (`chunks`).
// A chunk is a section: its text is "[Name]" followed by the song lines, its styles are positive_styles and
// negative_styles. The global styles of the readable format have no place in a chunk plan: toApi() puts them at the
// front of the styles of the first chunk (the docs call these the styles that set the tone of the whole song), and
// fromApi() reads a chunk plan without global styles. So text -> plan -> text is lossless, and so is the round trip
// through the API shape of the model that has a place for everything (v1); for chunks the global styles end up in the
// first section.
//
// Errors are { code, line, data, message }: a stable code (MUSIC_PLAN_*), the line number of the text (null where there is
// none), the values for the translated text (nodes.issue.<code> in the interface) and an English fallback sentence.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.OCDNodes = root.OCDNodes || {};
    root.OCDNodes.musicPlan = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // Limits of the Music API (docs of 2026-10-02): a section is 3 to 120 s, a song 3 s to 10 min, 30 song lines of 200
  // characters per section, a section name of 1 to 100 characters, 50 styles per list, 30 chunks per plan.
  const LIMITS = Object.freeze({
    minSectionMs: 3000,
    maxSectionMs: 120000,
    minLengthMs: 3000,
    maxLengthMs: 600000,
    maxLines: 30,
    maxLineChars: 200,
    maxNameChars: 100,
    maxStyles: 50,
    maxSections: 30
  });
  // The newest model first: it is the default (documented as the most advanced, with prompts and plans).
  const MODELS = Object.freeze(['music_v2_5', 'music_v2', 'music_v1']);
  const DEFAULT_MODEL = 'music_v2_5';

  const ESCAPED = '+-[\\';

  const FALLBACKS = {
    empty: () => 'The plan has no section. Start one with a line such as [Verse | 20 s].',
    text_outside: () => 'Song lines belong in a section. Put a line such as [Verse | 20 s] above them.',
    bad_header: () => 'A section header looks like [Name | 20 s] and must end with a closing bracket.',
    duration_missing: (d) => `Section "${d.name}" needs a duration, for example [${d.name} | 20 s].`,
    duration_bad: (d) => `"${d.text}" is not a duration. Write 20 s, 20s or 0:20.`,
    duration_range: (d) => `A section lasts ${d.min} to ${d.max} seconds (this one: ${d.seconds} s).`,
    total_max: (d) => `The song may last ${d.max / 60000} minutes at most.`,
    sections_max: (d) => `A song has ${d.max} sections at most.`,
    lines_max: (d) => `A section has ${d.max} song lines at most (this one: ${d.count}).`,
    lines_max_chunk: (d) => `With this model the section line counts as one of ${d.max + 1} lines, so a named section has ${d.max} song lines at most (this one: ${d.count}).`,
    name_needed: (d) => `With this model a song line that starts with "[" would be read as the name of the section. Give the section a name or change the line "${d.text}".`,
    line_chars: (d) => `A song line has ${d.max} characters at most (this one: ${d.count}).`,
    name_chars: (d) => `A section name has ${d.max} characters at most (this one: ${d.count}).`,
    styles_max: (d) => `A list of styles has ${d.max} entries at most (this one: ${d.count}).`
  };
  const codeOf = (key) => `MUSIC_PLAN_${key.toUpperCase()}`;
  const ERROR_CODES = Object.freeze(Object.keys(FALLBACKS).map(codeOf));

  function issue(code, line, data) {
    const values = { ...(data || {}) };
    if (line) values.line = line;
    const sentence = FALLBACKS[code](values);
    return { code: codeOf(code), line: line || null, data: values, message: line ? `Line ${line}: ${sentence}` : sentence };
  }

  const count = (text) => [...String(text)].length;

  /* ---------- durations ---------- */

  // "20 s", "20s", "12.5 s", "0:20", "1:05" -> milliseconds; null where the text is none of these.
  function parseDuration(text) {
    const value = String(text === undefined || text === null ? '' : text).trim().toLowerCase();
    let seconds = null;
    let match = /^(\d+(?:[.,]\d+)?)\s*s$/.exec(value);
    if (match) seconds = Number(match[1].replace(',', '.'));
    else {
      match = /^(\d+):([0-5]?\d(?:[.,]\d+)?)$/.exec(value);
      if (match) seconds = Number(match[1]) * 60 + Number(match[2].replace(',', '.'));
    }
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
  }

  // 20000 -> "20 s", 12500 -> "12.5 s": the one spelling the writer uses.
  function formatDuration(ms) {
    return `${+(ms / 1000).toFixed(3)} s`;
  }

  /* ---------- reading ---------- */

  function splitStyles(text) {
    return String(text)
      .split(',')
      .map((style) => style.trim())
      .filter(Boolean);
  }

  function unescapeLine(line) {
    return line.length > 1 && line[0] === '\\' && ESCAPED.includes(line[1]) ? line.slice(1) : line;
  }

  function escapeLine(line) {
    return line && ESCAPED.includes(line[0]) ? `\\${line}` : line;
  }

  function parseHeader(line, lineNo) {
    const errors = [];
    if (!line.endsWith(']')) {
      errors.push(issue('bad_header', lineNo));
      return { name: line.slice(1).trim(), durationMs: null, errors };
    }
    const inner = line.slice(1, -1);
    const pipe = inner.lastIndexOf('|');
    const name = (pipe < 0 ? inner : inner.slice(0, pipe)).trim();
    const durationText = pipe < 0 ? '' : inner.slice(pipe + 1).trim();
    let durationMs = null;
    if (!durationText) errors.push(issue('duration_missing', lineNo, { name }));
    else {
      durationMs = parseDuration(durationText);
      if (durationMs === null) errors.push(issue('duration_bad', lineNo, { text: durationText }));
    }
    return { name, durationMs, errors };
  }

  const firstOf = (list) => (list.length ? list[0] : null);

  // Reads the text. Returns { plan, errors, positions }: the plan as far as it could be read, every problem with its
  // line number (syntax and limits), and the lines the parts came from (for validate()). options.model: the limits that
  // only apply to the shape of that model (see validate()).
  function parse(text, options = {}) {
    const errors = [];
    const plan = { positive: [], negative: [], sections: [] };
    const positions = { positiveLine: null, negativeLine: null, sections: [] };
    const rows = String(text === undefined || text === null ? '' : text).replace(/^﻿/, '').split(/\r\n|\r|\n/);
    let section = null;
    let position = null;
    let outsideReported = false;
    rows.forEach((raw, index) => {
      const lineNo = index + 1;
      const line = raw.trim();
      if (!line) return;
      const head = line[0];
      if (head === '+' || head === '-') {
        const positive = head === '+';
        const target = section || plan;
        const where = position || positions;
        const styles = splitStyles(line.slice(1));
        // a loop, not push(...styles): a line with 100 000 entries must not overflow the call stack
        const list = positive ? target.positive : target.negative;
        for (const style of styles) list.push(style);
        const key = positive ? 'positiveLine' : 'negativeLine';
        if (where[key] === null && styles.length) where[key] = lineNo;
        return;
      }
      if (head === '[') {
        const header = parseHeader(line, lineNo);
        errors.push(...header.errors);
        section = { name: header.name, durationMs: header.durationMs, positive: [], negative: [], lines: [] };
        position = { line: lineNo, positiveLine: null, negativeLine: null, lineNumbers: [] };
        plan.sections.push(section);
        positions.sections.push(position);
        return;
      }
      if (!section) {
        if (!outsideReported) errors.push(issue('text_outside', lineNo));
        outsideReported = true;
        return;
      }
      section.lines.push(unescapeLine(line));
      position.lineNumbers.push(lineNo);
    });
    errors.push(...validate(plan, positions, options));
    errors.sort((a, b) => (a.line || 0) - (b.line || 0));
    return { plan, errors, positions };
  }

  /* ---------- limits ---------- */

  // The limits of the API for a plan. `positions` (from parse()) gives the line numbers; without them the errors have
  // none. options.model: for a chunk plan (music_v2, music_v2_5) the global styles count with the first section, the
  // section name is the first of the 30 lines a chunk text may have (so a named section has 29 song lines at most), and a
  // section without a name must not start with a song line in square brackets (it would be read as the name).
  function validate(plan, positions, options = {}) {
    const errors = [];
    const sections = plan.sections || [];
    const at = (i) => positions?.sections?.[i] || {};
    if (!sections.length) errors.push(issue('empty', null));
    const styleCheck = (list, line) => {
      if (list.length > LIMITS.maxStyles) errors.push(issue('styles_max', line, { max: LIMITS.maxStyles, count: list.length }));
    };
    styleCheck(plan.positive || [], positions?.positiveLine);
    styleCheck(plan.negative || [], positions?.negativeLine);
    let total = 0;
    let totalReported = false;
    sections.forEach((section, i) => {
      const where = at(i);
      const line = where.line || null;
      if (i === LIMITS.maxSections) errors.push(issue('sections_max', line, { max: LIMITS.maxSections }));
      if (count(section.name) > LIMITS.maxNameChars) errors.push(issue('name_chars', line, { max: LIMITS.maxNameChars, count: count(section.name) }));
      if (section.durationMs !== null && section.durationMs !== undefined) {
        if (section.durationMs < LIMITS.minSectionMs || section.durationMs > LIMITS.maxSectionMs) {
          errors.push(
            issue('duration_range', line, { min: LIMITS.minSectionMs / 1000, max: LIMITS.maxSectionMs / 1000, seconds: +(section.durationMs / 1000).toFixed(3) })
          );
        }
        total += section.durationMs;
        if (total > LIMITS.maxLengthMs && !totalReported) {
          errors.push(issue('total_max', line, { max: LIMITS.maxLengthMs }));
          totalReported = true;
        }
      }
      const chunked = Boolean(options.model) && shapeOf(options.model) === 'chunks';
      const named = chunked && section.name !== '';
      const maxLines = named ? LIMITS.maxLines - 1 : LIMITS.maxLines;
      if (section.lines.length > maxLines) errors.push(issue(named ? 'lines_max_chunk' : 'lines_max', line, { max: maxLines, count: section.lines.length }));
      if (chunked && !named && section.lines.length && section.lines[0][0] === '[') {
        errors.push(issue('name_needed', where.lineNumbers?.[0] || line, { text: section.lines[0].slice(0, 40) }));
      }
      section.lines.forEach((text, j) => {
        if (count(text) > LIMITS.maxLineChars) errors.push(issue('line_chars', where.lineNumbers?.[j] || line, { max: LIMITS.maxLineChars, count: count(text) }));
      });
      const merged = i === 0 && chunked;
      styleCheck(merged ? [...new Set([...(plan.positive || []), ...section.positive])] : section.positive, where.positiveLine || line);
      styleCheck(merged ? [...new Set([...(plan.negative || []), ...section.negative])] : section.negative, where.negativeLine || line);
    });
    errors.sort((a, b) => (a.line || 0) - (b.line || 0));
    return errors;
  }

  function totalMs(plan) {
    return (plan.sections || []).reduce((sum, section) => sum + (Number.isFinite(section.durationMs) ? section.durationMs : 0), 0);
  }

  // The total length of a text in milliseconds when the text is a valid plan, else null.
  function lengthOfText(text) {
    const { plan, errors } = parse(text);
    return errors.length ? null : totalMs(plan);
  }

  /* ---------- writing ---------- */

  function stringify(plan) {
    const out = [];
    const styleLines = (target) => {
      if (target.positive.length) out.push(`+ ${target.positive.join(', ')}`);
      if (target.negative.length) out.push(`- ${target.negative.join(', ')}`);
    };
    styleLines(plan);
    for (const section of plan.sections) {
      if (out.length) out.push('');
      const duration = Number.isFinite(section.durationMs) ? ` | ${formatDuration(section.durationMs)}` : '';
      out.push(`[${section.name}${duration}]`.replace('[ | ', '[| '));
      styleLines(section);
      for (const line of section.lines) out.push(escapeLine(line));
    }
    return out.join('\n');
  }

  /* ---------- API shapes ---------- */

  // 'sections' (music_v1) or 'chunks' (music_v2, music_v2_5) for a model id.
  function shapeOf(modelId) {
    return String(modelId) === 'music_v1' ? 'sections' : 'chunks';
  }

  const unique = (list) => [...new Set(list)];

  // The plan as the Music API takes it for the model.
  function toApi(plan, modelId = DEFAULT_MODEL) {
    if (shapeOf(modelId) === 'sections') {
      return {
        positive_global_styles: plan.positive.slice(),
        negative_global_styles: plan.negative.slice(),
        sections: plan.sections.map((section, i) => ({
          section_name: section.name || `Part ${i + 1}`,
          positive_local_styles: section.positive.slice(),
          negative_local_styles: section.negative.slice(),
          duration_ms: section.durationMs,
          lines: section.lines.slice()
        }))
      };
    }
    return {
      chunks: plan.sections.map((section, i) => ({
        text: [section.name ? `[${section.name}]` : '', ...section.lines].filter((line, index) => line || index > 0).join('\n'),
        duration_ms: section.durationMs,
        positive_styles: i === 0 ? unique([...plan.positive, ...section.positive]) : section.positive.slice(),
        negative_styles: i === 0 ? unique([...plan.negative, ...section.negative]) : section.negative.slice()
      }))
    };
  }

  const pick = (object, ...names) => {
    for (const name of names) if (object && object[name] !== undefined && object[name] !== null) return object[name];
    return undefined;
  };

  const cleanStyles = (value) => (Array.isArray(value) ? value.flatMap((style) => splitStyles(String(style))) : []);
  const cleanName = (value) => String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  const cleanLines = (lines) => lines.flatMap((line) => String(line).split(/\r\n|\r|\n/)).map((line) => line.trim()).filter(Boolean);
  const durationOf = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Math.round(Number(value)) : null);

  // The plan model of an answer or suggestion of the Music API (either shape; snake_case or camelCase keys). Throws
  // an Error with code MUSIC_PLAN_SHAPE for something that is none of them.
  function fromApi(api) {
    const plan = { positive: [], negative: [], sections: [] };
    const sections = pick(api, 'sections');
    const chunks = pick(api, 'chunks');
    if (Array.isArray(sections)) {
      plan.positive = cleanStyles(pick(api, 'positive_global_styles', 'positiveGlobalStyles'));
      plan.negative = cleanStyles(pick(api, 'negative_global_styles', 'negativeGlobalStyles'));
      for (const item of sections) {
        plan.sections.push({
          name: cleanName(pick(item, 'section_name', 'sectionName')),
          durationMs: durationOf(pick(item, 'duration_ms', 'durationMs')),
          positive: cleanStyles(pick(item, 'positive_local_styles', 'positiveLocalStyles')),
          negative: cleanStyles(pick(item, 'negative_local_styles', 'negativeLocalStyles')),
          lines: cleanLines(Array.isArray(item?.lines) ? item.lines : [])
        });
      }
      return plan;
    }
    if (Array.isArray(chunks)) {
      for (const item of chunks) {
        const rows = String(pick(item, 'text') || '').split(/\r\n|\r|\n/).map((row) => row.trim()).filter(Boolean);
        const named = rows.length ? /^\[(.*)\]$/.exec(rows[0]) : null;
        plan.sections.push({
          name: named ? cleanName(named[1]) : '',
          durationMs: durationOf(pick(item, 'duration_ms', 'durationMs')),
          positive: cleanStyles(pick(item, 'positive_styles', 'positiveStyles')),
          negative: cleanStyles(pick(item, 'negative_styles', 'negativeStyles')),
          lines: cleanLines(named ? rows.slice(1) : rows)
        });
      }
      return plan;
    }
    const err = new Error('The answer holds neither sections nor chunks.');
    err.code = 'MUSIC_PLAN_SHAPE';
    throw err;
  }

  return {
    LIMITS,
    MODELS,
    DEFAULT_MODEL,
    ERROR_CODES,
    parse,
    validate,
    stringify,
    totalMs,
    lengthOfText,
    parseDuration,
    formatDuration,
    shapeOf,
    toApi,
    fromApi
  };
});
