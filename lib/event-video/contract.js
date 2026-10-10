'use strict';

// The contract of the event video (WP53): the constants and the JSON shapes that the nodes event_video.* hand on to each other, and a check of
// the shape of each. Pure: no files, no network, no other module. The analysis (event_video.analyze), the planner (event_video.style, .music,
// .plan) and the cut and render (event_video.cut, .render) are built at the same time from this file; none of them changes it on its own.
//
//   info       v1  one clip or photo as event_video.analyze sees it                         checkInfo(info)
//   style      v1  the combined style of event_video.style (event type x mood, no format)   checkStyle(style)
//   answer     v1  the JSON the language model returns to event_video.plan                  checkAnswer(answer)
//   shots      v1  the plan for event_video.cut (independent of the format)                 checkShots(shots)
//   graphics   v1  the plan for event_video.render (independent of the format)              checkGraphics(graphics), checkPair(shots, graphics)
//
// Every check returns { ok, problems } and never throws: `problems` are short English sentences that name the place ("shots[3].anchor.x is
// 1.2, outside 0..1"); they can go to the log, to the board or back to the model. The checks look at the shape only: types, required fields,
// allowed values, ranges, the order of times, the lengths of texts. They do not look at the content (does a ref exist in the material, is a
// name in the brief, is a word range a sentence, does an act have the number of picks of the grid): that is the work of plan.js. checkAnswer
// names everything that can be seen without the material, the brief and the grid (also a scene picked twice, an act that is missing, a photo
// both in ai_photos and in parallax); plan.js decides which of these it repairs (spec §4: it replaces, fills up, cuts) and which it tells the
// model in the second try. Fields that are not named here are ignored, so a later field does not break an older reader.
//
// The shapes are those of the specification of WP53 ("spec" below; the shapes are in its §4, the style tables in §5). Where it leaves something
// open, this file decides (D1 to D18), and the three packages follow it:
//   D1  Indices start at 0. "v3#2" is scene 2 (info.scenes[2], whose `i` is 2) of videos[3], "p7" is photos[7], "v5" (a soundbite) is
//       videos[5]; the lists are the inputs `videos` and `photos` of the planner in their order (the order of `video_info` and `photo_info`).
//       shots[].source is the same index; shots[].clip is the index in `ai_clips` (in the order of answer.ai_photos) or in `parallax_clips`
//       (in the order of answer.parallax). Every clip of the two lists is used by exactly one shot (indices 0..n-1, each once).
//   D2  Times are seconds, rounded to milliseconds; checks allow 1 ms (EPS). Film times start at 0. The shots follow each other without a gap,
//       the first starts at 0, the last ends at `duration`. `duration` is the length of the film (LENGTHS, or shorter when the own music is
//       shorter: DURATION_RANGE). graphics.endFrame = round(duration * fps).
//   D3  The end card lies on the last `endcard.seconds` of the film, over the footage of the act close; it is not added after the film (the
//       HUD adds it, the event video does not). For lib/music-video-hud/chunks.js planChunks the render passes cuts as [{ start }] and an
//       endcardSeconds of 0.
//   D4  Required on every shot: id, act, start, end, kind, transition. `anchor` is required on every kind but photo_parallax (optional there,
//       default the centre). Optional: `exposure` (default 0, -0.08..0.08), `hdr` on video and soundbite (default false: the source is HLG/PQ
//       and the cut tone-maps it, or uses the fallback look), anchor.drift (default [0, 0]).
//   D5  shots[].transition is the transition INTO that shot: cut, dissolve (the cut's crossfade, the next shot fades in at its own start) or
//       match (a hard cut between a pair of the same subject). The first shot has cut. dip and flash are not shot transitions: they are layers
//       of the page, graphics.transitions at a cut (the shot there has cut). whip becomes cut and strobe becomes flash before the plan is
//       written; only the style may still name them.
//   D6  Positions (anchor, faces) are fractions 0..1 of the picture as it is shown (rotation applied), from the top left. drift [dx, dy] is
//       the move of the anchor over the whole shot, in fractions of the width and the height of the source, at most 0.05 each way.
//   D7  info.meta.width/height are the size as shown (rotation applied; `rotation` says what was applied). A photo has seconds 0, fps 0,
//       has_audio false, exactly one scene with in = out = 0 and speech null.
//   D8  A scene without a face has faces { count: 0, x: null, y: null, size: null }.
//   D9  An element that cannot be used (usable false) has a `reason`, scenes [], speech null and vision null; meta is null or what could be read.
//       A usable one has reason null.
//   D10 speech is null when there is no speech (or speech is off). Word times are seconds of the source. `language` is the code of
//       ISO 639-1 where it is known ("de"), else the code Scribe gives (2 or 3 lower-case letters), or null.
//   D11 The answer of the model: the lists soundbites, lower_thirds, intertitles, ai_photos, parallax and voiceover may be missing (= empty);
//       slow (false), pair, speaker, role, sub, url and why may be missing (null). `pair` on a pick is the ref of a second scene with the same
//       subject, the close one: the code puts it right after the pick with a match cut, and it is not a pick of its own. A pick has a scene
//       ref or a photo ref, a soundbite a video ref.
//   D12 graphics.acts [{ act, start, end }]: the six acts with their film times (the render needs them for the glow, which shows in hook, peak
//       and close only). graphics.look adds `grain` and `contrast` (the style values 0..1: noise and vignette of the final pass). look.glow is
//       the opacity of the light spot (0.22 * glow above a glow of 0.5, else 0), look.tint = (warmth - 0.5) * 0.3. look.ease is the ease of
//       the lower thirds, intertitles and the end card; the title uses the ease of its animation (TITLE_ANIMS).
//   D13 graphics.soundbites[].words: the subtitle in the spoken language, word times relative to the start of the soundbite. A soundbite shot
//       and the graphics soundbite at the same index have the same start and end (checkPair). A lower third lies inside a soundbite.
//   D14 graphics.voiceover[].index is the index in the list `voice` of the render (the order of vo_lines). graphics.cuts are the starts of the
//       shots (checkPair).
//   D15 Texts are counted in characters (code points). A text on the screen (title, lower thirds, intertitles, end card) must not name the tool
//       or its maker (FORBIDDEN_TEXT); the words of a soundbite are what was said and are not checked.
//   D16 style v1 (spec §5 has no JSON): { version, event_type, event_alias, mood, length, language, values { tempo, density, warmth, contrast,
//       saturation, grain, glow, formality, slowmo }, transitions { name: weight }, genre, type { title, body }, title_anim, energy { act: 0..1 },
//       soundbites { count: [min, max], seconds: [min, max] }, nat_level }. The values are already combined and clamped (festival: party with
//       its shift); transitions are the weights after the rule that cut is at least half of their sum; soundbites are for the chosen length.
//       The style has no format (a change of the format must not change the key of the plan). A font is "Family:weight" or "Family:weight:italic".
//   D17 shots[].fit (optional on every kind, default crop): how a picture whose shape differs from the format fills the frame. crop cuts the
//       format out around the anchor (with drift); blur shows the whole picture, scaled to the height (or width) of the frame, over a blurred,
//       darkened copy of itself that fills the frame (an upright photo in 16:9, a wide one in 9:16). The cut chooses it per shot when the plan
//       gives none: blur where a crop would keep less than about 45 % of the picture's area and the anchor has no face to hold, else crop.
//       Photo-only events are valid (no video, no soundbite): every rule that counts videos treats an empty list as zero.
//   D18 (added in the integration, WP53 package D) shots[].anchor.face (optional boolean): a face holds the anchor (the planner sets it from the
//       faces of the analysis; the cut keeps such a shot a crop, D17). Missing: no face known, but a soundbite counts as one (its speaker).
//       shots[].zoom (optional on video and photo, ZOOM_RANGE, default 1): the zoom the shot starts with, for a detail of a picture that is shown
//       a second time (the planner sets it there): the crop window is 1/zoom of its size around the anchor, a photo's move starts from it.

/* ---------- the axes of the app (spec §3, §5) ---------- */

const EVENT_TYPES = Object.freeze(['corporate', 'conference', 'workshop', 'launch', 'party', 'celebration']);
// an alias is read as its type with a shift of some values (spec §3: festival is party, a little warmer and with more grain)
const EVENT_TYPE_ALIASES = Object.freeze({ festival: 'party' });
const ALIAS_SHIFTS = Object.freeze({ festival: Object.freeze({ warmth: 0.1, grain: 0.1 }) });
const MOODS = Object.freeze(['fresh', 'calm', 'fast', 'emotional', 'epic', 'elegant']);
const LENGTHS = Object.freeze([30, 60, 90]);
const FORMATS = Object.freeze(['16:9', '9:16', '1:1']);
// the size of the film and the format of the render nodes (tools.js render_motion_graphics)
const FORMAT_SIZES = Object.freeze({
  '16:9': Object.freeze({ width: 1920, height: 1080, renderFormat: 'landscape' }),
  '9:16': Object.freeze({ width: 1080, height: 1920, renderFormat: 'portrait' }),
  '1:1': Object.freeze({ width: 1080, height: 1080, renderFormat: 'square' })
});
const LANGUAGES = Object.freeze(['de', 'en', 'es']);
const DEFAULTS = Object.freeze({ event_type: 'conference', mood: 'fresh', length: 60, format: '16:9', language: 'de' });

// The acts of the film and their share of its length (spec §5c; the boundaries snap to the nearest downbeat)
const ACTS = Object.freeze(['hook', 'arrival', 'programme', 'people', 'peak', 'close']);
const ACT_SHARES = Object.freeze({ hook: 0.1, arrival: 0.15, programme: 0.25, people: 0.2, peak: 0.2, close: 0.1 });
// the acts a voice-over may speak in
const VOICEOVER_ACTS = Object.freeze(['arrival', 'close']);

const FPS = 24;
const INFO_VERSION = 1;
const STYLE_VERSION = 1;
const SHOTS_VERSION = 1;
const GRAPHICS_VERSION = 1;
// the shortest film: own music of at least 20 s (EVENTMUSIC_TOO_SHORT), the film 2 s shorter than the music
const DURATION_RANGE = Object.freeze([18, 90]);
// the end card covers the last seconds of the film, the title stands from TITLE_FROM on (spec §5c)
const ENDCARD_SECONDS = 3;
const TITLE_FROM = 1.5;

/* ---------- the limits of a run (spec §1) ---------- */

const LIMITS = Object.freeze({
  listItems: 50, // per list of media (MAX_MEDIA_LIST, lib/nodes/nodes-basic.js)
  fileBytes: 500 * 1024 * 1024, // per file (MAX_UPLOAD_BYTES, lib/nodes/routes.js)
  videoSeconds: 30 * 60, // all footage of a run together; more is EVENTPLAN_TOO_MUCH_MATERIAL
  minUsable: 5 // usable clips and photos together; fewer is EVENTPLAN_NO_MATERIAL
});

/* ---------- the codes of the errors (spec §3) ---------- */

const ERRORS = Object.freeze({
  EVENTSTYLE_BAD_VALUE: 'EVENTSTYLE_BAD_VALUE',
  EVENTMEDIA_VISION_FAILED: 'EVENTMEDIA_VISION_FAILED',
  EVENTMEDIA_SPEECH_FAILED: 'EVENTMEDIA_SPEECH_FAILED',
  EVENTMUSIC_TOO_SHORT: 'EVENTMUSIC_TOO_SHORT',
  EVENTMUSIC_FAILED: 'EVENTMUSIC_FAILED',
  EVENTPLAN_BRIEF_EMPTY: 'EVENTPLAN_BRIEF_EMPTY',
  EVENTPLAN_NO_MATERIAL: 'EVENTPLAN_NO_MATERIAL',
  EVENTPLAN_TOO_MUCH_MATERIAL: 'EVENTPLAN_TOO_MUCH_MATERIAL',
  EVENTPLAN_NO_LLM: 'EVENTPLAN_NO_LLM',
  EVENTPLAN_MODEL_FAILED: 'EVENTPLAN_MODEL_FAILED',
  EVENTCUT_SOURCE_MISSING: 'EVENTCUT_SOURCE_MISSING',
  EVENTCUT_FAILED: 'EVENTCUT_FAILED',
  EVENTRENDER_NO_NODE: 'EVENTRENDER_NO_NODE',
  EVENTRENDER_CHUNK_FAILED: 'EVENTRENDER_CHUNK_FAILED',
  EVENTRENDER_VERIFY_FAILED: 'EVENTRENDER_VERIFY_FAILED',
  // the graphics of the render are not JSON or not of the shape graphics v1 (D18)
  EVENTRENDER_GRAPHICS_INVALID: 'EVENTRENDER_GRAPHICS_INVALID'
});

/* ---------- info v1: the analysis of one element (spec §4) ---------- */

const MEDIA_KINDS = Object.freeze(['video', 'photo']);
// why an element cannot be used; these are cached and never thrown
const UNUSABLE_REASONS = Object.freeze(['unsupported_format', 'decode_failed', 'no_video_stream', 'too_long', 'heic']);
const ROTATIONS = Object.freeze([0, 90, 180, 270]);
const SCENE_REASONS = Object.freeze(['ok', 'blurry', 'dark', 'shaky']);
const CAMERA_MOTIONS = Object.freeze(['static', 'pan_left', 'pan_right', 'handheld', 'fast']);
const PEOPLE = Object.freeze(['0', '1', '2-5', 'crowd']);
const EMOTIONS = Object.freeze(['laughing', 'listening', 'focused', 'cheering', 'neutral']);
const ACTIONS = Object.freeze(['applause', 'speech', 'dancing', 'toast', 'handshake', 'walking', 'detail', 'other']);
const FRAMINGS = Object.freeze(['wide', 'medium', 'close', 'detail']);
const RISKS = Object.freeze(['child', 'badge_readable', 'screen_readable', 'eating', 'unflattering', 'alcohol_close']);
// never picked (spec §4, validation); the others are soft and lower the score
const HARD_RISKS = Object.freeze(['child', 'unflattering']);
const FITS = Object.freeze(['opener', 'b_roll', 'speaker', 'crowd', 'detail', 'closer']);
const MAX_SCENES = 400;
const MAX_WORDS = 20000;
const MAX_TEXT_IN_IMAGE = 20;

/* ---------- style v1 (D16) ---------- */

const STYLE_VALUES = Object.freeze(['tempo', 'density', 'warmth', 'contrast', 'saturation', 'grain', 'glow', 'formality', 'slowmo']);
// the transitions the tables of spec §5 name; shots and graphics know fewer (D5)
const STYLE_TRANSITIONS = Object.freeze(['cut', 'dip', 'match', 'dissolve', 'whip', 'flash', 'strobe']);
const FONT_FAMILIES = Object.freeze(['Montserrat', 'Inter Tight', 'DM Sans', 'Space Grotesk', 'Anton', 'Playfair Display']);
// The animations of the title (spec §5b, one per mood); the title uses the ease of its animation (D12)
const TITLE_ANIMS = Object.freeze({
  words_up: Object.freeze({ ease: 'back.out(1.4)', stagger: 0.06 }),
  fade_rise: Object.freeze({ ease: 'power2.out', rise: 20 }),
  char_slam: Object.freeze({ ease: 'expo.out', stagger: 0.02 }),
  tracking: Object.freeze({ ease: 'sine.out', trackingEm: 0.1 }),
  scale_blur: Object.freeze({ ease: 'power4.out', scale: 1.15, blur: 12 }),
  line_draw: Object.freeze({ ease: 'power2.inOut' })
});
// look.ease (spec §5c): power3.out from a formality of 0.5, else back.out(1.4)
const LOOK_EASES = Object.freeze(['power3.out', 'back.out(1.4)']);
const MAX_SOUNDBITES = 6;

/* ---------- answer v1: what the model returns (spec §4) ---------- */

const TEXT_LIMITS = Object.freeze({
  treatment: 400,
  why: 80,
  title: 28,
  sub: 40,
  name: 40,
  role: 40,
  label: 32,
  intertitle: 32,
  aiPrompt: 300,
  voiceover: 180,
  endcardLine: 40,
  endcardSub: 40,
  url: 60,
  genre: 300,
  subject: 160,
  textInImage: 120,
  word: 64
});
const TEXT_SOURCES = Object.freeze({
  soundbite: Object.freeze(['description', 'transcript']),
  title: Object.freeze(['description', 'generic']),
  lowerThird: Object.freeze(['description', 'transcript', 'vision', 'generic']),
  intertitle: Object.freeze(['description']),
  endcard: Object.freeze(['description', 'generic'])
});
// at most this many intertitles by the length of the film (spec §4); the check of the shape allows the largest
const INTERTITLES_BY_LENGTH = Object.freeze({ 30: 1, 60: 2, 90: 3 });
const MAX_INTERTITLES = 3;
const MAX_LOWER_THIRDS = 6;
const MAX_AI_PHOTOS = 6;
const MAX_PARALLAX = 6;
const MAX_VOICEOVER = 3;
const MAX_PICKS_PER_ACT = 40;
// refs of the material (D1)
const SCENE_REF = /^v(0|[1-9]\d*)#(0|[1-9]\d*)$/;
const PHOTO_REF = /^p(0|[1-9]\d*)$/;
const VIDEO_REF = /^v(0|[1-9]\d*)$/;

/* ---------- shots v1 and graphics v1 (spec §4) ---------- */

const SHOT_KINDS = Object.freeze(['video', 'photo', 'photo_ai', 'photo_parallax', 'soundbite']);
const SHOT_TRANSITIONS = Object.freeze(['cut', 'dissolve', 'match']);
// how a picture whose shape differs from the format fills it (D17): crop around the anchor, or the whole picture over a blurred copy of itself
const SHOT_FITS = Object.freeze(['crop', 'blur']);
const PAGE_TRANSITIONS = Object.freeze(['dip', 'flash']);
const PHOTO_MOTIONS = Object.freeze(['zoom_in', 'zoom_out', 'pan_left', 'pan_right']);
// 0.5 only from sources of 50 fps and more, else 0.75 (spec §5c); speed ramps come later
const SPEEDS = Object.freeze([0.5, 0.75, 1]);
const MAX_SHOTS = 300;
const MAX_EXPOSURE = 0.08;
const MAX_DRIFT = 0.05;
// the start zoom of a detail (D18): 1 is the whole window of the format, 2 half of its width and height
const ZOOM_RANGE = Object.freeze([1, 2]);
// the zoom rate of a photo is 0.04 + 0.08 * tempo per second; the cut caps the whole move at +25 %
const MAX_PHOTO_RATE = 0.25;
// a soundbite: seconds and share of the film (spec §4 says 3 to 12 s; the table of party allows 2 s, so the shape allows it)
const SOUNDBITE_SECONDS = Object.freeze([2, 12]);
const SOUNDBITE_MAX_SHARE = 0.15;
const PAGE_TRANSITION_FRAMES = Object.freeze([1, 24]);
const TINT_RANGE = Object.freeze([-0.15, 0.15]);
const GLOW_RANGE = Object.freeze([0, 0.22]);
const TITLE_SECONDS_RANGE = Object.freeze([0.5, 1.5]);
const ENDCARD_SECONDS_RANGE = Object.freeze([1, 10]);
const MIX_RANGES = Object.freeze({ duck_db: Object.freeze([-30, 0]), ramp: Object.freeze([0.05, 2]), nat_level: Object.freeze([0, 1]), lufs: Object.freeze([-30, -8]) });
// what never stands on the screen (spec §4: the name of the maker of the tool removes a text)
const FORBIDDEN_TEXT = /kuble/i;

// one millisecond: times are rounded to it (D2)
const EPS = 0.001;
// a report names at most this many problems
const MAX_PROBLEMS = 100;

/* ---------- small helpers ---------- */

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const chars = (text) => [...text].length;
const typeName = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
const show = (value) => {
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (finite(value)) return String(Math.round(value * 1e6) / 1e6);
  return typeName(value);
};

// A collector of problems with the checks of the single values. Each check returns true when the value is fine, so that the caller can go on
// to look inside it.
function newReport() {
  const problems = [];
  let dropped = 0;
  const add = (at, message) => {
    if (problems.length < MAX_PROBLEMS) problems.push(`${at} ${message}`);
    else dropped += 1;
  };
  const present = (at, value, { optional = false, nullable = false } = {}) => {
    if (value === undefined) {
      if (!optional) add(at, 'is missing');
      return false;
    }
    if (value === null) {
      if (!nullable) add(at, 'is null');
      return false;
    }
    return true;
  };
  const r = {
    add,
    // an object; `optional`: may be missing, `nullable`: may be null
    object(at, value, options) {
      if (!present(at, value, options)) return false;
      if (!isObject(value)) return add(at, `must be an object, got ${typeName(value)}`), false;
      return true;
    },
    array(at, value, { min = 0, max = Infinity, ...options } = {}) {
      if (!present(at, value, options)) return false;
      if (!Array.isArray(value)) return add(at, `must be a list, got ${typeName(value)}`), false;
      if (value.length < min) return add(at, `has ${value.length} entries, at least ${min}`), false;
      if (value.length > max) return add(at, `has ${value.length} entries, at most ${max}`), false;
      return true;
    },
    number(at, value, { min = -Infinity, max = Infinity, above, integer = false, ...options } = {}) {
      if (!present(at, value, options)) return false;
      if (!finite(value)) return add(at, `must be a number, got ${typeName(value)}`), false;
      if (integer && !Number.isInteger(value)) return add(at, `is ${show(value)}, must be a whole number`), false;
      if (above !== undefined && !(value > above)) return add(at, `is ${show(value)}, must be above ${above}`), false;
      if (value < min || value > max) {
        if (max === Infinity) return add(at, `is ${show(value)}, must be at least ${min}`), false;
        if (min === -Infinity) return add(at, `is ${show(value)}, must be at most ${max}`), false;
        return add(at, `is ${show(value)}, outside ${min}..${max}`), false;
      }
      return true;
    },
    boolean(at, value, options) {
      if (!present(at, value, options)) return false;
      if (typeof value !== 'boolean') return add(at, `must be true or false, got ${typeName(value)}`), false;
      return true;
    },
    // a text: not empty (after trimming), at most `max` characters, optionally one of `pattern`
    text(at, value, { max = Infinity, pattern, ...options } = {}) {
      if (!present(at, value, options)) return false;
      if (typeof value !== 'string') return add(at, `must be a text, got ${typeName(value)}`), false;
      if (!value.trim()) return add(at, 'is empty'), false;
      if (chars(value) > max) return add(at, `has ${chars(value)} characters, at most ${max}`), false;
      if (pattern && !pattern.test(value)) return add(at, `${show(value)} has not the form ${pattern}`), false;
      return true;
    },
    oneOf(at, value, list, options) {
      if (!present(at, value, options)) return false;
      if (!list.includes(value)) return add(at, `${show(value)} is not one of ${list.join(', ')}`), false;
      return true;
    },
    version(at, value, expected) {
      if (!present(at, value)) return false;
      if (value !== expected) return add(at, `is ${show(value)}, expected ${expected}`), false;
      return true;
    },
    result() {
      const list = dropped ? [...problems, `... and ${dropped} more problems`] : problems.slice();
      return { ok: list.length === 0, problems: list };
    }
  };
  return r;
}

// Runs a check and turns an unexpected error into a problem: a check never throws.
function run(check, value, ...more) {
  const r = newReport();
  try {
    check(r, value, ...more);
  } catch (err) {
    r.add('the check', `failed: ${err && err.message ? err.message : String(err)}`);
  }
  return r.result();
}

// What a ref of the material names (D1): { kind: 'scene', video, scene } for "v3#2", { kind: 'photo', photo } for "p7", { kind: 'video', video }
// for "v5", null for anything else.
function parseRef(ref) {
  if (typeof ref !== 'string') return null;
  let match = SCENE_REF.exec(ref);
  if (match) return { kind: 'scene', video: Number(match[1]), scene: Number(match[2]) };
  match = PHOTO_REF.exec(ref);
  if (match) return { kind: 'photo', photo: Number(match[1]) };
  match = VIDEO_REF.exec(ref);
  if (match) return { kind: 'video', video: Number(match[1]) };
  return null;
}

// "Montserrat:700", "Playfair Display:600:italic" -> { family, weight, italic } or null
function parseFont(spec) {
  const match = /^([A-Za-z][A-Za-z ]*[A-Za-z]):([1-9]00)(:italic)?$/.exec(typeof spec === 'string' ? spec : '');
  if (!match || !FONT_FAMILIES.includes(match[1])) return null;
  return { family: match[1], weight: Number(match[2]), italic: Boolean(match[3]) };
}

// A list of times that must rise; `strict`: no two equal
function checkRising(r, at, times, strict) {
  for (let index = 1; index < times.length; index += 1) {
    if (!finite(times[index]) || !finite(times[index - 1])) continue;
    if (strict ? times[index] <= times[index - 1] : times[index] < times[index - 1] - EPS) {
      r.add(`${at}[${index}]`, `is ${show(times[index])}, ${strict ? 'not after' : 'before'} the one before (${show(times[index - 1])})`);
    }
  }
}

// { start, end } inside 0..duration with start < end
function checkSpan(r, at, item, duration) {
  const okStart = r.number(`${at}.start`, item.start, { min: 0 });
  const okEnd = r.number(`${at}.end`, item.end, { min: 0 });
  if (!okStart || !okEnd) return false;
  if (!(item.end > item.start)) return r.add(`${at}.end`, `is ${show(item.end)}, not after the start (${show(item.start)})`), false;
  if (finite(duration) && item.end > duration + EPS) return r.add(`${at}.end`, `is ${show(item.end)}, after the end of the film (${show(duration)})`), false;
  return true;
}

// A text that will stand on the screen (D15)
function screenText(r, at, value, options) {
  if (!r.text(at, value, options)) return false;
  if (FORBIDDEN_TEXT.test(value)) return r.add(at, 'names the tool or its maker, which never stands on the screen'), false;
  return true;
}

/* ---------- info v1 ---------- */

function checkInfoInto(r, info) {
  if (!r.object('info', info)) return;
  r.version('version', info.version, INFO_VERSION);
  r.text('id', info.id);
  const kindOk = r.oneOf('kind', info.kind, MEDIA_KINDS);
  if (!r.boolean('usable', info.usable)) return;
  const photo = kindOk && info.kind === 'photo';

  if (!info.usable) {
    // D9: the reason, and nothing that a reader could take for an analysis
    r.oneOf('reason', info.reason, UNUSABLE_REASONS);
    if (info.meta !== undefined && info.meta !== null) r.object('meta', info.meta);
    if (r.array('scenes', info.scenes, { optional: true }) && info.scenes.length) r.add('scenes', 'must be empty for an element that cannot be used');
    if (info.speech !== undefined && info.speech !== null) r.add('speech', 'must be null for an element that cannot be used');
    if (info.vision !== undefined && info.vision !== null) r.add('vision', 'must be null for an element that cannot be used');
    return;
  }
  if (info.reason === undefined) r.add('reason', 'is missing (null for a usable element)');
  else if (info.reason !== null) r.add('reason', `is ${show(info.reason)}, must be null for a usable element`);

  // meta (D7)
  let seconds = null;
  if (r.object('meta', info.meta)) {
    const meta = info.meta;
    if (r.number('meta.seconds', meta.seconds, { min: 0 })) seconds = meta.seconds;
    r.number('meta.width', meta.width, { integer: true, min: 1 });
    r.number('meta.height', meta.height, { integer: true, min: 1 });
    r.number('meta.fps', meta.fps, { min: 0, max: 1000 });
    r.oneOf('meta.rotation', meta.rotation, ROTATIONS);
    r.boolean('meta.hdr', meta.hdr);
    r.boolean('meta.has_audio', meta.has_audio);
    if (r.text('meta.taken_at', meta.taken_at, { nullable: true }) && Number.isNaN(Date.parse(meta.taken_at))) {
      r.add('meta.taken_at', `${show(meta.taken_at)} is not a date and time (ISO 8601)`);
    }
    if (photo) {
      if (meta.seconds !== 0) r.add('meta.seconds', `is ${show(meta.seconds)}, a photo has 0`);
      if (meta.fps !== 0) r.add('meta.fps', `is ${show(meta.fps)}, a photo has 0`);
      if (meta.has_audio !== false) r.add('meta.has_audio', 'must be false for a photo');
    } else {
      if (finite(meta.seconds) && !(meta.seconds > 0)) r.add('meta.seconds', 'must be above 0 for a video');
      if (finite(meta.fps) && !(meta.fps > 0)) r.add('meta.fps', 'must be above 0 for a video');
    }
  }

  // scenes
  if (r.array('scenes', info.scenes, { min: 1, max: photo ? 1 : MAX_SCENES })) {
    info.scenes.forEach((scene, index) => checkScene(r, `scenes[${index}]`, scene, index, { photo, seconds }));
    // the scenes follow each other and do not overlap (a gap is allowed)
    info.scenes.forEach((scene, index) => {
      const previous = info.scenes[index - 1];
      if (index > 0 && isObject(scene) && isObject(previous) && finite(scene.in) && finite(previous.out) && scene.in < previous.out - EPS) {
        r.add(`scenes[${index}].in`, `is ${show(scene.in)}, before the end of the scene before (${show(previous.out)})`);
      }
    });
  }

  // speech (D10)
  if (photo) {
    if (info.speech !== null) r.add('speech', 'must be null for a photo');
  } else if (r.object('speech', info.speech, { nullable: true })) {
    const speech = info.speech;
    r.text('speech.language', speech.language, { nullable: true, pattern: /^[a-z]{2,3}$/ });
    if (r.array('speech.words', speech.words, { min: 1, max: MAX_WORDS })) {
      speech.words.forEach((word, index) => checkWord(r, `speech.words[${index}]`, word, seconds));
      checkRising(r, 'speech.words[].s', speech.words.map((word) => (isObject(word) ? word.s : null)), false);
    }
  }

  // vision
  if (r.object('vision', info.vision)) {
    const vision = info.vision;
    r.text('vision.subject', vision.subject, { max: TEXT_LIMITS.subject });
    r.oneOf('vision.people', vision.people, PEOPLE);
    r.boolean('vision.faces_visible', vision.faces_visible);
    r.oneOf('vision.emotion', vision.emotion, EMOTIONS);
    r.oneOf('vision.action', vision.action, ACTIONS);
    r.oneOf('vision.framing', vision.framing, FRAMINGS);
    r.boolean('vision.stage', vision.stage);
    if (r.array('vision.text_in_image', vision.text_in_image, { max: MAX_TEXT_IN_IMAGE })) {
      vision.text_in_image.forEach((text, index) => r.text(`vision.text_in_image[${index}]`, text, { max: TEXT_LIMITS.textInImage }));
    }
    checkTags(r, 'vision.risk', vision.risk, RISKS);
    checkTags(r, 'vision.fit', vision.fit, FITS);
    r.number('vision.score', vision.score, { integer: true, min: 1, max: 5 });
  }
}

function checkScene(r, at, scene, index, { photo, seconds }) {
  if (!r.object(at, scene)) return;
  if (r.number(`${at}.i`, scene.i, { integer: true, min: 0 }) && scene.i !== index) r.add(`${at}.i`, `is ${scene.i}, must be its place in the list (${index})`);
  const okIn = r.number(`${at}.in`, scene.in, { min: 0 });
  const okOut = r.number(`${at}.out`, scene.out, { min: 0 });
  if (okIn && okOut) {
    if (photo) {
      if (scene.in !== 0 || scene.out !== 0) r.add(at, 'of a photo has in = out = 0');
    } else {
      if (!(scene.out > scene.in)) r.add(`${at}.out`, `is ${show(scene.out)}, not after the in point (${show(scene.in)})`);
      if (finite(seconds) && scene.out > seconds + EPS) r.add(`${at}.out`, `is ${show(scene.out)}, after the end of the clip (${show(seconds)})`);
    }
  }
  r.text(`${at}.hash`, scene.hash, { optional: true, pattern: /^[0-9a-f]{16}$/ });
  r.number(`${at}.quality`, scene.quality, { integer: true, min: 1, max: 5 });
  if (checkTags(r, `${at}.reasons`, scene.reasons, SCENE_REASONS, { min: 1 }) && scene.reasons.includes('ok') && scene.reasons.length > 1) {
    r.add(`${at}.reasons`, 'has "ok" next to a fault');
  }
  r.number(`${at}.luma`, scene.luma, { min: 0, max: 1 });
  r.number(`${at}.sharp`, scene.sharp, { min: 0, max: 1 });
  r.number(`${at}.shake`, scene.shake, { min: 0, max: 1 });
  r.oneOf(`${at}.motion`, scene.motion, CAMERA_MOTIONS);
  if (r.object(`${at}.faces`, scene.faces)) {
    const faces = scene.faces;
    if (r.number(`${at}.faces.count`, faces.count, { integer: true, min: 0 })) {
      // D8: the place of the faces only when there are any
      for (const key of ['x', 'y', 'size']) {
        if (faces.count === 0 && faces[key] !== null) r.add(`${at}.faces.${key}`, 'must be null when there is no face');
        else if (faces.count > 0) r.number(`${at}.faces.${key}`, faces[key], { min: 0, max: 1 });
      }
    }
  }
}

function checkWord(r, at, word, seconds) {
  if (!r.object(at, word)) return;
  r.text(`${at}.w`, word.w, { max: TEXT_LIMITS.word });
  const okS = r.number(`${at}.s`, word.s, { min: 0 });
  const okE = r.number(`${at}.e`, word.e, { min: 0 });
  if (okS && okE) {
    if (word.e < word.s) r.add(`${at}.e`, `is ${show(word.e)}, before the start of the word (${show(word.s)})`);
    if (finite(seconds) && word.e > seconds + EPS) r.add(`${at}.e`, `is ${show(word.e)}, after the end (${show(seconds)})`);
  }
}

// A list of tags from `allowed`, each once
function checkTags(r, at, list, allowed, { min = 0 } = {}) {
  if (!r.array(at, list, { min, max: allowed.length })) return false;
  let ok = true;
  list.forEach((tag, index) => {
    if (!r.oneOf(`${at}[${index}]`, tag, allowed)) ok = false;
    else if (list.indexOf(tag) !== index) {
      r.add(`${at}[${index}]`, `${show(tag)} is there twice`);
      ok = false;
    }
  });
  return ok;
}

/* ---------- style v1 (D16) ---------- */

function checkStyleInto(r, style) {
  if (!r.object('style', style)) return;
  r.version('version', style.version, STYLE_VERSION);
  const typeOk = r.oneOf('event_type', style.event_type, EVENT_TYPES);
  if (r.text('event_alias', style.event_alias, { nullable: true })) {
    if (!Object.prototype.hasOwnProperty.call(EVENT_TYPE_ALIASES, style.event_alias)) {
      r.add('event_alias', `${show(style.event_alias)} is not one of ${Object.keys(EVENT_TYPE_ALIASES).join(', ')}`);
    } else if (typeOk && EVENT_TYPE_ALIASES[style.event_alias] !== style.event_type) {
      r.add('event_alias', `${show(style.event_alias)} is read as ${EVENT_TYPE_ALIASES[style.event_alias]}, not ${style.event_type}`);
    }
  }
  r.oneOf('mood', style.mood, MOODS);
  r.oneOf('length', style.length, LENGTHS);
  r.oneOf('language', style.language, LANGUAGES);
  if (style.format !== undefined) r.add('format', 'must not be part of the style (a new format must not change the plan)');
  if (r.object('values', style.values)) {
    for (const key of STYLE_VALUES) r.number(`values.${key}`, style.values[key], { min: 0, max: 1 });
  }
  if (r.object('transitions', style.transitions)) {
    const entries = Object.entries(style.transitions);
    let sum = 0;
    for (const [name, weight] of entries) {
      r.oneOf(`transitions.${name}`, name, STYLE_TRANSITIONS);
      if (r.number(`transitions.${name}`, weight, { above: 0 })) sum += weight;
    }
    if (!finite(style.transitions.cut)) r.add('transitions.cut', 'is missing (hard cuts are at least half)');
    else if (sum > 0 && style.transitions.cut < sum / 2 - 1e-9) r.add('transitions.cut', `is ${show(style.transitions.cut)} of ${show(sum)}, less than half`);
  }
  r.text('genre', style.genre, { max: TEXT_LIMITS.genre });
  if (r.object('type', style.type)) {
    for (const key of ['title', 'body']) {
      if (r.text(`type.${key}`, style.type[key]) && !parseFont(style.type[key])) {
        r.add(`type.${key}`, `${show(style.type[key])} is not "Family:weight" or "Family:weight:italic" with a family of ${FONT_FAMILIES.join(', ')}`);
      }
    }
  }
  r.oneOf('title_anim', style.title_anim, Object.keys(TITLE_ANIMS));
  if (r.object('energy', style.energy)) {
    for (const act of ACTS) r.number(`energy.${act}`, style.energy[act], { min: 0, max: 1 });
  }
  if (r.object('soundbites', style.soundbites)) {
    checkPairRange(r, 'soundbites.count', style.soundbites.count, { min: 0, max: MAX_SOUNDBITES, integer: true });
    checkPairRange(r, 'soundbites.seconds', style.soundbites.seconds, { min: 1, max: 15 });
  }
  r.number('nat_level', style.nat_level, { min: 0, max: 1 });
}

// [low, high] with low <= high
function checkPairRange(r, at, value, options) {
  if (!r.array(at, value, { min: 2, max: 2 })) return;
  const okLow = r.number(`${at}[0]`, value[0], options);
  const okHigh = r.number(`${at}[1]`, value[1], options);
  if (okLow && okHigh && value[0] > value[1]) r.add(at, `[${value[0]}, ${value[1]}] has the low end above the high end`);
}

/* ---------- answer v1 (D11) ---------- */

function checkAnswerInto(r, answer) {
  if (!r.object('answer', answer)) return;
  r.text('treatment', answer.treatment, { max: TEXT_LIMITS.treatment });

  // the acts with their picks
  if (r.array('acts', answer.acts, { min: 1, max: ACTS.length })) {
    const seen = new Set();
    const used = new Map();
    answer.acts.forEach((act, index) => {
      const at = `acts[${index}]`;
      if (!r.object(at, act)) return;
      if (r.oneOf(`${at}.act`, act.act, ACTS)) {
        if (seen.has(act.act)) r.add(`${at}.act`, `${show(act.act)} is there twice`);
        seen.add(act.act);
      }
      if (!r.array(`${at}.picks`, act.picks, { min: 1, max: MAX_PICKS_PER_ACT })) return;
      act.picks.forEach((pick, k) => {
        const where = `${at}.picks[${k}]`;
        if (!r.object(where, pick)) return;
        const refOk = r.text(`${where}.ref`, pick.ref) && materialRef(r, `${where}.ref`, pick.ref);
        r.text(`${where}.why`, pick.why, { optional: true, nullable: true, max: TEXT_LIMITS.why });
        r.boolean(`${where}.slow`, pick.slow, { optional: true });
        if (r.text(`${where}.pair`, pick.pair, { optional: true, nullable: true }) && materialRef(r, `${where}.pair`, pick.pair) && pick.pair === pick.ref) {
          r.add(`${where}.pair`, 'is the pick itself');
        }
        for (const ref of [refOk ? pick.ref : null, typeof pick.pair === 'string' ? pick.pair : null]) {
          if (!ref) continue;
          if (used.has(ref)) r.add(where, `uses ${show(ref)}, which ${used.get(ref)} uses already`);
          else used.set(ref, where);
        }
      });
    });
    for (const act of ACTS) if (!seen.has(act)) r.add('acts', `has no act ${act}`);
  }

  // soundbites by word index (inclusive)
  const soundbites = optionalList(r, 'soundbites', answer.soundbites, MAX_SOUNDBITES);
  soundbites.forEach((bite, index) => {
    const at = `soundbites[${index}]`;
    if (!r.object(at, bite)) return;
    if (r.text(`${at}.ref`, bite.ref) && !VIDEO_REF.test(bite.ref)) r.add(`${at}.ref`, `${show(bite.ref)} is not a video ("v<index>")`);
    const okFrom = r.number(`${at}.word_from`, bite.word_from, { integer: true, min: 0 });
    const okTo = r.number(`${at}.word_to`, bite.word_to, { integer: true, min: 0 });
    if (okFrom && okTo && bite.word_to < bite.word_from) r.add(`${at}.word_to`, `is ${bite.word_to}, before word_from (${bite.word_from})`);
    r.text(`${at}.speaker`, bite.speaker, { optional: true, nullable: true, max: TEXT_LIMITS.name });
    r.text(`${at}.role`, bite.role, { optional: true, nullable: true, max: TEXT_LIMITS.role });
    r.oneOf(`${at}.source`, bite.source, TEXT_SOURCES.soundbite);
  });

  if (r.object('title', answer.title)) {
    screenText(r, 'title.text', answer.title.text, { max: TEXT_LIMITS.title });
    screenText(r, 'title.sub', answer.title.sub, { optional: true, nullable: true, max: TEXT_LIMITS.sub });
    r.oneOf('title.source', answer.title.source, TEXT_SOURCES.title);
  }

  optionalList(r, 'lower_thirds', answer.lower_thirds, MAX_LOWER_THIRDS).forEach((third, index) => {
    const at = `lower_thirds[${index}]`;
    if (!r.object(at, third)) return;
    if (r.number(`${at}.soundbite`, third.soundbite, { integer: true, min: 0 }) && third.soundbite >= soundbites.length) {
      r.add(`${at}.soundbite`, `is ${third.soundbite}, but there are ${soundbites.length} soundbites`);
    }
    lowerThirdTexts(r, at, third);
    r.oneOf(`${at}.source`, third.source, TEXT_SOURCES.lowerThird);
  });

  optionalList(r, 'intertitles', answer.intertitles, MAX_INTERTITLES).forEach((title, index) => {
    const at = `intertitles[${index}]`;
    if (!r.object(at, title)) return;
    r.oneOf(`${at}.act`, title.act, ACTS);
    screenText(r, `${at}.text`, title.text, { max: TEXT_LIMITS.intertitle });
    r.oneOf(`${at}.source`, title.source, TEXT_SOURCES.intertitle);
  });

  const aiRefs = new Set();
  optionalList(r, 'ai_photos', answer.ai_photos, MAX_AI_PHOTOS).forEach((item, index) => {
    const at = `ai_photos[${index}]`;
    if (!r.object(at, item)) return;
    if (r.text(`${at}.ref`, item.ref, { pattern: PHOTO_REF })) {
      if (aiRefs.has(item.ref)) r.add(`${at}.ref`, `${show(item.ref)} is there twice`);
      aiRefs.add(item.ref);
    }
    r.text(`${at}.prompt`, item.prompt, { max: TEXT_LIMITS.aiPrompt });
  });

  const parallax = optionalList(r, 'parallax', answer.parallax, MAX_PARALLAX);
  parallax.forEach((ref, index) => {
    const at = `parallax[${index}]`;
    if (!r.text(at, ref, { pattern: PHOTO_REF })) return;
    if (parallax.indexOf(ref) !== index) r.add(at, `${show(ref)} is there twice`);
    if (aiRefs.has(ref)) r.add(at, `${show(ref)} is animated by AI already`);
  });

  optionalList(r, 'voiceover', answer.voiceover, MAX_VOICEOVER).forEach((line, index) => {
    const at = `voiceover[${index}]`;
    if (!r.object(at, line)) return;
    r.oneOf(`${at}.act`, line.act, VOICEOVER_ACTS);
    r.text(`${at}.text`, line.text, { max: TEXT_LIMITS.voiceover });
  });

  if (r.object('endcard', answer.endcard)) {
    screenText(r, 'endcard.line', answer.endcard.line, { max: TEXT_LIMITS.endcardLine });
    screenText(r, 'endcard.sub', answer.endcard.sub, { optional: true, nullable: true, max: TEXT_LIMITS.endcardSub });
    screenText(r, 'endcard.url', answer.endcard.url, { optional: true, nullable: true, max: TEXT_LIMITS.url });
    r.oneOf('endcard.source', answer.endcard.source, TEXT_SOURCES.endcard);
  }
}

// A list of the answer that may be missing (D11): the list, or [] when it is missing or not a list (the latter is a problem)
function optionalList(r, at, value, max) {
  if (value === undefined || value === null) return [];
  return r.array(at, value, { max }) ? value : [];
}

// A pick names a scene of a video or a photo
function materialRef(r, at, ref) {
  const parsed = parseRef(ref);
  if (parsed && (parsed.kind === 'scene' || parsed.kind === 'photo')) return true;
  r.add(at, `${show(ref)} is not a scene ("v<index>#<scene>") or a photo ("p<index>")`);
  return false;
}

// name, role and label of a lower third: each optional, one at least
function lowerThirdTexts(r, at, third) {
  screenText(r, `${at}.name`, third.name, { optional: true, nullable: true, max: TEXT_LIMITS.name });
  screenText(r, `${at}.role`, third.role, { optional: true, nullable: true, max: TEXT_LIMITS.role });
  screenText(r, `${at}.label`, third.label, { optional: true, nullable: true, max: TEXT_LIMITS.label });
  const filled = ['name', 'role', 'label'].filter((key) => typeof third[key] === 'string' && third[key].trim());
  if (!filled.length) r.add(at, 'has neither a name, nor a role, nor a label');
}

/* ---------- shots v1 (D1 to D6) ---------- */

function checkShotsInto(r, plan) {
  if (!r.object('shots', plan)) return;
  r.version('version', plan.version, SHOTS_VERSION);
  r.version('fps', plan.fps, FPS);
  const durationOk = r.number('duration', plan.duration, { min: DURATION_RANGE[0], max: DURATION_RANGE[1] });
  const duration = durationOk ? plan.duration : null;
  if (r.object('look', plan.look)) {
    r.number('look.contrast', plan.look.contrast, { min: 0, max: 1 });
    r.number('look.saturation', plan.look.saturation, { min: 0, max: 1 });
  }
  if (!r.array('shots', plan.shots, { min: 1, max: MAX_SHOTS })) return;

  const ids = new Set();
  const clips = { photo_ai: [], photo_parallax: [] };
  let kindsOk = true;
  let lastAct = -1;
  plan.shots.forEach((shot, index) => {
    const at = `shots[${index}]`;
    if (!r.object(at, shot)) return;
    if (r.text(`${at}.id`, shot.id)) {
      if (ids.has(shot.id)) r.add(`${at}.id`, `${show(shot.id)} is there twice`);
      ids.add(shot.id);
    }
    if (r.oneOf(`${at}.act`, shot.act, ACTS)) {
      const order = ACTS.indexOf(shot.act);
      if (order < lastAct) r.add(`${at}.act`, `${show(shot.act)} comes after ${ACTS[lastAct]}`);
      lastAct = Math.max(lastAct, order);
    }
    const spanOk = checkSpan(r, at, shot, duration);
    if (spanOk) {
      const previous = plan.shots[index - 1];
      if (shot.end - shot.start < 1 / FPS - EPS) r.add(at, `is ${show(shot.end - shot.start)} s long, shorter than a frame`);
      if (index === 0 && Math.abs(shot.start) > EPS) r.add(`${at}.start`, `is ${show(shot.start)}, the film starts at 0`);
      if (index > 0 && isObject(previous) && finite(previous.end) && Math.abs(shot.start - previous.end) > EPS) {
        r.add(`${at}.start`, `is ${show(shot.start)}, not the end of the shot before (${show(previous.end)})`);
      }
      if (index === plan.shots.length - 1 && duration !== null && Math.abs(shot.end - duration) > EPS) {
        r.add(`${at}.end`, `is ${show(shot.end)}, the last shot ends with the film (${show(duration)})`);
      }
    }
    if (r.oneOf(`${at}.transition`, shot.transition, SHOT_TRANSITIONS) && index === 0 && shot.transition !== 'cut') {
      r.add(`${at}.transition`, `is ${show(shot.transition)}, the first shot has cut`);
    }
    r.number(`${at}.exposure`, shot.exposure, { optional: true, min: -MAX_EXPOSURE, max: MAX_EXPOSURE });
    r.oneOf(`${at}.fit`, shot.fit, SHOT_FITS, { optional: true });
    if (!r.oneOf(`${at}.kind`, shot.kind, SHOT_KINDS)) {
      kindsOk = false;
      return;
    }

    const kind = shot.kind;
    if (kind === 'video' || kind === 'soundbite') r.boolean(`${at}.hdr`, shot.hdr, { optional: true });
    else if (shot.hdr !== undefined) r.add(`${at}.hdr`, `belongs to a video or a soundbite, not to ${kind}`);
    // D18: the start zoom of a detail, on a clip or a photo only
    if (kind === 'video' || kind === 'photo') r.number(`${at}.zoom`, shot.zoom, { optional: true, min: ZOOM_RANGE[0], max: ZOOM_RANGE[1] });
    else if (shot.zoom !== undefined) r.add(`${at}.zoom`, `belongs to a video or a photo, not to ${kind}`);
    checkAnchor(r, `${at}.anchor`, shot.anchor, { optional: kind === 'photo_parallax' });

    if (kind === 'video') {
      r.number(`${at}.source`, shot.source, { integer: true, min: 0 });
      r.number(`${at}.from`, shot.from, { min: 0 });
      r.oneOf(`${at}.speed`, shot.speed, SPEEDS);
    } else if (kind === 'photo') {
      r.number(`${at}.source`, shot.source, { integer: true, min: 0 });
      if (r.object(`${at}.motion`, shot.motion)) {
        r.oneOf(`${at}.motion.type`, shot.motion.type, PHOTO_MOTIONS);
        r.number(`${at}.motion.rate`, shot.motion.rate, { above: 0, max: MAX_PHOTO_RATE });
      }
    } else if (kind === 'photo_ai' || kind === 'photo_parallax') {
      if (r.number(`${at}.clip`, shot.clip, { integer: true, min: 0 })) clips[kind].push({ at: `${at}.clip`, clip: shot.clip });
    } else if (kind === 'soundbite') {
      r.number(`${at}.source`, shot.source, { integer: true, min: 0 });
      const okFrom = r.number(`${at}.from`, shot.from, { min: 0 });
      const okTo = r.number(`${at}.to`, shot.to, { min: 0 });
      if (okFrom && okTo) {
        const length = shot.to - shot.from;
        if (!(length > 0)) r.add(`${at}.to`, `is ${show(shot.to)}, not after from (${show(shot.from)})`);
        else {
          if (length < SOUNDBITE_SECONDS[0] - EPS || length > SOUNDBITE_SECONDS[1] + EPS) {
            r.add(at, `is ${show(length)} s long, outside ${SOUNDBITE_SECONDS[0]}..${SOUNDBITE_SECONDS[1]} s`);
          }
          if (duration !== null && length > SOUNDBITE_MAX_SHARE * duration + EPS) {
            r.add(at, `is ${show(length)} s long, more than ${SOUNDBITE_MAX_SHARE * 100} % of the film`);
          }
          // a soundbite plays at its own speed: its time in the film is its time in the source, to one frame
          if (spanOk && Math.abs(length - (shot.end - shot.start)) > 1 / FPS + EPS) {
            r.add(at, `plays ${show(length)} s of the source in ${show(shot.end - shot.start)} s of the film`);
          }
        }
      }
    }
  });

  // D1: the clips of each list are used once each, 0..n-1 (counted only when every shot has a known kind)
  for (const kind of kindsOk ? Object.keys(clips) : []) {
    const list = clips[kind];
    const seen = new Set();
    for (const { at, clip } of list) {
      if (seen.has(clip)) r.add(at, `${clip} is used twice (each ${kind} clip is used once)`);
      seen.add(clip);
    }
    for (const { at, clip } of list) if (clip >= list.length) r.add(at, `is ${clip}, but the ${kind} shots number ${list.length} (clips 0..${list.length - 1})`);
  }
}

// D6: x and y 0..1, drift [dx, dy] at most MAX_DRIFT each way; D18: face true or false where it is known
function checkAnchor(r, at, anchor, { optional }) {
  if (!r.object(at, anchor, { optional })) return;
  r.number(`${at}.x`, anchor.x, { min: 0, max: 1 });
  r.number(`${at}.y`, anchor.y, { min: 0, max: 1 });
  r.boolean(`${at}.face`, anchor.face, { optional: true });
  if (anchor.drift !== undefined && r.array(`${at}.drift`, anchor.drift, { min: 2, max: 2 })) {
    r.number(`${at}.drift[0]`, anchor.drift[0], { min: -MAX_DRIFT, max: MAX_DRIFT });
    r.number(`${at}.drift[1]`, anchor.drift[1], { min: -MAX_DRIFT, max: MAX_DRIFT });
  }
}

/* ---------- graphics v1 (D2, D3, D12 to D15) ---------- */

function checkGraphicsInto(r, graphics) {
  if (!r.object('graphics', graphics)) return;
  r.version('version', graphics.version, GRAPHICS_VERSION);
  r.version('fps', graphics.fps, FPS);
  const durationOk = r.number('duration', graphics.duration, { min: DURATION_RANGE[0], max: DURATION_RANGE[1] });
  const duration = durationOk ? graphics.duration : null;
  if (r.number('endFrame', graphics.endFrame, { integer: true, min: 1 }) && duration !== null && graphics.endFrame !== Math.round(duration * FPS)) {
    r.add('endFrame', `is ${graphics.endFrame}, expected ${Math.round(duration * FPS)} (duration x fps)`);
  }

  // the cuts: the starts of the shots
  let cuts = [];
  if (r.array('cuts', graphics.cuts, { min: 1, max: MAX_SHOTS })) {
    graphics.cuts.forEach((cut, index) => r.number(`cuts[${index}]`, cut, { min: 0, max: duration !== null ? duration : Infinity }));
    if (finite(graphics.cuts[0]) && Math.abs(graphics.cuts[0]) > EPS) r.add('cuts[0]', `is ${show(graphics.cuts[0])}, the first cut is 0`);
    checkRising(r, 'cuts', graphics.cuts, true);
    graphics.cuts.forEach((cut, index) => {
      if (duration !== null && finite(cut) && cut >= duration - EPS) r.add(`cuts[${index}]`, `is ${show(cut)}, not before the end of the film`);
    });
    cuts = graphics.cuts.filter(finite);
  }

  // D12: the six acts in their order, without a gap
  if (r.array('acts', graphics.acts, { min: ACTS.length, max: ACTS.length })) {
    graphics.acts.forEach((act, index) => {
      const at = `acts[${index}]`;
      if (!r.object(at, act)) return;
      if (r.oneOf(`${at}.act`, act.act, ACTS) && act.act !== ACTS[index]) r.add(`${at}.act`, `is ${show(act.act)}, expected ${ACTS[index]}`);
      if (!checkSpan(r, at, act, duration)) return;
      const previous = graphics.acts[index - 1];
      if (index === 0 && Math.abs(act.start) > EPS) r.add(`${at}.start`, `is ${show(act.start)}, the film starts at 0`);
      if (index > 0 && isObject(previous) && finite(previous.end) && Math.abs(act.start - previous.end) > EPS) {
        r.add(`${at}.start`, `is ${show(act.start)}, not the end of the act before (${show(previous.end)})`);
      }
      if (index === ACTS.length - 1 && duration !== null && Math.abs(act.end - duration) > EPS) r.add(`${at}.end`, `is ${show(act.end)}, the last act ends with the film`);
    });
  }

  // D5: dip and flash at a cut
  if (r.array('transitions', graphics.transitions, { max: MAX_SHOTS })) {
    graphics.transitions.forEach((item, index) => {
      const at = `transitions[${index}]`;
      if (!r.object(at, item)) return;
      if (r.number(`${at}.at`, item.at, { above: 0, max: duration !== null ? duration : Infinity }) && cuts.length && !cuts.some((cut) => Math.abs(cut - item.at) <= EPS)) {
        r.add(`${at}.at`, `is ${show(item.at)}, which is not a cut`);
      }
      r.oneOf(`${at}.type`, item.type, PAGE_TRANSITIONS);
      r.number(`${at}.frames`, item.frames, { integer: true, min: PAGE_TRANSITION_FRAMES[0], max: PAGE_TRANSITION_FRAMES[1] });
    });
    checkRising(r, 'transitions[].at', graphics.transitions.map((item) => (isObject(item) ? item.at : null)), true);
  }

  // the title (null in a plan without a title text)
  if (r.object('title', graphics.title, { nullable: true })) {
    const title = graphics.title;
    screenText(r, 'title.text', title.text, { max: TEXT_LIMITS.title });
    screenText(r, 'title.sub', title.sub, { nullable: true, max: TEXT_LIMITS.sub });
    checkSpan(r, 'title', title, duration);
    r.oneOf('title.anim', title.anim, Object.keys(TITLE_ANIMS));
  }

  if (r.array('lower_thirds', graphics.lower_thirds, { max: MAX_LOWER_THIRDS })) {
    graphics.lower_thirds.forEach((third, index) => {
      const at = `lower_thirds[${index}]`;
      if (!r.object(at, third)) return;
      for (const key of ['name', 'role', 'label']) if (third[key] === undefined) r.add(`${at}.${key}`, 'is missing (null when empty)');
      lowerThirdTexts(r, at, third);
      checkSpan(r, at, third, duration);
    });
  }

  if (r.array('intertitles', graphics.intertitles, { max: MAX_INTERTITLES })) {
    graphics.intertitles.forEach((title, index) => {
      const at = `intertitles[${index}]`;
      if (!r.object(at, title)) return;
      screenText(r, `${at}.text`, title.text, { max: TEXT_LIMITS.intertitle });
      checkSpan(r, at, title, duration);
    });
  }

  // D13: the words of a soundbite relative to its start
  if (r.array('soundbites', graphics.soundbites, { max: MAX_SOUNDBITES })) {
    graphics.soundbites.forEach((bite, index) => {
      const at = `soundbites[${index}]`;
      if (!r.object(at, bite)) return;
      const spanOk = checkSpan(r, at, bite, duration);
      if (!r.array(`${at}.words`, bite.words, { min: 1, max: 400 })) return;
      const length = spanOk ? bite.end - bite.start : null;
      bite.words.forEach((word, k) => checkWord(r, `${at}.words[${k}]`, word, length));
      checkRising(r, `${at}.words[].s`, bite.words.map((word) => (isObject(word) ? word.s : null)), false);
    });
    checkRising(r, 'soundbites[].start', graphics.soundbites.map((bite) => (isObject(bite) ? bite.start : null)), true);
    graphics.soundbites.forEach((bite, index) => {
      const next = graphics.soundbites[index + 1];
      if (isObject(bite) && isObject(next) && finite(bite.end) && finite(next.start) && next.start < bite.end - EPS) {
        r.add(`soundbites[${index + 1}].start`, `is ${show(next.start)}, inside the soundbite before (until ${show(bite.end)})`);
      }
    });
    // a lower third stands over a soundbite only (spec §6, the texts)
    if (Array.isArray(graphics.lower_thirds)) {
      graphics.lower_thirds.forEach((third, index) => {
        if (!isObject(third) || !finite(third.start) || !finite(third.end)) return;
        const over = graphics.soundbites.some((bite) => isObject(bite) && finite(bite.start) && finite(bite.end) && third.start >= bite.start - EPS && third.end <= bite.end + EPS);
        if (!over) r.add(`lower_thirds[${index}]`, `${show(third.start)}..${show(third.end)} is not over a soundbite`);
      });
    }
  }

  // D14: the lines of the voice by their index in the list `voice`
  if (r.array('voiceover', graphics.voiceover, { max: MAX_VOICEOVER })) {
    const seen = new Set();
    graphics.voiceover.forEach((line, index) => {
      const at = `voiceover[${index}]`;
      if (!r.object(at, line)) return;
      if (r.number(`${at}.index`, line.index, { integer: true, min: 0, max: MAX_VOICEOVER - 1 })) {
        if (seen.has(line.index)) r.add(`${at}.index`, `${line.index} is there twice`);
        seen.add(line.index);
      }
      r.number(`${at}.start`, line.start, { min: 0, max: duration !== null ? duration - EPS : Infinity });
    });
  }

  // D3: the end card on the last seconds of the film
  if (r.object('endcard', graphics.endcard)) {
    const card = graphics.endcard;
    screenText(r, 'endcard.line', card.line, { max: TEXT_LIMITS.endcardLine });
    screenText(r, 'endcard.sub', card.sub, { nullable: true, max: TEXT_LIMITS.endcardSub });
    screenText(r, 'endcard.url', card.url, { nullable: true, max: TEXT_LIMITS.url });
    if (r.number('endcard.seconds', card.seconds, { min: ENDCARD_SECONDS_RANGE[0], max: ENDCARD_SECONDS_RANGE[1] }) && duration !== null && card.seconds > duration / 4) {
      r.add('endcard.seconds', `is ${show(card.seconds)}, more than a quarter of the film`);
    }
    r.boolean('endcard.logo', card.logo);
  }

  // D12: the look of the page and of the final pass
  if (r.object('look', graphics.look)) {
    const look = graphics.look;
    if (r.object('look.type', look.type)) {
      for (const key of ['title', 'body']) {
        if (r.text(`look.type.${key}`, look.type[key]) && !parseFont(look.type[key])) {
          r.add(`look.type.${key}`, `${show(look.type[key])} is not "Family:weight" or "Family:weight:italic" with a family of ${FONT_FAMILIES.join(', ')}`);
        }
      }
    }
    r.text('look.accent', look.accent, { pattern: /^#[0-9A-Fa-f]{6}$/ });
    r.number('look.tint', look.tint, { min: TINT_RANGE[0], max: TINT_RANGE[1] });
    r.number('look.glow', look.glow, { min: GLOW_RANGE[0], max: GLOW_RANGE[1] });
    r.number('look.title_seconds', look.title_seconds, { min: TITLE_SECONDS_RANGE[0], max: TITLE_SECONDS_RANGE[1] });
    r.oneOf('look.ease', look.ease, LOOK_EASES);
    r.number('look.grain', look.grain, { min: 0, max: 1 });
    r.number('look.contrast', look.contrast, { min: 0, max: 1 });
  }

  if (r.object('mix', graphics.mix)) {
    for (const key of Object.keys(MIX_RANGES)) r.number(`mix.${key}`, graphics.mix[key], { min: MIX_RANGES[key][0], max: MIX_RANGES[key][1] });
  }
}

/* ---------- shots and graphics of the same plan ---------- */

function checkPairInto(r, shots, graphics) {
  const shotsOk = checkShots(shots);
  const graphicsOk = checkGraphics(graphics);
  shotsOk.problems.forEach((problem) => r.add('shots:', problem));
  graphicsOk.problems.forEach((problem) => r.add('graphics:', problem));
  if (!shotsOk.ok || !graphicsOk.ok) return;
  if (Math.abs(shots.duration - graphics.duration) > EPS) r.add('duration', `of the shots (${show(shots.duration)}) and of the graphics (${show(graphics.duration)}) differ`);
  const starts = shots.shots.map((shot) => shot.start);
  if (starts.length !== graphics.cuts.length || starts.some((start, index) => Math.abs(start - graphics.cuts[index]) > EPS)) {
    r.add('graphics.cuts', 'are not the starts of the shots');
  }
  for (const act of graphics.acts) {
    const own = shots.shots.filter((shot) => shot.act === act.act);
    if (!own.length) {
      r.add(`acts.${act.act}`, 'has no shot');
      continue;
    }
    if (Math.abs(own[0].start - act.start) > EPS || Math.abs(own[own.length - 1].end - act.end) > EPS) {
      r.add(`acts.${act.act}`, `is ${show(act.start)}..${show(act.end)} in the graphics, ${show(own[0].start)}..${show(own[own.length - 1].end)} in the shots`);
    }
  }
  const bites = shots.shots.filter((shot) => shot.kind === 'soundbite');
  if (bites.length !== graphics.soundbites.length) r.add('soundbites', `${bites.length} soundbite shots, ${graphics.soundbites.length} soundbites in the graphics`);
  else {
    bites.forEach((shot, index) => {
      const bite = graphics.soundbites[index];
      if (Math.abs(shot.start - bite.start) > EPS || Math.abs(shot.end - bite.end) > EPS) {
        r.add(`soundbites[${index}]`, `is ${show(bite.start)}..${show(bite.end)} in the graphics, ${show(shot.start)}..${show(shot.end)} in the shots (${shot.id})`);
      }
    });
  }
}

/* ---------- the checks ---------- */

const checkInfo = (info) => run(checkInfoInto, info);
const checkStyle = (style) => run(checkStyleInto, style);
const checkAnswer = (answer) => run(checkAnswerInto, answer);
const checkShots = (shots) => run(checkShotsInto, shots);
const checkGraphics = (graphics) => run(checkGraphicsInto, graphics);
const checkPair = (shots, graphics) => run(checkPairInto, shots, graphics);

// The event type of a value of the app: a type, or an alias (festival) read as its type. null for anything else.
function readEventType(value) {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (EVENT_TYPES.includes(name)) return { type: name, alias: null, shift: null };
  if (Object.prototype.hasOwnProperty.call(EVENT_TYPE_ALIASES, name)) return { type: EVENT_TYPE_ALIASES[name], alias: name, shift: ALIAS_SHIFTS[name] };
  return null;
}

module.exports = {
  EVENT_TYPES,
  EVENT_TYPE_ALIASES,
  ALIAS_SHIFTS,
  MOODS,
  LENGTHS,
  FORMATS,
  FORMAT_SIZES,
  LANGUAGES,
  DEFAULTS,
  ACTS,
  ACT_SHARES,
  VOICEOVER_ACTS,
  FPS,
  INFO_VERSION,
  STYLE_VERSION,
  SHOTS_VERSION,
  GRAPHICS_VERSION,
  DURATION_RANGE,
  ENDCARD_SECONDS,
  TITLE_FROM,
  LIMITS,
  ERRORS,
  MEDIA_KINDS,
  UNUSABLE_REASONS,
  ROTATIONS,
  SCENE_REASONS,
  CAMERA_MOTIONS,
  PEOPLE,
  EMOTIONS,
  ACTIONS,
  FRAMINGS,
  RISKS,
  HARD_RISKS,
  FITS,
  STYLE_VALUES,
  STYLE_TRANSITIONS,
  FONT_FAMILIES,
  TITLE_ANIMS,
  LOOK_EASES,
  TEXT_LIMITS,
  TEXT_SOURCES,
  INTERTITLES_BY_LENGTH,
  MAX_SOUNDBITES,
  MAX_INTERTITLES,
  MAX_LOWER_THIRDS,
  MAX_AI_PHOTOS,
  MAX_PARALLAX,
  MAX_VOICEOVER,
  MAX_PICKS_PER_ACT,
  MAX_SCENES,
  MAX_SHOTS,
  SCENE_REF,
  PHOTO_REF,
  VIDEO_REF,
  SHOT_KINDS,
  SHOT_TRANSITIONS,
  SHOT_FITS,
  PAGE_TRANSITIONS,
  PHOTO_MOTIONS,
  SPEEDS,
  MAX_EXPOSURE,
  MAX_DRIFT,
  ZOOM_RANGE,
  MAX_PHOTO_RATE,
  SOUNDBITE_SECONDS,
  SOUNDBITE_MAX_SHARE,
  PAGE_TRANSITION_FRAMES,
  TINT_RANGE,
  GLOW_RANGE,
  TITLE_SECONDS_RANGE,
  ENDCARD_SECONDS_RANGE,
  MIX_RANGES,
  FORBIDDEN_TEXT,
  EPS,
  parseRef,
  parseFont,
  readEventType,
  checkInfo,
  checkStyle,
  checkAnswer,
  checkShots,
  checkGraphics,
  checkPair
};
