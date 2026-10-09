'use strict';

// Test support (not a test): a made-up song and a hand-made good answer of the language model for the planner of the HUD music video
// (lib/music-video-hud/plan.js, WP44). Nothing here is real material: the words are invented, the numbers come from a seeded generator.
//
//   makeSong({ seconds, bpm, seed, pace })   { analysis, timing, seconds }: the analysis of audio.beats (beats, bars, hits, loudness per second,
//                                            sections Intro / Verse / Chorus / Outro) and the times of audio.lyrics_timing (lines with words);
//                                            `pace` scales the gaps between the lines
//   FIGURE_TEXT                              a figure with the lines NAME, FULL, SHORT, LOOKS, NEVER and CREDIT
//   goodAnswer(grid, figure, { mutate, short })  the answer of a model that did everything right for the grid (plates with the identity texts, rising
//                                            counters, graphics that the layout can place); `mutate(answer)` may change it before it is returned;
//                                            a figure without a SHORT form gets `short` as its "figure_short"
//   scriptedModel(steps)                     a double for `ask` of runPlanner: every call takes the next step (a string or object is the answer, an
//                                            Error is thrown, a function is called with the request), and the requests are kept in `calls`

// the same figure without a SHORT form (the model writes one)
const FIGURE_NO_SHORT = [
  'NAME: Mira',
  'FULL: a 30-year-old woman with a strong jaw, short copper hair and a grey wool coat, a small silver ring in her left ear',
  'CREDIT: Mira by the test lab (example.org)'
].join('\n');

const FIGURE_TEXT = [
  'NAME: Mira',
  'FULL: a 30-year-old woman with a strong jaw, short copper hair and a grey wool coat, a small silver ring in her left ear',
  'SHORT: a woman with short copper hair and a grey wool coat',
  'LOOKS: a different coat colour for every chapter',
  'NEVER: a second Mira in the picture',
  'CREDIT: Mira by the test lab (example.org)'
].join('\n');

const round3 = (value) => Math.round(value * 1000) / 1000;

// A small seeded generator, so that the same seed gives the same song.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const VOCABULARY = [
  'midnight', 'timeline', 'counted', 'forty', 'tokens', 'platform', 'ticket', 'lights', 'again', 'nobody', 'harbour', 'signal', 'quiet', 'engine', 'window',
  'borrowed', 'paper', 'orbit', 'ledger', 'answer', 'staying', 'running', 'remember', 'tonight', 'silver', 'echo', 'hours', 'wire', 'door', 'rain', 'the', 'and', 'of', 'I'
];

// [name, share of the song, loudness]; the lines are sung in the verses and the choruses
const SECTIONS = [
  ['Intro', 0.1, 0.2],
  ['Verse 1', 0.22, 0.45],
  ['Chorus 1', 0.2, 0.85],
  ['Verse 2', 0.2, 0.5],
  ['Chorus 2', 0.18, 0.9],
  ['Outro', 0.1, 0.25]
];

function makeSong({ seconds = 72, bpm = 120, seed = 7, pace = 1 } = {}) {
  const rnd = random(seed);
  const beat = 60 / bpm;
  const beats = [];
  for (let time = 0.3; time < seconds - 0.2; time += beat) beats.push(round3(time));
  const downbeats = beats.filter((_time, index) => index % 4 === 0);
  const hits = [];
  beats.forEach((time, index) => {
    if (index % 4 === 0) hits.push({ t: time, strength: round3(0.5 + rnd() * 0.5) });
    else if (rnd() < 0.1) hits.push({ t: time, strength: round3(0.3 + rnd() * 0.4) });
  });

  const sections = [];
  let at = 0;
  SECTIONS.forEach(([name, share, energy], index) => {
    const end = index === SECTIONS.length - 1 ? seconds : round3(at + share * seconds);
    sections.push({ name, start: round3(at), end, energy });
    at = end;
  });
  const energy = Array.from({ length: Math.ceil(seconds) }, (_item, second) => {
    const section = sections.find((item) => second + 0.5 >= item.start && second + 0.5 < item.end) || sections[sections.length - 1];
    return round3(Math.max(0, Math.min(1, section.energy + (rnd() - 0.5) * 0.1)));
  });

  const lines = [];
  const words = [];
  for (const section of sections.filter((item) => /verse|chorus/i.test(item.name))) {
    let time = section.start + 0.8;
    while (time < section.end - 2.6) {
      const count = 3 + Math.floor(rnd() * 5);
      const line = [];
      for (let index = 0; index < count; index += 1) {
        const text = VOCABULARY[Math.floor(rnd() * VOCABULARY.length)];
        const length = 0.16 + 0.04 * text.length;
        line.push({ text, start: round3(time), end: round3(time + length) });
        time += length + 0.04;
      }
      if (line[line.length - 1].end > section.end - 0.5) break;
      words.push(...line);
      lines.push({ text: line.map((word) => word.text).join(' '), start: line[0].start, end: line[line.length - 1].end });
      time += pace * (0.35 + rnd() * 1.4);
    }
  }
  return {
    seconds,
    analysis: { version: 1, duration: seconds, bpm, beats, downbeats, hits, energy, sections },
    timing: { version: 1, lines, words }
  };
}

/* ---------- the good answer ---------- */

const NARROW = ['counter', 'tag', 'stamp', 'toggle', 'progress', 'clock', 'stopwatch', 'notification'];
const WIDE = ['chart', 'list', 'spec', 'terminal', 'chat', 'blueprint', 'voice'];
const CLOSE = ['ECU', 'CU', 'MCU'];
// What finds room beside the face (measured with the layout of graphics.js, 1920 x 1080): in an ECU only the smallest devices, in a CU a few more, in an MCU the
// bars and the notification; the clock and the chart are the biggest, they only fit in wide shots.
const POOLS = {
  ECU: ['tag', 'counter'],
  CU: ['tag', 'counter', 'toggle', 'stamp'],
  MCU: ['counter', 'toggle', 'progress', 'notification', 'tag'],
  OTHER: ['tag', 'toggle', 'progress', 'notification', 'list', 'chat', 'stopwatch', 'spec', 'terminal', 'counter', 'voice', 'stamp', 'chart', 'blueprint', 'clock']
};

function device(type, number, key, line) {
  const base = { key, type };
  switch (type) {
    case 'counter': return { ...base, label: `COUNT ${number}`, format: 'int', from: 0, to: 10 + number };
    case 'tag': return { ...base, text: `TAG ${number} · LINE ${line.index}` };
    case 'stamp': return { ...base, text: 'CHECKED', count: 2 };
    case 'toggle': return { ...base, label: `OPTION ${number}`, states: ['ON', 'OFF?'] };
    case 'progress': return { ...base, label: `LOAD ${number}`, from: 4, to: 40 + (number % 50) };
    case 'clock': return { ...base, time: '00:07', label: `LOCAL ${number}`, arc: 0.9 };
    case 'stopwatch': return { ...base, from: '03:52:17:00', label: `CLOCK ${number}` };
    case 'notification': return { ...base, app: 'ALERTS', title: `Notice ${number}`, text: 'Gate: open', time: 'now' };
    case 'chart': return { ...base, title: `CHART ${number}`, values: [23, 27, 26, 34, 41, 58], marker: `MAX ${60 + (number % 30)}%` };
    case 'list': return { ...base, title: `LOG ${number}`, rows: ['G-2210 ENTRY ..... PASS', 'G-2211 EXIT ...... PASS', 'G-2212 SPEED ..... PASS'] };
    case 'spec': return { ...base, title: `SPEC ${number}`, rows: [['TYPE', 'LATCH'], ['RATING', 'BAY 4 EAST'], ['OWNER', 'UNKNOWN']], redact: 2 };
    case 'terminal': return { ...base, prompt: '$', lines: ['tail -n 3 log', 'ticket 03 accepted', 'queue: 12 left'] };
    case 'chat': return { ...base, messages: [{ from: 'them', text: 'are you at home yet?' }, { from: 'her', text: 'no, still at the club' }] };
    case 'blueprint': return { ...base, title: `FIG ${number}`, labels: { a: 'A · SENSOR', b: 'B · HINGE' }, dims: [2.1, 1.4] };
    case 'voice': return { ...base, label: 'VOICE · HUMMING', db: -32 };
    default: throw new Error(`no fixture for the type ${type}`);
  }
}

// The answer of a model that did everything right for `grid` (hard to get right by chance, so it is made here from the grid and the figure).
function goodAnswer(grid, figure, { mutate = null, short = 'a woman with short copper hair and a grey wool coat' } = {}) {
  const sections = grid.sections.length;
  const rising = (first) => Array.from({ length: sections }, (_item, index) => Math.round(first * 3 ** index));
  let sung = 0;
  let other = 0;
  const units = grid.units.map((unit) => {
    let framing;
    if (unit.index === 0) framing = 'CU';
    else if (unit.kind === 'performance') framing = CLOSE[sung++ % CLOSE.length];
    else framing = ['MS', 'MWS', 'WS', 'MCU', 'MS'][other++ % 5];
    const close = [...CLOSE, 'MS'].includes(framing);
    const identity = close ? figure.full : figure.short || short;
    return {
      index: unit.index,
      framing,
      with_figure: true,
      subject: ['center', 'left', 'right'][unit.index % 3],
      plate: `${framing}, ${close ? '85 mm' : '35 mm'} lens, ${identity}, chapter ${unit.section} look, scene number ${unit.index} at the place number ${unit.index * 7}, photographic film still, cinematic light, natural colour, film grain, no text, no letters, no logos`,
      motion: unit.kind === 'story' ? `Slow push-in on scene ${unit.index}, ending on a steady frame, exactly one person. No text, letters or logos.` : ''
    };
  });
  const unitOf = (time) => grid.units.find((unit) => time >= unit.start - 1e-6 && time < unit.end - 1e-6) || grid.units[grid.units.length - 1];
  let counter = 0;
  const pools = [];
  const lines = grid.lines.map((line, at) => {
    const entry = units[unitOf(line.words[0].start).index];
    const closeUp = CLOSE.includes(entry.framing);
    const words = line.words.length;
    const pool = POOLS[entry.framing] || POOLS.OTHER;
    const graphics = [device(pool[(at * 7 + 1) % pool.length], (counter += 1), 0, line)];
    // a second, narrow graphic on some lines that are not in a close-up
    if (!closeUp && words >= 3 && at % 3 === 0) graphics.push(device(graphics[0].type === 'tag' ? 'counter' : 'tag', (counter += 1), words - 1, line));
    const word = line.words[Math.min(1, words - 1)].text;
    pools.push(pool);
    return {
      index: at,
      key: Math.min(1, words - 1),
      // the big words only where the unit leaves room beside the face
      display: closeUp || at % 2 === 0 ? null : { style: at % 4 === 1 ? 'condensed' : 'serif', rows: [{ text: word.toUpperCase().slice(0, 14), size: 'xl', box: at % 6 === 1 }] },
      graphics
    };
  });
  // never the same first type three lines in a row (the pools differ from line to line, so it can happen by chance)
  for (let at = 2; at < lines.length; at += 1) {
    const type = (index) => lines[index].graphics[0].type;
    if (type(at) === type(at - 1) && type(at) === type(at - 2)) {
      const other = pools[at - 1].find((candidate) => candidate !== type(at - 1));
      lines[at - 1].graphics[0] = device(other, (counter += 1), 0, grid.lines[at - 1]);
    }
  }
  const answer = {
    treatment: 'A made-up film about a woman and a light that stays on.',
    hud: {
      title: 'MOTH PARADE',
      counter_label: 'WATTS',
      counter_values: rising(1),
      console: 'TEST LOG · MIRA CONSOLE',
      figure: 'MIRA',
      instances_label: 'MOTHS',
      instances_values: rising(40),
      ticker: ['LAMP: WARM', 'MOTHS NEARBY: 40', 'WINDOWS LIT: 3/9', 'FUSE: STABLE', 'DIMMER ▼', 'BULB: NEW', 'NEIGHBOURS ASLEEP: 2', 'CURTAINS: OPEN']
    },
    chapters: grid.sections.map((section) => ({
      section: section.index,
      name: ['DUSK', 'THE LAMP', 'HALLWAY', 'MOTH HOUR', 'FUSE BOX', 'DAWN', 'ENCORE', 'LATE', 'END', 'CODA'][section.index] || `PART ${section.index}`,
      look: `coat number ${section.index}`,
      set: `place number ${section.index}`,
      light: 'cold white'
    })),
    units,
    lines,
    endcard: { title: 'MOTH PARADE', lines: ['A film about a light'] }
  };
  if (!figure.short) answer.figure_short = short;
  return mutate ? mutate(answer) || answer : answer;
}

/* ---------- the model, replaced ---------- */

// `steps`: a string or an object (the answer, as JSON), an Error (thrown), or a function of the request that returns one of these. After the last step the
// last one is used again. `usd` is the cost every answer reports.
function scriptedModel(steps, { usd = 0.25 } = {}) {
  const calls = [];
  const ask = async (request) => {
    calls.push(request);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    const value = typeof step === 'function' ? step(request) : step;
    if (value instanceof Error) throw value;
    return { text: typeof value === 'string' ? value : JSON.stringify(value), usd };
  };
  return { ask, calls };
}

module.exports = { FIGURE_TEXT, FIGURE_NO_SHORT, makeSong, goodAnswer, scriptedModel, NARROW, WIDE, CLOSE, POOLS };
