'use strict';

// The data of the HUD of the music video (WP44): the contract "graphics v1" between the planner (music_video.hud_plan) and the renderer
// (music_video.hud_render), the check of it, the layout of the devices and the cut into chunks of the data.
//
//   normalizeGraphics(input, options)   validates and normalises the JSON text of the planner: texts are cut, numbers are limited, unknown
//                                       fields are ignored, a device of an unknown type is left out and named in the warnings. It never throws
//                                       because of design data: { graphics, warnings }
//   resolveGraphics(graphics, options)  adds what the renderer derives: the frame grid of the cuts, when each device enters and leaves, the words
//                                       of the big type with their times, where each device stands (never over the face, never over another
//                                       device: see "the layout" below), which one carries the accent. A pure function; everything the renderer
//                                       needs is in the result, so a chunk of the data (sliceGraphics) draws the same frames as the whole film.
//                                       options.warn(message) hears of a device that was left out
//   prepareGraphics(input, options)     both steps
//   sliceGraphics(graphics, from, to)   the part of the data a chunk of the film needs
//   demoGraphics({ duration })          a realistic example with every kind of device, for the tests and for the look at the pictures
// Times are seconds of the song. The sizes are px at 1920 x 1080 (the only size that is drawn: the HUD is made for it).
// The style (`theme`, lib/music-video-hud/themes.js) decides which faces the layout measures and how big the devices are: HUD Blue measures Anton and
// has no padding, Kuble measures Montserrat and puts its devices on cards.

const metricsLib = require('./metrics');
const state = require('./state');
const view = require('./view');
const themes = require('./themes');
const targets = require('./targets');

const { SIZES } = view;

const FPS = 24;
const WIDTH = 1920;
const HEIGHT = 1080;
const DEFAULT_ACCENT = '#3B82F6';
const MAX = Object.freeze({ lines: 400, words: 64, cuts: 600, devices: 300, beats: 4000, downbeats: 1200, hits: 1500, energy: 3600, ticker: 16, chapters: 40, drops: 24, steps: 40 });

// The limits of the texts and lists of every device: what normalizeGraphics keeps and what the planner may write (music_video.hud_plan reads this table for
// its checks and for the catalogue in its prompt, so that both say the same as the normalisers below).
const LIMITS = Object.freeze({
  display: Object.freeze({ rows: 4, text: 14, around: 2 }),
  counter: Object.freeze({ label: 24 }),
  tag: Object.freeze({ text: 32 }),
  stamp: Object.freeze({ text: 12, count: 4 }),
  strike: Object.freeze({ text: 24 }),
  spec: Object.freeze({ title: 40, rows: 6, minRows: 2, label: 20, value: 20 }),
  blueprint: Object.freeze({ title: 40, label: 24 }),
  chart: Object.freeze({ title: 32, values: 12, minValues: 5, marker: 24 }),
  terminal: Object.freeze({ lines: 6, line: 44, prompt: 16 }),
  chat: Object.freeze({ messages: 3, text: 60 }),
  notification: Object.freeze({ app: 20, title: 32, text: 64, time: 12 }),
  voice: Object.freeze({ label: 32 }),
  clock: Object.freeze({ label: 32 }),
  stopwatch: Object.freeze({ label: 32 }),
  list: Object.freeze({ title: 32, rows: 12, row: 40 }),
  toggle: Object.freeze({ label: 24, state: 8, flips: 8 }),
  progress: Object.freeze({ label: 32 }),
  pin: Object.freeze({ label: 32 })
});

const POSITIONS = Object.freeze(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'left', 'right', 'top', 'center', 'around']);
const DEVICE_TYPES = Object.freeze(['display', 'counter', 'tag', 'stamp', 'strike', 'spec', 'blueprint', 'chart', 'terminal', 'chat', 'notification', 'voice', 'clock', 'stopwatch', 'list', 'toggle', 'progress', 'pin']);
const COUNTER_FORMATS = Object.freeze(['int', 'percent', 'money', 'clock', 'fraction', 'multiplier']);
const DEFAULT_POSITION = Object.freeze({
  display: 'top-left', counter: 'bottom-left', tag: 'right', stamp: 'right', strike: 'top', spec: 'right', blueprint: 'bottom-left', chart: 'right', terminal: 'right',
  chat: 'right', notification: 'top-right', voice: 'bottom-right', clock: 'top', stopwatch: 'bottom-left', list: 'left', toggle: 'right', progress: 'bottom-right', pin: 'center'
});
const CUT_KINDS = Object.freeze(['performance', 'story', 'still']);
// where the figure stands; `none` is a cut without the figure (an insert, a thing): it has no zone of the face
const SUBJECTS = Object.freeze(['left', 'center', 'right', 'none']);
const TRANSITIONS = Object.freeze(['cut', 'glitch', 'wipe', 'flash']);
// how close the camera is to the figure (film language): extreme close-up, close-up, medium close-up, medium, medium wide, wide, full, extra wide,
// over the shoulder. Anything else is dropped.
const FRAMINGS = Object.freeze(['ECU', 'CU', 'MCU', 'MS', 'MWS', 'WS', 'FS', 'EWS', 'OTS']);

// where the devices may stand: the margins of the Stilblatt (left 72, top 56, right 96, bottom 84) and the free area inside the frame of the HUD
// (the title, the bar and beat line and the numbers on top, the karaoke line and the ticker below)
const SAFE = Object.freeze({ left: 96, top: 150, right: 1824, bottom: 944 });
const GAP = 24;
// where the head of the figure is on the picture, by the `subject` of the cut (x range; the y range is the same for all): devices keep out of it.
// This is the zone of a cut without a `framing`; faceZone() makes the zone of a cut.
const FACE = Object.freeze({ left: { x0: 220, x1: 820 }, center: { x0: 660, x1: 1260 }, right: { x0: 1100, x1: 1700 }, y0: 70, y1: 800 });
// The middle of the figure (x) by the subject of a cut, and by the framing how far the zone reaches to both sides of it (half the width) and from
// where to where it stands (y). In a close-up the face is wide and the mouth and the chin are low, in a wide shot the head is small.
const SUBJECT_X = Object.freeze({ left: 520, center: 960, right: 1400 });
const WIDE_ZONE = Object.freeze({ half: 180, y0: 90, y1: 520 });
const FRAME_ZONES = Object.freeze({
  ECU: { half: 560, y0: 0, y1: 1010 },
  CU: { half: 420, y0: 40, y1: 980 },
  MCU: { half: 320, y0: 60, y1: 860 },
  MS: { half: 240, y0: 80, y1: 640 },
  MWS: WIDE_ZONE,
  WS: WIDE_ZONE,
  FS: WIDE_ZONE,
  EWS: WIDE_ZONE,
  OTS: WIDE_ZONE
});
// a lip-sync cut without a framing: the zone reaches at least down to the mouth and the chin
const PERFORMANCE_BOTTOM = 860;
// a device that does not fit into the free lane is made smaller, down to this scale (a tag is never made smaller)
const SCALES = Object.freeze([1, 0.9, 0.8, 0.7]);
const MIN_SCALE = Object.freeze({ display: 0.7, tag: 1, counter: 0.8, stamp: 0.8, strike: 0.7, spec: 0.8, blueprint: 0.8, chart: 0.8, terminal: 0.8, chat: 0.8, notification: 0.8, voice: 0.8, clock: 0.7, stopwatch: 0.75, list: 0.8, toggle: 0.8, progress: 0.7 });
// A graphic that is cut short (to make room for a newer one, or at a cut where the figure would be covered) stays this long fully on the screen
// (after its entrance, before its exit). One that has to come late still has this long left.
const MIN_SHOWN_S = 1.2;
const MIN_LATE_S = 1.0;

/* ---------- small helpers ---------- */

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function num(value, low, high, fallback) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, low, high) : fallback;
}

// a text for the screen: no control characters, no angle brackets, one line, cut at `max` characters (not in the middle of a character)
function text(value, max) {
  if (value === null || value === undefined || typeof value === 'object') return '';
  const clean = String(value).replace(/[\u0000-\u001f\u007f\u2028\u2029<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(clean).slice(0, max).join('').trim();
}

const upper = (value, max) => text(value, max).toUpperCase();
const snap = (seconds) => Math.round(seconds * FPS) / FPS;
const round3 = (value) => Math.round(value * 1000) / 1000;

function isColor(value) {
  return typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

function normalizeColor(value, fallback = DEFAULT_ACCENT) {
  if (!isColor(value)) return fallback;
  let hex = value.trim().toUpperCase();
  if (hex.length === 4) hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  return hex;
}

// The accent colour of a film: the parameter of the node (a valid colour) wins over the plan. The accent of the first style is the default of the
// parameter, so for another style it means that no colour was chosen: the film then takes the accent of its own style.
function accentFor(themeName, param, fallback = DEFAULT_ACCENT) {
  const theme = themes.get(themeName);
  const accent = normalizeColor(param, fallback);
  return theme.id !== themes.DEFAULT && accent === normalizeColor(DEFAULT_ACCENT) ? theme.accent.toUpperCase() : accent;
}

function sortedNumbers(list, low, high, limit) {
  if (!Array.isArray(list)) return [];
  const found = [];
  for (const value of list) {
    const n = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(n) && n >= low && n <= high) found.push(round3(n));
  }
  found.sort((a, b) => a - b);
  return found.filter((value, index) => index === 0 || value !== found[index - 1]).slice(0, limit);
}

function normalizeSteps(list, duration) {
  if (!Array.isArray(list)) return [];
  const steps = [];
  for (const step of list.slice(0, MAX.steps * 2)) {
    if (!isObject(step)) continue;
    const at = num(step.at, 0, duration, null);
    const value = num(step.value, 0, 1e12, null);
    if (at === null || value === null) continue;
    steps.push({ at: round3(at), value: Math.round(value) });
  }
  steps.sort((a, b) => a.at - b.at);
  const unique = [];
  for (const step of steps) {
    if (unique.length && unique[unique.length - 1].at === step.at) unique[unique.length - 1] = step;
    else unique.push(step);
  }
  return unique.slice(0, MAX.steps);
}

// "03:52:17:04", "03:52:17", "52:17" -> the same text with every part of two digits; the fallback when it is none of them
function normalizeClock(value, fallback) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!/^\d{1,2}(:\d{1,2}){1,3}$/.test(raw)) return fallback;
  return raw.split(':').map((part) => part.padStart(2, '0')).join(':');
}

/* ---------- the check of the data ---------- */

function normalizeCuts(list, duration, warn) {
  const cuts = [];
  let unknownFraming = 0;
  for (const raw of Array.isArray(list) ? list.slice(0, MAX.cuts * 2) : []) {
    if (!isObject(raw)) continue;
    const start = num(raw.start, 0, duration, null);
    const end = num(raw.end, 0, duration + 5, null);
    if (start === null || end === null || end <= start) {
      warn('a cut without a usable start and end was left out');
      continue;
    }
    const crop = isObject(raw.crop) ? raw.crop : {};
    const framing = typeof raw.framing === 'string' ? raw.framing.trim().toUpperCase() : '';
    if (raw.framing !== undefined && raw.framing !== null && raw.framing !== '' && !FRAMINGS.includes(framing)) unknownFraming += 1;
    cuts.push({
      start,
      end,
      kind: CUT_KINDS.includes(raw.kind) ? raw.kind : 'story',
      unit: Math.round(num(raw.unit, 0, 1000, 0)),
      crop: { scale: round3(num(crop.scale, 1, 1.6, 1)), x: round3(num(crop.x, 0, 1, 0.5)), y: round3(num(crop.y, 0, 1, 0.5)) },
      subject: SUBJECTS.includes(raw.subject) ? raw.subject : 'center',
      framing: FRAMINGS.includes(framing) ? framing : null,
      transition: TRANSITIONS.includes(raw.transition) ? raw.transition : 'cut',
      luma: Array.isArray(raw.luma) && raw.luma.length === 2 && raw.luma.every((value) => Number.isFinite(Number(value))) ? raw.luma.map((value) => round3(clamp(Number(value), 0, 1))) : null
    });
  }
  if (unknownFraming) warn(`${unknownFraming} cuts have a framing that is none of ${FRAMINGS.join(', ')}: it was dropped (the zone of the figure is then guessed)`);
  cuts.sort((a, b) => a.start - b.start);
  return cuts.slice(0, MAX.cuts);
}

// The cuts cover the song without a gap: on the frame grid, the first one starts where the film starts, each one starts where the one before
// ends (a gap is closed by the cut before it, an overlap cut off), the last one ends with the song, and a cut is at least one frame long.
function coverCuts(cuts, duration, warn) {
  const endFrame = Math.max(1, Math.round(duration * FPS));
  if (!cuts.length) {
    warn('there are no cuts: one cut covers the whole song');
    return [{ start: 0, end: endFrame / FPS, kind: 'story', unit: 0, crop: { scale: 1, x: 0.5, y: 0.5 }, subject: 'center', framing: null, transition: 'cut', luma: null }];
  }
  const out = [];
  let cursor = Math.min(endFrame - 1, Math.round(cuts[0].start * FPS));
  for (let index = 0; index < cuts.length; index += 1) {
    const cut = cuts[index];
    const next = index + 1 < cuts.length ? Math.round(cuts[index + 1].start * FPS) : endFrame;
    let end = Math.min(endFrame, Math.max(cursor + 1, next));
    if (index === cuts.length - 1) end = endFrame;
    if (end <= cursor) continue;
    out.push({ ...cut, start: cursor / FPS, end: end / FPS });
    cursor = end;
  }
  if (cursor < endFrame && out.length) out[out.length - 1].end = endFrame / FPS;
  if (out.length !== cuts.length) warn(`${cuts.length - out.length} cuts were shorter than a frame and joined to the cut before them`);
  return out;
}

function normalizeLines(list, duration, warn) {
  const lines = [];
  for (const raw of Array.isArray(list) ? list.slice(0, MAX.lines * 2) : []) {
    if (!isObject(raw)) continue;
    const words = [];
    for (const word of Array.isArray(raw.words) ? raw.words.slice(0, MAX.words) : []) {
      if (!isObject(word)) continue;
      const wordText = text(word.text, 32);
      const start = num(word.start, 0, duration + 5, null);
      if (!wordText || start === null) continue;
      words.push({ text: wordText, start: round3(start), end: round3(Math.max(start + 0.05, num(word.end, 0, duration + 5, start + 0.3))) });
    }
    if (!words.length) continue;
    words.sort((a, b) => a.start - b.start);
    const start = num(raw.start, 0, duration + 5, words[0].start);
    const end = Math.max(start + 0.2, num(raw.end, 0, duration + 5, words[words.length - 1].end));
    lines.push({ start: round3(start), end: round3(end), key: Math.round(num(raw.key, 0, words.length - 1, 0)), words });
  }
  lines.sort((a, b) => a.start - b.start);
  if (Array.isArray(list) && list.length && !lines.length) warn('no line had usable words: there is no karaoke line');
  return lines.slice(0, MAX.lines);
}

/* ---------- the devices ---------- */

const normalizers = {
  display(raw, warn) {
    const style = ['condensed', 'serif', 'around'].includes(raw.style) ? raw.style : 'condensed';
    const rows = [];
    let boxes = 0;
    for (const item of Array.isArray(raw.rows) ? raw.rows.slice(0, LIMITS.display.rows) : []) {
      const row = isObject(item) ? item : { text: item };
      const content = style === 'serif' ? text(row.text, LIMITS.display.text) : upper(row.text, LIMITS.display.text);
      if (!content) continue;
      let box = row.box === true;
      if (box && boxes >= 1) {
        box = false;
        warn('a display with more than one box: only the first keeps it');
      }
      if (box) boxes += 1;
      rows.push({ text: content, size: ['xl', 'l', 'm'].includes(row.size) ? row.size : 'l', box });
    }
    if (!rows.length) return null;
    if (style === 'around' && rows.length > LIMITS.display.around) rows.length = LIMITS.display.around;
    return { style, rows };
  },
  counter(raw) {
    const format = COUNTER_FORMATS.includes(raw.format) ? raw.format : 'int';
    const out = { label: upper(raw.label, LIMITS.counter.label), format };
    if (format === 'clock') {
      out.from = normalizeClock(raw.from, '00:00:00:00');
      out.to = normalizeClock(raw.to, out.from);
    } else {
      out.from = Math.round(num(raw.from, -1e12, 1e12, 0));
      out.to = Math.round(num(raw.to, -1e12, 1e12, out.from));
      if (format === 'fraction') out.total = Math.round(num(raw.total, 0, 1e12, Math.max(out.to, 1)));
      if (format === 'percent') {
        out.from = clamp(out.from, 0, 999);
        out.to = clamp(out.to, 0, 999);
      }
    }
    return out;
  },
  // `target` (WP51, optional): the place on the figure the tag points at (targets.js); kept when it is a known one. Without it the words of the tag
  // decide when the tag is drawn, so the data of a tag of before stay as they were.
  tag(raw) {
    const content = text(raw.text, LIMITS.tag.text);
    if (!content) return null;
    const target = typeof raw.target === 'string' ? raw.target.trim().toLowerCase() : '';
    return targets.TARGETS.includes(target) ? { text: content, target } : { text: content };
  },
  stamp(raw) {
    const content = upper(raw.text, LIMITS.stamp.text);
    return content ? { text: content, count: Math.round(num(raw.count, 1, LIMITS.stamp.count, 1)) } : null;
  },
  strike(raw) {
    const content = upper(raw.text, LIMITS.strike.text);
    return content ? { text: content, mode: raw.mode === 'redact' ? 'redact' : 'strike' } : null;
  },
  spec(raw) {
    const rows = [];
    for (const row of Array.isArray(raw.rows) ? raw.rows.slice(0, LIMITS.spec.rows) : []) {
      if (!Array.isArray(row)) continue;
      const label = text(row[0], LIMITS.spec.label);
      const value = text(row[1], LIMITS.spec.value);
      if (label) rows.push({ label, value });
    }
    if (rows.length < LIMITS.spec.minRows) return null;
    const redact = Number.isInteger(raw.redact) && raw.redact >= 0 && raw.redact < rows.length ? raw.redact : null;
    return { title: text(raw.title, LIMITS.spec.title), rows, redact };
  },
  blueprint(raw) {
    const labels = isObject(raw.labels) ? raw.labels : {};
    const dims = Array.isArray(raw.dims) ? raw.dims : [];
    return { title: text(raw.title, LIMITS.blueprint.title), labels: { a: text(labels.a, LIMITS.blueprint.label) || 'A', b: text(labels.b, LIMITS.blueprint.label) || 'B' }, dims: [num(dims[0], 0.01, 99, 2.1), num(dims[1], 0.01, 99, 1.4)] };
  },
  chart(raw, warn) {
    const values = (Array.isArray(raw.values) ? raw.values : []).map((value) => Number(value)).filter((value) => Number.isFinite(value)).slice(0, LIMITS.chart.values).map((value) => clamp(value, 0, 100));
    if (values.length < LIMITS.chart.minValues) {
      warn('a chart needs at least five values: it was left out');
      return null;
    }
    return { title: text(raw.title, LIMITS.chart.title), values, marker: text(raw.marker, LIMITS.chart.marker) };
  },
  terminal(raw) {
    const lines = (Array.isArray(raw.lines) ? raw.lines : []).map((line) => text(line, LIMITS.terminal.line)).filter(Boolean).slice(0, LIMITS.terminal.lines);
    return lines.length ? { lines, prompt: text(raw.prompt, LIMITS.terminal.prompt) || '$' } : null;
  },
  chat(raw) {
    const messages = [];
    for (const message of Array.isArray(raw.messages) ? raw.messages.slice(0, LIMITS.chat.messages) : []) {
      if (!isObject(message)) continue;
      const content = text(message.text, LIMITS.chat.text);
      if (content) messages.push({ from: message.from === 'her' ? 'her' : 'them', text: content });
    }
    return messages.length ? { messages } : null;
  },
  notification(raw) {
    const title = text(raw.title, LIMITS.notification.title);
    const body = text(raw.text, LIMITS.notification.text);
    if (!title && !body) return null;
    return { app: text(raw.app, LIMITS.notification.app) || 'MESSAGES', title, text: body, time: text(raw.time, LIMITS.notification.time) || 'now' };
  },
  voice(raw) {
    return { label: text(raw.label, LIMITS.voice.label), db: round3(num(raw.db, -120, 0, -32)) };
  },
  clock(raw) {
    const time = normalizeClock(raw.time, '12:00');
    return { time: time.split(':').slice(0, 2).join(':'), label: text(raw.label, LIMITS.clock.label), arc: round3(num(raw.arc, 0, 1, 0.5)) };
  },
  stopwatch(raw) {
    return { from: normalizeClock(raw.from, '00:00:00:00'), label: text(raw.label, LIMITS.stopwatch.label) };
  },
  list(raw) {
    const rows = (Array.isArray(raw.rows) ? raw.rows : []).map((row) => text(row, LIMITS.list.row)).filter(Boolean).slice(0, LIMITS.list.rows);
    return rows.length ? { title: text(raw.title, LIMITS.list.title), rows } : null;
  },
  toggle(raw, _warn, device) {
    const states = (Array.isArray(raw.states) ? raw.states : []).map((item) => text(item, LIMITS.toggle.state)).filter(Boolean).slice(0, 2);
    const flips = sortedNumbers(raw.flips, device.start, device.end, LIMITS.toggle.flips);
    return { label: text(raw.label, LIMITS.toggle.label), states: [states[0] || 'ON', states[1] || 'OFF?'], flips };
  },
  progress(raw) {
    return { label: text(raw.label, LIMITS.progress.label), from: clamp(Math.round(num(raw.from, 0, 100, 0)), 0, 100), to: clamp(Math.round(num(raw.to, 0, 100, 100)), 0, 100) };
  },
  pin(raw) {
    return { label: text(raw.label, LIMITS.pin.label), x: round3(num(raw.x, 0.05, 0.95, 0.5)), y: round3(num(raw.y, 0.12, 0.85, 0.5)) };
  }
};

function normalizeDevices(list, duration, lineCount, warn) {
  const devices = [];
  const seen = new Set();
  for (const [position, raw] of (Array.isArray(list) ? list.slice(0, MAX.devices * 2) : []).entries()) {
    if (!isObject(raw)) continue;
    const type = String(raw.type || '');
    if (!DEVICE_TYPES.includes(type)) {
      warn(`a device of the unknown type "${text(type, 24)}" was left out`);
      continue;
    }
    const start = num(raw.start, 0, duration, null);
    if (start === null) {
      warn(`a ${type} without a start time was left out`);
      continue;
    }
    const device = { id: '', line: null, start: round3(start), end: round3(Math.min(duration + 0.5, Math.max(start + 0.8, num(raw.end, 0, duration + 5, start + 3)))), type, position: '' };
    let id = text(raw.id, 24).replace(/[^A-Za-z0-9_-]/g, '');
    if (!id || seen.has(id)) id = `g${position + 1}`;
    while (seen.has(id)) id += 'x';
    seen.add(id);
    device.id = id;
    if (Number.isInteger(raw.line) && raw.line >= 0 && raw.line < lineCount) device.line = raw.line;
    // `key` (optional): the word of its line that the device appears on, counted from 0. Left out when it is not given or the device has no line;
    // a number beyond the last word of the line means the last word (appearTime, where the words are known). Without it the key word of the line
    // holds, and the device is as it was before the field came (so are the resolved data).
    const key = device.line === null || (typeof raw.key !== 'number' && typeof raw.key !== 'string') ? null : num(raw.key, 0, MAX.words - 1, null);
    if (key !== null) device.key = Math.round(key);
    device.position = POSITIONS.includes(raw.position) ? raw.position : DEFAULT_POSITION[type];
    if (device.position === 'around' && type !== 'display') device.position = DEFAULT_POSITION[type];
    const body = normalizers[type](raw, warn, device);
    if (!body) {
      warn(`a ${type} without usable content was left out`);
      continue;
    }
    devices.push({ ...device, ...body });
    if (devices.length >= MAX.devices) break;
  }
  devices.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  return devices;
}

function normalizeHud(raw, duration, warn) {
  const hud = isObject(raw) ? raw : {};
  const out = {
    title: upper(hud.title, 40),
    counter: null,
    console: upper(hud.console, 48),
    chapters: [],
    figure: upper(hud.figure, 24),
    instances: null,
    ticker: [],
    rec: text(hud.rec, 48),
    drops: sortedNumbers(hud.drops, 0, duration, MAX.drops)
  };
  if (isObject(hud.counter)) {
    const steps = normalizeSteps(hud.counter.steps, duration);
    if (steps.length) out.counter = { label: upper(hud.counter.label, 16), pad: Math.round(num(hud.counter.pad, 0, 4, 2)), steps };
  }
  if (isObject(hud.instances)) {
    const steps = normalizeSteps(hud.instances.steps, duration);
    if (steps.length) out.instances = { label: upper(hud.instances.label, 16) || 'INSTANCES', steps };
  }
  for (const chapter of Array.isArray(hud.chapters) ? hud.chapters.slice(0, MAX.chapters) : []) {
    if (!isObject(chapter)) continue;
    const start = num(chapter.start, 0, duration, null);
    const name = upper(chapter.name, 24);
    if (start === null || !name) continue;
    out.chapters.push({ start: round3(start), end: round3(num(chapter.end, start, duration, duration)), name });
  }
  out.chapters.sort((a, b) => a.start - b.start);
  out.ticker = (Array.isArray(hud.ticker) ? hud.ticker : []).map((entry) => upper(entry, 48)).filter(Boolean).slice(0, MAX.ticker);
  if (!out.title && !out.counter) warn('the HUD has no title');
  return out;
}

function normalizeMusic(raw, duration) {
  const music = isObject(raw) ? raw : {};
  const hits = [];
  for (const hit of Array.isArray(music.hits) ? music.hits.slice(0, MAX.hits * 2) : []) {
    if (!isObject(hit)) continue;
    const t = num(hit.t, 0, duration + 5, null);
    if (t !== null) hits.push({ t: round3(t), strength: round3(num(hit.strength, 0, 1, 0.5)) });
  }
  hits.sort((a, b) => a.t - b.t);
  return {
    bpm: Math.round(num(music.bpm, 40, 260, 120) * 100) / 100,
    beats: sortedNumbers(music.beats, 0, duration + 5, MAX.beats),
    downbeats: sortedNumbers(music.downbeats, 0, duration + 5, MAX.downbeats),
    hits: hits.slice(0, MAX.hits),
    energy: (Array.isArray(music.energy) ? music.energy : []).slice(0, MAX.energy).map((value) => round3(num(value, 0, 1, 0.5)))
  };
}

// Reads the JSON text (or object) of the planner. Returns { graphics, warnings }; graphics is always usable.
function normalizeGraphics(input, options = {}) {
  const warnings = [];
  const warn = (message) => {
    if (warnings.length < 100) warnings.push(message);
  };
  let raw = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (err) {
      warn(`the graphics text is not JSON (${text(err.message, 80)}): an empty HUD is drawn`);
      raw = {};
    }
  }
  if (!isObject(raw)) {
    warn('the graphics are not an object: an empty HUD is drawn');
    raw = {};
  }
  if (raw.version !== undefined && raw.version !== 1) warn(`the graphics have version ${text(raw.version, 12)}; version 1 is read`);
  if (raw.fps !== undefined && Number(raw.fps) !== FPS) warn(`the HUD is drawn at ${FPS} fps, not at ${text(raw.fps, 8)}`);
  if ((raw.width !== undefined && Number(raw.width) !== WIDTH) || (raw.height !== undefined && Number(raw.height) !== HEIGHT)) warn(`the HUD is drawn at ${WIDTH}x${HEIGHT}, not at ${text(raw.width, 8)}x${text(raw.height, 8)}`);

  const fallbackDuration = num(options.duration, 1, 7200, null);
  let duration = num(raw.duration, 1, 7200, null);
  if (duration === null) {
    const ends = [];
    for (const list of [raw.cuts, raw.lines]) for (const item of Array.isArray(list) ? list : []) if (isObject(item) && Number.isFinite(Number(item.end))) ends.push(Number(item.end));
    duration = fallbackDuration || (ends.length ? Math.max(...ends) : 10);
    warn(`the graphics have no duration: ${round3(duration)} s is used`);
  }
  duration = snap(Math.max(1, duration));

  const lines = normalizeLines(raw.lines, duration, warn);
  const cuts = coverCuts(normalizeCuts(raw.cuts, duration, warn), duration, warn);
  const graphics = {
    version: 1,
    duration,
    endFrame: Math.round(duration * FPS),
    start: cuts[0].start,
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    accent: normalizeColor(raw.accent),
    hud: normalizeHud(raw.hud, duration, warn),
    music: normalizeMusic(raw.music, duration),
    lines,
    cuts,
    graphics: normalizeDevices(raw.graphics, duration, lines.length, warn),
    endcard: null
  };
  // the style: `options.theme` (the parameter of the node) wins over the field of the plan; the first style is not written down
  const theme = themes.resolve(options.theme, raw.theme);
  if (theme !== themes.DEFAULT) graphics.theme = theme;
  const card = isObject(raw.endcard) ? raw.endcard : null;
  if (card) {
    graphics.endcard = {
      seconds: snap(num(card.seconds, 0, 10, 3)),
      title: upper(card.title, 40),
      lines: (Array.isArray(card.lines) ? card.lines : []).map((line) => text(line, 80)).filter(Boolean).slice(0, 3)
    };
  }
  return { graphics, warnings };
}

/* ---------- the layout ---------- */

const W = (face, content, size, tracking = 0, cells = true) => metricsLib.textWidth(face, content, size, tracking, cells);

function clockLength(value) {
  return value.split(':').length;
}

const intersects = (a, b, pad = 0) => a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
const floor3 = (seconds) => Math.floor(seconds * 1000 + 1e-6) / 1000;
const ceil3 = (seconds) => Math.ceil(seconds * 1000 - 1e-6) / 1000;

// The zone of the face on the screen for a cut: { x0, y0, x1, y1 }, the place that no graphic may take. Its width and height come from the framing of
// the cut round the middle of the figure (the subject); a cut without a framing has FACE, and one with lip-sync reaches down to the mouth and the
// chin. A punch-in (crop.scale above 1) makes the picture bigger, and so the zone: it goes through the transform of the picture (the camera of
// state.js, which for a punch-in in the middle is a growth round the middle of the screen) and is kept on the screen. A cut without the figure
// (`subject: none`) has no zone: null.
function faceZone(cut) {
  if (cut.subject === 'none') return null;
  const framed = FRAME_ZONES[cut.framing];
  const cx = SUBJECT_X[cut.subject] || SUBJECT_X.center;
  const half = framed ? framed.half : (FACE.center.x1 - FACE.center.x0) / 2;
  const y0 = framed ? framed.y0 : FACE.y0;
  const y1 = framed ? framed.y1 : cut.kind === 'performance' ? Math.max(FACE.y1, PERFORMANCE_BOTTOM) : FACE.y1;
  let zone = { x0: cx - half, y0, x1: cx + half, y1 };
  if (cut.crop && Number(cut.crop.scale) > 1) {
    const camera = state.camera(cut.crop, 0);
    zone = { x0: zone.x0 * camera.scale + camera.tx, y0: zone.y0 * camera.scale + camera.ty, x1: zone.x1 * camera.scale + camera.tx, y1: zone.y1 * camera.scale + camera.ty };
  }
  return { x0: Math.round(clamp(zone.x0, 0, WIDTH)), y0: Math.round(clamp(zone.y0, 0, HEIGHT)), x1: Math.round(clamp(zone.x1, 0, WIDTH)), y1: Math.round(clamp(zone.y1, 0, HEIGHT)) };
}

// The outline of a panel that hangs tilted like a board on a wall (CSS perspective(P) rotateY(a) rotateZ(b) round its centre, the right side nearer):
// the box it covers on the screen, relative to the centre of the panel at its natural size, { x0, y0, x1, y1 }.
function tiltedBox(w, h, tilt) {
  const rad = (degrees) => (degrees * Math.PI) / 180;
  const cosZ = Math.cos(rad(tilt.rotateZ));
  const sinZ = Math.sin(rad(tilt.rotateZ));
  const cosY = Math.cos(rad(tilt.rotateY));
  const sinY = Math.sin(rad(tilt.rotateY));
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const [cornerX, cornerY] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const x = (cornerX * w) / 2;
    const y = (cornerY * h) / 2;
    const rotatedX = x * cosZ - y * sinZ;
    const rotatedY = x * sinZ + y * cosZ;
    const depth = -rotatedX * sinY;
    const scale = 1 / (1 - depth / tilt.perspective);
    const sx = rotatedX * cosY * scale;
    const sy = rotatedY * scale;
    box.x0 = Math.min(box.x0, sx);
    box.y0 = Math.min(box.y0, sy);
    box.x1 = Math.max(box.x1, sx);
    box.y1 = Math.max(box.y1, sy);
  }
  return box;
}

// the free stretches of the width (x only) that the zones of the face leave over, for the size of the big words
function freeIntervals(zones) {
  let free = [[SAFE.left, SAFE.right]];
  for (const zone of zones) {
    const next = [];
    for (const [a, b] of free) {
      if (zone.x + zone.w <= a || zone.x >= b) next.push([a, b]);
      else {
        if (zone.x > a) next.push([a, zone.x - 20]);
        if (zone.x + zone.w < b) next.push([zone.x + zone.w + 20, b]);
      }
    }
    free = next;
  }
  return free.filter(([a, b]) => b - a > 160);
}

function widest(free) {
  return free.reduce((best, interval) => (interval[1] - interval[0] > best ? interval[1] - interval[0] : best), 0);
}

// the sizes of the rows of a display and the size of the whole (the words are measured in the face of the style; the digits of a word are the
// digits of the face, not cells)
function sizeDisplay(d, maxWidth, theme = themes.get(themes.DEFAULT)) {
  const S = view.sizesOf(theme.id).display;
  const serif = d.style === 'serif';
  const presets = serif ? { xl: S.serifXl, l: S.serifL, m: S.serifM } : { xl: S.xl, l: S.l, m: S.m };
  const face = serif ? 'serif' : theme.faces.display;
  const min = serif ? S.serifMin : S.min;
  const rows = d.rows.map((row) => {
    const widthAt = (fs) => W(face, row.text, fs, S.tracking || 0, false) + (row.box ? 2 * S.boxPad * fs : 0) + fs * 0.02;
    let fs = presets[row.size];
    if (widthAt(fs) > maxWidth) fs = Math.max(min, Math.floor((fs * maxWidth) / widthAt(fs)));
    return { ...row, fs, w: Math.round(widthAt(fs)), tokens: row.text.split(' ').filter(Boolean) };
  });
  if (serif && !rows.some((row) => row.box)) rows[rows.length - 1].accent = true;
  else if (serif) rows.forEach((row) => { row.accent = row.box; });
  const line = serif ? S.serifLine : S.line;
  return { rows, w: Math.max(...rows.map((row) => row.w)), h: Math.round(rows.reduce((sum, row) => sum + row.fs * line, 0)) };
}

function counterNumber(d, theme) {
  const C = view.sizesOf(theme.id).counter;
  const face = theme.faces.number;
  const fs = C[d.format] || C.int;
  if (d.format === 'clock') return { w: W(face, d.to.length === 11 ? '00:00:00:00' : d.to, fs), fs };
  if (d.format === 'multiplier') return { w: W(face, `×${state.groupThousands(Math.max(d.from, d.to))}`, fs) + 2 * C.multPadX, fs };
  if (d.format === 'fraction') return { w: W(face, state.groupThousands(Math.max(d.from, d.to)), fs) + W(face, `/ ${state.groupThousands(d.total)}`, fs * 0.42) + fs * 0.2, fs };
  const widest = Math.max(d.from, d.to);
  const shown = d.format === 'percent' ? `${widest}%` : d.format === 'money' ? `$${state.groupThousands(widest)}` : state.groupThousands(widest);
  return { w: W(face, shown, fs), fs };
}

function bubbleLines(content, theme) {
  const C = view.sizesOf(theme.id).chat;
  return Math.max(1, Math.ceil(W(theme.faces.sans, content, C.font) / (C.maxW - 2 * C.padX)));
}

// the size of every device that does not depend on the free width: { w, h }. `theme` is the table of the style (themes.js): its faces are measured,
// its sizes are used, and a device that stands on a card (theme.cards) is as much bigger as the padding of the card.
function measure(d, theme = themes.get(themes.DEFAULT)) {
  const size = measureContent(d, theme);
  if (!view.isCard(theme, d)) return size;
  const pad = view.sizesOf(theme.id).card.pad;
  return { ...size, w: size.w + 2 * pad, h: size.h + 2 * pad };
}

function measureContent(d, theme) {
  const S = view.sizesOf(theme.id);
  const F = theme.faces;
  switch (d.type) {
    case 'tag':
      return { w: Math.round(W('mono', d.text, S.tag.font, S.tag.tracking) + 2 * S.tag.padX), h: S.tag.h };
    case 'counter': {
      const number = counterNumber(d, theme);
      const labelH = d.label ? S.counter.label + S.counter.gap : 0;
      const h = d.format === 'multiplier' ? number.fs + 2 * S.counter.multPadY : number.fs * S.counter.line;
      return { w: Math.round(Math.max(number.w, d.label ? W('mono', d.label, 15, 0.16) : 0)), h: Math.round(labelH + h) };
    }
    case 'stamp': {
      const P = S.stamp;
      const w = W('mono', d.text, P.font, P.tracking) + 2 * (P.padX + P.border);
      const h = P.font * 1.1 + 2 * (P.padY + P.border);
      return { w: Math.round(w + (d.count > 1 ? 60 : 8)), h: Math.round(d.count * h + (d.count - 1) * P.gap) };
    }
    case 'strike':
      return { w: Math.round(W(F.number, d.text, S.strike.font, 0, false) + 24), h: S.strike.font };
    case 'spec':
      return { w: S.spec.w, h: S.spec.title + d.rows.length * S.spec.row + S.spec.pad };
    case 'blueprint': {
      // the drawing is 340 px wide, the two labels stand to the right of it
      const longest = Math.max(W('mono', d.labels.a, 15, 0.14), W('mono', d.labels.b, 15, 0.14));
      return { w: Math.round(Math.max(S.blueprint.w, 340 + longest + 14)), h: S.blueprint.h };
    }
    case 'chart': {
      // the chart hangs tilted on the wall: what it covers on the screen is the outline of the tilted panel, not the panel before the tilt. `box` is the
      // panel at its natural size, `anchor` the middle of it, measured from the top left corner of the outline.
      const outline = tiltedBox(S.chart.w, S.chart.h, S.chart);
      return { w: Math.ceil(outline.x1 - outline.x0), h: Math.ceil(outline.y1 - outline.y0), box: { w: S.chart.w, h: S.chart.h }, anchor: { x: -outline.x0, y: -outline.y0 } };
    }
    case 'terminal':
      return { w: S.terminal.w, h: 4 + S.terminal.bar + 2 * S.terminal.pad + d.lines.length * S.terminal.line };
    case 'chat': {
      let h = 0;
      let w = 0;
      for (const message of d.messages) {
        h += 2 * S.chat.padY + bubbleLines(message.text, theme) * S.chat.font * 1.2;
        w = Math.max(w, Math.min(S.chat.maxW, W(F.sans, message.text, S.chat.font) + 2 * S.chat.padX));
      }
      return { w: Math.round(Math.max(w, 200)), h: Math.round(h + (d.messages.length - 1) * S.chat.gap) };
    }
    case 'notification':
      return { w: S.notification.w, h: S.notification.h };
    case 'voice':
      return { ...S.voice };
    case 'clock':
      return { w: Math.round(S.clock.dial + S.clock.gap + W(F.number, d.time, S.clock.font)), h: S.clock.dial };
    case 'stopwatch': {
      const width = W(F.number, clockLength(d.from) >= 4 ? '00:00:00:00' : clockLength(d.from) === 3 ? '00:00:00' : '00:00', S.stopwatch.font);
      return { w: Math.round(Math.max(width, W('mono', d.label, 17, 0.2))), h: Math.round(S.stopwatch.label + S.stopwatch.font * S.stopwatch.line) };
    }
    case 'list': {
      const widthOf = (row) => W('mono', row, S.list.font, 0.1);
      const w = Math.max(S.list.w, ...d.rows.map(widthOf), d.title ? W('mono', d.title, 15, 0.16) : 0);
      return { w: Math.round(w), h: (d.title ? S.list.title : 0) + d.rows.length * S.list.row };
    }
    case 'toggle': {
      const T = S.toggle;
      const label = Math.max(...d.states.map((state2) => W(F.number, state2, T.font, 0, false)));
      return { w: Math.round(T.trackW + T.gap + label), h: T.label + T.trackH };
    }
    case 'progress':
      // a style that gives the height of the row of the number (`rowH`) is measured with it (the number is taller than the label)
      return { w: S.progress.w, h: Math.round(S.progress.rowH ? S.progress.rowH + 10 + S.progress.bar : S.progress.label + 4 + S.progress.bar + 6) };
    default:
      return { w: 300, h: 100 };
  }
}

// the candidate places of a device by its wish, in the order they are tried (the wish first, then the same row on the other side, ...)
const SLOT_ORDER = Object.freeze({
  'top-left': ['top-left', 'top-right', 'left', 'right', 'bottom-left', 'bottom-right', 'top', 'center'],
  'top-right': ['top-right', 'top-left', 'right', 'left', 'bottom-right', 'bottom-left', 'top', 'center'],
  'bottom-left': ['bottom-left', 'bottom-right', 'left', 'right', 'top-left', 'top-right', 'top', 'center'],
  'bottom-right': ['bottom-right', 'bottom-left', 'right', 'left', 'top-right', 'top-left', 'top', 'center'],
  left: ['left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'top', 'center'],
  right: ['right', 'left', 'top-right', 'top-left', 'bottom-right', 'bottom-left', 'top', 'center'],
  top: ['top', 'top-left', 'top-right', 'left', 'right', 'bottom-left', 'bottom-right', 'center'],
  center: ['center', 'top', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right']
});

// The starting point of a slot, the direction of the scan and how far it may go: down from the top, up from the bottom, out from the middle of the
// height. The middle lane (over the figure) does not stack: a device that does not fit there goes to another slot.
function slotStart(slot, w, h) {
  const middle = Math.round((SAFE.top + SAFE.bottom - h) / 2);
  switch (slot) {
    case 'top-left': return { x: SAFE.left, y: SAFE.top, step: 1, limit: 480 };
    case 'top-right': return { x: SAFE.right - w, y: SAFE.top, step: 1, limit: 480 };
    case 'bottom-left': return { x: SAFE.left, y: SAFE.bottom - h, step: -1, limit: 480 };
    case 'bottom-right': return { x: SAFE.right - w, y: SAFE.bottom - h, step: -1, limit: 480 };
    case 'left': return { x: SAFE.left, y: middle, step: 0, limit: 240 };
    case 'right': return { x: SAFE.right - w, y: middle, step: 0, limit: 240 };
    case 'top': return { x: Math.round((WIDTH - w) / 2), y: SAFE.top, step: 1, limit: 36 };
    default: return { x: Math.round((WIDTH - w) / 2), y: middle, step: 0, limit: 36 };
  }
}

function inside(rect) {
  return rect.x >= SAFE.left - 24 && rect.x + rect.w <= SAFE.right + 24 && rect.y >= SAFE.top - 8 && rect.y + rect.h <= SAFE.bottom + 8;
}

// The offsets along a lane (steps of 6 px) at which a rect of height h can stand free of `obstacles` ({ y, h, pad }): where the lane starts and where the
// rect has just got past the edge of an obstacle. Between two of them nothing changes, so the first free one of them is the first free place of a scan
// in steps. In the order they are tried: along the stack (down from the top, up from the bottom), or out from the middle (down first).
function laneOffsets(start, h, obstacles) {
  const found = new Set([0]);
  for (const obstacle of obstacles) {
    if (start.step >= 0) {
      const down = Math.ceil((obstacle.y + obstacle.h + obstacle.pad - start.y) / 6) * 6;
      if (down > 0) found.add(down);
    }
    if (start.step <= 0) {
      const up = Math.floor((obstacle.y - obstacle.pad - h - start.y) / 6) * 6;
      if (up < 0) found.add(up);
    }
  }
  const list = [...found].filter((offset) => Math.abs(offset) <= start.limit);
  if (start.step === 0) return list.sort((a, b) => Math.abs(a) - Math.abs(b) || b - a);
  return list.sort((a, b) => (start.step > 0 ? a - b : b - a));
}

/* ---------- the layout: when and where ---------- */

// Every device is laid out in the order it appears, and it gets the place that is free while it is on the screen. What is on the screen is not only
// what is alive: a device is shown from `appear` until its end plus its exit (3 frames, none when a cut begins there). Nothing that is on the screen
// at the same time may touch another device (a gap of GAP px), and nothing may lie on the zone of the face of a cut that it is shown over (faceZone):
// over a lip-sync cut not for a single frame, over the others not for 0.4 s or more (a shorter stay is allowed when there is no better place).
// When a device finds no place in the smallest size it is allowed, the one who is new wins:
//   1. the older devices that stand at the best place end earlier, so that their exit is over when the new one appears (a device stays at least
//      MIN_SHOWN_S fully on the screen, so one that has not been there that long cannot be asked);
//   2. when that does not work the new device ends at the cut where it would cover the face (its exit is over at the cut), or before a device that
//      is already there appears (MIN_SHOWN_S fully on the screen at least);
//   3. when that does not work it appears later, at the latest MIN_LATE_S before its end;
//   4. when that does not work it is left out (a note for the warnings).
// All of this is a function of the data: the same plan gives the same layout, and a chunk of the film draws the same frames as the whole film.

function makeWorld(g) {
  const theme = themes.get(g.theme);
  const cuts = g.cuts.map((cut) => {
    // a cut without the figure has no zone: nothing keeps a graphic away from the middle of it
    const zone = faceZone(cut);
    const rect = zone ? { x: zone.x0, y: zone.y0, w: zone.x1 - zone.x0, h: zone.y1 - zone.y0 } : null;
    return { start: cut.start, end: cut.end, strict: cut.kind === 'performance' && Boolean(zone), subject: cut.subject, zone: rect, zoneKey: rect ? `${rect.x},${rect.y},${rect.w},${rect.h}` : 'none' };
  });
  return { g, theme, cuts, starts: cuts.map((cut) => cut.start), placed: [] };
}

// as in state.js: a device that ends where a cut begins is gone with the cut, any other one leaves in 3 frames
const hardEnd = (world, end) => world.starts.some((start) => Math.abs(start - end) <= 0.05);
const shownEnd = (world, end) => end + (hardEnd(world, end) ? 0 : state.EXIT_S);
const entryShown = (world, entry) => (entry.fixed ? entry.d.end : shownEnd(world, entry.d.end));

// is there a frame (a multiple of 1/24 s) in [from, to) as the renderer counts them?
function hasFrame(from, to) {
  return Math.ceil((from - 1e-6) * FPS - 1e-9) <= Math.ceil((to - 1e-6) * FPS - 1e-9) - 1;
}

// When a device is first on the screen. A device exists from `appear`, but the words of a big display are drawn at their own times (the word of the
// line when it is sung), so the place of such a display is free until its first word comes. `late`: the device comes later than it was planned.
function shownFrom(world, d, a, b, late) {
  if (d.type !== 'display') return a;
  const times = displayTimes({ ...d, start: late ? Math.max(d.start, a) : d.start, end: b }, world.g, a).flat();
  return times.length ? Math.max(a, Math.min(...times)) : a;
}

// What a placed device does when a newer one needs its place at the time `from`: 'trim' (it ends before `from` anyway, only its exit is in the way,
// and it is a few frames shorter), 'yield' (it ends earlier), 'block' (it cannot: it is a fixed place, or it would not stay MIN_SHOWN_S fully on the
// screen).
function yieldKind(entry, from) {
  const end = floor3(from - state.EXIT_S);
  if (entry.fixed || end < entry.from + state.ENTER_S + MIN_SHOWN_S - 1e-9 || end >= entry.d.end - 1e-9) return 'block';
  return entry.d.end <= from + 1e-9 ? 'trim' : 'yield';
}

// What stands in the way of a device that is on the screen from `from` (its `appear`, or the first word of a display) to `b`: the zones of the face of the
// cuts it is shown over (`hard`: it must not touch them; `soft`: it should not, but may when there is no other place: a cut that it is shown over for a short
// time only) and the devices that are shown at the same time.
function windowOf(world, from, b) {
  const shown = shownEnd(world, b);
  // a face is in the way when it is on screen for 0.4 s (for half the life of a short device) or more; one that is there for two frames or more but
  // less is only "brief" (the device is still entering, 6 frames, or already leaving)
  const need = Math.min(0.4, (b - from) / 2) - 1e-9;
  const hard = [];
  const soft = [];
  const cuts = [];
  for (const cut of world.cuts) {
    if (!cut.zone) continue;
    const lo = Math.max(cut.start, from);
    const hi = Math.min(cut.end, shown);
    if (hi - lo <= 1e-9) continue;
    if (cut.strict ? hasFrame(lo, hi) : hi - lo >= need) {
      cuts.push(cut);
      if (!hard.some((zone) => zone.key === cut.zoneKey)) hard.push({ ...cut.zone, key: cut.zoneKey });
    } else if (!cut.strict && hi - lo >= 2 / FPS - 1e-9 && !soft.some((zone) => zone.key === cut.zoneKey)) soft.push({ ...cut.zone, key: cut.zoneKey });
  }
  const hardKeys = new Set(hard.map((zone) => zone.key));
  const blockers = [];
  for (const entry of world.placed) {
    if (entry.from < shown - 1e-9 && entryShown(world, entry) > from + 1e-9) blockers.push({ entry, rects: entry.rects, kind: yieldKind(entry, from) });
  }
  const softZones = soft.filter((zone) => !hardKeys.has(zone.key));
  const obstacles = [
    ...hard.map((zone) => ({ ...zone, pad: 0 })),
    ...softZones.map((zone) => ({ ...zone, pad: 0 })),
    ...blockers.flatMap((blocker) => blocker.rects.map((rect) => ({ ...rect, pad: GAP })))
  ];
  return { from, b, shown, hard, soft: softZones, cuts, blockers, obstacles, yieldEnd: floor3(from - state.EXIT_S), theme: world.theme };
}

// Does a device with these rects stand free in the window? null when not; else the devices that would have to make room and whether it touches a
// zone that is only briefly in the way. `allowYield`: the devices that can end earlier may be asked to ('block' ones never).
function standing(win, rects, allowYield) {
  for (const rect of rects) for (const zone of win.hard) if (intersects(rect, zone, 0)) return null;
  const conflicts = [];
  for (const blocker of win.blockers) {
    if (!rects.some((rect) => blocker.rects.some((other) => intersects(rect, other, GAP)))) continue;
    if (blocker.kind === 'block' || (blocker.kind === 'yield' && !allowYield)) return null;
    conflicts.push(blocker);
  }
  const brief = rects.some((rect) => win.soft.some((zone) => intersects(rect, zone, 0)));
  return { conflicts, brief };
}

const lessThan = (a, b) => {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

// The first of the candidates ({ rects, spot }, in the order of preference) that stands free: a place that is clear of everything first, one that only
// touches a briefly visible face when there is none. With `allowYield` the one that costs the older devices the least (how many have to end earlier,
// by how much, whether it touches a brief face); the first of them when it is a tie.
function firstFitting(win, candidates, allowYield) {
  let tolerated = null;
  let cheapest = null;
  for (const candidate of candidates) {
    const found = standing(win, candidate.rects, allowYield);
    if (!found) continue;
    const spot = { ...candidate.spot, conflicts: found.conflicts };
    if (!allowYield) {
      if (!found.brief) return spot;
      if (!tolerated) tolerated = spot;
      continue;
    }
    const yielding = found.conflicts.filter((blocker) => blocker.kind === 'yield');
    const cost = [yielding.length, Math.round(yielding.reduce((sum, blocker) => sum + blocker.entry.d.end - win.yieldEnd, 0) * 1000), found.brief ? 1 : 0];
    if (!cheapest || lessThan(cost, cheapest.cost)) cheapest = { ...spot, cost };
  }
  return tolerated || cheapest;
}

// The place of a device by its wish: the first slot (see SLOT_ORDER) where it stands free; a device that does not fit is made smaller (down to
// `minScale`) before the next slot is tried. Returns { rect, scale, conflicts } (rect is the size on the screen: the natural size times the scale)
// or null.
function slotSpot(win, device, size, minScale, allowYield) {
  for (const slot of SLOT_ORDER[device.position] || SLOT_ORDER.center) {
    for (const scale of SCALES) {
      if (scale < minScale - 1e-9) break;
      const w = Math.round(size.w * scale);
      const h = Math.round(size.h * scale);
      const start = slotStart(slot, w, h);
      const candidates = [];
      for (const offset of laneOffsets(start, h, win.obstacles)) {
        const rect = { x: start.x, y: start.y + offset, w, h };
        if (inside(rect)) candidates.push({ rects: [rect], spot: { rect, scale } });
      }
      const spot = firstFitting(win, candidates, allowYield);
      if (spot) return spot;
    }
  }
  return null;
}

// The pin: the author names the spot (x and y); the pin keeps its row but slides sideways, to the right first, to the nearest place that is free.
function pinSpot(win, d, allowYield) {
  const y = d.y * HEIGHT;
  const w = 60 + 44 + Math.round(W('mono', d.label, SIZES.pin.font, 0.12) + 28);
  const x = d.x * WIDTH;
  const candidates = [];
  for (let step = 0; step <= 2 * Math.ceil(WIDTH / 12); step += 1) {
    const px = x + (step % 2 ? Math.ceil(step / 2) : -(step / 2)) * 12;
    if (step > 0 && (px < SAFE.left + 30 || px > SAFE.right - (w - 30))) continue;
    const rect = { x: Math.round(px - 30), y: Math.round(y - 80), w, h: 90 };
    candidates.push({ rects: [rect], spot: { rect, scale: 1, patch: { x: round3(px / WIDTH) } } });
  }
  return firstFitting(win, candidates, allowYield);
}

// the big words: sized to the width that the zones leave, then placed like the others; "around" (two words, left and right of the head) when the
// figure is in the middle of the picture over the whole life of the device and there is room at both sides
function displaySpot(win, d, allowYield) {
  const S = view.sizesOf(win.theme.id).display;
  if (d.style === 'around' && win.cuts.length && win.cuts.every((cut) => cut.subject === 'center')) {
    const x0 = Math.min(...win.hard.map((zone) => zone.x));
    const x1 = Math.max(...win.hard.map((zone) => zone.x + zone.w));
    // the words stand 20 px from the zone, 12 px wider than their text, and inside the side margins (as the others do)
    const room = Math.min(x0 - 20 - 12 - (SAFE.left - 24), SAFE.right + 24 - (x1 + 20) - 12);
    if (room >= 200) {
      const sized = sizeDisplay(d, room, win.theme);
      const top = 250;
      const arounds = sized.rows.map((row, index) => {
        const w = row.w + 12;
        const h = Math.round(row.fs * S.line);
        return index === 0 ? { x: x0 - 20 - w, y: top, w, h } : { x: x1 + 20, y: top + 40, w, h };
      });
      const left = arounds[0];
      const right = arounds[arounds.length - 1];
      const rect = { x: left.x, y: top, w: right.x + right.w - left.x, h: Math.max(...arounds.map((around) => around.h)) + 40 };
      const spot = firstFitting(win, [{ rects: arounds, spot: { rect, scale: 1, occupies: arounds } }], allowYield);
      if (spot) return { ...spot, patch: { style: 'around', rows: sized.rows, arounds, align: 'left', accent: false } };
    }
  }
  const style = d.style === 'around' ? 'condensed' : d.style;
  const sized = sizeDisplay({ ...d, style }, Math.max(300, Math.min(widest(freeIntervals(win.hard)) - 20, 980)), win.theme);
  const spot = slotSpot(win, d, { w: sized.w, h: sized.h }, MIN_SCALE.display, allowYield);
  return spot && { ...spot, patch: { style, rows: sized.rows, align: spot.rect.x + spot.rect.w / 2 > WIDTH / 2 ? 'right' : 'left' } };
}

function spotFor(win, d, size, allowYield) {
  if (d.type === 'display') return displaySpot(win, d, allowYield);
  if (d.type === 'pin') return pinSpot(win, d, allowYield);
  const spot = slotSpot(win, d, size, MIN_SCALE[d.type] || 1, allowYield);
  if (spot && size.box) {
    // a tilted device is drawn in its natural box; what the layout holds is the outline on the screen (the rect). The box sits where the outline says.
    const cx = spot.rect.x + size.anchor.x * spot.scale;
    const cy = spot.rect.y + size.anchor.y * spot.scale;
    spot.patch = { box: { x: Math.round(cx - size.box.w / 2), y: Math.round(cy - size.box.h / 2), w: size.box.w, h: size.box.h } };
  }
  return spot;
}

// The times at which a device could appear instead of `a0` (it is late, but at most until MIN_LATE_S before its end): when a cut begins, when a device
// that is in the way is gone, when a device that is in the way has been on the screen long enough to be asked to end. Earliest first.
function* appearCandidates(world, a0, b0) {
  yield a0;
  const latest = b0 - MIN_LATE_S;
  if (latest <= a0 + 1e-6) return;
  const times = new Set();
  const add = (time) => {
    if (time > a0 + 1e-6 && time <= latest + 1e-9) times.add(time);
  };
  for (const cut of world.cuts) add(floor3(cut.start));
  for (const entry of world.placed) {
    add(ceil3(entryShown(world, entry)));
    if (!entry.fixed) add(ceil3(entry.from + state.ENTER_S + MIN_SHOWN_S + state.EXIT_S));
  }
  yield* [...times].sort((x, y) => x - y).slice(0, 24);
}

// The times at which a device that is on the screen from `from` could end instead of `b0`: so that its exit is over when a cut begins (a face may be
// there) or when a device that is placed already comes; it stays MIN_SHOWN_S fully on the screen at least. Latest first.
function* endCandidates(world, from, b0) {
  yield b0;
  const earliest = from + state.ENTER_S + MIN_SHOWN_S;
  const times = new Set();
  const add = (time) => {
    const end = floor3(time - state.EXIT_S);
    if (end >= earliest - 1e-9 && end < b0 - 0.05) times.add(end);
  };
  for (const cut of world.cuts) add(cut.start);
  for (const entry of world.placed) add(entry.from);
  yield* [...times].sort((x, y) => y - x).slice(0, 12);
}

// The place and the time of a device: the times it asked for first (the free place, then the one that older devices make room for), then a shorter
// life, then a later start. Returns { a, b, rect, scale, conflicts, patch... } or null.
function schedule(world, d, size) {
  const b0 = d.end;
  for (const a of appearCandidates(world, d.appear, b0)) {
    const late = a > d.appear + 1e-9;
    for (const b of endCandidates(world, shownFrom(world, d, a, b0, late), b0)) {
      const from = shownFrom(world, d, a, b, late);
      const win = windowOf(world, from, b);
      for (const allowYield of [false, true]) {
        const spot = spotFor(win, d, size, allowYield);
        if (spot) return { ...spot, a, b, from, yieldEnd: win.yieldEnd };
      }
    }
  }
  return null;
}

/* ---------- when a device appears ---------- */

const normToken = (word) => String(word).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function nextBeat(music, t) {
  const beats = music.beats;
  const index = state.after(beats, t - 1e-6 - 1e-9);
  const found = beats.find((beat, i) => i >= Math.max(0, index - 1) && beat >= t - 1e-6);
  return found === undefined ? t : found;
}

// A device with a line appears on a word of it: its own (`key`, the planner puts one to three devices on a line and each on its word) or else the
// key word of the line. Not before its start; when that word comes too late for the device to be seen for half a second, it appears at its start.
function appearTime(d, g) {
  const line = d.line !== null ? g.lines[d.line] : null;
  if (!line) return d.start;
  const key = line.words[clamp(d.key === undefined ? line.key : d.key, 0, line.words.length - 1)];
  let at = Math.max(d.start, key ? key.start : line.start);
  if (at > d.end - 0.5) at = d.start;
  return round3(at);
}

// the time at which each word of the rows of a display enters: the word of the line when it is sung (the row says words of the line), else the
// key word of the line for the whole block
function displayTimes(d, g, appear) {
  const line = d.line !== null ? g.lines[d.line] : null;
  const used = new Set();
  return d.rows.map((row) =>
    row.tokens.map((token) => {
      if (line) {
        const norm = normToken(token);
        const index = line.words.findIndex((word, i) => !used.has(i) && normToken(word.text) === norm);
        if (index >= 0) {
          used.add(index);
          return round3(clamp(Math.max(d.start, line.words[index].start), d.start, d.end - 0.3));
        }
      }
      return appear;
    })
  );
}

// How much a device wants the accent colour (a small number is more important); null: the device has no use for it. The accent goes to few
// devices: at most `budget` at any moment (the karaoke word is the other accent of the picture), the most important ones first.
function accentPriority(d) {
  if (d.type === 'counter') return d.format === 'multiplier' ? 0 : 3;
  if (d.type === 'display') return d.style === 'serif' || d.rows.some((row) => row.box) ? 4 : null;
  const table = { toggle: 1, chart: 1, clock: 1, progress: 2, spec: 5, blueprint: 5, voice: 6, chat: 7, terminal: 8, notification: 9 };
  return table[d.type] === undefined ? null : table[d.type];
}

// can `d` hold the accent without more than `budget` holders at one moment? (a device is there until its exit is over, 3 frames after its end)
function accentFits(holders, d, budget) {
  const until = (item) => item.end + state.EXIT_S;
  const overlapping = holders.filter((other) => other.appear < until(d) && until(other) > d.appear);
  const moments = [d.appear, ...overlapping.map((other) => other.appear).filter((time) => time > d.appear)];
  return moments.every((time) => overlapping.filter((other) => other.appear <= time && until(other) > time).length + 1 <= budget);
}

// Everything that depends on when a device is on the screen, from its final times: when each word of a display enters, when a stamp and a strike land
// on a beat, when the bubbles of a chat come.
function timeDevice(d, g) {
  if (d.type === 'display') d.wordTimes = displayTimes(d, g, d.appear);
  if (d.type === 'stamp') {
    d.landings = [];
    let from = d.appear + 0.08;
    for (let i = 0; i < d.count; i += 1) {
      const at = g.music.beats.length ? nextBeat(g.music, from) : from + 0.12;
      d.landings.push(round3(at));
      from = at + 0.2;
    }
  }
  if (d.type === 'strike') d.landings = [round3(g.music.beats.length ? nextBeat(g.music, d.appear + 0.3) : d.appear + 0.4)];
  if (d.type === 'chat') {
    const line = d.line !== null ? g.lines[d.line] : null;
    d.bubbleTimes = d.messages.map((_message, i) => {
      if (line) {
        const word = line.words[Math.floor((i * line.words.length) / d.messages.length)];
        return round3(Math.max(d.appear, word.start));
      }
      return round3(d.appear + i * 0.9);
    });
  }
}

function resolveDevices(g, accentBudget, warn = () => {}) {
  const world = makeWorld(g);
  const theme = world.theme;
  const devices = [];
  // the countdown to a drop (top right, in the 8 seconds before it) is a place that is taken
  for (const at of (g.hud && g.hud.drops) || []) world.placed.push({ d: { appear: at - state.DROP_WINDOW_S, end: at }, from: at - state.DROP_WINDOW_S, rects: [{ x: 1620, y: 136, w: 240, h: 50 }], fixed: true });

  // in the order they appear; the big words first when two appear together (they are the biggest and the most important)
  const queue = g.graphics.map((base) => {
    const d = { ...base, scale: 1 };
    d.appear = appearTime(d, g);
    if (d.type === 'display') d.rows = d.rows.map((row) => ({ ...row, tokens: row.text.split(' ').filter(Boolean) }));
    return d;
  });
  queue.sort((a, b) => a.appear - b.appear || (a.type === 'display' ? 0 : 1) - (b.type === 'display' ? 0 : 1) || a.start - b.start || a.id.localeCompare(b.id));
  for (const d of queue) {
    const size = d.type === 'display' || d.type === 'pin' ? null : measure(d, theme);
    const found = schedule(world, d, size);
    if (!found) {
      warn(`the ${d.type} "${d.id}" (${round3(d.appear)} to ${round3(d.end)} s) found no free place, not even later or shorter, and was left out`);
      continue;
    }
    // the older devices that make room end so that their exit is over when this one appears
    for (const blocker of found.conflicts) if (found.yieldEnd < blocker.entry.d.end) blocker.entry.d.end = found.yieldEnd;
    if (found.a > d.appear + 1e-9) d.start = Math.max(d.start, found.a);
    d.appear = found.a;
    // the first word of a big display comes later than the display itself: until then it is not on the screen and its place is free
    if (found.from > found.a + 1e-9) d.first = found.from;
    d.end = found.b;
    d.rect = found.rect;
    d.scale = found.scale;
    if (found.occupies) d.occupies = found.occupies;
    Object.assign(d, found.patch);
    world.placed.push({ d, from: found.from, rects: d.occupies || [d.rect], fixed: false });
    devices.push(d);
  }
  for (const d of devices) timeDevice(d, g);

  // who carries the accent
  const wanting = devices.map((d) => ({ d, priority: accentPriority(d) })).filter((entry) => entry.priority !== null);
  wanting.sort((a, b) => a.priority - b.priority || a.d.appear - b.d.appear || a.d.id.localeCompare(b.d.id));
  const holders = [];
  for (const { d } of wanting) {
    if (accentFits(holders, d, accentBudget)) {
      d.accent = true;
      holders.push(d);
    }
  }
  for (const d of devices) d.accent = Boolean(d.accent);
  return devices.sort((a, b) => a.appear - b.appear || a.id.localeCompare(b.id));
}

// The data the renderer reads: the normalised data with everything derived. The list of devices of the planner (`graphics`) is replaced by
// `devices`, the resolved ones. options.karaoke false: the accent may go to two devices at a time (the karaoke word does not carry one).
// options.warn(message) is told of every device that found no place and was left out.
function resolveGraphics(input, options = {}) {
  const g = { ...input };
  const music = { ...input.music };
  if (!music.downbeats.length && music.beats.length) music.downbeats = music.beats.filter((_beat, index) => index % 4 === 0);
  music.hitTimes = music.hits.map((hit) => hit.t);
  music.beatsBefore = 0;
  music.downbeatsBefore = 0;
  music.energyFrom = 0;
  g.music = music;
  g.devices = resolveDevices(g, options.karaoke === false ? 2 : 1, typeof options.warn === 'function' ? options.warn : undefined);
  delete g.graphics;
  g.resolved = true;
  return g;
}

// options: { luma, theme, accent, karaoke, warn }. `theme` and `accent` are the parameters of the node (they win over the plan): without them the plan is
// taken as it is.
function prepareGraphics(input, options = {}) {
  const { graphics: planned, warnings } = normalizeGraphics(input, options);
  const graphics = options.accent === undefined ? planned : { ...planned, accent: accentFor(planned.theme, options.accent, planned.accent) };
  const withLuma = options.luma ? { ...graphics, cuts: graphics.cuts.map((cut, index) => ({ ...cut, luma: options.luma[index] || cut.luma })) } : graphics;
  const warn = (message) => {
    if (warnings.length < 100) warnings.push(message);
  };
  return { graphics: resolveGraphics(withLuma, { ...options, warn }), warnings };
}

/* ---------- the data of one chunk ---------- */

// The part of the resolved data that the frames from `from` to `to` need: the cuts, lines, devices, beats, hits and loudness values around them.
// Counts and offsets (`beatsBefore`, `downbeatsBefore`, `energyFrom`) keep the bar and beat numbers and the loudness right.
function sliceGraphics(g, from, to) {
  const music = g.music;
  const lastDown = music.downbeats.filter((time) => time <= from).pop();
  const lowBeat = Math.min(from - 3, lastDown !== undefined ? lastDown - 0.05 : from - 3);
  const beatFrom = music.beats.findIndex((beat) => beat >= lowBeat);
  const beatStart = beatFrom < 0 ? music.beats.length : beatFrom;
  const downFrom = lastDown !== undefined ? music.downbeats.indexOf(lastDown) : music.downbeats.findIndex((time) => time > from);
  const downStart = downFrom < 0 ? music.downbeats.length : downFrom;
  const energyFrom = Math.max(0, Math.floor(from) - 2);
  const hits = music.hits.filter((hit) => hit.t >= from - 1 && hit.t <= to + 1);
  const fx = themes.get(g.theme).fx;
  const lookback = fx ? fx.sparks.seconds : 0;
  const lines = g.lines.filter((line) => line.end + state.KARAOKE_TAIL_S >= from - 0.01 && line.start - state.KARAOKE_LEAD_S <= to + 0.01);
  const cuts = g.cuts.filter((cut) => cut.end > from + 1e-6 && cut.start < to - 1e-6);
  // how many lines and cuts of the film lie before the first ones kept: the number of a cut (the first one of the film has no transition) and of a line
  // is the same in every chunk
  const linesBefore = (g.linesBefore || 0) + (lines.length ? g.lines.indexOf(lines[0]) : g.lines.length);
  const cutsBefore = (g.cutsBefore || 0) + (cuts.length ? g.cuts.indexOf(cuts[0]) : g.cuts.length);
  // (a style with sparks looks back for the devices that were on the screen when the sparks that are still in the air were thrown: they decide the side)
  const devices = g.devices.filter((d) => d.end + state.EXIT_S + lookback >= from - 1e-6 && d.appear <= to + 1e-6);
  const out = {
    ...g,
    music: {
      bpm: music.bpm,
      beats: music.beats.slice(beatStart).filter((beat) => beat <= to + 3),
      beatsBefore: (music.beatsBefore || 0) + beatStart,
      downbeats: music.downbeats.slice(downStart).filter((time) => time <= to + 3),
      downbeatsBefore: (music.downbeatsBefore || 0) + downStart,
      hits,
      hitTimes: hits.map((hit) => hit.t),
      energy: music.energy.slice(energyFrom, Math.ceil(to) + 3),
      energyFrom: (music.energyFrom || 0) + energyFrom
    },
    lines,
    linesBefore,
    cuts,
    cutsBefore,
    devices
  };
  // the track of the face (WP51, faces.js) goes only into a chunk with a tag, and only its part of it: the data of a chunk without a tag are the ones
  // of before
  delete out.faces;
  if (g.faces && devices.some((d) => d.type === 'tag')) {
    const first = Math.floor(from * FPS) - FPS;
    const last = Math.ceil(to * FPS) + FPS;
    out.faces = { step: g.faces.step, points: (g.faces.points || []).filter((point) => point[0] >= first && point[0] <= last) };
  }
  return out;
}

/* ---------- an example ---------- */

// Sung lines of the example (written for it: a night that is danced through after the last train was missed), each with the device that explains it.
// The words get times of 0.3 to 0.5 s each.
const DEMO_LINES = [
  { text: 'Seven minutes past twelve', key: 0, device: { type: 'clock', time: '00:07', label: 'LOCAL TIME · PLATFORM 9', arc: 0.12 }, rows: [{ text: 'SEVEN', size: 'xl' }] },
  { text: 'Twenty cabs passed me by', key: 3, device: { type: 'counter', format: 'multiplier', from: 1, to: 20, label: 'CABS PASSED' }, rows: [{ text: 'TWENTY', size: 'xl', box: true }, { text: 'PASSED ME', size: 'l' }] },
  { text: 'Almost zero percent and dying', key: 1, device: { type: 'counter', format: 'percent', from: 99, to: 1, label: 'BATTERY' }, rows: [{ text: 'AND DYING', size: 'l' }] },
  { text: 'Out of trains and money', key: 2, device: { type: 'list', title: 'DEPARTURES', rows: ['22:48 BERN ..... GONE', '23:05 CHUR ..... GONE', '23:17 BIEL ..... GONE', '23:34 ZUG ...... GONE', '23:46 THUN ..... GONE', '00:00 HOME ..... GONE'] }, rows: [{ text: 'Out of trains', size: 'xl' }], style: 'serif' },
  { text: 'Friends asked where I went', key: 3, device: { type: 'chat', messages: [{ from: 'them', text: 'where did you run off?' }, { from: 'her', text: 'last train gone, I am dancing' }] }, rows: [{ text: 'WHERE', size: 'xl' }] },
  { text: 'Echoes sang back for me', key: 2, device: { type: 'voice', label: 'VOICE · ECHO', db: -28 }, rows: [{ text: 'sang', size: 'l' }, { text: 'for me', size: 'l' }], style: 'serif' },
  { text: 'The gate is shut till morning', key: 4, device: { type: 'blueprint', title: 'FIG. 1 · TICKET GATE', labels: { a: 'A · SENSOR', b: 'B · HINGE' }, dims: [1.1, 0.9] }, rows: [{ text: 'GATE', size: 'xl' }, { text: 'SHUT', size: 'xl' }], style: 'around' },
  { text: 'Wheels all stopped at night', key: 1, device: { type: 'stamp', text: 'CANCELLED', count: 3 }, rows: [{ text: 'WHEELS', size: 'xl' }] },
  { text: 'Abandon the rush', key: 1, device: { type: 'strike', text: 'THE BIG RUSH', mode: 'strike' }, rows: [{ text: 'ABANDON', size: 'xl' }] },
  { text: 'Rides cost ten times too much', key: 1, device: { type: 'terminal', prompt: '$', lines: ['ride request --to home', 'drivers found: 0', 'fare: 10x', 'next try 00:09'] }, rows: [{ text: 'RIDES', size: 'l' }, { text: 'TOO MUCH', size: 'l' }] },
  { text: 'Stay late dance on', key: 3, device: { type: 'toggle', label: 'DANCE MODE', states: ['ON', 'OFF?'] }, rows: [{ text: 'DANCE', size: 'xl', box: true }, { text: 'ON', size: 'xl' }] },
  { text: 'Celebrating the moment', key: 1, device: { type: 'progress', label: 'FLOOR · FILLING', from: 4, to: 92 }, rows: [{ text: 'THE MOMENT', size: 'l' }] },
  { text: 'Down by Pier Eleven', key: 3, device: { type: 'pin', label: 'PIER 11 · HANGAR', x: 0.62, y: 0.4 }, rows: [{ text: 'ELEVEN', size: 'xl' }] },
  { text: 'Messages at four', key: 2, device: { type: 'notification', app: 'MESSAGES', title: 'Friends · 4 new', text: 'are you alive?', time: 'now' }, rows: [{ text: 'AT FOUR', size: 'xl' }] },
  { text: 'Late hours and sleepy dancers', key: 1, device: { type: 'stopwatch', from: '03:52:17:04', label: 'SINCE THE LAST TRAIN' }, rows: [{ text: 'LATE HOURS', size: 'l' }] },
  { text: 'Seven thousand steps counted', key: 1, device: { type: 'counter', format: 'int', from: 12, to: 7684, label: 'STEPS TODAY' }, rows: [{ text: 'STEPS', size: 'xl' }] },
  { text: 'Play it loud', key: 1, device: { type: 'tag', text: 'DJ BOOTH · ROOM 2 · 128 BPM' }, rows: [{ text: 'PLAY IT', size: 'xl' }] },
  { text: 'Songs and secrets', key: 0, device: { type: 'spec', title: 'THE HANGAR', rows: [['TYPE', 'PIER PARTY'], ['CAPACITY', '1,200'], ['SOUND', '128 BPM'], ['DRESS', 'ANYTHING'], ['ENCORE', 'UNKNOWN']], redact: 4 }, rows: [{ text: 'SONGS', size: 'm' }, { text: 'SECRETS', size: 'xl' }] },
  { text: 'We danced harder now', key: 2, device: { type: 'chart', title: 'FLOOR · LOUDNESS', values: [23, 27, 26, 34, 41, 49, 47, 58], marker: 'PEAK AT 58%' }, rows: [{ text: 'HARDER', size: 'l' }, { text: 'NOW', size: 'xl' }] },
  { text: 'Six hundred got in', key: 1, device: { type: 'counter', format: 'fraction', from: 0, to: 600, total: 1200, label: 'GUESTS INSIDE' }, rows: [{ text: 'GOT IN', size: 'xl' }] },
  { text: 'Buy the ticket', key: 2, device: { type: 'counter', format: 'money', from: 0, to: 18, label: 'TICKET HOME' }, rows: [{ text: 'BUY', size: 'xl' }] },
  { text: 'Catch the first train', key: 1, device: { type: 'counter', format: 'clock', from: '05:11:56:00', to: '05:12:00:04', label: 'PLATFORM CLOCK · LIVE' }, rows: [{ text: 'TRAIN', size: 'xl', box: true }] }
];

function wordsOf(content, start, step) {
  const words = content.split(' ');
  let at = start;
  return words.map((word) => {
    const length = 0.26 + 0.045 * word.length;
    const item = { text: word, start: round3(at), end: round3(at + length) };
    at += length + step;
    return item;
  });
}

// A film of `duration` seconds (default 128.4) at 128 BPM: the lines of DEMO_LINES in turn, a device and big words for each, cuts on the beats with
// punch-ins, a glitch, a wipe and a flash, a rising counter and number of fans, chapters, a ticker and drops. Everything is a function of the
// duration: the same call gives the same data.
function demoGraphics({ duration = 128.4 } = {}) {
  const total = snap(clamp(Number(duration) || 128.4, 8, 600));
  const bpm = 128;
  const beat = 60 / bpm;
  const first = 0.47;
  const beats = [];
  for (let t = first; t < total + 1; t += beat) beats.push(round3(t));
  const downbeats = beats.filter((_value, index) => index % 4 === 0);
  const energy = [];
  for (let i = 0; i <= Math.ceil(total); i += 1) energy.push(round3(clamp(0.5 + 0.32 * Math.sin(i / 6.5) + 0.12 * Math.sin(i * 1.7), 0.08, 1)));
  const hits = [];
  for (let i = 0; i < beats.length; i += 1) if (i % 8 === 0 && beats[i] < total) hits.push({ t: beats[i], strength: i % 16 === 0 ? 0.9 : 0.7 });

  const lines = [];
  const devices = [];
  const lineSpan = 2.9;
  let at = 1.2;
  for (let index = 0; at + 2.5 < total - 1; index += 1) {
    const entry = DEMO_LINES[index % DEMO_LINES.length];
    const words = wordsOf(entry.text, at, 0.04);
    const end = words[words.length - 1].end;
    lines.push({ start: words[0].start, end, key: Math.min(entry.key, words.length - 1), words });
    const id = `g${index + 1}`;
    const key = words[Math.min(entry.key, words.length - 1)];
    const lifeEnd = Math.min(total, Math.max(end + 0.5, key.start + 2.4));
    devices.push({ id, line: index, start: words[0].start, end: round3(lifeEnd), ...entry.device, position: entry.device.position });
    if (entry.rows && index % 3 !== 2) {
      devices.push({ id: `${id}d`, line: index, start: words[0].start, end: round3(Math.min(total, end + 0.3)), type: 'display', style: entry.style || 'condensed', rows: entry.rows, position: entry.style === 'around' ? 'around' : index % 2 ? 'top-right' : 'top-left' });
    }
    at += lineSpan + (index % 4 === 3 ? 0.5 : 0);
  }

  // cuts on the beats: 1.3 to 2.7 s, a punch-in on the second cut of a unit
  const cuts = [];
  const lengths = [4, 3, 6, 4, 5, 3, 8, 4];
  let beatIndex = 0;
  let unit = 0;
  while (beatIndex < beats.length - 1 && beats[beatIndex] < total - 0.4) {
    const take = lengths[unit % lengths.length];
    const start = cuts.length ? beats[beatIndex] : 0;
    const endIndex = Math.min(beats.length - 1, beatIndex + take);
    const end = Math.min(total, beats[endIndex]);
    if (end - start < 0.3) break;
    const kind = ['performance', 'story', 'still', 'performance', 'story'][unit % 5];
    const zoom = unit % 3 === 1;
    cuts.push({
      start: round3(start),
      end: round3(end),
      kind,
      unit: Math.floor(unit / 2),
      crop: { scale: zoom ? 1.35 : 1, x: 0.5, y: zoom ? 0.42 : 0.5 },
      subject: ['center', 'left', 'center', 'right', 'center', 'left'][unit % 6],
      transition: unit === 0 ? 'cut' : unit % 11 === 5 ? 'glitch' : unit % 13 === 7 ? 'wipe' : unit % 17 === 9 ? 'flash' : 'cut'
    });
    beatIndex = endIndex;
    unit += 1;
    if (end >= total - 1e-6) break;
  }
  if (cuts.length) cuts[cuts.length - 1].end = total;

  const chapterNames = ['PLATFORM 9', 'NO CABS', 'DANCE FLOOR', 'SMALL HOURS', 'FIRST TRAIN'];
  const chapters = chapterNames.map((name, index) => ({ start: round3((total / chapterNames.length) * index), end: round3((total / chapterNames.length) * (index + 1)), name }));
  const steps = [{ at: 0, value: 2 }, { at: round3(total * 0.25), value: 9 }, { at: round3(total * 0.5), value: 87 }, { at: round3(total * 0.75), value: 1204 }];
  const fans = [{ at: 0, value: 40 }, { at: round3(total * 0.25), value: 1200 }, { at: round3(total * 0.5), value: 15000 }, { at: round3(total * 0.75), value: 2400000 }];
  return {
    version: 1,
    duration: total,
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    accent: DEFAULT_ACCENT,
    hud: {
      title: 'LAST TRAIN HOME',
      counter: { label: 'UNREAD', pad: 2, steps },
      console: 'STATION LOG · CLAUDIA CONSOLE',
      chapters,
      figure: 'CLAUDIA',
      instances: { label: 'FANS', steps: fans },
      ticker: ['LAST TRAIN LEFT: 00:00', 'SUNRISE: 06:41', 'SONGS DANCED TO: 87', 'CAB FARE QUOTED: $180', 'CABS FREE: 0/20', 'DANCE FLOOR: PACKED', 'BASS: LOUD', 'SLEEP: POSTPONED', 'BATTERY 1% ▼'],
      rec: 'REC · CAM A · 24 FPS · ISO 800',
      drops: [round3(total * 0.5), round3(total * 0.8)].filter((time) => time > 10)
    },
    music: { bpm, beats, downbeats, hits, energy },
    lines,
    cuts,
    graphics: devices,
    endcard: { seconds: 3, title: 'AI-GENERATED MUSIC VIDEO', lines: ['Images, clips and graphics made with AI', 'Claudia by anabology · claudia.gallery'] }
  };
}

module.exports = {
  FPS,
  WIDTH,
  HEIGHT,
  SAFE,
  GAP,
  MIN_SCALE,
  FACE,
  FRAMINGS,
  SUBJECTS,
  FRAME_ZONES,
  MIN_SHOWN_S,
  MIN_LATE_S,
  faceZone,
  tiltedBox,
  DEVICE_TYPES,
  POSITIONS,
  COUNTER_FORMATS,
  LIMITS,
  cleanText: text,
  DEFAULT_ACCENT,
  accentFor,
  MAX,
  normalizeGraphics,
  resolveGraphics,
  prepareGraphics,
  sliceGraphics,
  demoGraphics,
  measure,
  normalizeColor,
  snap
};
