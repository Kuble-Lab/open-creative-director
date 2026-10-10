'use strict';

// The planner of the event video (WP53, spec §4 to §6): from the analysis of every clip and photo (info v1), the style (style v1), the beats of the music
// and the description of the organiser it makes the plan of the cut (shots v1) and of the page (graphics v1), the board for the approval and the estimate.
// Pure: no files, no network; the language model is asked through `ask` (lib/nodes/nodes-event-video.js is the adapter). The code sets every time, crop,
// transition, colour and slow motion; the model only chooses WHICH material goes where and writes the texts (spec, decisions).
//
//   readMaterial(videos, photos)   the infos of the inputs, checked (contract.checkInfo), and the units to choose from: every scene of a usable video, every
//                                  usable photo, with its score (spec §4)
//   planGrid({ analysis, style, material, musicSeconds, options })
//                                  the acts on the downbeats, the shots of every act from the cuts per minute of the style, the soundbites, and how the grid
//                                  fits the material: longer photo shots, a photo once more as a detail, a shorter film (WP53 package B, new rules 1)
//   systemPrompt, userPrompt, answerSchema   the prompt of spec §6
//   readAnswer(text, ctx)          the answer as JSON, or the complete parts of one that was cut off (salvageJson of the HUD with the lists of the answer), then validateAnswer
//   validateAnswer(data, ctx)      the checks of spec §4 (picks, soundbites, texts) with the repairs of the code; `problems` go back to the model in the
//                                  second try, `notes` are soft points for the board (they never ask again)
//   toShots(content, ctx)          shots v1 (format free, D17: fit only where the plan has a reason) and the source of every shot for the contact sheet
//   toGraphics(content, shots, ctx)   graphics v1
//   plainPlan(ctx)                 a plan by the score alone (allow_plain): no title text, a generic end card, no soundbites
//   estimate(...)                  the price of the film by its parts (the table of spec §2)
//   boardText(...)                 the board (code labels in English like the HUD)
//   runEventPlanner(input)         the whole planner: the grid, the model with a second try, the empty answers asked again, the plan, the board

const contract = require('./contract');
const styles = require('./styles');
const planLib = require('../music-video-plan');
const hudPlan = require('../music-video-hud/plan');

const { ACTS, ACT_SHARES, FPS, ERRORS, LIMITS, TEXT_LIMITS, ENDCARD_SECONDS, TITLE_FROM, HARD_RISKS, EPS } = contract;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const round3 = (value) => Math.round(value * 1000) / 1000;
const round2 = (value) => Math.round(value * 100) / 100;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const chars = (text) => [...String(text)].length;
const group = (value) => Number(value).toLocaleString('en-US');

function planError(code, message, data) {
  const err = new Error(message);
  err.code = code;
  if (data) err.data = data;
  return err;
}

/* ---------- the material ---------- */

// A scene shorter than this is no shot of its own
const MIN_SCENE_SECONDS = 1;
// the length of a clip of the AI animation and of the parallax (event-video.json: fal.h3_video 5 s, image.to_video 5 s)
const CLIP_SECONDS = 5;
// the longest shot of a video scene, and of a photo when the material is short (WP53 B, rule 1: rest suits photos)
const MAX_VIDEO_SHOT = 8;
const PHOTO_LONG = 4.5;
const PHOTO_MAX = 6;
// "the same subject within 15 seconds" (spec §4, the score): the same clip or photo
const SAME_SUBJECT_SECONDS = 15;
// "each source at most three times" (spec §4, soft rules)
const MAX_SOURCE_USES = 3;

function parseInfo(value) {
  if (isObject(value)) return value;
  if (isObject(value?.value)) return value.value;
  const text = typeof value === 'string' ? value : value && typeof value.value === 'string' ? value.value : null;
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

// One element of the material: its info when the contract accepts it, else an element that cannot be used (the reason names the problem).
function readElement(raw, index, kind) {
  const ref = `${kind === 'video' ? 'v' : 'p'}${index}`;
  const info = parseInfo(raw);
  const check = contract.checkInfo(info);
  if (!check.ok) return { ref, index, kind, usable: false, reason: `the analysis is not valid (${check.problems[0]})`, info: null };
  if (info.kind !== kind) return { ref, index, kind, usable: false, reason: `the analysis is of a ${info.kind}, not of a ${kind}`, info: null };
  if (!info.usable) return { ref, index, kind, usable: false, reason: info.reason, info };
  return { ref, index, kind, usable: true, reason: null, info };
}

// The units to choose from: every scene of a usable video ("v3#2") and every usable photo ("p7"), with what the score and the checks need.
function unitsOf(element) {
  if (!element.usable) return [];
  const info = element.info;
  const vision = info.vision;
  const risks = Array.isArray(vision.risk) ? vision.risk : [];
  const common = {
    element: element.ref,
    source: element.index,
    emotion: vision.emotion,
    framing: vision.framing,
    action: vision.action,
    vision: vision.score,
    subject: vision.subject,
    words: subjectWords(vision.subject),
    hard: risks.filter((risk) => HARD_RISKS.includes(risk)),
    softRisks: risks.filter((risk) => !HARD_RISKS.includes(risk)).length,
    risks,
    fit: vision.fit || [],
    hdr: Boolean(info.meta.hdr),
    fps: info.meta.fps
  };
  if (element.kind === 'photo') {
    const scene = info.scenes[0];
    return [{ ...common, ref: element.ref, kind: 'photo', scene: 0, sc: scene, quality: scene.quality, reasons: scene.reasons, faces: scene.faces, luma: scene.luma, seconds: Infinity, width: info.meta.width, height: info.meta.height }];
  }
  return info.scenes.map((scene) => ({
    ...common,
    ref: `${element.ref}#${scene.i}`,
    kind: 'scene',
    scene: scene.i,
    sc: scene,
    quality: scene.quality,
    reasons: scene.reasons,
    faces: scene.faces,
    luma: scene.luma,
    seconds: round3(scene.out - scene.in),
    clipSeconds: info.meta.seconds
  }));
}

// Maximum bit distances for duplicates and similar pictures, on the 64-bit scene hash.
const DUPLICATE_HASH_DISTANCE = 6;
const SIMILAR_HASH_DISTANCE = 14;

// Missing hashes preserve the legacy selection. Distances use all 64 bits without number rounding.
function hashDistance(a, b) {
  if (!a || !b) return Infinity;
  let bits = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let distance = 0;
  while (bits) { bits &= bits - 1n; distance += 1; }
  return distance;
}
// Words every event picture shares; they say nothing about which subject a picture shows.
const SUBJECT_STOP_WORDS = new Set(('with from that this their they them while into onto over under front behind near some each other several large small ' +
  'white dark gray grey black wearing holds holding stands standing seated sitting people person persons event room table tables background ' +
  'foreground side view wooden smiling').split(' '));
// The share of content words two subjects must have in common, with the same action and framing, to show the same subject. Measured on 18 real event
// photos (2026-10-10): three shots of the same dessert planter share 0.33 to 0.47 (their pixel hashes differ by 32 to 36 bits), different subjects 0.21 or less.
const SAME_SUBJECT_SHARE = 0.3;
const FRAMING_GROUPS = Object.freeze({ wide: 'wide', medium: 'medium', close: 'close', detail: 'close' });

// The content words of a subject as stems (four letters or more, a plural "s" or "es" cut).
function subjectWords(subject) {
  const words = String(subject || '').toLowerCase().match(/[a-z]+/g) || [];
  return [...new Set(words.filter((word) => word.length >= 4 && !SUBJECT_STOP_WORDS.has(word)).map((word) => word.replace(/(es|s)$/, '')))];
}

// Two pictures of different clips or photos that show the same subject in the same way (vision subject, action and framing).
function sameSubject(a, b) {
  if (a.element === b.element || a.action !== b.action || FRAMING_GROUPS[a.framing] !== FRAMING_GROUPS[b.framing]) return false;
  const shared = a.words.filter((word) => b.words.includes(word)).length;
  const all = a.words.length + b.words.length - shared;
  return all > 0 && shared / all >= SAME_SUBJECT_SHARE;
}
const looksLike = (a, b) => Boolean(a && b && (hashDistance(a.sc.hash, b.sc.hash) <= SIMILAR_HASH_DISTANCE || sameSubject(a, b)));

// The infos of the inputs video_info and photo_info (texts or objects, in the order of the inputs videos and photos, D1).
function readMaterial(videoInfos = [], photoInfos = []) {
  const videos = videoInfos.map((raw, index) => readElement(raw, index, 'video'));
  const photos = photoInfos.map((raw, index) => readElement(raw, index, 'photo'));
  const allUnits = [...videos.flatMap(unitsOf), ...photos.flatMap(unitsOf)];
  const kept = [];
  const duplicates = new Map();
  // Stable sorting keeps the earlier input when vision and quality tie.
  for (const unit of allUnits.slice().sort((a, b) => b.vision - a.vision || b.quality - a.quality)) {
    const original = kept.find((other) => hashDistance(unit.sc.hash, other.sc.hash) <= DUPLICATE_HASH_DISTANCE);
    if (original) duplicates.set(unit.ref, original.ref);
    else kept.push(unit);
  }
  const units = allUnits.filter((unit) => !duplicates.has(unit.ref));
  for (const unit of units) unit.similar = units.filter((other) => other !== unit && looksLike(unit, other)).map((other) => other.ref);
  for (const photo of photos) if (duplicates.has(photo.ref)) {
    photo.usable = false;
    photo.reason = `duplicate of ${duplicates.get(photo.ref)}`;
  }
  const byRef = new Map(units.map((unit) => [unit.ref, unit]));
  const usableVideos = videos.filter((video) => video.usable);
  const speech = usableVideos.filter((video) => video.info.speech && video.info.speech.words.length);
  return {
    videos,
    photos,
    units,
    byRef,
    duplicates,
    usable: usableVideos.length + photos.filter((photo) => photo.usable).length,
    videoSeconds: round3(videos.reduce((sum, video) => sum + (video.info && video.info.meta && finite(video.info.meta.seconds) ? video.info.meta.seconds : 0), 0)),
    speechVideos: speech.map((video) => video.index)
  };
}

// The score of a unit (spec §4) without what depends on its place: vision.score + quality / 2 + 1 for an emotion that is not neutral - the soft risks.
const baseScore = (unit) => unit.vision + unit.quality / 2 + (unit.emotion !== 'neutral' ? 1 : 0) - unit.softRisks;
// ... and with its place: +1 for a framing other than the shot before, -2 for the same clip or photo within 15 s
function placeScore(unit, previous, recent) {
  return baseScore(unit) + (!previous || previous.framing !== unit.framing ? 1 : 0) - (recent.has(unit.element) ? 2 : 0);
}

// Why a unit cannot be picked in an act (spec §4, validation), or null.
function unitFault(unit, act, style) {
  if (unit.quality < 3) return `quality ${unit.quality} is below 3`;
  if (unit.hard.length) return `it has the risk ${unit.hard.join(' and ')}`;
  const bad = unit.reasons.filter((reason) => reason === 'dark' || reason === 'shaky');
  if (bad.length && !(style.event_type === 'party' && act === 'peak')) return `it is ${bad.join(' and ')}, which only the peak of a party may use`;
  if (unit.kind === 'scene' && unit.seconds < MIN_SCENE_SECONDS) return `the scene is shorter than ${MIN_SCENE_SECONDS} s`;
  return null;
}

/* ---------- the grid ---------- */

// The acts that hold the soundbites, in order (spec §5c: the first in programme, the second in people, the third in arrival; more for 90 s)
// How much shorter than the cap a soundbite of a short film may be when the style asks for longer ones (s).
const SHORT_BITE_RANGE = 1.5;
const SOUNDBITE_ACTS = Object.freeze(['programme', 'people', 'arrival', 'peak', 'programme', 'people']);
// AI clips and parallax photos by the length of the film (spec §2: 2/4/6)
const CLIPS_BY_LENGTH = Object.freeze({ 30: 2, 60: 4, 90: 6 });
const clipsFor = (duration) => (duration <= 30 ? CLIPS_BY_LENGTH[30] : duration <= 60 ? CLIPS_BY_LENGTH[60] : CLIPS_BY_LENGTH[90]);
const intertitlesFor = (duration) => (duration <= 30 ? contract.INTERTITLES_BY_LENGTH[30] : duration <= 60 ? contract.INTERTITLES_BY_LENGTH[60] : contract.INTERTITLES_BY_LENGTH[90]);

function readAnalysis(analysis) {
  const data = typeof analysis === 'string' ? planLib.parseJsonAnswer(analysis) : analysis;
  if (!isObject(data)) throw new Error('music_analysis: the text is not the analysis of the music (a JSON object of audio.beats)');
  const times = (list) => (Array.isArray(list) ? list.map(Number).filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b) : []);
  return { bpm: Number(data.bpm) || 0, duration: Number(data.duration) || 0, beats: times(data.beats), downbeats: times(data.downbeats) };
}

// The beats up to the end of the film: those of the analysis, continued at their own pace (or at the BPM of the style when the analysis has none).
function beatsUntil(read, duration, styleBpm) {
  let beats = read.beats.slice();
  const spacing = (() => {
    if (beats.length >= 4) {
      const gaps = beats.slice(1).map((time, index) => time - beats[index]).sort((a, b) => a - b);
      return gaps[Math.floor(gaps.length / 2)];
    }
    return 60 / (read.bpm > 0 ? read.bpm : styleBpm);
  })();
  if (!beats.length) beats = [0];
  while (beats[beats.length - 1] + spacing <= duration + spacing) beats.push(round3(beats[beats.length - 1] + spacing));
  let downbeats = read.downbeats.filter((time) => beats.some((beat) => Math.abs(beat - time) < 0.02));
  if (!downbeats.length) downbeats = beats.filter((_, index) => index % 4 === 0);
  const lastDown = downbeats[downbeats.length - 1];
  for (let time = lastDown + spacing * 4; time <= duration + spacing; time += spacing * 4) downbeats.push(round3(time));
  return { beats: beats.filter((time) => time <= duration + EPS), downbeats: downbeats.filter((time) => time <= duration + EPS), spacing };
}

// The places a cut may go: every `step`th beat counted from the first downbeat; in the peak with half beats (density above 0.8) every beat and the half
// beats between.
function snapPoints(beats, downbeats, step, half) {
  const first = beats.findIndex((beat) => Math.abs(beat - downbeats[0]) < 0.02);
  const origin = first < 0 ? 0 : first;
  const points = beats.filter((_, index) => ((index - origin) % step + step) % step === 0);
  if (!half) return points;
  const out = [];
  beats.forEach((beat, index) => {
    out.push(beat);
    if (index + 1 < beats.length) out.push(round3((beat + beats[index + 1]) / 2));
  });
  return out;
}

// The six acts on the downbeats (spec §5c): the share of every act, each boundary snapped to the nearest downbeat when one lies within a bar and every act
// keeps at least 1.5 s.
function actBounds(duration, downbeats, spacing) {
  const out = [];
  let start = 0;
  let share = 0;
  ACTS.forEach((act, index) => {
    share += ACT_SHARES[act];
    let end = index === ACTS.length - 1 ? duration : duration * share;
    if (index < ACTS.length - 1) {
      const near = downbeats.filter((time) => Math.abs(time - end) <= spacing * 2 + EPS && time - start >= 1.5 && duration - time >= 1.5 * (ACTS.length - 1 - index));
      if (near.length) end = near.reduce((best, time) => (Math.abs(time - end) < Math.abs(best - end) ? time : best));
    }
    out.push({ act, start: round3(start), end: round3(end) });
    start = end;
  });
  return out;
}

// The shots an act needs at a shot length (the reserved seconds of its soundbites left out), at least 1, at least 2 where a soundbite plays (a pick
// before it and one after).
function slotsOf(acts, lengthOf) {
  return acts.map((act) => {
    const free = Math.max(0, act.end - act.start - act.reserved);
    const slots = Math.max(act.bites ? 2 : 1, Math.round(free / lengthOf(act)));
    return slots;
  });
}

// The grid of the film. `material` is readMaterial(...), `musicSeconds` the length of the music; `options.soundbites` 'auto' or 'off'.
// Returns { duration, length, acts [{ act, start, end, slots, shotSeconds, bites }], snaps, peakSnaps, soundbites { count, seconds, acts }, details,
// stretched, shortened, notes, derived, capacity, usableUnits }.
function planGrid({ analysis, style, material, musicSeconds = null, options = {} }) {
  const derived = styles.derive(style);
  const read = readAnalysis(analysis);
  const music = finite(musicSeconds) && musicSeconds > 0 ? musicSeconds : read.duration > 0 ? read.duration : style.length + 2;
  const notes = [];
  // own music shorter than the film shortens it (the film 2 s shorter than the music, at least 18 s; spec §3, contract DURATION_RANGE)
  let duration = style.length;
  if (music < style.length) {
    duration = clamp(Math.floor((music - 2) * FPS) / FPS, contract.DURATION_RANGE[0], contract.DURATION_RANGE[1]);
    notes.push(`the music is ${round2(music)} s long: the film is ${round2(duration)} s instead of ${style.length} s`);
  }
  // what can be picked (in any act; the dark and shaky scenes of the peak of a party do not count)
  const usableUnits = material.units.filter((unit) => !unitFault(unit, 'programme', style));
  const photoUnits = usableUnits.filter((unit) => unit.kind === 'photo').length;
  const speech = options.soundbites === 'off' ? [] : material.speechVideos;

  const build = (filmSeconds) => {
    const shape = filmSeconds === style.length ? style.soundbites : styles.soundbitesFor(style.event_type, filmSeconds <= 30 ? 30 : filmSeconds <= 60 ? 60 : 90);
    const count = speech.length ? shape.count.slice() : [0, 0];
    const timing = beatsUntil(read, filmSeconds, derived.bpm);
    const acts = actBounds(filmSeconds, timing.downbeats, timing.spacing);
    const maxBite = Math.min(shape.seconds[1], contract.SOUNDBITE_MAX_SHARE * filmSeconds);
    const reserve = round3(Math.min((shape.seconds[0] + shape.seconds[1]) / 2, maxBite));
    for (const act of acts) {
      act.bites = 0;
      act.reserved = 0;
    }
    SOUNDBITE_ACTS.slice(0, count[1]).forEach((name) => {
      const act = acts.find((entry) => entry.act === name);
      act.bites += 1;
      act.reserved += reserve;
    });
    return { filmSeconds, acts, timing, count, shape, maxBite, reserve };
  };
  const styleLength = (act) => Math.max(derived.minShot, 60 / derived.actCpm[act.act]);

  // the material decides: the shots of the style; else longer shots (photos up to about 4.5 s); else a photo once more as a detail; else a shorter film
  let plan = build(duration);
  let lengthOf = styleLength;
  let slots = slotsOf(plan.acts, lengthOf);
  let details = 0;
  let stretched = false;
  let shortened = null;
  const fits = (list, capacity) => list.reduce((sum, value) => sum + value, 0) <= capacity;
  for (;;) {
    if (fits(slots, usableUnits.length)) break;
    // longer shots, at most PHOTO_LONG (an act whose shots are longer already keeps them)
    let scale = 1;
    let found = false;
    while (scale < 4) {
      scale = round3(scale + 0.05);
      const scaled = (act) => Math.max(styleLength(act), Math.min(styleLength(act) * scale, PHOTO_LONG));
      const trial = slotsOf(plan.acts, scaled);
      if (fits(trial, usableUnits.length)) {
        lengthOf = scaled;
        slots = trial;
        found = true;
        break;
      }
    }
    const longest = (act) => Math.max(styleLength(act), PHOTO_LONG);
    if (found) {
      stretched = true;
      break;
    }
    const longSlots = slotsOf(plan.acts, longest);
    if (fits(longSlots, usableUnits.length + photoUnits)) {
      lengthOf = longest;
      slots = longSlots;
      stretched = true;
      details = longSlots.reduce((sum, value) => sum + value, 0) - usableUnits.length;
      break;
    }
    const smaller = contract.LENGTHS.filter((length) => length < plan.filmSeconds - EPS).pop();
    if (!smaller) {
      // the shortest film: the shots as long as they must be
      lengthOf = longest;
      slots = longSlots;
      stretched = true;
      details = Math.max(0, Math.min(photoUnits, longSlots.reduce((sum, value) => sum + value, 0) - usableUnits.length));
      break;
    }
    shortened = { from: shortened ? shortened.from : plan.filmSeconds, to: smaller };
    plan = build(smaller);
    lengthOf = styleLength;
    slots = slotsOf(plan.acts, lengthOf);
  }
  duration = plan.filmSeconds;
  if (shortened) notes.push(`only ${usableUnits.length} usable clips and photos for a film of ${shortened.from} s: the film is shortened to ${shortened.to} s`);
  if (stretched) notes.push(`${usableUnits.length} usable clips and photos for ${slots.reduce((sum, value) => sum + value, 0)} shots: the shots are longer (photos up to about ${PHOTO_LONG} s)${details ? `, ${details} photos are shown a second time as a detail` : ''}`);

  const acts = plan.acts.map((act, index) => ({ act: act.act, start: act.start, end: act.end, slots: slots[index], picks: slots[index], shotSeconds: round3(lengthOf(act)), bites: act.bites, reserved: round3(act.reserved) }));
  // the details of photos are the code's: the model is asked for the other picks, the acts with the most shots give theirs first
  for (let left = details, guard = 0; left > 0 && guard < 1000; guard += 1) {
    const act = acts.filter((entry) => entry.picks > (entry.bites ? 2 : 1)).sort((a, b) => b.picks - a.picks)[0];
    if (!act) break;
    act.picks -= 1;
    left -= 1;
  }
  const snaps = snapPoints(plan.timing.beats, plan.timing.downbeats, derived.beatStep, false);
  const peakSnaps = derived.halfBeatsInPeak ? snapPoints(plan.timing.beats, plan.timing.downbeats, 1, true) : snaps;
  // a short film caps the soundbite at 15 % of its length (4.5 s in 30 s); where the shortest one of the style is longer than that, the range becomes
  // the last SHORT_BITE_RANGE seconds below the cap (5 to 8 s of a conference become 3 to 4.5 s in 30 s)
  const longestBite = Math.min(contract.SOUNDBITE_SECONDS[1], plan.maxBite);
  const shortestBite = Math.max(contract.SOUNDBITE_SECONDS[0], plan.shape.seconds[0]);
  const soundbiteSeconds = [round3(shortestBite <= longestBite ? shortestBite : Math.max(contract.SOUNDBITE_SECONDS[0], longestBite - SHORT_BITE_RANGE)), round3(longestBite)];
  return {
    duration: round3(duration),
    length: style.length,
    musicSeconds: round3(music),
    bpm: read.bpm > 0 ? round2(read.bpm) : derived.bpm,
    acts,
    beats: plan.timing.beats,
    downbeats: plan.timing.downbeats,
    snaps,
    peakSnaps,
    soundbites: { count: plan.count, seconds: soundbiteSeconds, acts: SOUNDBITE_ACTS.slice(0, plan.count[1]) },
    details,
    stretched,
    shortened,
    notes,
    derived,
    usableUnits: usableUnits.length,
    photoUnits,
    picks: slots.reduce((sum, value) => sum + value, 0)
  };
}

/* ---------- the prompt (spec §6) ---------- */

const LANGUAGE_NAMES = Object.freeze({ de: 'German (Swiss High German: always "ss", never the sharp s)', en: 'English', es: 'Spanish' });
// the tags of vision.fit an event type prefers (spec §6, {{preferred}})
const PREFERRED = Object.freeze({
  corporate: ['speaker', 'detail', 'b_roll'],
  conference: ['speaker', 'crowd', 'opener'],
  workshop: ['detail', 'b_roll', 'crowd'],
  launch: ['opener', 'detail', 'speaker'],
  party: ['crowd', 'opener', 'closer'],
  celebration: ['crowd', 'closer', 'detail']
});
// the material of the prompt: about 25 000 tokens at most (spec §6), the rest by the score
const MAX_MATERIAL_CHARS = 75000;

const ANSWER_SCHEMA = `{"treatment":"<=400 characters: the idea of the film",
 "acts":[{"act":"hook|arrival|programme|people|peak|close","picks":[{"ref":"v3#2|p7","why":"<=80 characters","slow":false,"pair":null}]}],
 "soundbites":[{"ref":"v5","word_from":41,"word_to":63,"speaker":null,"role":null,"source":"description|transcript"}],
 "title":{"text":"<=28","sub":"<=40|null","source":"description|generic"},
 "lower_thirds":[{"soundbite":0,"name":null,"role":null,"label":"<=32|null","source":"description|transcript|vision|generic"}],
 "intertitles":[{"act":"programme","text":"<=32","source":"description"}],
 "ai_photos":[{"ref":"p7","prompt":"<=300, camera and subtle motion only"}],
 "parallax":["p2","p9"],
 "voiceover":[{"act":"arrival|close","text":"<=180"}],
 "endcard":{"line":"<=40","sub":"<=40|null","url":null,"source":"description|generic"}}`;

const SYSTEM_TEMPLATE = `You are the editor of an event aftermovie: real footage and photos of one event, cut to music, with a title, a few lower thirds and an end card. {{style_block}} Be concrete and restrained; never invent facts.

You receive the organiser's description, the analysis of every clip and photo, the style, the target length and the language of the on-screen texts. The code has already laid the grid: the acts, how many shots each act needs and when soundbites may play. You choose WHICH material goes where and write the texts. The code sets all times, crops, transitions, colour and slow motion. Answer with ONE JSON object in exactly the schema at the end, nothing else.

THE STORY
- Acts and shot counts: {{grid}}. Give exactly that many picks per act (plus or minus 2).
- hook: the strongest moment (cheering, applause, stage, a wide shot of the crowd). close: one calm shot.
- Alternate wide and close, people and detail; never three close-ups in a row; no scene twice; one source at most three times; not the same subject within 15 seconds.
- Mark "slow": true where slow motion pays off (people, end of peak). Use "pair" for a match cut: two scenes with the same subject, wide then close.{{material_rule}}

THE MATERIAL
- Refer to video scenes as "v<index>#<scene>" and to photos as "p<index>", only from the list.
- Prefer quality 4-5 and tags {{preferred}}. Never use risk child or unflattering. Use dark or shaky only in the peak of a party.
- {{photo_rule}}
- {{soundbite_rule}}

THE TEXTS (in {{language}})
- Title at most 28 characters; subtitle only place and date, and only if the description names them.
- {{lower_third_rule}}
- Intertitles (at most {{max_intertitles}}): numbers and facts only from the description.
- End card: one line of thanks or the date; a website or hashtag only from the description.
- Every text has "source". Never invent names, numbers, places, companies or quotes. Never name the tool or its maker.
{{voiceover_rule}}
ANSWER SCHEMA
{{answer_schema}}`;

const USER_TEMPLATE = `EVENT (the only source of facts)
{{brief}}

STYLE
event {{event_type}}, mood {{mood}}, length {{length}} s, music {{music}}

MATERIAL (ref, kind, seconds, quality, tags, text in image, transcript with word indices)
{{material}}
{{problems}}
Return the JSON object now.`;

const fill = (template, values) => template.replace(/\{\{(\w+)\}\}/g, (_, key) => (values[key] === undefined ? '' : String(values[key])));
const fixed = (value) => (Math.round(value * 10) / 10).toFixed(1);

function gridText(grid) {
  return grid.acts
    .map((act) => `${act.act} ${act.picks} ${act.picks === 1 ? 'pick' : 'picks'} (${fixed(act.start)}-${fixed(act.end)} s${act.bites ? `, ${act.bites} soundbite${act.bites === 1 ? '' : 's'}` : ''})`)
    .join(', ');
}

// The limits of the lists of the answer that depend on the options and the material.
function answerLimits(grid, material, options) {
  const photos = material.photos.filter((photo) => photo.usable).length;
  const ai = options.photoMotion === 'ai' ? Math.min(photos, options.maxAiPhotos > 0 ? options.maxAiPhotos : clipsFor(grid.duration), contract.MAX_AI_PHOTOS) : 0;
  const parallax = options.photoMotion !== 'ai' && options.parallax !== false ? Math.min(photos, clipsFor(grid.duration), contract.MAX_PARALLAX) : 0;
  return { ai, parallax, intertitles: intertitlesFor(grid.duration), soundbites: grid.soundbites.count, voiceover: options.voiceover === true };
}

function systemPrompt({ style, grid, material, options = {} }) {
  const limits = answerLimits(grid, material, options);
  const photos = material.photos.some((photo) => photo.usable);
  const videos = material.videos.some((video) => video.usable);
  const photoRule = !photos
    ? 'There are no photos: leave "ai_photos" and "parallax" empty.'
    : limits.ai
      ? `Choose up to ${limits.ai} of the photos you pick for AI animation ("ai_photos") with a short camera-and-motion prompt; no new people, objects or text.`
      : limits.parallax
        ? `Choose up to ${limits.parallax} of the photos you pick with clear depth for "parallax".`
        : 'The code moves the photos (zoom and pan): leave "ai_photos" and "parallax" empty.';
  const [low, high] = limits.soundbites;
  const soundbiteRule = !videos
    ? 'There are no videos, only photos: there are no soundbites and no sound of the clips. Leave "soundbites" and "lower_thirds" empty.'
    : high === 0
      ? `No soundbites in this film${material.speechVideos.length ? '' : ' (no clip has speech)'}: leave "soundbites" and "lower_thirds" empty.`
      : `Soundbites: pick ${low === high ? low : `${low} to ${high}`} complete, intelligible sentences of ${grid.soundbites.seconds[0]} to ${grid.soundbites.seconds[1]} s from the transcripts, by word index (word_from, word_to inclusive).`;
  const lowerThirdRule =
    options.lowerThirds === false || high === 0
      ? 'No lower thirds: leave "lower_thirds" empty.'
      : 'Lower thirds only over a soundbite: name and role only if the description, the transcript or text_in_image states them; otherwise a programme label such as "Keynote".';
  const materialRule = grid.details
    ? ` The material is short: ${grid.usableUnits} usable clips and photos for ${grid.picks} shots. Use every good element once; the code shows ${grid.details} photos a second time as a detail. Never repeat a ref yourself.`
    : grid.stretched
      ? ` The material is short (${grid.usableUnits} usable clips and photos): the shots are long and calm, photos up to about ${PHOTO_LONG} s.`
      : '';
  const voiceoverRule = limits.voiceover
    ? `- Voice-over ("voiceover"): 2 or 3 short sentences in ${LANGUAGE_NAMES[style.language]}, for the acts arrival and close, at most 180 characters each, only facts from the description.\n`
    : '- No voice-over: leave "voiceover" empty.\n';
  return fill(SYSTEM_TEMPLATE, {
    style_block: styles.styleBlock(style),
    grid: gridText(grid),
    material_rule: materialRule,
    preferred: PREFERRED[style.event_type].join(', '),
    photo_rule: photoRule,
    soundbite_rule: soundbiteRule,
    language: LANGUAGE_NAMES[style.language],
    lower_third_rule: lowerThirdRule,
    max_intertitles: limits.intertitles,
    voiceover_rule: voiceoverRule,
    answer_schema: ANSWER_SCHEMA
  });
}

const answerSchema = () => ANSWER_SCHEMA;

// The rows of one element for the prompt: the element, its scenes, its transcript with word indices.
function elementRows(element) {
  const info = element.info;
  const vision = info.vision;
  const tags = [
    `${vision.framing}`,
    `people ${vision.people}`,
    vision.emotion,
    vision.action,
    vision.stage ? 'stage' : '',
    vision.fit.length ? `fit ${vision.fit.join('/')}` : '',
    vision.risk.length ? `risk ${vision.risk.join('/')}` : '',
    `score ${vision.score}`
  ].filter(Boolean);
  const text = vision.text_in_image.length ? `, text in image ${vision.text_in_image.map((entry) => JSON.stringify(entry)).join(' ')}` : '';
  if (element.kind === 'photo') {
    const scene = info.scenes[0];
    const shape = info.meta.width >= info.meta.height ? 'landscape' : 'upright';
    const faults = scene.reasons.filter((reason) => reason !== 'ok');
    return [`${element.ref} photo ${shape}, quality ${scene.quality}${faults.length ? ` (${faults.join(', ')})` : ''}, faces ${scene.faces.count}: ${vision.subject}; ${tags.join(', ')}${text}`];
  }
  const rows = [`${element.ref} video ${fixed(info.meta.seconds)} s, ${Math.round(info.meta.fps)} fps: ${vision.subject}; ${tags.join(', ')}${text}`];
  for (const scene of info.scenes) {
    const faults = scene.reasons.filter((reason) => reason !== 'ok');
    rows.push(`  ${element.ref}#${scene.i} ${fixed(scene.in)}-${fixed(scene.out)} s, quality ${scene.quality}${faults.length ? ` (${faults.join(', ')})` : ''}, ${scene.motion}, faces ${scene.faces.count}`);
  }
  if (info.speech && info.speech.words.length) {
    rows.push(`  transcript (${info.speech.language || 'unknown'}): ${info.speech.words.map((word, index) => `${index} ${word.w}`).join(' ')}`);
  }
  return rows;
}

// The material of the prompt: the usable elements, the best first when the text would be longer than MAX_MATERIAL_CHARS (the others are left out with
// a note). Returns { text, left } where `left` names the elements left out.
function materialText(material) {
  const elements = [...material.videos, ...material.photos].filter((element) => element.usable);
  const scored = elements.map((element) => {
    const units = material.units.filter((unit) => unit.element === element.ref);
    const best = units.length ? Math.max(...units.map(baseScore)) : 0;
    const rows = elementRows(element).filter((row) => ![...material.duplicates.keys()].some((ref) => row.trimStart().startsWith(`${ref} `)));
    for (const unit of units) if (unit.similar.length) rows.push(`  ${unit.ref} looks like ${unit.similar.join(', ')}`);
    return { element, rows, best };
  });
  let total = scored.reduce((sum, entry) => sum + entry.rows.join('\n').length + 1, 0);
  const left = [];
  const keep = new Set(scored.map((entry) => entry.element.ref));
  for (const entry of scored.slice().sort((a, b) => a.best - b.best || b.element.ref.localeCompare(a.element.ref))) {
    if (total <= MAX_MATERIAL_CHARS) break;
    keep.delete(entry.element.ref);
    left.push(entry.element.ref);
    total -= entry.rows.join('\n').length + 1;
  }
  return { text: scored.filter((entry) => keep.has(entry.element.ref)).flatMap((entry) => entry.rows).join('\n'), left };
}

function userPrompt({ brief, style, grid, material, problems = [], previous = '' }) {
  const told = problems.length
    ? `\nYOUR LAST ANSWER HAD THESE PROBLEMS (the code repaired what it could; fix them all in the new answer)\n${problems.slice(0, 30).map((problem) => `- ${problem}`).join('\n')}\n${previous ? `\nYOUR LAST ANSWER\n${previous}\n` : ''}`
    : '';
  return fill(USER_TEMPLATE, {
    brief: String(brief).trim(),
    event_type: style.event_alias || style.event_type,
    mood: style.mood,
    length: grid.duration,
    music: `${grid.bpm} BPM, ${grid.musicSeconds} s`,
    material: materialText(material).text,
    problems: told
  });
}

/* ---------- the texts ---------- */

// Words that may stand on the screen without being in the description (thanks, the parts of an event), lower case. Every other name-like word must be in
// the description, a transcript or a text in an image (spec §4: names, numbers, places and companies are never invented).
const COMMON_WORDS = Object.freeze({
  de: ['danke', 'dank', 'vielen', 'merci', 'bis', 'zum', 'nächsten', 'mal', 'wiedersehen', 'gäste', 'tag', 'tage', 'abend', 'morgen', 'nachmittag', 'team', 'teams', 'menschen', 'ideen', 'idee', 'zukunft', 'keynote', 'keynotes', 'workshop', 'workshops', 'panel', 'apéro', 'networking', 'bühne', 'programm', 'highlights', 'moment', 'momente', 'begegnung', 'begegnungen', 'gespräch', 'gespräche', 'event', 'eröffnung', 'pause', 'konzert', 'party', 'feier', 'jahr', 'ausgabe', 'eindrücke', 'rückblick', 'willkommen', 'austausch', 'inspiration', 'gemeinsam', 'alle', 'ein', 'eine', 'der', 'die', 'das', 'und', 'wir', 'sie', 'ihr'],
  en: ['thank', 'thanks', 'you', 'see', 'next', 'time', 'welcome', 'keynote', 'workshop', 'workshops', 'panel', 'networking', 'highlights', 'day', 'night', 'together', 'the', 'a', 'an', 'and', 'we'],
  es: ['gracias', 'hasta', 'pronto', 'bienvenidos', 'bienvenida', 'keynote', 'taller', 'talleres', 'panel', 'networking', 'día', 'noche', 'juntos', 'el', 'la', 'los', 'las', 'y', 'un', 'una']
});
const NUMBER_WORDS = Object.freeze({
  de: ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf'],
  en: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'],
  es: ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce']
});
const GENERIC_ENDCARD = Object.freeze({ de: 'Danke', en: 'Thank you', es: 'Gracias' });

// Month names and abbreviations in all supported languages are numeric facts in either direction.
const MONTHS = [
  'januar january enero jan ene', 'februar february febrero feb', 'märz maerz march marzo mär mar',
  'april abril apr abr', 'mai may mayo', 'juni june junio jun', 'juli july julio jul',
  'august agosto aug ago', 'september septiembre sept sep setiembre', 'oktober october octubre okt oct',
  'november noviembre nov', 'dezember december diciembre dez dec dic'
];
const MONTH_NUMBERS = new Map(MONTHS.flatMap((names, index) => names.split(' ').map((name) => [name, String(index + 1)])));
const normalizeNumber = (digits) => digits.replace(/^0+(?=\d)/, '');
const numberParts = (run) => run.split(/[.,'’:/-]/).filter(Boolean).map(normalizeNumber);
const numericText = (text) => String(text).replace(/\p{L}+\.?/gu, (word) => {
  if (/\p{Lu}/u.test(word.slice(1))) return word;
  return MONTH_NUMBERS.get(word.replace(/\.$/, '').toLowerCase()) || word;
});
const numberRuns = (text) => numericText(text).match(/\d+(?:[.,'’:/-]\d+)*/g) || [];

// Store complete digit sequences and every component, also without leading zeros.
function factSource(texts) {
  const text = texts.filter(Boolean).join('\n').toLowerCase();
  const numbers = new Set();
  for (const run of numberRuns(text)) {
    numbers.add(normalizeNumber(run.replace(/\D/g, '')));
    numberParts(run).forEach((part) => numbers.add(part));
  }
  for (const words of Object.values(NUMBER_WORDS)) {
    words.forEach((word, value) => {
      if (new RegExp(`(^|[^\\p{L}])${word}([^\\p{L}]|$)`, 'u').test(text)) numbers.add(String(value));
    });
  }
  return { text, numbers };
}

function sourcesOf(brief, material) {
  const transcripts = material.videos.filter((video) => video.usable && video.info.speech).map((video) => video.info.speech.words.map((word) => word.w).join(' '));
  const inImage = [...material.videos, ...material.photos].filter((element) => element.usable).flatMap((element) => element.info.vision.text_in_image);
  return { all: factSource([brief, ...transcripts, ...inImage]), brief: factSource([brief]) };
}

const inSource = (word, source) => {
  const lower = word.toLowerCase();
  const tokens = source.text.match(/[\p{L}\p{N}]+(?:['’.][\p{L}\p{N}]+)*/gu) || [];
  if (tokens.includes(lower)) return true;
  // Inflected long words may share a stem; acronyms, mixed-case names and numbers stay exact.
  if (lower.length < 6 || /[\p{Lu}\p{N}]/u.test(word.slice(1))) return false;
  const stem = lower.slice(0, -2);
  return tokens.some((token) => token.startsWith(stem) && token.length <= lower.length + 2);
};

// The words and numbers of a text that are not in the source: numbers, words with a capital inside (acronyms, names like "einstAIn"), and capitalised
// words (German: every one that is not a common word; English and Spanish: every one but the first of a sentence).
function unknownFacts(text, source, language = 'de', { free = false } = {}) {
  const out = [];
  const common = new Set([...(COMMON_WORDS[language] || []), ...COMMON_WORDS.en]);
  for (const run of numberRuns(text)) {
    if (!source.numbers.has(normalizeNumber(run.replace(/\D/g, ''))) && !numberParts(run).every((part) => source.numbers.has(part))) out.push(run);
  }
  const pieces = String(text).split(/\s+/).filter(Boolean);
  pieces.forEach((piece, index) => {
    const sentenceStart = index === 0 || /[.!?:]["»”']?$/.test(pieces[index - 1]);
    const words = (piece.match(/[\p{L}\p{N}][\p{L}\p{N}'’.]*/gu) || []).flatMap((word) => word.split(/[-–]/)).filter(Boolean);
    for (const part of words) {
      const word = part.replace(/[.'’]+$/, '');
      if (!word) continue;
      if (/\d/.test(word)) {
        if (/\p{L}/u.test(word) && !inSource(word, source)) out.push(word);
        continue;
      }
      const inner = /\p{Lu}/u.test(word.slice(1));
      if (!inner && MONTH_NUMBERS.has(word.toLowerCase())) continue;
      const capital = /^\p{Lu}/u.test(word);
      if (!inner && !capital) continue;
      if (!inner && common.has(word.toLowerCase())) continue;
      if (free && language === 'de' && capital && !inner &&
          (/(?:ung|heit|keit|schaft|sein|tion|ität|nis|tum|ismus|mente?|ik|enz|anz|ei|ling|chen|ive[n]?|ur(?:en)?)$/iu.test(word) ||
           (word.length >= 7 && /er$/i.test(word)) || (word.length >= 8 && /en$/i.test(word)))) continue;
      if (!inner && language !== 'de' && sentenceStart) continue;
      if (!inSource(word, source)) out.push(word);
    }
  });
  return [...new Set(out)].sort((a, b) => String(text).indexOf(a) - String(text).indexOf(b));
}

// A text cut to `max` characters at a word (spec §4: lengths are cut), without a dangling comma or dash.
function cutText(text, max) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (chars(clean) <= max) return clean;
  const head = [...clean].slice(0, max + 1).join('');
  const space = head.lastIndexOf(' ');
  const cut = (space > max * 0.5 ? head.slice(0, space) : [...clean].slice(0, max).join('')).replace(/[\s,;:–-]+$/, '');
  return cut;
}

const textOrNull = (value) => (typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim() : null);
const forbidden = (value) => typeof value === 'string' && contract.FORBIDDEN_TEXT.test(value);

/* ---------- the soundbites ---------- */

const SENTENCE_END = /[.!?…]["»”']?$/;
// the soundbite starts a little before its first word and ends a little after its last (never inside a neighbouring word)
const BITE_LEAD = 0.15;
const BITE_TAIL = 0.25;

// The range of words snapped to sentences: out to the sentence boundaries around it, or in to those inside it when that is too long; a sentence that is too
// short takes the next one (or the one before at the end of the transcript) while the whole stays within the seconds. The first that fits, else the range
// snapped out with `outside`.
function snapWords(words, from, to, seconds) {
  const startOf = (index) => {
    let at = index;
    while (at > 0 && !SENTENCE_END.test(words[at - 1].w)) at -= 1;
    return at;
  };
  const endOf = (index) => {
    let at = index;
    while (at < words.length - 1 && !SENTENCE_END.test(words[at].w)) at += 1;
    return at;
  };
  const fits = (a, b) => {
    if (!(a >= 0 && b < words.length && a <= b)) return null;
    const span = biteSpan(words, a, b);
    return span.seconds >= seconds[0] - EPS && span.seconds <= seconds[1] + EPS ? { from: a, to: b, ...span } : null;
  };
  const outward = [startOf(from), endOf(to)];
  const options = [outward];
  // inward: from the first sentence that starts inside to the last that ends inside
  const inwardStart = from === 0 || SENTENCE_END.test(words[from - 1].w) ? from : endOf(from) + 1;
  const inwardEnd = SENTENCE_END.test(words[to].w) ? to : startOf(to) - 1;
  options.push([inwardStart, inwardEnd], [outward[0], inwardEnd], [inwardStart, outward[1]]);
  for (const [a, b] of options) {
    const found = fits(a, b);
    if (found) return found;
  }
  // too short: whole sentences after it, then before it
  let [a, b] = outward;
  for (let step = 0; step < 12 && biteSpan(words, a, b).seconds < seconds[0]; step += 1) {
    if (b < words.length - 1) b = endOf(b + 1);
    else if (a > 0) a = startOf(a - 1);
    else break;
    const found = fits(a, b);
    if (found) return found;
  }
  return { from: outward[0], to: outward[1], ...biteSpan(words, outward[0], outward[1]), outside: true };
}

function biteSpan(words, from, to) {
  const before = from > 0 ? words[from - 1].e : 0;
  const after = to < words.length - 1 ? words[to + 1].s : words[to].e + BITE_TAIL;
  const start = round3(Math.max(before, words[from].s - BITE_LEAD, 0));
  const end = round3(Math.min(after, words[to].e + BITE_TAIL));
  return { start, end, seconds: round3(end - start) };
}

/* ---------- reading and checking the answer ---------- */

// The lists of the answer that keep their complete entries when the answer was cut off (salvageJson of the HUD with the lists of the event answer)
const SALVAGE_LISTS = Object.freeze(['acts', 'soundbites', 'lower_thirds', 'intertitles', 'ai_photos', 'parallax', 'voiceover']);
const salvageAnswer = (text) => hudPlan.salvageJson(text, SALVAGE_LISTS);

// The answer as JSON: the whole object, or the complete parts of one that was cut off or broke off. { data, cut }
function parseAnswer(text) {
  const parsed = planLib.parseJsonAnswer(text);
  if (isObject(parsed)) return { data: parsed, cut: false };
  const salvaged = salvageAnswer(text);
  return { data: salvaged.data, cut: Boolean(salvaged.data) };
}

// The picker of the code: the best unit for a place that is not used yet (spec §4: by the score), else a photo once more as a detail.
function makePicker(ctx) {
  const { material, style } = ctx;
  const used = new Set();
  const detailed = new Set();
  const uses = new Map();
  const take = (unit) => {
    used.add(unit.ref);
    if (unit.detail) detailed.add(unit.element);
    uses.set(unit.element, (uses.get(unit.element) || 0) + 1);
  };
  // `placed`: the clips and photos the film shows before this place; a detail only follows its photo
  const best = (act, previous, recent, { details = false, placed = null } = {}) => {
    let choice = null;
    let top = -Infinity;
    let fallback = null;
    let fallbackScore = -Infinity;
    for (const unit of material.units) {
      if (used.has(unit.ref) || unitFault(unit, act, style) || (uses.get(unit.element) || 0) >= MAX_SOURCE_USES) continue;
      const score = placeScore(unit, previous, recent);
      if (looksLike(unit, previous)) {
        if (score > fallbackScore) { fallback = unit; fallbackScore = score; }
        continue;
      }
      if (score > top + 1e-9) {
        top = score;
        choice = unit;
      }
    }
    if (choice || !details) return choice || fallback;
    for (const unit of material.units) {
      if (unit.kind !== 'photo' || !used.has(unit.ref) || detailed.has(unit.element) || unitFault(unit, act, style)) continue;
      if (placed && !placed.has(unit.element)) continue;
      const score = placeScore(unit, previous, recent);
      if (looksLike(unit, previous)) {
        if (score > fallbackScore) { fallback = { ...unit, ref: `${unit.ref}*`, detail: true }; fallbackScore = score; }
        continue;
      }
      if (score > top + 1e-9) {
        top = score;
        choice = { ...unit, ref: `${unit.ref}*`, detail: true };
      }
    }
    return choice || fallback;
  };
  return { used, take, best, uses, detailed };
}

// Checks the answer against the material, the grid and the description and repairs it (spec §4). Returns
//   { ok, content, problems, notes, replaced, picks }
// content: { treatment, acts { act: [{ unit, slow, pair, why, replaced }] }, soundbites [...], title, lowerThirds, intertitles, aiPhotos, parallax, voiceover,
// endcard }; problems: what goes back to the model in the second try (a pick the code replaced, a soundbite left out, an invented text); notes: soft points for
// the board; replaced: the picks the code had to choose itself (more than 25 % is EVENTPLAN_MODEL_FAILED).
function validateAnswer(data, ctx) {
  const { material, grid, style, options = {}, sources } = ctx;
  const problems = [];
  const notes = [];
  if (!isObject(data)) return { ok: false, content: null, problems: ['The answer is not a JSON object in the schema.'], notes, replaced: 0, picks: 0 };
  const language = style.language;
  const limits = answerLimits(grid, material, options);

  // the treatment
  let treatment = textOrNull(data.treatment);
  if (treatment && chars(treatment) > TEXT_LIMITS.treatment) {
    treatment = cutText(treatment, TEXT_LIMITS.treatment);
    notes.push(`the treatment was cut to ${TEXT_LIMITS.treatment} characters`);
  }

  // the picks, act by act: first every pick of the model that can stay (so that a repair never takes what a later act picked), then the repairs and the
  // shots the act still needs, in the order of the film
  const picker = makePicker(ctx);
  const acts = {};
  let replaced = 0;
  let total = 0;
  const lists = Array.isArray(data.acts) ? data.acts.filter(isObject) : [];
  if (!Array.isArray(data.acts)) problems.push('"acts" is missing: give the six acts with their picks.');
  const drafts = {};
  for (const act of grid.acts) {
    const entry = lists.find((item) => item.act === act.act);
    if (!entry && Array.isArray(data.acts)) problems.push(`the act ${act.act} is missing (it needs ${act.picks} picks).`);
    const raw = entry && Array.isArray(entry.picks) ? entry.picks.filter(isObject) : [];
    const high = act.picks + 2;
    if (raw.length > high) problems.push(`the act ${act.act} has ${raw.length} picks; the grid asks for ${act.picks} (plus or minus 2): the code left out the last ${raw.length - high}.`);
    drafts[act.act] = { entry, list: [] };
    raw.slice(0, high).forEach((pick, k) => {
      const ref = typeof pick.ref === 'string' ? pick.ref.trim() : '';
      const unit = material.byRef.get(ref) || null;
      let fault = null;
      if (!unit) {
        const parsed = contract.parseRef(ref);
        const element = parsed && parsed.kind === 'scene' ? material.videos[parsed.video] : parsed && parsed.kind === 'photo' ? material.photos[parsed.photo] : null;
        fault = element && !element.usable ? `${ref} cannot be used (${element.reason})` : `${JSON.stringify(ref || pick.ref || null)} is not in the material`;
      } else if (picker.used.has(unit.ref)) fault = `${ref} is picked twice`;
      else if ((picker.uses.get(unit.element) || 0) >= MAX_SOURCE_USES) fault = `${unit.element} is used more than ${MAX_SOURCE_USES} times`;
      else {
        const why = unitFault(unit, act.act, style);
        if (why) fault = `${ref} cannot be used here: ${why}`;
      }
      const why = textOrNull(pick.why) ? cutText(pick.why, TEXT_LIMITS.why) : null;
      if (fault) {
        drafts[act.act].list.push({ fault, k, why: null });
        return;
      }
      picker.take(unit);
      let pair = null;
      if (typeof pick.pair === 'string' && pick.pair.trim()) {
        const other = material.byRef.get(pick.pair.trim());
        const pairFault = !other
          ? 'is not in the material'
          : picker.used.has(other.ref)
            ? 'is used already'
            : other.kind !== 'scene' || unit.kind !== 'scene'
              ? 'a match cut pairs two video scenes'
              : unitFault(other, act.act, style);
        if (pairFault) notes.push(`${act.act}: the pair ${pick.pair} of ${ref} was left out (${pairFault})`);
        else {
          pair = other;
          picker.take(other);
        }
      }
      drafts[act.act].list.push({ unit, slow: pick.slow === true, pair, why, replaced: false });
    });
  }
  const timeline = [];
  const placedNow = () => new Set(timeline.map((item) => item.unit.element));
  for (const act of grid.acts) {
    const { entry, list } = drafts[act.act];
    const step = (act.end - act.start) / Math.max(1, act.slots);
    const out = [];
    let shots = 0;
    const context = () => {
      const time = act.start + shots * step;
      const recent = new Set(timeline.filter((item) => time - item.time < SAME_SUBJECT_SECONDS).map((item) => item.unit.element));
      return [timeline.length ? timeline[timeline.length - 1].unit : null, recent];
    };
    const push = (pick) => {
      const time = act.start + shots * step;
      out.push(pick);
      timeline.push({ unit: pick.unit, time });
      shots += 1;
      if (pick.pair) {
        timeline.push({ unit: pick.pair, time: time + step });
        shots += 1;
      }
    };
    for (const draft of list) {
      if (!draft.fault) {
        push(draft);
        continue;
      }
      const choice = picker.best(act.act, ...context(), { details: grid.details > 0, placed: placedNow() });
      replaced += 1;
      if (!choice) {
        problems.push(`${act.act} pick ${draft.k}: ${draft.fault}; nothing was left to put there.`);
        continue;
      }
      problems.push(`${act.act} pick ${draft.k}: ${draft.fault}; the code put ${choice.ref.replace('*', ' (detail)')} there.`);
      picker.take(choice);
      push({ unit: choice, slow: false, pair: null, why: null, replaced: true });
    }
    // missing picks (below the tolerance of the grid) are filled by the code and count as replaced; the details of photos the grid planned (slots beyond the
    // picks) come on top of what the model gave
    const short = Math.max(0, Math.max(1, act.picks - 2) - out.length);
    if (short && entry) problems.push(`the act ${act.act} has ${out.length} usable picks; the grid asks for ${act.picks} (plus or minus 2).`);
    const target = Math.max(shots, shots + short) + (act.slots - act.picks);
    for (let k = 0; shots < target; k += 1) {
      const choice = picker.best(act.act, ...context(), { details: true, placed: placedNow() });
      if (!choice) break;
      picker.take(choice);
      push({ unit: choice, slow: false, pair: null, why: null, replaced: true, filled: true });
      if (k < short) replaced += 1;
    }
    total += out.length;
    acts[act.act] = out;
  }

  // Separate model picks before deciding which of their photos need paid animation.
  const pickSlots = ACTS.flatMap((act) => acts[act].map((pick) => ({ act, pick })));
  const orderedPicks = pickSlots.map((slot) => slot.pick);
  separateSimilar(orderedPicks, null, picker, (index) => pickSlots[index].act, new Set(), notes, (unit, act) => !unitFault(unit, act, style));
  let slot = 0;
  for (const act of ACTS) acts[act] = acts[act].map(() => orderedPicks[slot++]);

  // the soft rules (spec §4): never three close-ups in a row, every source at most three times (the score already keeps the same subject apart)
  const sequence = ACTS.flatMap((act) => acts[act].flatMap((pick) => [pick.unit, ...(pick.pair ? [pick.pair] : [])]));
  for (let index = 2; index < sequence.length; index += 1) {
    if (sequence.slice(index - 2, index + 1).every((unit) => unit.framing === 'close')) {
      notes.push(`three close-ups in a row: ${sequence.slice(index - 2, index + 1).map((unit) => unit.ref).join(', ')}`);
      break;
    }
  }

  // the soundbites
  const bites = [];
  const biteIndex = new Map();
  const rawBites = Array.isArray(data.soundbites) ? data.soundbites.filter(isObject) : [];
  const [, maxBites] = grid.soundbites.count;
  rawBites.forEach((bite, k) => {
    if (bites.length >= maxBites) {
      if (maxBites === 0) notes.push(`soundbite ${k} was left out: this film has no soundbites`);
      else notes.push(`soundbite ${k} was left out: at most ${maxBites} in this film`);
      return;
    }
    const parsed = contract.parseRef(typeof bite.ref === 'string' ? bite.ref.trim() : '');
    const video = parsed && parsed.kind === 'video' ? material.videos[parsed.video] : null;
    const words = video && video.usable && video.info.speech ? video.info.speech.words : null;
    const from = Number(bite.word_from);
    const to = Number(bite.word_to);
    let fault = null;
    if (!video) fault = `${JSON.stringify(bite.ref)} is not a video of the material`;
    else if (!video.usable) fault = `${video.ref} cannot be used (${video.reason})`;
    else if (!words) fault = `${video.ref} has no transcript`;
    else if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to >= words.length || to < from) fault = `the words ${bite.word_from} to ${bite.word_to} are not in the transcript of ${video.ref} (0 to ${words.length - 1})`;
    let snapped = null;
    if (!fault) {
      snapped = snapWords(words, from, to, grid.soundbites.seconds);
      if (snapped.outside) fault = `the words ${from} to ${to} of ${video.ref} make ${snapped.seconds} s as whole sentences; a soundbite has ${grid.soundbites.seconds[0]} to ${grid.soundbites.seconds[1]} s`;
      else if (bites.some((other) => other.video === video.index && other.start < snapped.end && snapped.start < other.end)) fault = `the words ${from} to ${to} of ${video.ref} overlap another soundbite`;
    }
    if (fault) {
      problems.push(`soundbite ${k}: ${fault}; it was left out.`);
      return;
    }
    if (snapped.from !== from || snapped.to !== to) notes.push(`soundbite ${k} (${video.ref}) snapped to whole sentences: words ${snapped.from} to ${snapped.to}`);
    biteIndex.set(k, bites.length);
    bites.push({
      video: video.index,
      ref: video.ref,
      wordFrom: snapped.from,
      wordTo: snapped.to,
      start: snapped.start,
      end: snapped.end,
      seconds: snapped.seconds,
      words: words.slice(snapped.from, snapped.to + 1),
      speaker: textOrNull(bite.speaker),
      role: textOrNull(bite.role),
      act: grid.soundbites.acts[bites.length]
    });
  });
  if (maxBites > 0 && bites.length < grid.soundbites.count[0] && material.speechVideos.length) notes.push(`${bites.length} soundbites, the style asks for ${grid.soundbites.count[0]} to ${maxBites}`);

  // the texts on the screen: never the tool or its maker, never an invented fact (spec §4, texts)
  const screen = (where, value, max, source, { hard = true, free = false } = {}) => {
    const text = textOrNull(value);
    if (!text) return null;
    if (forbidden(text)) {
      problems.push(`${where} names the tool or its maker; it was removed.`);
      return null;
    }
    const unknown = unknownFacts(text, source, language, { free });
    if (unknown.length) {
      const message = `${where} «${text}» names ${unknown.map((word) => `«${word}»`).join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not in the description${source === sources.all ? ', a transcript or a text in an image' : ''}; it was removed.`;
      if (hard) problems.push(message);
      else notes.push(message);
      return null;
    }
    if (chars(text) > max) {
      notes.push(`${where} was cut to ${max} characters`);
      return cutText(text, max);
    }
    return text;
  };

  // the title (null: the film has no title text)
  let title = null;
  if (isObject(data.title)) {
    const text = screen('title.text', data.title.text, TEXT_LIMITS.title, sources.all);
    if (text) title = { text, sub: screen('title.sub', data.title.sub, TEXT_LIMITS.sub, sources.all), source: data.title.source === 'generic' ? 'generic' : 'description' };
  } else problems.push('"title" is missing.');

  // the lower thirds: only over a soundbite, a name only when it stands in the sources (else the role or the label stays)
  const lowerThirds = [];
  const rawThirds = Array.isArray(data.lower_thirds) ? data.lower_thirds.filter(isObject) : [];
  if (options.lowerThirds === false && rawThirds.length) notes.push('the lower thirds are switched off: those of the answer were left out');
  else {
    rawThirds.forEach((third, k) => {
      const at = biteIndex.get(Number(third.soundbite));
      if (at === undefined) {
        notes.push(`lower third ${k} was left out: its soundbite ${third.soundbite} is not in the film`);
        return;
      }
      if (lowerThirds.some((other) => other.soundbite === at)) {
        notes.push(`lower third ${k} was left out: soundbite ${third.soundbite} has one already`);
        return;
      }
      let name = textOrNull(third.name);
      if (name && (forbidden(name) || !sources.all.text.includes(name.toLowerCase()))) {
        problems.push(`lower third ${k}: the name «${name}» is not in the description, a transcript or a text in an image; the name was removed.`);
        name = null;
      } else if (name && chars(name) > TEXT_LIMITS.name) name = cutText(name, TEXT_LIMITS.name);
      const role = screen(`lower third ${k} role`, third.role, TEXT_LIMITS.role, sources.all);
      const label = screen(`lower third ${k} label`, third.label, TEXT_LIMITS.label, sources.all);
      if (!name && !role && !label) {
        notes.push(`lower third ${k} was left out: nothing of it could stay`);
        return;
      }
      lowerThirds.push({ soundbite: at, name, role, label });
    });
  }

  // the intertitles: facts of the description only, at most 1, 2 or 3 by the length
  const intertitles = [];
  (Array.isArray(data.intertitles) ? data.intertitles.filter(isObject) : []).forEach((title, k) => {
    if (intertitles.length >= limits.intertitles) {
      notes.push(`intertitle ${k} was left out: at most ${limits.intertitles} in a film of ${grid.duration} s`);
      return;
    }
    if (!ACTS.includes(title.act)) {
      notes.push(`intertitle ${k} was left out: ${JSON.stringify(title.act)} is no act`);
      return;
    }
    if (intertitles.some((other) => other.act === title.act)) {
      notes.push(`intertitle ${k} was left out: the act ${title.act} has one already`);
      return;
    }
    const text = screen(`intertitle ${k}`, title.text, TEXT_LIMITS.intertitle, sources.brief, { free: true });
    if (text) intertitles.push({ act: title.act, text });
  });

  // the end card: a line of the description or the generic thanks; a website only from the description
  let endcard = null;
  if (isObject(data.endcard)) {
    const line = screen('endcard.line', data.endcard.line, TEXT_LIMITS.endcardLine, sources.all, { free: true });
    if (line) {
      const sub = screen('endcard.sub', data.endcard.sub, TEXT_LIMITS.endcardSub, sources.all);
      let url = textOrNull(data.endcard.url);
      if (url && (forbidden(url) || !sources.brief.text.includes(url.toLowerCase()) || chars(url) > TEXT_LIMITS.url)) {
        problems.push(`endcard.url «${url}» is not in the description; it was removed.`);
        url = null;
      }
      endcard = { line, sub, url, source: data.endcard.source === 'generic' ? 'generic' : 'description' };
    }
  }
  if (!endcard) {
    endcard = { line: GENERIC_ENDCARD[language], sub: null, url: null, source: 'generic' };
    notes.push(`the end card is the generic «${endcard.line}»`);
  }

  // the photos for the AI animation and the parallax: picked photos only, within the limits
  const pickedPhotos = new Set(sequence.filter((unit) => unit.kind === 'photo' && !unit.detail).map((unit) => unit.ref));
  const aiPhotos = [];
  (Array.isArray(data.ai_photos) ? data.ai_photos.filter(isObject) : []).forEach((item) => {
    const ref = typeof item.ref === 'string' ? item.ref.trim() : '';
    if (!limits.ai) return notes.push(`ai_photos ${ref} was left out: ${options.photoMotion === 'ai' ? 'no AI clips in this film' : 'the photos move by code'}`);
    if (aiPhotos.length >= limits.ai) return notes.push(`ai_photos ${ref} was left out: at most ${limits.ai}`);
    if (!pickedPhotos.has(ref)) return notes.push(`ai_photos ${ref} was left out: it is not a photo of the picks`);
    if (aiPhotos.some((other) => other.ref === ref)) return undefined;
    const prompt = textOrNull(item.prompt);
    if (!prompt) return notes.push(`ai_photos ${ref} was left out: no prompt`);
    aiPhotos.push({ ref, photo: material.byRef.get(ref).source, prompt: cutText(prompt, TEXT_LIMITS.aiPrompt) });
    return undefined;
  });
  const parallax = [];
  (Array.isArray(data.parallax) ? data.parallax : []).forEach((value) => {
    const ref = typeof value === 'string' ? value.trim() : '';
    if (!limits.parallax) return notes.push(`parallax ${ref} was left out: ${options.photoMotion === 'ai' ? 'the photos are animated by AI' : 'the parallax is switched off'}`);
    if (parallax.length >= limits.parallax) return notes.push(`parallax ${ref} was left out: at most ${limits.parallax}`);
    if (!pickedPhotos.has(ref) || aiPhotos.some((item) => item.ref === ref)) return notes.push(`parallax ${ref} was left out: it is not a photo of the picks`);
    if (!parallax.some((item) => item.ref === ref)) parallax.push({ ref, photo: material.byRef.get(ref).source });
    return undefined;
  });

  // the voice-over: only when it is switched on, facts of the description only
  const voiceover = [];
  const rawVoice = Array.isArray(data.voiceover) ? data.voiceover.filter(isObject) : [];
  if (!limits.voiceover && rawVoice.length) notes.push('the voice-over is switched off: the lines of the answer were left out');
  if (limits.voiceover) {
    rawVoice.forEach((line, k) => {
      if (voiceover.length >= contract.MAX_VOICEOVER) return;
      if (!contract.VOICEOVER_ACTS.includes(line.act)) return notes.push(`voice-over ${k} was left out: it may speak in arrival and close only`);
      const text = textOrNull(line.text);
      if (!text) return undefined;
      if (forbidden(text)) return problems.push(`voice-over ${k} names the tool or its maker; it was removed.`);
      const unknown = unknownFacts(text, sources.brief, language, { free: true });
      if (unknown.length) return problems.push(`voice-over ${k} names ${unknown.map((word) => `«${word}»`).join(', ')}, not in the description; it was removed.`);
      voiceover.push({ act: line.act, text: cutText(text, TEXT_LIMITS.voiceover) });
      return undefined;
    });
    if (!voiceover.length) notes.push('the voice-over is switched on, but the answer has no usable line');
  }

  const content = { treatment, acts, soundbites: bites, title, lowerThirds, intertitles, aiPhotos, parallax, voiceover, endcard };
  return { ok: true, content, problems, notes, replaced, picks: total };
}

// The answer of the model, read and checked: { ok, content, problems, notes, replaced, picks, cut }
function readAnswer(text, ctx) {
  const { data, cut } = parseAnswer(text);
  if (!data) return { ok: false, content: null, problems: ['The answer is not a JSON object in the schema.'], notes: [], replaced: 0, picks: 0, cut: false };
  const result = validateAnswer(data, ctx);
  if (cut) result.problems.unshift('Your answer was cut off: answer again, completely and shorter ("why" in a few words).');
  return { ...result, cut };
}

/* ---------- the plain plan ---------- */

// A plan by the score alone (spec §4, allow_plain): the best unit for every place, no soundbites, no title text, a generic end card.
function plainPlan(ctx) {
  const { grid, style } = ctx;
  const picker = makePicker(ctx);
  const acts = {};
  const timeline = [];
  for (const act of grid.acts) {
    const out = [];
    const step = (act.end - act.start) / Math.max(1, act.slots);
    for (let k = 0; k < act.slots; k += 1) {
      const time = act.start + k * step;
      const recent = new Set(timeline.filter((item) => time - item.time < SAME_SUBJECT_SECONDS).map((item) => item.unit.element));
      const choice = picker.best(act.act, timeline.length ? timeline[timeline.length - 1].unit : null, recent, { details: true, placed: new Set(timeline.map((item) => item.unit.element)) });
      if (!choice) break;
      picker.take(choice);
      out.push({ unit: choice, slow: false, pair: null, why: null, replaced: true });
      timeline.push({ unit: choice, time });
    }
    acts[act.act] = out;
  }
  return {
    treatment: null,
    acts,
    soundbites: [],
    title: null,
    lowerThirds: [],
    intertitles: [],
    aiPhotos: [],
    parallax: [],
    voiceover: [],
    endcard: { line: GENERIC_ENDCARD[style.language], sub: null, url: null, source: 'generic' }
  };
}

/* ---------- the shots ---------- */

const ANCHOR_DEFAULT = Object.freeze({ x: 0.5, y: 0.45 });
const hasFaces = (unit) => Boolean(unit.faces && unit.faces.count > 0 && finite(unit.faces.x) && finite(unit.faces.y));
// the anchor on the faces of the analysis, else a little above the middle; `face` (D18) says whether a face holds it, so the cut keeps the shot a crop
const anchorOf = (unit) => (hasFaces(unit) ? { x: round3(clamp(unit.faces.x, 0, 1)), y: round3(clamp(unit.faces.y, 0, 1)), face: true } : { ...ANCHOR_DEFAULT, face: false });
// the start zoom of a photo shown a second time (D18): two thirds of the window of the first time
const DETAIL_ZOOM = 1.5;
// the anchor of a photo shown a second time (a detail): another face or another part of the picture than the first (WP53 B, rule 1); with two faces
// or more the shift lands on another one
function detailAnchor(unit) {
  const first = anchorOf(unit);
  const several = Boolean(unit.faces && unit.faces.count >= 2);
  const shift = several ? 0.18 : 0.25;
  const x = first.x < 0.5 ? first.x + shift : first.x - shift;
  const y = several ? first.y : first.y + 0.1;
  return { x: round3(clamp(x, 0.15, 0.85)), y: round3(clamp(y, 0.15, 0.85)), face: several && hasFaces(unit) };
}
const OPPOSITE_MOTION = Object.freeze({ zoom_in: 'zoom_out', zoom_out: 'zoom_in', pan_left: 'pan_right', pan_right: 'pan_left' });
const PHOTO_MOTION_CYCLE = Object.freeze(['zoom_in', 'pan_right', 'zoom_out', 'pan_left']);
// slow motion: 0.5 only from 50 fps, else 0.75 (spec §5c)
const slowSpeed = (unit) => (unit.fps >= 50 ? 0.5 : 0.75);
// a dip to black and a flash in frames; a dip into the close is a little longer
const DIP_FRAMES = 6;
const DIP_FRAMES_CLOSE = 8;
const FLASH_FRAMES = 3;

// The items of an act in their order: the picks with their pairs, and the soundbites of the act after the first third of the picks (never first, never last).
function actItems(act, content) {
  const items = [];
  for (const pick of content.acts[act.act] || []) {
    items.push({ type: 'pick', unit: pick.unit, slow: pick.slow, why: pick.why });
    if (pick.pair) items.push({ type: 'pair', unit: pick.pair, slow: false, why: null });
  }
  const bites = content.soundbites.map((bite, index) => ({ bite, index })).filter(({ bite }) => bite.act === act.act);
  bites.forEach(({ bite, index: biteIndex }, index) => {
    const picks = items.length;
    let at = Math.max(1, Math.round((picks * (index + 1)) / (bites.length + 2)));
    while (at < items.length && items[at].type === 'pair') at += 1;
    items.splice(Math.min(at, items.length), 0, { type: 'bite', bite, biteIndex });
  });
  return items;
}

// The lengths an item may have: a soundbite its own; a clip of the AI animation or of the parallax up to 5 s; a scene its seconds at its speed (at most 8 s);
// a photo up to 6 s (relaxed: as long as the act needs).
function boundsOf(item, ideal, grid, relaxed) {
  if (item.type === 'bite') return { fixed: item.bite.seconds };
  const min = Math.min(grid.derived.minShot, 0.8 * ideal);
  if (item.kind === 'photo_ai' || item.kind === 'photo_parallax') return { min: Math.min(min, CLIP_SECONDS), max: CLIP_SECONDS };
  if (item.unit.kind === 'photo') return { min, max: relaxed ? Infinity : PHOTO_MAX };
  const speed = item.speed || 1;
  const source = relaxed ? (item.unit.clipSeconds - item.unit.sc.in) / speed : item.unit.seconds / speed;
  const max = relaxed ? source : Math.min(MAX_VIDEO_SHOT, source);
  return { min: Math.min(min, max), max };
}

// The lengths of the flexible items: equal shares of what the fixed ones leave, each within its bounds (water filling).
function shareLengths(free, bounds) {
  const lengths = bounds.map(() => 0);
  let open = bounds.map((_, index) => index);
  let rest = free;
  for (let round = 0; round < bounds.length + 1 && open.length; round += 1) {
    const share = rest / open.length;
    const low = open.filter((index) => bounds[index].min > share);
    const high = open.filter((index) => bounds[index].max < share);
    if (!low.length && !high.length) {
      for (const index of open) lengths[index] = share;
      return lengths;
    }
    for (const index of low) lengths[index] = bounds[index].min;
    for (const index of high) lengths[index] = bounds[index].max;
    const done = new Set([...low, ...high]);
    rest -= [...done].reduce((sum, index) => sum + lengths[index], 0);
    open = open.filter((index) => !done.has(index));
  }
  return lengths;
}

// The cut times of an act: every cut on a beat of the grid near its ideal place where the bounds allow it, the act ends where it ends.
function placeCuts(act, items, lengths, snaps) {
  const ends = [];
  let time = act.start;
  items.forEach((item, index) => {
    if (index === items.length - 1) {
      ends.push(act.end);
      return;
    }
    const rest = items.slice(index + 1);
    const restMin = rest.reduce((sum, other) => sum + (other.bounds.fixed !== undefined ? other.bounds.fixed : other.bounds.min), 0);
    const restMax = rest.reduce((sum, other) => sum + (other.bounds.fixed !== undefined ? other.bounds.fixed : other.bounds.max), 0);
    if (item.bounds.fixed !== undefined) {
      time = round3(time + item.bounds.fixed);
      ends.push(time);
      return;
    }
    const ideal = time + lengths[index];
    const low = Math.max(time + item.bounds.min, act.end - restMax, time + 1 / FPS);
    const high = Math.min(time + item.bounds.max, act.end - restMin, act.end - rest.length / FPS);
    const reach = Math.max(0.35, lengths[index] * 0.45);
    let best = null;
    for (const point of snaps) {
      if (point < low - EPS || point > high + EPS || Math.abs(point - ideal) > reach) continue;
      if (best === null || Math.abs(point - ideal) < Math.abs(best - ideal)) best = point;
    }
    const end = best !== null ? best : clamp(ideal, Math.min(low, high), Math.max(low, high));
    time = round3(end);
    ends.push(time);
  });
  return ends;
}

// Prefer a different picture next, including across act boundaries. Keep soundbites in place.
function separateSimilar(items, previous, picker, act, placed, notes, allowed = () => true) {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const currentAct = typeof act === 'function' ? act(index) : act;
    if (!item.unit) { previous = null; continue; }
    if (looksLike(item.unit, previous)) {
      const other = items.findIndex((entry, at) => at > index && entry.unit && (!entry.unit.detail || placed?.has(entry.unit.element)) && !looksLike(entry.unit, previous) &&
        allowed(entry.unit, currentAct) && (!entry.pair || allowed(entry.pair, currentAct)) &&
        allowed(item.unit, typeof act === 'function' ? act(at) : act) &&
        (!item.pair || allowed(item.pair, typeof act === 'function' ? act(at) : act)));
      if (other >= 0) [items[index], items[other]] = [items[other], items[index]];
      else {
        const choice = picker && picker.best(currentAct, previous, new Set(), { details: true, placed });
        if (choice && !looksLike(choice, previous)) {
          picker.take(choice);
          notes.push(`${currentAct}: the code replaced ${item.unit.ref} with ${choice.ref} to separate similar pictures`);
          item.unit = choice;
        }
      }
    }
    previous = items[index].pair || items[index].unit;
    placed?.add(items[index].unit.element);
    if (items[index].pair) placed?.add(items[index].pair.element);
  }
  return previous;
}

// shots v1 from the content (spec §4): the speed of the slow shots, the length of every shot in its act on the beats, the anchors, the motion of the photos,
// the exposure, the transitions. D17: `fit` only where the plan has a reason (a detail of a photo is a crop); else the cut decides. Returns { shots, sources,
// notes, pageTransitions } where sources[i] is what shot i shows ({ kind: 'video'|'photo', index, at }) for the contact sheet.
function toShots(content, ctx) {
  const { grid, style } = ctx;
  const derived = grid.derived;
  const notes = [];
  const aiOf = new Map(content.aiPhotos.map((item, index) => [item.ref, index]));
  const parallaxOf = new Map(content.parallax.map((item, index) => [item.ref, index]));
  const picker = makePicker(ctx);
  for (const act of ACTS) for (const pick of content.acts[act] || []) [pick.unit, pick.pair].filter(Boolean).forEach((unit) => picker.take(unit));

  // the kind of every item, and slow motion (spec §5c: the share slowmo of the video shots, people and peak first, the picks marked slow first)
  const perAct = grid.acts.map((act) => ({ act, items: actItems(act, content) }));
  const kindOf = (item) => {
    if (item.type === 'bite') return 'soundbite';
    if (item.unit.kind === 'scene') return 'video';
    if (!item.unit.detail && aiOf.has(item.unit.ref)) return 'photo_ai';
    if (!item.unit.detail && parallaxOf.has(item.unit.ref)) return 'photo_parallax';
    return 'photo';
  };
  for (const { items } of perAct) for (const item of items) item.kind = kindOf(item);
  const videoItems = perAct.flatMap(({ act, items }) => items.filter((item) => item.kind === 'video').map((item) => ({ act: act.act, item })));
  const slowCount = Math.round(style.values.slowmo * videoItems.length);
  const rank = ({ act, item }) => (item.slow ? 0 : 2) + (act === 'people' || act === 'peak' ? 0 : 1);
  videoItems
    .slice()
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, slowCount)
    .forEach(({ item }) => {
      item.speed = slowSpeed(item.unit);
    });

  const shots = [];
  const sources = [];
  // the clips and photos of the acts before (a detail only follows its photo)
  const shown = new Set();
  let previousUnit = null;
  let photoCount = 0;
  const lastMotion = new Map();
  for (const { act, items } of perAct) {
    separateSimilar(items, previousUnit, null, act.act, new Set(shown), notes);
    for (const item of items) item.kind = kindOf(item);
    const total = act.end - act.start;
    let relaxed = false;
    let lengths;
    for (let round = 0; round < 40; round += 1) {
      const flexible = items.filter((item) => item.type !== 'bite');
      const fixed = items.filter((item) => item.type === 'bite').reduce((sum, item) => sum + item.bite.seconds, 0);
      const ideal = flexible.length ? Math.max(0.1, (total - fixed) / flexible.length) : 0;
      for (const item of items) item.bounds = boundsOf(item, ideal, grid, relaxed);
      const minSum = items.reduce((sum, item) => sum + (item.bounds.fixed !== undefined ? item.bounds.fixed : item.bounds.min), 0);
      const maxSum = items.reduce((sum, item) => sum + (item.bounds.fixed !== undefined ? item.bounds.fixed : item.bounds.max), 0);
      if (minSum > total + EPS) {
        // too many shots for the act: the last pick that is no soundbite goes (a pair goes with its pick)
        const at = items.map((item) => item.type).lastIndexOf('pick');
        if (at < 0 || flexible.length <= 1) break;
        const removed = items.splice(at, items[at + 1] && items[at + 1].type === 'pair' ? 2 : 1);
        notes.push(`${act.act}: ${removed[0].unit.ref.replace('*', '')} was left out, the act is too short for all its shots`);
        continue;
      }
      if (maxSum < total - EPS || !flexible.length) {
        // too few: one more shot from the material, else longer shots than usual
        const previous = flexible.length ? flexible[flexible.length - 1].unit : previousUnit;
        const placed = new Set([...shown, ...flexible.map((item) => item.unit.element)]);
        const choice = picker.best(act.act, previous, new Set(), { details: true, placed });
        if (choice && round < 30) {
          picker.take(choice);
          const item = { type: 'pick', unit: choice, slow: false, why: null };
          item.kind = kindOf(item);
          const last = items.length && items[items.length - 1].type === 'bite' ? items.length - 1 : items.length;
          items.splice(last, 0, item);
          notes.push(`${act.act}: the code added ${choice.ref.replace('*', ' (detail)')}, the shots were too short for the act`);
          continue;
        }
        if (!relaxed) {
          relaxed = true;
          continue;
        }
      }
      const flexIndex = items.map((item, index) => (item.bounds.fixed === undefined ? index : -1)).filter((index) => index >= 0);
      const shares = shareLengths(total - fixed, flexIndex.map((index) => items[index].bounds));
      lengths = items.map((item) => (item.bounds.fixed !== undefined ? item.bounds.fixed : 0));
      flexIndex.forEach((index, k) => {
        lengths[index] = shares[k];
      });
      break;
    }
    // a soundbite must not end the act: it moves before the last pick
    if (items.length > 1 && items[items.length - 1].type === 'bite') {
      const bite = items.pop();
      items.splice(items.length - 1, 0, bite);
      const length = lengths.pop();
      lengths.splice(lengths.length - 1, 0, length);
    }
    // Move each source's allocated length with it when the final filled order changes.
    const before = items.slice();
    previousUnit = separateSimilar(items, previousUnit, null, act.act, new Set(shown), notes);
    if (items.some((item, index) => item !== before[index])) {
      lengths = items.map((item) => lengths[before.indexOf(item)]);
    }
    const ends = placeCuts(act, items, lengths, act.act === 'peak' ? grid.peakSnaps : grid.snaps);
    let start = act.start;
    items.forEach((item, index) => {
      const end = ends[index];
      const shot = { id: `s${shots.length + 1}`, act: act.act, start: round3(start), end: round3(end), kind: item.kind };
      const seconds = end - start;
      if (item.kind === 'soundbite') {
        const bite = item.bite;
        const video = ctx.material.videos[bite.video];
        const scene = video.info.scenes.find((entry) => bite.start >= entry.in - EPS && bite.start < entry.out) || video.info.scenes[0];
        const unit = ctx.material.byRef.get(`${video.ref}#${scene.i}`) || unitsOf(video).find((entry) => entry.scene === scene.i);
        shot.source = bite.video;
        shot.from = bite.start;
        shot.to = round3(bite.start + seconds);
        // a soundbite without a face in the analysis keeps no `face`: the cut takes its speaker for one (D18)
        const { face, ...place } = anchorOf(unit);
        shot.anchor = { ...place, ...(face ? { face } : {}), drift: [0, 0] };
        if (unit.hdr) shot.hdr = true;
        shot.exposure = derived.exposure(scene.luma);
        sources.push({ kind: 'video', index: bite.video, at: bite.start });
      } else if (item.kind === 'video') {
        const unit = item.unit;
        const speed = item.speed || 1;
        const need = seconds * speed;
        const sceneLeft = unit.sc.out - unit.sc.in;
        let from = unit.sc.in + Math.max(0, (sceneLeft - need) / 2);
        if (from + need > unit.clipSeconds - 0.05) from = Math.max(0, unit.clipSeconds - 0.05 - need);
        shot.source = unit.source;
        shot.from = round3(from);
        shot.speed = speed;
        const drift = unit.sc.motion === 'pan_right' ? [0.02, 0] : unit.sc.motion === 'pan_left' ? [-0.02, 0] : [0, 0];
        shot.anchor = { ...anchorOf(unit), drift };
        if (unit.hdr) shot.hdr = true;
        shot.exposure = derived.exposure(unit.luma);
        sources.push({ kind: 'video', index: unit.source, at: round3(from + need / 2) });
      } else {
        const unit = item.unit;
        if (item.kind === 'photo_ai') shot.clip = aiOf.get(unit.ref);
        else if (item.kind === 'photo_parallax') shot.clip = parallaxOf.get(unit.ref);
        else {
          shot.source = unit.source;
          let type;
          if (unit.detail) type = OPPOSITE_MOTION[lastMotion.get(unit.element) || 'zoom_in'];
          else if (unit.faces && unit.faces.count > 0) type = 'zoom_in';
          else type = PHOTO_MOTION_CYCLE[photoCount % PHOTO_MOTION_CYCLE.length];
          photoCount += 1;
          lastMotion.set(unit.element, type);
          shot.motion = { type, rate: Math.min(derived.zoomRate, contract.MAX_PHOTO_RATE) };
        }
        shot.anchor = unit.detail ? detailAnchor(unit) : anchorOf(unit);
        // D17, D18: a detail is a crop of another part of the photo, zoomed in; everything else: the cut chooses
        if (unit.detail) {
          shot.fit = 'crop';
          if (item.kind === 'photo') shot.zoom = DETAIL_ZOOM;
        }
        shot.exposure = derived.exposure(unit.luma);
        sources.push({ kind: 'photo', index: unit.source, at: 0, detail: Boolean(unit.detail) });
      }
      shot.transition = item.type === 'pair' ? 'match' : 'cut';
      shot.why = item.why || null;
      if (item.type !== 'bite') shown.add(item.unit.element);
      shot.ref = item.type === 'bite' ? item.bite.ref : item.unit.ref;
      shot.biteIndex = item.type === 'bite' ? item.biteIndex : null;
      shots.push(shot);
      start = end;
    });
  }

  // the soft transitions (spec §5, D5): the weights of the style over the cuts at the start of an act and on a downbeat; dissolve is a transition of the cut,
  // dip and flash (and strobe) are layers of the page at a cut, whip is a cut and match needs a pair
  const weights = style.transitions;
  const sum = Object.values(weights).reduce((total, weight) => total + weight, 0);
  const soft = { dissolve: weights.dissolve || 0, dip: weights.dip || 0, flash: (weights.flash || 0) + (weights.strobe || 0) };
  const softSum = soft.dissolve + soft.dip + soft.flash;
  const pageTransitions = [];
  if (softSum > 0) {
    const actStarts = new Set(grid.acts.slice(1).map((act) => act.start));
    const onDownbeat = (time) => grid.downbeats.some((beat) => Math.abs(beat - time) < 0.03);
    const candidates = shots.map((shot, index) => ({ shot, index })).filter(({ shot, index }) => index > 0 && shot.transition === 'cut' && (actStarts.has(shot.start) || onDownbeat(shot.start)));
    const wanted = Math.round((candidates.length * softSum) / sum);
    const used = { dissolve: 0, dip: 0, flash: 0 };
    // the act starts first, then every other downbeat cut
    const ordered = [...candidates.filter(({ shot }) => actStarts.has(shot.start)), ...candidates.filter(({ shot }) => !actStarts.has(shot.start)).filter((_, k) => k % 2 === 0)];
    for (const { shot } of ordered.slice(0, wanted)) {
      const done = used.dissolve + used.dip + used.flash + 1;
      const type = Object.keys(soft)
        .filter((name) => soft[name] > 0)
        .sort((a, b) => (soft[b] / softSum) * done - used[b] - ((soft[a] / softSum) * done - used[a]))[0];
      used[type] += 1;
      if (type === 'dissolve') shot.transition = 'dissolve';
      else pageTransitions.push({ at: shot.start, type, frames: type === 'flash' ? FLASH_FRAMES : shot.act === 'close' && actStarts.has(shot.start) ? DIP_FRAMES_CLOSE : DIP_FRAMES });
    }
  }
  pageTransitions.sort((a, b) => a.at - b.at);

  const plan = {
    version: contract.SHOTS_VERSION,
    fps: FPS,
    duration: grid.duration,
    look: { contrast: style.values.contrast, saturation: style.values.saturation },
    shots: shots.map(({ why, ref, biteIndex, ...shot }) => shot)
  };
  // the soundbites of the content in the order of the film (the third one plays in arrival, before the first)
  const biteOrder = shots.filter((shot) => shot.kind === 'soundbite').map((shot) => shot.biteIndex);
  return { shots: plan, sources, notes, pageTransitions, biteOrder, refs: shots.map((shot) => ({ ref: shot.ref, why: shot.why })) };
}

/* ---------- the graphics ---------- */

const TITLE_HOLD = Object.freeze({ base: 1.6, perSecond: 0.06, min: 2.5, max: 4.5 });
const LOWER_THIRD = Object.freeze({ lead: 0.3, tail: 0.3, max: 4.5 });
const INTERTITLE = Object.freeze({ lead: 0.2, min: 1.5, max: 2.5 });
const VOICE_LEAD = 0.4;

// The accent of the branding (its colour with the role accent), else white (spec §7).
function accentOf(brand) {
  const data = typeof brand === 'string' ? planLib.parseJsonAnswer(brand) : brand;
  if (!isObject(data) || data.neutral || !Array.isArray(data.colors)) return '#FFFFFF';
  const accent = data.colors.find((color) => isObject(color) && color.role === 'accent' && /^#[0-9A-Fa-f]{6}$/.test(String(color.hex)));
  return accent ? accent.hex.toUpperCase() : '#FFFFFF';
}

// graphics v1 (spec §4, D12 to D14) from the content and the shots.
function toGraphics(content, made, ctx) {
  const { grid, style, brand } = ctx;
  const derived = grid.derived;
  const plan = made.shots;
  const duration = grid.duration;
  const cuts = plan.shots.map((shot) => shot.start);
  const acts = grid.acts.map((act) => {
    const own = plan.shots.filter((shot) => shot.act === act.act);
    return { act: act.act, start: own.length ? own[0].start : act.start, end: own.length ? own[own.length - 1].end : act.end };
  });
  const biteShots = plan.shots.filter((shot) => shot.kind === 'soundbite');
  const soundbites = biteShots.map((shot, index) => {
    const bite = content.soundbites[made.biteOrder[index]];
    const words = bite.words.map((word) => ({ w: word.w, s: round3(clamp(word.s - shot.from, 0, shot.end - shot.start)), e: round3(clamp(word.e - shot.from, 0, shot.end - shot.start)) }));
    return { start: shot.start, end: shot.end, words };
  });
  const insideBite = (time) => soundbites.some((bite) => time > bite.start - EPS && time < bite.end + EPS);

  let title = null;
  if (content.title) {
    const end = round3(Math.min(duration - ENDCARD_SECONDS - 1, TITLE_FROM + clamp(TITLE_HOLD.base + TITLE_HOLD.perSecond * duration, TITLE_HOLD.min, TITLE_HOLD.max)));
    title = { text: content.title.text, sub: content.title.sub || null, start: TITLE_FROM, end, anim: style.title_anim };
  }

  const lowerThirds = content.lowerThirds
    .filter((third) => made.biteOrder.includes(third.soundbite))
    .map((third) => {
      const bite = soundbites[made.biteOrder.indexOf(third.soundbite)];
      const start = round3(bite.start + LOWER_THIRD.lead);
      const end = round3(Math.min(bite.end - LOWER_THIRD.tail, start + LOWER_THIRD.max));
      return { name: third.name, role: third.role, label: third.label, start, end };
    })
    .filter((third) => third.end - third.start >= 1)
    .sort((a, b) => a.start - b.start);

  // an intertitle on the second shot of its act (the first where the act has one shot), never over a soundbite or the title
  const intertitles = [];
  for (const entry of content.intertitles) {
    const own = plan.shots.filter((shot) => shot.act === entry.act && shot.kind !== 'soundbite');
    const shot = own.find((candidate, index) => index >= Math.min(1, own.length - 1) && !insideBite(candidate.start + INTERTITLE.lead) && (!title || candidate.start + INTERTITLE.lead >= title.end));
    if (!shot) continue;
    const start = round3(shot.start + INTERTITLE.lead);
    const end = round3(Math.min(start + clamp(shot.end - shot.start - 0.3, INTERTITLE.min, INTERTITLE.max), duration - ENDCARD_SECONDS));
    if (end - start < 1 || soundbites.some((bite) => bite.start < end && start < bite.end)) continue;
    intertitles.push({ text: entry.text, start, end });
  }

  // the voice-over at the start of its act, after a soundbite that plays there
  const voiceover = [];
  content.voiceover.forEach((line, index) => {
    const act = acts.find((entry) => entry.act === line.act);
    let start = act.start + VOICE_LEAD;
    for (const bite of soundbites) if (start > bite.start - EPS && start < bite.end) start = bite.end + 0.3;
    if (start < duration - 1) voiceover.push({ index, start: round3(start) });
  });

  const endcard = { line: content.endcard.line, sub: content.endcard.sub || null, url: content.endcard.url || null, seconds: ENDCARD_SECONDS, logo: true };
  const hasVideo = plan.shots.some((shot) => shot.kind === 'video' || shot.kind === 'soundbite');
  return {
    version: contract.GRAPHICS_VERSION,
    fps: FPS,
    duration,
    cuts,
    endFrame: Math.round(duration * FPS),
    acts,
    transitions: made.pageTransitions.filter((item) => cuts.some((cut) => Math.abs(cut - item.at) <= EPS) && item.at > 0),
    title,
    lower_thirds: lowerThirds,
    intertitles,
    soundbites,
    voiceover,
    endcard,
    look: {
      type: { title: style.type.title, body: style.type.body },
      accent: accentOf(brand),
      tint: derived.tint,
      glow: derived.glow,
      title_seconds: derived.titleSeconds,
      ease: derived.ease,
      grain: style.values.grain,
      contrast: style.values.contrast
    },
    // without a clip there is no sound of the clips (WP53 B, rule 1)
    mix: { duck_db: derived.mix.duck_db, ramp: derived.mix.ramp, nat_level: hasVideo ? derived.mix.nat_level : 0, lufs: derived.mix.lufs }
  };
}

/* ---------- the price ---------- */

// The tokens of one call of the planner: the prompt by its length; the answer by its picks (a ref and a reason each, and the texts) and the thinking at the effort
// "medium", which grows with the picks. Set so that the typical material of spec §2 (20 clips of 10 min, 20 photos, typicalPromptChars) with the cuts of the
// default style (conference x fresh, 34 a minute) gives the planner of its table for Opus 5.5: 0.35 / 0.42 / 0.50 USD at 30 / 60 / 90 s.
const PLAN_TEXT_TOKENS = Object.freeze({ film: 3900, pick: 120 });
const PLAN_THINKING_TOKENS = Object.freeze({ film: 8000, pick: 100 });
function llmTokens({ picks }, promptChars, charsPerToken = 3) {
  const text = PLAN_TEXT_TOKENS.film + PLAN_TEXT_TOKENS.pick * picks;
  const thinking = PLAN_THINKING_TOKENS.film + PLAN_THINKING_TOKENS.pick * picks;
  return { input: Math.ceil(promptChars / charsPerToken), output: thinking + text, text, thinking };
}

// The typical material of spec §2 and the characters of its prompt: a row and its scenes for every clip (a scene about every 8 s), the transcript of half of
// the footage (about 2.3 words a second, 9 characters a word with its index), a row for every photo, and the system prompt with the schema.
const TYPICAL_MATERIAL = Object.freeze({ videos: 20, photos: 20, videoSeconds: 600, speechSeconds: 900 });
const TYPICAL_CHARS = Object.freeze({ system: 5200, user: 600, video: 230, scene: 70, sceneSeconds: 8, wordsPerSecond: 2.3, word: 9, speechShare: 0.5, photo: 230 });
function typicalPromptChars({ videos = TYPICAL_MATERIAL.videos, photos = TYPICAL_MATERIAL.photos, videoSeconds = TYPICAL_MATERIAL.videoSeconds } = {}) {
  const c = TYPICAL_CHARS;
  return Math.round(c.system + c.user + videos * c.video + (videoSeconds / c.sceneSeconds) * c.scene + videoSeconds * c.speechShare * c.wordsPerSecond * c.word + photos * c.photo);
}

const cents = (usd) => Math.round(usd * 10000) / 10000;

// The price of the film by its parts (spec §2), in USD; a part whose price is not known is null and the total then too. `prices`:
//   { visionPerItem, speechPerHour, music(seconds) -> usd, llm { inputPerMillion, outputPerMillion, charsPerToken }, depth, clipPerSecond, voicePerChar }
// `work`: { items (elements analysed), speechSeconds, musicSeconds (0 for own music), picks, promptChars, aiClips, depthMaps, voiceChars }.
// Returns { parts, total, step1, step2, unknown, tokens }: step 1 is the analysis, the music and the plan; step 2 what runs after the approval.
function estimate(work, prices = {}) {
  const price = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const times = (unit, count) => (count === 0 ? 0 : price(unit) === null ? null : price(unit) * count);
  const llm = prices.llm && price(prices.llm.inputPerMillion) !== null && price(prices.llm.outputPerMillion) !== null ? prices.llm : null;
  const tokens = llmTokens({ picks: work.picks || 0 }, work.promptChars || 0, llm ? llm.charsPerToken || 3 : 3);
  const parts = {
    vision: times(prices.visionPerItem, work.items || 0),
    speech: work.speechSeconds ? (price(prices.speechPerHour) === null ? null : (price(prices.speechPerHour) * work.speechSeconds) / 3600) : 0,
    music: work.musicSeconds ? (typeof prices.music === 'function' ? price(prices.music(work.musicSeconds)) : null) : 0,
    llm: llm ? (tokens.input * llm.inputPerMillion + tokens.output * llm.outputPerMillion) / 1e6 : null,
    depth: times(prices.depth, work.depthMaps || 0),
    ai: times(price(prices.clipPerSecond) === null ? null : prices.clipPerSecond * CLIP_SECONDS, work.aiClips || 0),
    voice: times(prices.voicePerChar, work.voiceChars || 0)
  };
  const unknown = Object.keys(parts).filter((name) => parts[name] === null);
  for (const name of Object.keys(parts)) if (parts[name] !== null) parts[name] = cents(parts[name]);
  const sum = (names) => (names.some((name) => parts[name] === null) ? null : cents(names.reduce((total, name) => total + parts[name], 0)));
  return { parts, total: sum(Object.keys(parts)), step1: sum(['vision', 'speech', 'music', 'llm']), step2: sum(['depth', 'ai', 'voice']), unknown, tokens };
}

/* ---------- the board ---------- */

const money = (usd) => (usd === null || usd === undefined ? 'unknown' : usd.toFixed(2));
const clock = (seconds) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
const minutes = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
const label = (name) => name.padEnd(11, ' ');
const KIND_LABEL = Object.freeze({ video: 'VIDEO', photo: 'PHOTO', photo_ai: 'AI', photo_parallax: 'DEPTH', soundbite: 'SOUND' });

// The board for the approval (spec §4, board rows): TREATMENT, STYLE, NUMBERS, ESTIMATE, MODEL, NOTE, PLAIN, SOUNDBITES, TITLES, LEFT OUT, then the shots of every
// act.
function boardText({ content, made, graphics, grid, style, material, cost, model = null, plain = false, notes = [], leftOut = [] }) {
  const out = [];
  const shots = made.shots.shots;
  out.push('TREATMENT', content.treatment || (plain ? '(a plain plan: no treatment)' : '(the language model wrote none)'), '');
  const transitions = Object.entries(style.transitions).map(([name, weight]) => `${name} ${weight}`).join(', ');
  const v = style.values;
  out.push(
    `${label('STYLE')}${style.event_alias ? `${style.event_alias} (${style.event_type})` : style.event_type} / ${style.mood} · ${grid.duration} s · ${grid.bpm} BPM · ${grid.derived.cpm} cuts/min · look contrast ${v.contrast}, saturation ${v.saturation}, warmth ${v.warmth}, grain ${v.grain}, glow ${v.glow} · transitions ${transitions} · type ${style.type.title.replace(/:/g, ' ')} / ${style.type.body.replace(/:/g, ' ')}`
  );
  const usableVideos = material.videos.filter((video) => video.usable);
  const usablePhotos = material.photos.filter((photo) => photo.usable);
  const count = (kind) => shots.filter((shot) => shot.kind === kind).length;
  out.push(
    `${label('NUMBERS')}material ${material.videos.length} videos (${usableVideos.length} usable, ${minutes(material.videoSeconds)} min) and ${material.photos.length} photos (${usablePhotos.length} usable) · ${grid.usableUnits} scenes and photos to choose from · ${shots.length} shots (${count('video')} video, ${count('photo')} photo, ${count('photo_ai')} AI, ${count('photo_parallax')} parallax, ${count('soundbite')} soundbites) · ${round2((shots.length * 60) / grid.duration)} cuts/min`
  );
  const p = cost.parts;
  out.push(
    `${label('ESTIMATE')}AI clips ${content.aiPhotos.length} ${money(p.ai)} + depth maps ${content.parallax.length} ${money(p.depth)} + voice ${money(p.voice)} + rest (analysis ${money(p.vision === null || p.speech === null ? null : cents(p.vision + p.speech))}, music ${money(p.music)}, plan ${money(p.llm)}) = ${money(cost.total)} USD; after the approval ${money(cost.step2)} USD${cost.total === null ? ` (unknown: ${cost.unknown.join(', ')})` : ''}`
  );
  if (model) out.push(`${label('MODEL')}${model}`);
  for (const note of [...grid.notes, ...notes]) out.push(`${label('NOTE')}${note}`);
  if (plain) out.push(`${label('PLAIN')}a plan by the score alone (allowed by "Allow a plain plan"): no title text, no soundbites, a generic end card`);
  if (graphics.soundbites.length) {
    graphics.soundbites.forEach((bite, index) => {
      const entry = content.soundbites[made.biteOrder[index]];
      const third = graphics.lower_thirds.find((item) => item.start >= bite.start - EPS && item.end <= bite.end + EPS);
      const who = third ? ` · ${[third.name, third.role, third.label].filter(Boolean).join(', ')}` : '';
      const quote = entry.words.map((word) => word.w).join(' ');
      out.push(`${index === 0 ? label('SOUNDBITES') : label('')}${index + 1} «${quote.length > 90 ? `${quote.slice(0, 89)}…` : quote}» ${entry.ref} ${fixed(entry.start)}-${fixed(entry.end)} s (${fixed(entry.seconds)} s) at ${clock(bite.start)}${who}`);
    });
  } else out.push(`${label('SOUNDBITES')}none${material.videos.some((video) => video.usable) ? '' : ' (no videos: no soundbites and no sound of the clips)'}`);
  const titleParts = [
    graphics.title ? `title «${graphics.title.text}»${graphics.title.sub ? ` / «${graphics.title.sub}»` : ''}` : 'no title',
    graphics.intertitles.length ? `intertitles ${graphics.intertitles.map((item) => `«${item.text}» at ${clock(item.start)}`).join(', ')}` : '',
    `end card «${graphics.endcard.line}»${graphics.endcard.sub ? ` / «${graphics.endcard.sub}»` : ''}${graphics.endcard.url ? ` · ${graphics.endcard.url}` : ''}`,
    content.voiceover.length ? `voice-over ${content.voiceover.map((line) => `«${line.text}»`).join(' ')}` : ''
  ];
  out.push(`${label('TITLES')}${titleParts.filter(Boolean).join(' · ')}`);
  if (leftOut.length) out.push(`${label('LEFT OUT')}${leftOut.join(', ')}`);
  out.push('');
  for (const act of graphics.acts) {
    out.push(`${act.act.toUpperCase()}  ${clock(act.start)}-${clock(act.end)}`);
    shots.forEach((shot, index) => {
      if (shot.act !== act.act) return;
      const ref = made.refs[index];
      const extra = [
        shot.kind === 'video' && shot.speed !== 1 ? `slow ${shot.speed}x` : '',
        shot.transition !== 'cut' ? shot.transition : '',
        graphics.transitions.find((item) => Math.abs(item.at - shot.start) <= EPS)?.type || '',
        shot.fit ? `fit ${shot.fit}` : ''
      ].filter(Boolean);
      const what = ref.ref.endsWith('*') ? `${ref.ref.slice(0, -1)} (detail)` : ref.ref;
      out.push(`${String(shot.id).padStart(4, ' ')}  ${clock(shot.start)}-${clock(shot.end)}  ${KIND_LABEL[shot.kind].padEnd(5, ' ')}  ${what}${extra.length ? ` [${extra.join(', ')}]` : ''}${ref.why ? `  ${ref.why}` : ''}`);
    });
  }
  return out.join('\n');
}

/* ---------- the run ---------- */

// The tokens the model may use, thinking included, and its effort (WP52a: medium with enough room; the answer of an event is about 4 000 tokens of text).
const PLAN_MAX_TOKENS = 32000;
const PLAN_REASONING_EFFORT = 'medium';
const RETRY_REASONING_EFFORT = 'low';
// one answer and at most one more with the problems of the first
const MAX_ATTEMPTS = 2;
// an empty answer is asked again up to twice, the second time after a pause (Opus 5.5 gave two empty answers in a row live, WP52a)
const EMPTY_RETRIES = 2;
const EMPTY_PAUSE_MS = 20000;
// more picks replaced by the code than this share: EVENTPLAN_MODEL_FAILED (or the plain plan with allow_plain)
const MAX_REPLACED_SHARE = 0.25;

const errorText = (err) => String(err?.message || err).slice(0, 200);

function usageOf(usage) {
  const count = (value) => {
    const number = Number(value);
    return value !== null && value !== undefined && Number.isFinite(number) && number >= 0 ? number : null;
  };
  if (!isObject(usage)) return { completion: null, reasoning: null };
  return {
    completion: count(usage.completion_tokens ?? usage.output_tokens),
    reasoning: count(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens)
  };
}

const TRY_ENDS = Object.freeze({ complete: 'complete', cut: 'cut off at the limit', broken: 'broke off (invalid JSON)', 'not-json': 'no JSON object', empty: 'empty', error: 'failed' });

// The line MODEL of the board: the model and every request with its effort, tokens, end, the picks it delivered and its price.
function modelLine(records, model) {
  const tries = records.map((record) => {
    const tokens =
      record.completion !== null
        ? `${group(record.completion)} of ${group(record.limit)} tokens${record.reasoning !== null ? ` (thinking ${group(record.reasoning)}, text ${group(Math.max(0, record.completion - record.reasoning))})` : ''}`
        : `limit ${group(record.limit)} tokens`;
    const picks = record.picks !== null && record.picks !== undefined ? `, ${record.replaced} of ${record.picks} picks replaced` : '';
    const usd = typeof record.usd === 'number' ? `, ${record.usd.toFixed(2)} USD` : '';
    const name = record.again ? `request ${record.request} (empty before, again${record.paused ? ' after a pause' : ''})` : `try ${record.attempt}`;
    return `${name}: effort ${record.effort}, ${tokens}, ${TRY_ENDS[record.finish] || record.finish}${record.error ? ` (${record.error.slice(0, 80)})` : ''}${picks}${usd}`;
  });
  return [model || 'the language model', ...tries].join(' · ');
}

function modelFailedError({ records, costs, model, why }) {
  const usd = costs.filter(finite).reduce((sum, value) => sum + value, 0);
  const err = planError(
    ERRORS.EVENTPLAN_MODEL_FAILED,
    `The language model delivered no usable plan (${why}; ${modelLine(records, model)}): ${usd.toFixed(2)} USD were paid. Run the node again, choose another model, ` +
      'or switch on "Allow a plain plan" to make the film from the score of the material alone',
    { attempts: records.length, usd: usd.toFixed(2), why, model: model || '' }
  );
  err.costs = costs;
  return err;
}

// The checks before anything is paid: the description, the amount of the material (spec §1). `material` is readMaterial(...).
function checkInputs(brief, material) {
  if (!String(brief || '').trim()) throw planError(ERRORS.EVENTPLAN_BRIEF_EMPTY, 'brief: describe the event (what, when, where, who): it is the only source of the facts on the screen');
  if (material.videoSeconds > LIMITS.videoSeconds + EPS) {
    // what to leave out: the clips with the lowest score until the rest fits
    const ranked = material.videos
      .filter((video) => video.info && video.info.meta && finite(video.info.meta.seconds))
      .map((video) => ({ video, score: video.usable ? Math.max(...material.units.filter((unit) => unit.element === video.ref).map(baseScore), 0) : -1 }))
      .sort((a, b) => a.score - b.score || b.video.info.meta.seconds - a.video.info.meta.seconds);
    let rest = material.videoSeconds;
    const drop = [];
    for (const { video } of ranked) {
      if (rest <= LIMITS.videoSeconds) break;
      drop.push(video.ref);
      rest -= video.info.meta.seconds;
    }
    throw planError(
      ERRORS.EVENTPLAN_TOO_MUCH_MATERIAL,
      `The videos are ${minutes(material.videoSeconds)} min long together, at most ${LIMITS.videoSeconds / 60} min are allowed: leave out ${drop.join(', ')} (the clips with the lowest score) or shorter ones`,
      { minutes: round2(material.videoSeconds / 60), limit: LIMITS.videoSeconds / 60, leave: drop.join(', ') }
    );
  }
  if (material.usable < LIMITS.minUsable) {
    throw planError(ERRORS.EVENTPLAN_NO_MATERIAL, `Only ${material.usable} of the clips and photos can be used, at least ${LIMITS.minUsable} are needed`, { usable: material.usable, needed: LIMITS.minUsable });
  }
}

// The elements that are not in the film and why (the board, LEFT OUT).
function leftOutOf(material, made) {
  const shown = new Set();
  for (const shot of made.shots.shots) {
    if (shot.kind === 'video' || shot.kind === 'soundbite') shown.add(`v${shot.source}`);
  }
  made.sources.filter((source) => source.kind === 'photo').forEach((source) => shown.add(`p${source.index}`));
  const out = [...material.duplicates].filter(([ref]) => ref.includes('#')).map(([ref, original]) => `${ref} (duplicate of ${original})`);
  for (const element of [...material.videos, ...material.photos]) {
    if (!element.usable) out.push(`${element.ref} (${element.reason})`);
    else if (!shown.has(element.ref)) {
      const units = material.units.filter((unit) => unit.element === element.ref);
      const fault = units.map((unit) => unitFault(unit, 'programme', { event_type: 'conference' })).find(Boolean);
      out.push(`${element.ref} (${fault && units.every((unit) => unitFault(unit, 'programme', { event_type: 'conference' })) ? fault : 'not picked'})`);
    }
  }
  return out;
}

// The whole planner without the network. `ask({ system, prompt, json, maxTokens, reasoningEffort })` returns { text, usd, usage?, finishReason?, model? } or
// throws (an empty answer carries emptyAnswer, finishReason, completionTokens, reasoningTokens and usd); `fatal(err)` says which errors end the node; `sleep(ms)`
// waits (a test passes one that does not). `videos`/`photos`: the infos (texts or objects) in the order of the inputs; `analysis`: the beats of the music;
// `musicSeconds`: the length of the music; `options`: { photoMotion, parallax, maxAiPhotos, voiceover, lowerThirds, soundbites, allowPlain }.
async function runEventPlanner(input) {
  const { brief, style: styleInput, videos = [], photos = [], analysis, musicSeconds = null, brand = null, options = {}, ask, log = () => {}, prices = {}, fatal = () => false } = input;
  const sleep = input.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const style = typeof styleInput === 'string' ? JSON.parse(styleInput) : styleInput;
  const styleCheck = contract.checkStyle(style);
  if (!styleCheck.ok) throw new Error(`style: the text is not the style of event_video.style (${styleCheck.problems[0]})`);
  const material = readMaterial(videos, photos);
  checkInputs(brief, material);
  const grid = planGrid({ analysis, style, material, musicSeconds, options });
  const sources = sourcesOf(brief, material);
  const ctx = { material, grid, style, options, sources, brand, brief: String(brief).trim() };
  const system = systemPrompt({ style, grid, material, options });
  const left = materialText(material).left;
  if (left.length) grid.notes.push(`the material was too long for the prompt: ${left.join(', ')} were left out (the lowest score)`);

  const costs = [];
  const records = [];
  const tries = [];
  let model = null;
  let effort = PLAN_REASONING_EFFORT;
  let problemsTold = [];
  let previous = '';
  let empties = 0;
  let request = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; ) {
    request += 1;
    const prompt = userPrompt({ brief, style, grid, material, problems: problemsTold, previous });
    const record = { request, attempt, effort, limit: PLAN_MAX_TOKENS, finish: 'error', completion: null, reasoning: null, usd: null, picks: null, replaced: 0, again: empties > 0, paused: false };
    if (empties >= 2) record.paused = true;
    records.push(record);
    let result;
    try {
      result = await ask({ system, prompt, json: true, maxTokens: PLAN_MAX_TOKENS, reasoningEffort: effort });
    } catch (err) {
      if (fatal(err)) throw err;
      if (typeof err?.usd === 'number') {
        costs.push(err.usd);
        record.usd = err.usd;
      }
      if (err?.model) model = model || err.model;
      if (!err?.emptyAnswer) {
        record.error = errorText(err);
        if (!tries.length) throw err;
        log(`The second request to the language model failed (${errorText(err)}): the first answer is used.`);
        break;
      }
      record.finish = 'empty';
      record.completion = usageOf({ completion_tokens: err.completionTokens }).completion;
      record.reasoning = usageOf({ completion_tokens_details: { reasoning_tokens: err.reasoningTokens } }).reasoning;
      if (empties >= EMPTY_RETRIES) {
        log(`The language model wrote nothing again (${errorText(err)}).`);
        break;
      }
      empties += 1;
      if (err.finishReason === 'length' && effort !== RETRY_REASONING_EFFORT) effort = RETRY_REASONING_EFFORT;
      if (empties === EMPTY_RETRIES) {
        log(`The language model wrote nothing (${errorText(err)}): asking again in ${EMPTY_PAUSE_MS / 1000} s.`);
        await sleep(EMPTY_PAUSE_MS);
      } else log(`The language model wrote nothing (${errorText(err)}): asking again.`);
      continue;
    }
    empties = 0;
    costs.push(result.usd);
    record.usd = typeof result.usd === 'number' ? result.usd : null;
    model = result.model || model;
    const used = usageOf(result.usage);
    record.completion = used.completion;
    record.reasoning = used.reasoning;
    const atLimit = result.finishReason === 'length' || (used.completion !== null && used.completion >= PLAN_MAX_TOKENS);
    const read = readAnswer(result.text, ctx);
    record.finish = !read.ok ? 'not-json' : read.cut ? (atLimit ? 'cut' : 'broken') : 'complete';
    record.picks = read.picks;
    record.replaced = read.replaced;
    const share = read.ok && read.picks ? read.replaced / read.picks : 1;
    tries.push({ attempt, read, share, score: read.ok ? share * 1000 + read.problems.length : 1e9 });
    if (!read.problems.length) break;
    if (attempt < MAX_ATTEMPTS) {
      log(`The answer of the language model had ${read.problems.length} problem${read.problems.length === 1 ? '' : 's'}: asking once more (${read.problems.slice(0, 2).join('; ').slice(0, 200)})`);
      problemsTold = read.problems;
      previous = read.ok && !read.cut ? String(result.text).slice(0, 20000) : '';
      if (atLimit) effort = RETRY_REASONING_EFFORT;
    }
    attempt += 1;
  }

  // the better answer (the later one where they are equally good); none, or too much replaced: EVENTPLAN_MODEL_FAILED, or the plain plan with allow_plain
  const best = tries.slice().sort((a, b) => a.score - b.score || b.attempt - a.attempt)[0] || null;
  let content;
  let plain = false;
  let notes = [];
  if (!best || !best.read.ok || best.share > MAX_REPLACED_SHARE + 1e-9) {
    const why = !best || !best.read.ok ? (records.some((record) => record.finish === 'empty') && !tries.some((entry) => entry.read.ok) ? 'empty answers' : 'no JSON object in the schema') : `${best.read.replaced} of ${best.read.picks} picks had to be replaced by the code`;
    if (options.allowPlain !== true) throw modelFailedError({ records, costs, model, why });
    log(`The language model delivered no usable plan (${why}): a plan by the score alone is made (allowed by "Allow a plain plan").`);
    content = plainPlan(ctx);
    plain = true;
    notes.push(`the language model delivered no usable plan (${why})`);
  } else {
    content = best.read.content;
    notes = best.read.notes.slice();
    if (best.read.problems.length) {
      log(`${best.read.problems.length} problem${best.read.problems.length === 1 ? '' : 's'} left after the last try: the code repaired them (${best.read.problems.slice(0, 2).join('; ').slice(0, 200)})`);
      notes.push(...best.read.problems.map((problem) => `repaired: ${problem}`));
    }
  }

  const made = toShots(content, ctx);
  notes.push(...made.notes);
  const graphics = toGraphics(content, made, ctx);
  const promptChars = system.length + userPrompt({ brief, style, grid, material }).length;
  const cost = estimate(
    {
      items: material.videos.length + material.photos.length,
      speechSeconds: material.videos.reduce((sum, video) => sum + (video.info && video.info.meta && video.info.meta.has_audio ? video.info.meta.seconds : 0), 0),
      musicSeconds: input.ownMusic ? 0 : grid.musicSeconds,
      picks: grid.picks,
      promptChars,
      aiClips: content.aiPhotos.length,
      depthMaps: content.parallax.length,
      voiceChars: content.voiceover.reduce((sum, line) => sum + chars(line.text), 0)
    },
    prices
  );
  const leftOut = leftOutOf(material, made);
  const board = boardText({ content, made, graphics, grid, style, material, cost, model: records.length ? modelLine(records, model) : null, plain, notes, leftOut });
  const check = contract.checkPair(made.shots, graphics);
  if (!check.ok) throw new Error(`the plan does not pass the contract (${check.problems.slice(0, 3).join('; ')})`);
  return {
    grid,
    content,
    shots: made.shots,
    graphics,
    sources: made.sources,
    board,
    cost,
    costs,
    tries: records,
    model,
    plain,
    notes,
    aiPhotos: content.aiPhotos.map((item) => item.photo),
    aiPrompts: content.aiPhotos.map((item) => item.prompt),
    parallaxPhotos: content.parallax.map((item) => item.photo),
    voLines: content.voiceover.map((line) => line.text)
  };
}

module.exports = {
  MIN_SCENE_SECONDS,
  CLIP_SECONDS,
  PHOTO_LONG,
  PHOTO_MAX,
  SOUNDBITE_ACTS,
  CLIPS_BY_LENGTH,
  MAX_MATERIAL_CHARS,
  PLAN_MAX_TOKENS,
  PLAN_REASONING_EFFORT,
  RETRY_REASONING_EFFORT,
  MAX_ATTEMPTS,
  EMPTY_RETRIES,
  EMPTY_PAUSE_MS,
  MAX_REPLACED_SHARE,
  PLAN_TEXT_TOKENS,
  PLAN_THINKING_TOKENS,
  TYPICAL_MATERIAL,
  GENERIC_ENDCARD,
  DETAIL_ZOOM,
  readMaterial,
  baseScore,
  unitFault,
  planGrid,
  answerLimits,
  systemPrompt,
  userPrompt,
  answerSchema,
  materialText,
  unknownFacts,
  hashDistance,
  sameSubject,
  subjectWords,
  sourcesOf,
  cutText,
  snapWords,
  parseAnswer,
  salvageAnswer,
  readAnswer,
  validateAnswer,
  plainPlan,
  toShots,
  toGraphics,
  accentOf,
  llmTokens,
  typicalPromptChars,
  estimate,
  boardText,
  modelLine,
  checkInputs,
  runEventPlanner
};
