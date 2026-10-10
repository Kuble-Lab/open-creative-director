'use strict';

// The style system of the event video (WP53, spec §5): the tables of the event types (5a) and the moods (5b), their combination into the style v1 of
// lib/event-video/contract.js (D16, the output `style` of event_video.style) and what the cut, the page and the music derive from it (5c). Pure: no files,
// no network. The style has no format: a new format must not change the key of the plan (D16).
//
//   readChoice(raw)     the five values of the app (event_type, mood, length, format, language), checked; EVENTSTYLE_BAD_VALUE for anything else
//   combineStyle(c)     event type x mood -> style v1 (clamped values, transitions with cut at least half, genre, fonts, title animation, energy, soundbites)
//   derive(style)       the numbers of the cut, the page and the music: bpm, cuts per minute (per act), the beat step, the shortest shot, the zoom rate,
//                       the eq of the cut, tint, glow, grain, vignette, the sizes of the type, the seconds and the ease of the title
//   musicPrompt(style)  the prompt of the music (ElevenLabs, instrumental): genre, BPM range, seconds, a sentence about the energy; no artist
//   styleBlock(style)   one sentence for every axis, for the system prompt of the planner

const contract = require('./contract');

const { ACTS, ACT_SHARES, EVENT_TYPES, MOODS, LENGTHS, FORMATS, LANGUAGES, DEFAULTS, STYLE_VALUES, ERRORS, SOUNDBITE_SECONDS } = contract;

/* ---------- 5a: the event types ---------- */

// Every number: { base, min, max } where the table gives limits, else the base alone (clamped to 0..1). slowmo: the table gives a maximum only.
const EVENTS = Object.freeze({
  corporate: {
    tempo: [0.45, 0.2, 0.7], density: [0.4, 0.2, 0.6], warmth: 0.45, contrast: 0.5, saturation: 0.45, grain: 0.15, glow: 0.2, formality: [0.85, 0.6, 1], slowmo: [0.1, 0, 0.25],
    transitions: ['cut', 'dip', 'match'], soundbites: { count: [1, 2], seconds: [4, 7] }, nat_level: 0.12,
    type: { title: 'Montserrat:700', body: 'Inter Tight:500' },
    genre: 'modern corporate, clean electronic pop, piano and soft synth pads, light percussion',
    sentence: 'The event is corporate: measured, credible, clean; people appear as professionals.'
  },
  conference: {
    tempo: [0.4, 0.2, 0.65], density: [0.35, 0.2, 0.6], warmth: 0.5, contrast: 0.45, saturation: 0.5, grain: 0.15, glow: 0.25, formality: [0.8, 0.5, 1], slowmo: [0.1, 0, 0.25],
    transitions: ['cut', 'dip', 'match'], soundbites: { count: [2, 3], seconds: [5, 8] }, nat_level: 0.12,
    type: { title: 'Inter Tight:700', body: 'Inter Tight:400' },
    genre: 'cinematic ambient pop, warm piano, soft strings, subtle electronic beat',
    sentence: 'The event is a conference: ideas on stage and an attentive audience; the talks and the faces listening matter most.'
  },
  workshop: {
    tempo: [0.5, 0.3, 0.75], density: [0.45, 0.3, 0.7], warmth: 0.6, contrast: 0.4, saturation: 0.55, grain: 0.25, glow: 0.3, formality: [0.5, 0.3, 0.7], slowmo: [0.1, 0, 0.2],
    transitions: ['cut', 'dip', 'whip'], soundbites: { count: [2, 3], seconds: [3, 6] }, nat_level: 0.2,
    type: { title: 'DM Sans:700', body: 'DM Sans:400' },
    genre: 'indie folk pop, acoustic guitar, hand claps, light drums',
    sentence: 'The event is a workshop: hands at work, groups at tables, people thinking together; show the doing, not only the talking.'
  },
  launch: {
    tempo: [0.6, 0.4, 0.9], density: [0.6, 0.4, 0.9], warmth: 0.4, contrast: 0.65, saturation: 0.6, grain: 0.2, glow: 0.5, formality: [0.7, 0.5, 0.9], slowmo: [0.2, 0, 0.35],
    transitions: ['cut', 'whip', 'flash', 'match'], soundbites: { count: [1, 2], seconds: [3, 5] }, nat_level: 0.15,
    type: { title: 'Space Grotesk:700', body: 'Inter Tight:400' },
    genre: 'cinematic electronic, pulsing synth bass, big drums, risers',
    sentence: 'The event is a launch: anticipation, a reveal and the reaction to it; the product or the stage moment is the hero.'
  },
  party: {
    tempo: [0.8, 0.6, 1], density: [0.8, 0.5, 1], warmth: 0.55, contrast: 0.7, saturation: 0.75, grain: 0.35, glow: 0.7, formality: [0.15, 0, 0.4], slowmo: [0.2, 0, 0.4],
    transitions: ['cut', 'whip', 'flash', 'strobe'], soundbites: { count: [0, 1], seconds: [2, 3] }, nat_level: 0.3,
    type: { title: 'Anton:400', body: 'Inter Tight:600' },
    genre: 'house and dance pop, four-on-the-floor kick, bright synth leads, crowd energy',
    sentence: 'The event is a party: energy, light, dancing and laughter; the crowd is the star.'
  },
  celebration: {
    tempo: [0.5, 0.2, 0.8], density: [0.4, 0.2, 0.7], warmth: 0.7, contrast: 0.45, saturation: 0.6, grain: 0.3, glow: 0.6, formality: [0.4, 0.2, 0.7], slowmo: [0.3, 0, 0.5],
    transitions: ['cut', 'dip', 'match', 'dissolve'], soundbites: { count: [1, 2], seconds: [4, 8] }, nat_level: 0.25,
    type: { title: 'Playfair Display:600:italic', body: 'Inter Tight:400' },
    genre: 'emotional cinematic pop, piano, strings, soft acoustic guitar, gentle build',
    sentence: 'The event is a celebration: warmth, toasts, embraces and shared moments; people and their emotions carry the film.'
  }
});

/* ---------- 5b: the moods ---------- */

// The shifts of the numbers, the weights of the transitions, the energy of the six acts (hook ... close), the title animation and the title font that
// replaces the one of the event type (null: none).
const MOOD_TABLE = Object.freeze({
  fresh: {
    delta: { tempo: 0.1, density: 0.1, warmth: 0, contrast: 0.05, saturation: 0.15, grain: -0.05, formality: -0.1, glow: 0.1, slowmo: 0 },
    transitions: { cut: 6, whip: 2, match: 2, dip: 1 }, energy: [0.5, 0.55, 0.6, 0.8, 0.9, 0.5], title_anim: 'words_up', title: null,
    genre: 'bright, uplifting, light and airy, major key', sentence: 'The mood is fresh: bright, light, forward-moving.'
  },
  calm: {
    delta: { tempo: -0.25, density: -0.25, warmth: 0.1, contrast: -0.1, saturation: -0.1, grain: 0, formality: 0, glow: 0.1, slowmo: 0.15 },
    transitions: { cut: 4, dip: 4, dissolve: 2, match: 1 }, energy: [0.3, 0.35, 0.4, 0.5, 0.6, 0.3], title_anim: 'fade_rise', title: null,
    genre: 'slow, gentle, spacious, lots of air, no drums or brushed drums', sentence: 'The mood is calm: unhurried, spacious, attentive; let moments breathe.'
  },
  fast: {
    delta: { tempo: 0.3, density: 0.35, warmth: -0.1, contrast: 0.15, saturation: 0.1, grain: 0.05, formality: -0.15, glow: -0.1, slowmo: -0.1 },
    transitions: { cut: 8, whip: 4, flash: 2, strobe: 1 }, energy: [0.6, 0.7, 0.8, 0.9, 1, 0.6], title_anim: 'char_slam', title: null,
    genre: 'high energy, driving, punchy, builds to a drop', sentence: 'The mood is fast: driving, punchy, always moving on.'
  },
  emotional: {
    delta: { tempo: -0.15, density: -0.15, warmth: 0.15, contrast: -0.05, saturation: 0, grain: 0.1, formality: -0.1, glow: 0.2, slowmo: 0.2 },
    transitions: { cut: 4, dip: 3, dissolve: 3, match: 2 }, energy: [0.3, 0.4, 0.5, 0.7, 0.9, 0.4], title_anim: 'tracking', title: 'Playfair Display:500:italic',
    genre: 'heartfelt, tender, swelling, warm', sentence: 'The mood is emotional: tender and warm; faces, gestures and reactions come first.'
  },
  epic: {
    delta: { tempo: 0.05, density: 0.1, warmth: -0.05, contrast: 0.2, saturation: 0.05, grain: 0.05, formality: 0.05, glow: 0.2, slowmo: 0.1 },
    transitions: { cut: 5, flash: 2, dip: 2, match: 2 }, energy: [0.4, 0.5, 0.6, 0.8, 1, 0.5], title_anim: 'scale_blur', title: 'Anton:400',
    genre: 'grand, orchestral layers, epic build, big hits', sentence: 'The mood is epic: grand, building, big wide shots and big moments.'
  },
  elegant: {
    delta: { tempo: -0.1, density: -0.15, warmth: 0, contrast: 0.1, saturation: -0.15, grain: 0, formality: 0.15, glow: 0.1, slowmo: 0.1 },
    transitions: { cut: 5, dip: 3, match: 2, dissolve: 1 }, energy: [0.4, 0.45, 0.5, 0.6, 0.7, 0.4], title_anim: 'line_draw', title: 'Playfair Display:600:italic',
    genre: 'refined, minimal, sophisticated, jazzy chords', sentence: 'The mood is elegant: refined, composed, never loud; details and quiet gestures.'
  }
});

/* ---------- 5c: the derived values ---------- */

// cuts per minute of an act: the factor on the cuts per minute of the film
const ACT_CUT_FACTORS = Object.freeze({ hook: 1.2, arrival: 0.7, programme: 1.0, people: 0.9, peak: 1.5, close: 0.5 });
// the ramp of the soundbites in the mix and the target loudness (spec decision: ducking -12 dB with a ramp of 0.3 s, -16 LUFS)
const MIX = Object.freeze({ duck_db: -12, ramp: 0.3, lufs: -16 });
const TINT_WARM = '#FF9F45';
const TINT_COOL = '#4A7BFF';
// the zoom of a photo: 0.04 + 0.08 * tempo per second, the whole move at most +25 % (the cut caps it)
const PHOTO_ZOOM = Object.freeze({ base: 0.04, perTempo: 0.08, maxTotal: 0.25 });
// the end of the music prompt: how the energy ends (spec §5c: the fade in the last 8 s)
const OUTRO_SECONDS = 8;

const round3 = (value) => Math.round(value * 1000) / 1000;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function badValue(field, value, allowed) {
  const err = new Error(`${field}: ${JSON.stringify(value)} is not one of ${allowed.join(', ')}`);
  err.code = ERRORS.EVENTSTYLE_BAD_VALUE;
  err.data = { field, value: String(value), allowed: allowed.join(', ') };
  return err;
}

// The five values of the app as the node reads them (spec §3): the event type may be an alias (festival), the length a number or a text of one.
// Throws EVENTSTYLE_BAD_VALUE for anything else. Missing values take the defaults of the contract.
function readChoice(raw = {}) {
  const value = (key) => (raw[key] === undefined || raw[key] === null || raw[key] === '' ? DEFAULTS[key] : raw[key]);
  const eventType = contract.readEventType(value('event_type'));
  if (!eventType) throw badValue('event_type', raw.event_type, [...EVENT_TYPES, ...Object.keys(contract.EVENT_TYPE_ALIASES)]);
  const mood = String(value('mood')).trim().toLowerCase();
  if (!MOODS.includes(mood)) throw badValue('mood', raw.mood, MOODS);
  const length = Number(value('length'));
  if (!LENGTHS.includes(length)) throw badValue('length', raw.length, LENGTHS.map(String));
  const format = String(value('format')).trim();
  if (!FORMATS.includes(format)) throw badValue('format', raw.format, FORMATS);
  const language = String(value('language')).trim().toLowerCase();
  if (!LANGUAGES.includes(language)) throw badValue('language', raw.language, LANGUAGES);
  return { eventType: eventType.type, alias: eventType.alias, shift: eventType.shift, mood, length, format, language };
}

// The soundbites of an event type for a length (spec §5a): the table counts for 60 s; at 30 s at most one (party: none), at 90 s the upper end plus one.
// The seconds are those of the table, within 2..12 s (the contract: SOUNDBITE_SECONDS).
function soundbitesFor(eventType, length) {
  const row = EVENTS[eventType].soundbites;
  let [low, high] = row.count;
  if (length <= 30) {
    low = eventType === 'party' ? 0 : Math.min(low, 1);
    high = eventType === 'party' ? 0 : Math.min(high, 1);
  } else if (length >= 90) {
    high += 1;
  }
  const seconds = [clamp(row.seconds[0], SOUNDBITE_SECONDS[0], SOUNDBITE_SECONDS[1]), clamp(row.seconds[1], SOUNDBITE_SECONDS[0], SOUNDBITE_SECONDS[1])];
  return { count: [low, high], seconds };
}

// The transitions: those of the event type that the mood weighs, the weights of the mood (the event type weighs each of its own 1); none in common
// gives cut and dip; a hard cut is always at least half of the sum (spec §5).
function combineTransitions(eventType, mood) {
  const own = EVENTS[eventType].transitions;
  const weights = MOOD_TABLE[mood].transitions;
  let out = {};
  for (const name of own) if (weights[name]) out[name] = weights[name];
  if (!Object.keys(out).length) out = { cut: 1, dip: 1 };
  if (!out.cut) out = { cut: 0, ...out };
  const others = Object.entries(out).filter(([name]) => name !== 'cut').reduce((sum, [, weight]) => sum + weight, 0);
  if (out.cut < others) out.cut = others;
  if (!(out.cut > 0)) out.cut = 1;
  return out;
}

// event type x mood -> style v1 (D16). `choice` is what readChoice returns, or the raw values of the app.
function combineStyle(choice) {
  const c = choice && choice.eventType ? choice : readChoice(choice);
  const event = EVENTS[c.eventType];
  const mood = MOOD_TABLE[c.mood];
  const values = {};
  for (const key of STYLE_VALUES) {
    const row = event[key];
    const [base, low, high] = Array.isArray(row) ? row : [row, 0, 1];
    const shift = c.shift && typeof c.shift[key] === 'number' ? c.shift[key] : 0;
    values[key] = round3(clamp(base + shift + mood.delta[key], Math.max(0, low), Math.min(1, high)));
  }
  const energy = {};
  ACTS.forEach((act, index) => {
    energy[act] = mood.energy[index];
  });
  return {
    version: contract.STYLE_VERSION,
    event_type: c.eventType,
    event_alias: c.alias || null,
    mood: c.mood,
    length: c.length,
    language: c.language,
    values,
    transitions: combineTransitions(c.eventType, c.mood),
    genre: `${event.genre}, ${mood.genre}`,
    type: { title: mood.title || event.type.title, body: event.type.body },
    title_anim: mood.title_anim,
    energy,
    soundbites: soundbitesFor(c.eventType, c.length),
    nat_level: event.nat_level
  };
}

// The numbers of the cut, the page and the music (spec §5c).
function derive(style) {
  const v = style.values;
  const bpm = Math.round(70 + 70 * v.tempo);
  const cpm = Math.round(12 + 48 * v.density);
  const actCpm = {};
  for (const act of ACTS) actCpm[act] = round3(cpm * ACT_CUT_FACTORS[act]);
  // a cut every 4 beats below a density of 0.4, every 2 up to 0.7, else on every beat; half beats only in the peak above 0.8
  const beatStep = v.density < 0.4 ? 4 : v.density <= 0.7 ? 2 : 1;
  const exposure = (luma) => round3(clamp((0.45 - luma) * 0.5, -contract.MAX_EXPOSURE, contract.MAX_EXPOSURE));
  const tint = round3((v.warmth - 0.5) * 0.3);
  return {
    bpm,
    bpmRange: [bpm - 6, bpm + 6],
    cpm,
    actCpm,
    beatStep,
    halfBeatsInPeak: v.density > 0.8,
    minShot: round3(clamp(2.4 - 1.8 * v.density, 0.6, 2.4)),
    slowmo: v.slowmo,
    zoomRate: round3(PHOTO_ZOOM.base + PHOTO_ZOOM.perTempo * v.tempo),
    zoomMaxTotal: PHOTO_ZOOM.maxTotal,
    // the cut (server, YUV only): eq=contrast:saturation:gamma, brightness = exposure of the shot
    eq: { contrast: round3(0.9 + 0.4 * v.contrast), saturation: round3(0.7 + 0.7 * v.saturation), gamma: round3(1.05 - 0.1 * v.contrast) },
    exposure,
    // the page: a soft-light tint, warm or cool, and a light spot (screen) above a glow of 0.5, in hook, peak and close only
    tint,
    tintColor: tint >= 0 ? TINT_WARM : TINT_COOL,
    glow: v.glow > 0.5 ? round3(0.22 * v.glow) : 0,
    // the final pass: grain and vignette
    noise: Math.round(12 * v.grain),
    vignette: `PI/${round3(5 + 3 * (1 - v.contrast))}`,
    // the type: shares of the height of the frame (9:16: of 1920)
    typeSizes: { title: { wide: 0.07, tall: 0.05 }, name: 0.028, role: 0.02, endcard: 0.04 },
    titleSeconds: round3(clamp(1.3 - 0.6 * v.tempo, contract.TITLE_SECONDS_RANGE[0], contract.TITLE_SECONDS_RANGE[1])),
    ease: v.formality >= 0.5 ? 'power3.out' : 'back.out(1.4)',
    mix: { ...MIX, nat_level: style.nat_level }
  };
}

/* ---------- the music ---------- */

// Where the energy of the acts is highest, in percent of the film (the start of that act), and the words for the start, the build and the end.
function energySentence(style) {
  const curve = ACTS.map((act) => style.energy[act]);
  const start = curve[0];
  const peak = Math.max(...curve);
  const peakAct = curve.indexOf(peak);
  let before = 0;
  for (let index = 0; index < peakAct; index += 1) before += ACT_SHARES[ACTS[index]];
  const percent = Math.round(before * 100);
  const opening = start < 0.35 ? 'Starts almost silent' : start < 0.45 ? 'Starts soft' : start < 0.55 ? 'Starts light' : 'Opens on the beat';
  const rise = peak - start;
  const build = rise > 0.35 ? 'builds fast' : rise > 0.2 ? 'builds steadily' : 'grows slowly';
  const end = curve[curve.length - 1];
  const ending = end <= 0.35 ? `fades over the last ${OUTRO_SECONDS} seconds` : `resolves calmly in the last ${OUTRO_SECONDS} seconds`;
  return `${opening}, ${build}, peaks at about ${percent} percent, ${ending}`;
}

// The prompt of the music (spec §5c). `seconds`: the length of the music (the film plus 2 s). Built from the tables only: no artist, no song, no lyrics.
function musicPrompt(style, seconds = style.length + 2) {
  const { bpmRange } = derive(style);
  const genre = style.genre.charAt(0).toUpperCase() + style.genre.slice(1);
  return `${genre}. Instrumental, ${bpmRange[0]} to ${bpmRange[1]} BPM, ${seconds} seconds. ${energySentence(style)}. Clean ending, no vocals, no lyrics, no artist references.`;
}

// One sentence for every axis (spec §6, style_block).
function styleBlock(style) {
  return `${EVENTS[style.event_type].sentence} ${MOOD_TABLE[style.mood].sentence}`;
}

// The style text of the output `style` (and the key of everything behind it): the JSON of the style, keys in a fixed order.
const styleText = (style) => JSON.stringify(style);

module.exports = {
  EVENTS,
  MOOD_TABLE,
  ACT_CUT_FACTORS,
  MIX,
  TINT_WARM,
  TINT_COOL,
  PHOTO_ZOOM,
  readChoice,
  soundbitesFor,
  combineTransitions,
  combineStyle,
  derive,
  energySentence,
  musicPrompt,
  styleBlock,
  styleText
};
