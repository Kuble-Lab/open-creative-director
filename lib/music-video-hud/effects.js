'use strict';

// The beat effects of the music video with the HUD (WP45, WP49): glitch, noise, disturbances, time effects, distortion, motion, light and colour on the
// music, with a palette of its own for every part of the song, nothing on the end card. Made by code from the data of the song, without a language model:
//   planEffects(graphics, { level, glitch })  the plan of the whole film, null for the level `off`. A pure function: the same graphics and options give
//                                      the same plan.
//                                      - the parts of the song (break, verse, chorus, bridge, drop), from the lyrics that come back (a chorus), the bars
//                                        in which a word is sung and the loudness of every bar as a percentile of the song (partsOf)
//                                      - a palette of 3 to 5 kinds of effect for every part, from a seed of the song; a part of the same kind later in the
//                                        song varies the palette of the first one instead of copying it (palettesOf)
//                                      - the accents: the downbeats of loud bars, the strong hits (their strength as a percentile of the song), the cuts
//                                        and the starts of the parts. Every accent gets one kind of its palette, in turn: never a kind of the accent
//                                        before it, at most CAPS of a kind in any minute; zoom punch and exposure pulse only on accents
//                                      - the stretches over bars: an RGB split that wanders in the drop, noise on the way into the bridge, scanlines in a
//                                        break; the copies of the footage that HyperFrames plays (freeze, stutter, echo, mirror); the look of the style
//   sliceEffects(plan, from, to)       the part of the plan that a chunk of the film needs (what still runs at its start included)
//   frameEffects(plan, t)              what the effects do to the frame at the song time t. A pure function of the plan and of t (noise comes from a hash
//                                      of the frame number), so a chunk drawn on any render node shows the frames of the whole film, also at its seams.
//   view(state)                        the CSS of the wrappers and layers and the values of the SVG filters that draw one frame
//   flashFrames(plan, graphics)        every flash of the film (the planned ones and those the HUD draws itself), for the limit of 3 a second
// Where it is drawn, all of it in the page of the chunk (HyperFrames 0.8.139, every kind checked frame by frame on the local render, WP49):
//   the footage only (#fx round the footage and layers over it under the HUD; the HUD stays sharp): zoom, shake, turn, bulge, wave, blur, chromatic
//     edges, colour, the long RGB split, noise, scanlines with the line offset, pixels, the smear, and the copies of the footage (freeze and stutter,
//     echo, mirror: <video> clips of HyperFrames with their own place in the footage, COPY_STYLES)
//   the whole picture (#fxall round the stage, the HUD included; at most 12 frames, never in the first half second of a new graphic, so it stays
//     readable): the short RGB split, slices, blocks, a VHS band, the picture rolling, snow
//   the light (#fx-light between the footage and the HUD): flashes, strobe
// The built-in shaders of HyperFrames (data-color-grading: digitalGlitch, tape damage ...) are frame exact as well, but a render node without a graphics
// card draws them in software (SwiftShader) about 50 times slower; the SVG filters and CSS here take about twice as long there.
// The limits: no bulge and no wave in a lip-sync cut; while a word is sung in it only what leaves the face as it is (zoom, pulse, turn, light, colour,
// a smaller shake, light noise and scanlines, colour edges and an RGB split of at most 3 px on the footage); at most 3 flashes in any second, no red
// flash (an accent colour that is red flashes white instead); nothing before the film and nothing on the end card.
// UMD: runs in Node (the plan, the tests) and in the browser (inlined in the page of a chunk after themes.js, when the effects are on).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./themes'));
  else root.HudEffects = factory(root.HudThemes);
})(typeof self !== 'undefined' ? self : this, function (themes) {
  const FPS = 24;
  const WIDTH = 1920;
  const HEIGHT = 1080;
  const LEVELS = Object.freeze(['off', 'subtle', 'strong', 'wild']);
  // the default of the parameter of the node; the modules read a missing level as `off`, so a page or a command made without it is the one of before
  const DEFAULT_LEVEL = 'strong';
  const PART_KINDS = Object.freeze(['break', 'verse', 'chorus', 'bridge', 'drop']);
  // the flashes: at most this many in any second
  const FLASH_LIMIT = 3;
  // the longest event (frames) apart from the stretches: how far a frame looks back for the events that still run
  const LONGEST_FRAMES = 12;
  // the change of the colour from one part to the next (frames)
  const BLEND_FRAMES = 10;
  // a new graphic of the HUD is readable in its first half second: no effect over the whole picture in these frames from its start
  const FRESH_FRAMES = 12;
  // the points where chunks.js may cut the film besides the cuts: every MAX_SECONDS / 2 inside a long cut (frames). A copy of the footage never
  // reaches over one of them (its frames must be in the footage of its chunk).
  const SEAM_FRAMES = 288;
  // a part of the song lasts at least this many bars
  const MIN_PART_BARS = 4;
  // the length of a glitch: short on an accent, a burst on the strongest hits and at the starts of the parts (frames)
  const SHORT_FRAMES = Object.freeze([2, 4]);
  const BURST_FRAMES = Object.freeze([6, 12]);
  // a copy of the footage that holds a frame (playback rate 0.1) lasts at most this many frames, a longer hold takes several (the frame stays exact)
  const HOLD_FRAMES = 4;
  // the default of the slider `glitch` of the node: the strength the effects are made for
  const GLITCH_DEFAULT = 0.6;
  // the RGB split and the colour edges while a word is sung (px)
  const SUNG_SPLIT_PX = 3;

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const r1 = (value) => Math.round(value * 10) / 10;
  const r3 = (value) => Math.round(value * 1000) / 1000;
  const r4 = (value) => Math.round(value * 10000) / 10000;
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const frameOf = (seconds) => Math.round(seconds * FPS);

  // The hash of state.js: integers into [0, 1), the same on every machine.
  function hash(a, b = 0, c = 0) {
    let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    return h / 4294967296;
  }

  // the first index whose value (or `key` of the entry) is above x
  function after(list, x, key) {
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((key === undefined ? list[mid] : list[mid][key]) <= x) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  // the level of the effects: one of LEVELS, anything else (a missing value too) is `off`
  function normalizeLevel(value) {
    const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return LEVELS.includes(name) ? name : 'off';
  }

  /* ---------- the vocabulary ---------- */

  // Every kind of effect. layer: 'cam' the footage only, 'all' the whole picture with the HUD, 'light' the light layer. sung: what it may do while a
  // word is sung in a lip-sync cut (true: as it is, 'small': less of it, false: nothing). lip: false for the kinds that never come into a lip-sync cut
  // (they pull the face out of shape). on: the accents it fits (down: the downbeat of a loud bar, hit: a strong hit, cut: a cut, start: the start of a
  // part). long: it lasts 6 to 12 frames whatever the accent. glitch: the slider `glitch` scales it (0: none of these). copies: drawn with copies of the
  // footage. flash: counts as a flash. max: the most frames it lasts. (beat: the third beat of a loud bar in a drop or a chorus, which takes only short
  // kinds; zoom punch and exposure pulse come only on a downbeat of a loud bar, a strong hit or the start of a part)
  const KINDS = Object.freeze({
    punch: { layer: 'cam', sung: true, on: ['down', 'hit', 'start'] },
    pulse: { layer: 'cam', sung: true, on: ['down', 'hit'] },
    shake: { layer: 'cam', sung: 'small', on: ['hit', 'down', 'beat'] },
    turn: { layer: 'cam', sung: true, on: ['down', 'start', 'hit', 'cut'] },
    bulge: { layer: 'cam', sung: false, lip: false, on: ['down', 'hit'] },
    wave: { layer: 'cam', sung: false, lip: false, on: ['hit', 'down'] },
    chroma: { layer: 'cam', sung: 'small', on: ['cut', 'hit', 'down', 'beat'] },
    blur: { layer: 'cam', sung: false, on: ['cut'] },
    flash: { layer: 'light', sung: true, on: ['hit', 'start'], flash: true },
    rgb: { layer: 'all', sung: false, on: ['hit', 'cut', 'down', 'start', 'beat'], glitch: true },
    noise: { layer: 'cam', sung: 'small', on: ['hit', 'down', 'start', 'beat'], glitch: true },
    snow: { layer: 'all', sung: false, on: ['hit', 'start'], glitch: true, flash: true, max: 8 },
    blocks: { layer: 'all', sung: false, on: ['hit', 'cut', 'start', 'down', 'beat'], glitch: true },
    slices: { layer: 'all', sung: false, on: ['hit', 'cut', 'down', 'start', 'beat'], glitch: true },
    pixel: { layer: 'cam', sung: false, on: ['hit', 'down', 'cut', 'beat'], glitch: true },
    scan: { layer: 'cam', sung: 'small', on: ['down', 'start'], glitch: true, long: true },
    vhs: { layer: 'all', sung: false, on: ['hit', 'start', 'down'], glitch: true, long: true },
    roll: { layer: 'all', sung: false, on: ['start', 'hit'], glitch: true, long: true, max: 10 },
    smear: { layer: 'cam', sung: false, on: ['hit', 'down'], glitch: true, long: true, copies: true },
    stutter: { layer: 'cam', sung: false, on: ['down', 'hit'], long: true, copies: true },
    echo: { layer: 'cam', sung: false, on: ['down', 'hit'], long: true, copies: true },
    mirror: { layer: 'cam', sung: false, on: ['down', 'start'], long: true, copies: true }
  });
  // the kinds that only come as a stretch over bars (not on an accent)
  const SPAN_KINDS = Object.freeze(['split']);
  const KIND_NAMES = Object.freeze([...Object.keys(KINDS), ...SPAN_KINDS]);
  // the kinds that are drawn over the whole picture, the HUD included
  const WHOLE_KINDS = Object.freeze(Object.keys(KINDS).filter((kind) => KINDS[kind].layer === 'all'));

  // At most this many of a kind in any minute (60 s) at `strong` (subtle: half, wild: one and a half times); so no kind takes over a long loud part.
  const CAPS = Object.freeze({
    punch: 12, pulse: 10, shake: 10, turn: 4, bulge: 6, wave: 3, chroma: 10, blur: 6, flash: 6,
    rgb: 10, noise: 8, snow: 4, blocks: 8, slices: 10, pixel: 6, scan: 4, vhs: 4, roll: 3, smear: 4, stutter: 5, echo: 5, mirror: 3
  });

  // The palettes of the parts: `first` the kinds that may lead the palette (they make the part look like itself: the analog VHS and roll of the bridge,
  // the digital blocks and snow of the drop ...), `pool` all kinds it may take, `size` how many (the level adds or takes one; 3 to 5).
  const PALETTES = Object.freeze({
    break: { size: 3, first: ['echo', 'stutter', 'pixel'], pool: ['echo', 'stutter', 'pixel', 'turn', 'noise', 'mirror', 'chroma', 'pulse'] },
    verse: { size: 3, first: ['pixel', 'stutter', 'slices', 'chroma'], pool: ['punch', 'shake', 'chroma', 'pixel', 'stutter', 'slices', 'noise', 'echo', 'turn', 'rgb', 'pulse'] },
    chorus: { size: 4, first: ['rgb', 'echo', 'mirror'], pool: ['punch', 'pulse', 'bulge', 'rgb', 'slices', 'echo', 'mirror', 'turn', 'wave', 'flash', 'blocks', 'chroma', 'blur', 'shake'] },
    bridge: { size: 4, first: ['vhs', 'roll', 'smear'], pool: ['vhs', 'noise', 'roll', 'smear', 'echo', 'mirror', 'scan', 'pixel', 'wave', 'stutter', 'turn'] },
    drop: { size: 5, first: ['blocks', 'snow', 'smear', 'slices'], pool: ['punch', 'shake', 'rgb', 'blocks', 'snow', 'slices', 'stutter', 'smear', 'roll', 'pixel', 'bulge', 'flash', 'pulse', 'blur', 'chroma'] }
  });

  // The amplitudes at `strong` with the slider at its default: [an accent, a burst or a start] (punch, pulse: zoom and exposure; shake, bulge, wave,
  // chroma, rgb, blocks, slices, smear, vhs: px; turn: degrees; flash, noise, snow, scan: opacity; pixel: the cell in px; blur: sideways, zoom). Even the
  // weakest of every kind changes 5 % of the picture or more by more than 16 of 255 over its frames (the exposure pulse, which fades in 9 frames, on its
  // first ones; measured on a film, WP49, IMPLEMENTATION-NOTES).
  const AMP = Object.freeze({
    punch: [0.04, 0.065], pulse: [0.13, 0.15], shake: [11, 18], turn: [1.2, 1.8], bulge: [80, 110], wave: [14, 18], chroma: [32, 40], blur: [13, 54],
    flash: [0.5, 0.65], rgb: [12, 30], noise: [0.42, 0.6], snow: [0.38, 0.55], blocks: [150, 240], slices: [130, 260], pixel: [16, 32], scan: [0.3, 0.42],
    vhs: [90, 140], roll: [1, 1], smear: [120, 200]
  });

  // What each level does. gain: the amplitudes; size: added to the size of the palettes; caps: times CAPS; gap: the fewest frames between two accents;
  // burstFrom: from which percentile a hit is a burst; burstMax: the longest burst; accents: per part, every: a downbeat accent every n bars (0: none),
  // from: the percentile of the loudness a bar needs for it, third: the third beat too from this percentile, hit: the percentile a hit needs, cut: an
  // accent on every n-th cut (0: none); never: kinds it does not use; split: bars of the RGB split in the drop (its px: splitPx); scan: the scanlines
  // of a break; strobe: bars of strobe at the start of a drop; negative: one negative flash in a drop; sectionFlash: the white flash at the start of a
  // chorus or a drop; grade: how far the colour of the parts goes; micro: the shake that is always there in a drop (px).
  const LEVEL = Object.freeze({
    subtle: {
      gain: 0.55,
      size: 0,
      caps: 0.5,
      gap: 8,
      burstFrom: 0.985,
      burstMax: 8,
      accents: {
        break: { every: 0, from: 1, hit: 0.995, cut: 0 },
        verse: { every: 4, from: 0.3, hit: 0.95, cut: 0 },
        chorus: { every: 2, from: 0.3, hit: 0.9, cut: 2 },
        bridge: { every: 4, from: 0.3, hit: 0.92, cut: 0 },
        drop: { every: 1, from: 0.2, hit: 0.85, cut: 2 }
      },
      never: ['roll', 'snow', 'mirror', 'wave', 'turn'],
      split: 1,
      splitPx: 6,
      scan: 0.1,
      strobe: 0,
      negative: false,
      sectionFlash: 0.55,
      grade: 0.5,
      micro: 0
    },
    strong: {
      gain: 1,
      size: 0,
      caps: 1,
      gap: 6,
      burstFrom: 0.95,
      burstMax: 12,
      accents: {
        break: { every: 4, from: 0, hit: 0.97, cut: 0 },
        verse: { every: 2, from: 0.15, hit: 0.9, cut: 2 },
        chorus: { every: 1, from: 0.2, hit: 0.82, cut: 1 },
        bridge: { every: 2, from: 0.25, hit: 0.85, cut: 2 },
        drop: { every: 1, from: 0, third: 0.5, hit: 0.75, cut: 1 }
      },
      never: [],
      split: 2,
      splitPx: 12,
      scan: 0.16,
      strobe: 2,
      negative: true,
      sectionFlash: 0.85,
      grade: 1,
      micro: 2.5
    },
    wild: {
      gain: 1.3,
      size: 1,
      caps: 1.5,
      gap: 5,
      burstFrom: 0.9,
      burstMax: 12,
      accents: {
        break: { every: 2, from: 0, hit: 0.93, cut: 2 },
        verse: { every: 1, from: 0.1, hit: 0.85, cut: 1 },
        chorus: { every: 1, from: 0, third: 0.6, hit: 0.75, cut: 1 },
        bridge: { every: 1, from: 0.2, hit: 0.8, cut: 1 },
        drop: { every: 1, from: 0, third: 0.3, hit: 0.65, cut: 1 }
      },
      never: [],
      split: 4,
      splitPx: 16,
      scan: 0.2,
      strobe: 2,
      negative: true,
      sectionFlash: 0.9,
      grade: 1.25,
      micro: 3.5
    }
  });

  // the colour of the parts at `strong`: [brightness, contrast, saturation]
  const GRADES = Object.freeze({
    break: [0.95, 0.97, 0.84],
    verse: [1, 1, 0.97],
    chorus: [1.05, 1.08, 1.16],
    bridge: [0.97, 1.08, 0.88],
    drop: [1.08, 1.14, 1.26]
  });

  // The copies of the footage: the CSS of a <video> clip of HyperFrames above the footage (the frame it shows is the clip's own, see plan.copies).
  // A mirror keeps one half (or a quarter) of the picture and turns it over onto the other; the echo is a ghost of the picture a few frames before.
  const COPY_STYLES = Object.freeze({
    plain: '',
    echo: 'opacity:.5;mix-blend-mode:screen;transform:scale(1.045);filter:grayscale(1) brightness(1.08)',
    left: 'transform:scaleX(-1);clip-path:inset(0 50% 0 0)',
    right: 'transform:scaleX(-1);clip-path:inset(0 0 0 50%)',
    kx: 'transform:scaleX(-1);clip-path:inset(0 50% 50% 0)',
    ky: 'transform:scaleY(-1);clip-path:inset(0 50% 50% 0)',
    kxy: 'transform:scale(-1,-1);clip-path:inset(0 50% 50% 0)'
  });

  /* ---------- the look of the styles ---------- */

  // A colour as [hue (degrees), saturation, value] (0 to 1)
  function hsv(hex) {
    const value = String(hex || '').replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
    const [r, g, b] = [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
    }
    return [(h * 60 + 360) % 360, max ? d / max : 0, max];
  }

  // Is a colour a red that must not flash over a large area? Hues from magenta-red over red to red-orange (330 to 25 degrees) with some colour in them:
  // a wider net than the saturated red of WCAG (red / (red + green + blue) of 0.8 or more).
  function isRed(hex) {
    const c = hsv(hex);
    return Boolean(c) && (c[0] >= 330 || c[0] <= 25) && c[1] >= 0.35 && c[2] >= 0.25;
  }

  // The colour a flash in the accent may have: the accent, or white (`white`) when it is red or not a colour.
  function safeFlashColor(hex, white = '#FFFFFF') {
    return hsv(hex) && !isRed(hex) ? String(hex).toUpperCase() : white;
  }

  // The look of the style: the colours of the flashes (0: white of the style, 1: the accent) and the CSS of the negative flash. HUD Blue: white and
  // its accent, a black and white negative. Kuble: Ink and Kuble Blue whatever the accent is (never amber: amber is one small element of a picture),
  // a negative in night blue.
  function lookOf(graphics) {
    const theme = themes.get(graphics.theme);
    if (theme.id === 'kuble') {
      const ink = theme.colors.ink.toUpperCase();
      return { colors: [ink, safeFlashColor(theme.colors.blue, ink)], invert: 'invert(1) grayscale(1) sepia(1) hue-rotate(185deg) saturate(2.4) brightness(.78)' };
    }
    return { colors: ['#FFFFFF', safeFlashColor(graphics.accent || theme.accent)], invert: 'invert(1) grayscale(1) brightness(.85)' };
  }

  /* ---------- the song: bars, parts, sung words ---------- */

  // The loudness at t (one value per second of the song, at the middle of the second), as state.js reads it.
  function energyAt(music, t) {
    const list = music.energy || [];
    if (!list.length) return 0.5;
    const x = t - 0.5 - (music.energyFrom || 0);
    const index = Math.floor(x);
    const at = (i) => list[clamp(i, 0, list.length - 1)];
    return clamp(at(index) + (at(index + 1) - at(index)) * (x - index), 0, 1);
  }

  // The percentile of every value among all of them: 0 for the smallest, 1 for the largest; equal values share the mean of their places.
  function ranks(values) {
    const n = values.length;
    if (n < 2) return values.map(() => 0.5);
    const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
    const out = new Array(n);
    for (let i = 0; i < n; ) {
      let j = i;
      while (j + 1 < n && order[j + 1].value === order[i].value) j += 1;
      const place = (i + j) / 2 / (n - 1);
      for (let k = i; k <= j; k += 1) out[order[k].index] = place;
      i = j + 1;
    }
    return out;
  }

  // The beats of the song; without any, a grid of the tempo over the whole film.
  function beatsOf(g) {
    const music = g.music || {};
    if ((music.beats || []).length >= 2) return music.beats.slice();
    const period = clamp(60 / (music.bpm || 120), 0.2, 1.5);
    const end = (g.endFrame || 0) / FPS;
    const out = [];
    for (let t = 0; t < end + period; t += period) out.push(r3(t));
    return out;
  }

  // The bars of the song: from one downbeat to the next (without downbeats, every fourth beat starts one); the time before the first one is a bar too.
  function barsOf(g, beats) {
    const music = g.music || {};
    let downs = (music.downbeats || []).length >= 2 ? music.downbeats.slice() : beats.filter((_beat, index) => index % 4 === 0);
    if (downs.length < 2) downs = [0, Math.max(1, (g.endFrame || FPS) / FPS)];
    const end = Math.max((g.endFrame || 0) / FPS, downs[downs.length - 1] + 0.5);
    const bars = [];
    if (downs[0] > 0.3) bars.push({ start: 0, end: downs[0] });
    for (let i = 0; i < downs.length; i += 1) {
      const last = i + 1 >= downs.length;
      const length = last ? downs[i] - downs[i - 1] : downs[i + 1] - downs[i];
      bars.push({ start: downs[i], end: last ? Math.max(downs[i] + length, end) : downs[i + 1] });
    }
    return bars;
  }

  // The loudness of every bar (the mean of four points in it) and its percentile among the bars of the song.
  function barRanks(g, bars) {
    const music = g.music || {};
    const loud = bars.map((bar) => {
      let sum = 0;
      for (let i = 0; i < 4; i += 1) sum += energyAt(music, bar.start + ((i + 0.5) / 4) * (bar.end - bar.start));
      return sum / 4;
    });
    return ranks(loud);
  }

  // The words of the song in the order they are sung, each as its letters and digits in lower case (any script) with its times.
  function wordsOf(g) {
    const out = [];
    for (const line of g.lines || []) {
      for (const word of line.words || []) {
        const text = String(word.text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
        const start = num(word.start, NaN);
        const end = num(word.end, NaN);
        if (text && Number.isFinite(start) && Number.isFinite(end) && end >= start) out.push({ x: text, t: start, e: end });
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }

  // Which words belong to the lyrics that come back: a run of three words sung at several places at least 8 s apart (3 places, or 2 when nothing comes
  // back three times). A chorus is sung three times, a pre-chorus mostly twice. { flags, any }
  function repeatedWords(words) {
    const flags = words.map(() => false);
    const places = new Map();
    for (let i = 0; i + 2 < words.length; i += 1) {
      const key = `${words[i].x} ${words[i + 1].x} ${words[i + 2].x}`;
      if (!places.has(key)) places.set(key, []);
      places.get(key).push(i);
    }
    const counts = new Map();
    let most = 0;
    for (const [key, list] of places) {
      let count = 0;
      let last = -Infinity;
      for (const i of list) {
        if (words[i].t - last >= 8) {
          count += 1;
          last = words[i].t;
        }
      }
      counts.set(key, count);
      most = Math.max(most, count);
    }
    const need = Math.max(2, Math.min(3, most));
    for (const [key, list] of places) if (counts.get(key) >= need) for (const i of list) flags[i] = flags[i + 1] = flags[i + 2] = true;
    return { flags, any: most >= 2 };
  }

  // The parts of the song: [{ b0, b1, kind, n, rank }] (bars b0 to b1, n: the how-many-th part of its kind, rank: the mean loudness percentile).
  //   - a bar in which words are sung for a fifth of its time or more is a chorus when most of the words of it and its two neighbours come back
  //     (repeatedWords), a verse otherwise
  //   - bars without words: in a run of 4 or more a loud bar (0.62 and more on the middle of three; 0.45 when the run holds a drop of the plan,
  //     hud.drops) is a drop, the others a break; a shorter run belongs to the part around it
  //   - a song without lyrics: by the loudness (under 0.2 a break, under 0.5 a verse, under 0.8 a chorus, above a drop; the middle of five bars)
  //   - lyrics that never come back: a loud bar of a verse (0.62 and more on the middle of three) is a chorus
  //   - a part of fewer than 4 bars joins a neighbour (the shortest first)
  //   - a bridge: a verse after the second chorus that a chorus or a drop follows
  //   - a drop, whatever is sung (not in a bridge): the loudest stretches (4 bars or more at 0.85 and more on the middle of three), and from a drop of
  //     the plan on when its 4 bars are 0.8 or more on the mean (while the bars stay at 0.55, at most 16)
  //   - a part of more than 16 bars is cut into phrases of at most 12 (a later phrase varies the palette of the first)
  function partsOf(g, bars, rank) {
    const n = bars.length;
    const words = wordsOf(g);
    const repeated = repeatedWords(words);
    const sung = new Array(n).fill(0);
    const back = new Array(n).fill(0);
    words.forEach((word, index) => {
      for (let b = Math.max(0, after(bars, word.t, 'start') - 1); b < n && bars[b].start < word.e; b += 1) {
        const overlap = Math.min(word.e, bars[b].end) - Math.max(word.t, bars[b].start);
        if (overlap > 0) {
          sung[b] += overlap;
          if (repeated.flags[index]) back[b] += overlap;
        }
      }
    });
    const length = (b) => Math.max(0.1, bars[b].end - bars[b].start);
    const drops = ((g.hud && g.hud.drops) || []).filter((t) => Number.isFinite(Number(t))).map(Number);
    const middle = (b) => [rank[Math.max(0, b - 1)], rank[b], rank[Math.min(n - 1, b + 1)]].sort((x, y) => x - y)[1];
    const meanOf = (b0, b1) => {
      let sum = 0;
      for (let b = b0; b < b1; b += 1) sum += rank[b];
      return sum / Math.max(1, b1 - b0);
    };
    let labels;
    if (words.length < 8) {
      const raw = rank.map((value) => (value < 0.2 ? 0 : value < 0.5 ? 1 : value < 0.8 ? 2 : 3));
      labels = raw.map((_value, i) => {
        const near = [];
        for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k += 1) near.push(raw[k]);
        return ['break', 'verse', 'chorus', 'drop'][near.sort((a, b) => a - b)[near.length >> 1]];
      });
    } else {
      labels = bars.map((_bar, b) => {
        if (sung[b] / length(b) < 0.2) return null;
        let all = 0;
        let again = 0;
        for (let k = Math.max(0, b - 1); k <= Math.min(n - 1, b + 1); k += 1) {
          all += sung[k];
          again += back[k];
        }
        return repeated.any && again / all >= 0.45 ? 'chorus' : 'verse';
      });
      // the bars without words
      for (let i = 0; i < n; ) {
        if (labels[i] !== null) {
          i += 1;
          continue;
        }
        let j = i;
        while (j < n && labels[j] === null) j += 1;
        if (j - i >= MIN_PART_BARS) {
          // bar by bar (the middle of three): loud bars a drop, the others a break (a short stretch joins its neighbours later)
          const marked = drops.some((t) => t >= bars[i].start - length(i) && t < bars[j - 1].end);
          for (let k = i; k < j; k += 1) labels[k] = middle(k) >= 0.62 || (marked && middle(k) >= 0.45) ? 'drop' : 'break';
        } else {
          const label = (i > 0 && labels[i - 1]) || (j < n && labels[j]) || 'break';
          for (let k = i; k < j; k += 1) labels[k] = label;
        }
        i = j;
      }
    }
    const runsOf = (list) => {
      const out = [];
      list.forEach((label, b) => {
        const last = out[out.length - 1];
        if (last && last.kind === label) last.b1 = b + 1;
        else out.push({ b0: b, b1: b + 1, kind: label });
      });
      return out;
    };
    const join = (list) => {
      const out = [];
      for (const run of list) {
        const last = out[out.length - 1];
        if (last && last.kind === run.kind) last.b1 = run.b1;
        else out.push({ ...run });
      }
      return out;
    };
    // the short parts join a neighbour, the shortest first (the one before it, at the start the one after it)
    const settle = (list) => {
      let out = join(list);
      for (;;) {
        let shortest = -1;
        out.forEach((run, index) => {
          if (run.b1 - run.b0 < MIN_PART_BARS && out.length > 1 && (shortest < 0 || run.b1 - run.b0 < out[shortest].b1 - out[shortest].b0)) shortest = index;
        });
        if (shortest < 0) return out;
        const run = out[shortest];
        if (shortest > 0) out[shortest - 1].b1 = run.b1;
        else out[1].b0 = run.b0;
        out.splice(shortest, 1);
        out = join(out);
      }
    };
    if (words.length >= 8 && !repeated.any) labels = labels.map((label, b) => (label === 'verse' && middle(b) >= 0.62 ? 'chorus' : label));
    let runs = settle(runsOf(labels));
    // the bridge
    const choruses = runs.filter((run) => run.kind === 'chorus');
    if (choruses.length >= 2) {
      for (let k = runs.indexOf(choruses[1]) + 1; k < runs.length && runs[k].kind !== 'chorus'; k += 1) {
        if (runs[k].kind === 'verse' && runs.slice(k + 1).some((run) => run.kind === 'chorus' || run.kind === 'drop')) runs[k].kind = 'bridge';
      }
    }
    // the drops
    const kinds = new Array(n);
    for (const run of runs) for (let b = run.b0; b < run.b1; b += 1) kinds[b] = run.kind;
    for (let b = 0; b < n; ) {
      if (middle(b) < 0.85) {
        b += 1;
        continue;
      }
      let e = b;
      while (e < n && middle(e) >= 0.85) e += 1;
      if (e - b >= MIN_PART_BARS) for (let k = b; k < e; k += 1) if (kinds[k] !== 'bridge') kinds[k] = 'drop';
      b = e;
    }
    for (const t of drops) {
      const b = Math.max(0, after(bars, t + 1e-6, 'start') - 1);
      if (kinds[b] === 'bridge' || kinds[b] === 'drop' || b + MIN_PART_BARS > n || meanOf(b, b + MIN_PART_BARS) < 0.8) continue;
      let e = b + MIN_PART_BARS;
      while (e < n && e - b < 16 && kinds[e] !== 'bridge' && middle(e) >= 0.55) e += 1;
      for (let k = b; k < e; k += 1) if (kinds[k] !== 'bridge') kinds[k] = 'drop';
    }
    runs = settle(runsOf(kinds));
    // a long part is several phrases
    const phrases = [];
    for (const run of runs) {
      const size = run.b1 - run.b0;
      const count = size > 16 ? Math.ceil(size / 12) : 1;
      for (let i = 0; i < count; i += 1) phrases.push({ b0: run.b0 + Math.round((i * size) / count), b1: run.b0 + Math.round(((i + 1) * size) / count), kind: run.kind, piece: i });
    }
    const seen = {};
    return phrases.map((run) => {
      seen[run.kind] = (seen[run.kind] || 0) + 1;
      return { ...run, n: seen[run.kind], rank: r3(meanOf(run.b0, run.b1)) };
    });
  }

  // The frames in which a word is sung in a lip-sync cut (`performance`): one frame before the word to one after it, cut to the cut; gaps of less than
  // two frames are closed (no glitch fits there). [[first, end)] in frames of the song, sorted.
  function quietOf(g) {
    const sung = (g.cuts || []).filter((cut) => cut.kind === 'performance');
    const spans = [];
    for (const line of g.lines || []) {
      for (const word of line.words || []) {
        for (const cut of sung) {
          const a = Math.max(frameOf(word.start) - 1, frameOf(cut.start));
          const b = Math.min(frameOf(word.end) + 1, frameOf(cut.end));
          if (b > a) spans.push([a, b]);
        }
      }
    }
    return mergeSpans(spans, 1);
  }

  // The frames of the lip-sync cuts: [[first, end)], sorted, apart.
  function lipOf(g) {
    const spans = (g.cuts || []).filter((cut) => cut.kind === 'performance').map((cut) => [frameOf(cut.start), frameOf(cut.end)]);
    return mergeSpans(spans.filter((span) => span[1] > span[0]), 0);
  }

  // The first half second of every graphic of the HUD (from the moment it appears): [[first, end)], sorted, apart.
  function freshOf(g) {
    const spans = [];
    for (const device of g.devices || []) {
      const at = num(device.appear, num(device.start, NaN));
      if (Number.isFinite(at)) spans.push([frameOf(at), frameOf(at) + FRESH_FRAMES]);
    }
    return mergeSpans(spans, 0);
  }

  // The frames where the film may be cut into chunks (chunks.js): the cuts, and every SEAM_FRAMES inside a cut that is longer. Sorted.
  function seamsOf(g) {
    const cuts = (g.cuts || []).map((cut) => frameOf(cut.start));
    const end = Math.round(num(g.endFrame, 0));
    const bounds = [...new Set([...cuts, end])].sort((a, b) => a - b);
    const points = new Set(bounds);
    for (let i = 0; i + 1 < bounds.length; i += 1) for (let f = bounds[i] + SEAM_FRAMES; f < bounds[i + 1]; f += SEAM_FRAMES) points.add(f);
    return [...points].sort((a, b) => a - b);
  }

  // [[a, b)] sorted and joined where they overlap or where no more than `gap` frames lie between them: the spans are apart and in order of their ends too
  function mergeSpans(spans, gap) {
    const out = [];
    for (const span of spans.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
      const last = out[out.length - 1];
      if (last && span[0] <= last[1] + gap) last[1] = Math.max(last[1], span[1]);
      else out.push(span.slice());
    }
    return out;
  }

  // is the frame f inside one of the spans [[a, b)] (apart, sorted)?
  function inSpans(spans, f) {
    const index = after(spans, f, 0) - 1;
    return index >= 0 && f < spans[index][1];
  }

  // does [f, f + n) touch one of the spans (apart, sorted)? The last span that starts before f + n has the latest end of those that do.
  function touchesSpans(spans, f, n) {
    const index = after(spans, f + n - 1, 0) - 1;
    return index >= 0 && spans[index][1] > f;
  }

  // The seed of the song: from its tempo, its length and its first beats (the same song gives the same palettes).
  function songSeed(g) {
    const music = g.music || {};
    const beats = music.beats || [];
    let seed = Math.floor(hash(Math.round(num(music.bpm, 120) * 100), beats.length, Math.round(num(g.duration, 0) * 10)) * 4294967296);
    beats.slice(0, 16).forEach((t, i) => {
      seed = Math.floor(hash(seed, frameOf(num(t, 0)), i + 1) * 4294967296);
    });
    return seed >>> 0;
  }

  /* ---------- the palettes ---------- */

  // the kinds of motion and light (the others are the glitch of the signal, the time effects and the lens)
  const MOTION_KINDS = Object.freeze(['punch', 'pulse', 'shake', 'turn', 'bulge', 'wave', 'flash']);

  // The palette of every part (part.palette, in the order its accents take the kinds). The first part of a kind: a leading kind from `first`, the rest
  // from the pool, at most two of motion and light; kinds that the film has not used yet come first, and at most two kinds of the part before it. A
  // later part of the same kind keeps the leading kind of the first one and changes one other kind (two in a palette of four or more) for one of the
  // same sort, and takes them in another order. Every palette has a glitch of the signal (with the slider above 0). The palette of a part in which
  // words are sung in lip-sync cuts for a fifth of its frames or more (part.sung) has a kind that may come on a downbeat while a word is sung, so the
  // part keeps its beat.
  function palettesOf(parts, level, seed, glitchOn) {
    const rules = LEVEL[level];
    const fits = (kind) => !rules.never.includes(kind) && (glitchOn || !KINDS[kind].glitch);
    const motion = (kind) => MOTION_KINDS.includes(kind);
    const glitchy = (kind) => Boolean(KINDS[kind].glitch);
    const safe = (kind) => KINDS[kind].sung !== false && KINDS[kind].lip !== false && KINDS[kind].on.includes('down');
    const used = new Map();
    const first = {};
    let before = [];
    const kindIndex = (kind) => KIND_NAMES.indexOf(kind);
    parts.forEach((part, index) => {
      const spec = PALETTES[part.k];
      const size = clamp(spec.size + rules.size, 3, 5);
      const pool = spec.pool.filter(fits);
      const score = (kind, salt) => (used.get(kind) || 0) + hash(seed, index * 97 + salt, kindIndex(kind));
      const best = (list, salt) => list.slice().sort((a, b) => score(a, salt) - score(b, salt));
      let palette;
      if (first[part.k] && first[part.k].length) {
        const base = first[part.k];
        const change = Math.min(base.length - 1, size >= 4 ? 2 : 1);
        palette = base.slice(0, base.length - change);
        // what it keeps of the first one (the fix below does not take it away)
        part.kept = palette.slice();
        for (const gone of base.slice(base.length - change)) {
          const free = pool.filter((kind) => !base.includes(kind) && !palette.includes(kind));
          const same = free.filter((kind) => motion(kind) === motion(gone));
          const pick = best(same.length ? same : free, 5)[0];
          if (pick) palette.push(pick);
        }
        for (const kind of base) if (palette.length < 3 && !palette.includes(kind)) palette.push(kind);
      } else {
        const leads = spec.first.filter(fits);
        const lead = best(leads.length ? leads : pool, 1)[0];
        palette = lead ? [lead] : [];
        const rest = best(pool.filter((kind) => kind !== lead), 2);
        const add = (kind) => {
          if (palette.length >= size || palette.includes(kind)) return;
          if (motion(kind) && palette.filter(motion).length >= 2) return;
          if (before.includes(kind) && palette.filter((other) => before.includes(other)).length >= 2) return;
          palette.push(kind);
        };
        // two kinds that are not motion or light first (the lead counts), then the others
        for (const kind of rest) if (!motion(kind) && palette.filter((other) => !motion(other)).length < 2) add(kind);
        for (const kind of rest) add(kind);
        for (const kind of rest) if (palette.length < size && !palette.includes(kind)) palette.push(kind);
      }
      // a glitch of the signal in every palette (with the slider above 0): it takes the place of the last kind after the lead that is no motion or light
      // (the time effects and the lens are no glitch), so a chorus of echo, blur, flash and shake gets its RGB split, slices or blocks
      if (glitchOn && !palette.some(glitchy)) {
        const pick = best(pool.filter((kind) => glitchy(kind) && !palette.includes(kind)), 11)[0];
        const at = palette.map((other, i) => ({ other, i })).reverse().find((item) => item.i > 0 && !motion(item.other));
        if (pick && at) palette[at.i] = pick;
        else if (pick) palette.push(pick);
      }
      if (!first[part.k]) first[part.k] = palette;
      if (part.sung >= 0.2 && !palette.some(safe)) {
        // not the only glitch of the palette
        const out = palette.map((other, i) => ({ other, i })).reverse().find((item) => item.i > 0 && !(glitchy(item.other) && palette.filter(glitchy).length === 1)) || null;
        const same = pool.filter((kind) => safe(kind) && (!out || motion(kind) === motion(out.other)));
        const pick = best(same.length ? same : pool.filter(safe), 9)[0];
        if (pick && out) palette[out.i] = pick;
        else if (pick) palette.push(pick);
      }
      for (const kind of palette) used.set(kind, (used.get(kind) || 0) + 1);
      // the order the accents take them: the leading kind first, the rest by the seed of this part
      part.palette = [palette[0], ...palette.slice(1).sort((a, b) => hash(seed, index * 13 + 3, kindIndex(a)) - hash(seed, index * 13 + 3, kindIndex(b)))].filter(Boolean);
      before = palette;
    });
    // every kind in some palette: a kind that no palette took replaces, in the longest part whose pool has it, a kind that two or more palettes have
    // (not the leading kind, not the only kind for a sung downbeat, not the only glitch, not a kind that the later parts of its sort keep of the first),
    // or joins a palette that has room
    const count = (kind) => parts.filter((part) => part.palette.includes(kind)).length;
    const keptOf = (sort) => new Set(parts.filter((part) => part.k === sort && part.kept).flatMap((part) => part.kept));
    for (const kind of Object.keys(KINDS).filter(fits)) {
      if (count(kind) > 0) continue;
      const hosts = parts.filter((part) => PALETTES[part.k].pool.includes(kind)).sort((a, b) => b.b1 - b.b0 - (a.b1 - a.b0) || a.b0 - b.b0);
      for (const host of hosts) {
        const keeps = (other, test) => !test(other) || host.palette.filter(test).length > 1 || test(kind);
        const kept = keptOf(host.k);
        const at = host.palette.findIndex((other, i) => i > 0 && count(other) >= 2 && keeps(other, safe) && (!glitchOn || keeps(other, glitchy)) && !kept.has(other));
        if (at > 0) host.palette[at] = kind;
        // or one more kind in a palette that has room (at most 5, at most two of motion and light)
        else if (host.palette.length < 5 && !(motion(kind) && host.palette.filter(motion).length >= 2)) host.palette.push(kind);
        else continue;
        break;
      }
    }
  }

  /* ---------- the plan ---------- */

  // The flashes that the HUD draws itself: a cut with the transition `flash` (2 frames of white) and, in the style Kuble, the pulse of the accent on a hit
  // (themes.js fx.pulse). Frames of the song.
  function fixedFlashFrames(g) {
    const out = [];
    (g.cuts || []).forEach((cut, index) => {
      if (index + (g.cutsBefore || 0) > 0 && cut.transition === 'flash') out.push(frameOf(cut.start));
    });
    const fx = themes.get(g.theme).fx;
    if (fx && fx.pulse) for (const hit of (g.music && g.music.hits) || []) if (clamp(num(hit.strength, 0), 0, 1) >= fx.pulse.from) out.push(Math.ceil(hit.t * FPS - 1e-6));
    return out.sort((a, b) => a - b);
  }

  // Would one more flash at the frame f keep every second (24 frames from any frame) at FLASH_LIMIT flashes or fewer? `taken` is sorted.
  function flashFits(taken, f) {
    const lo = after(taken, f - FPS);
    const hi = after(taken, f + FPS - 1);
    const near = taken.slice(lo, hi);
    near.push(f);
    near.sort((a, b) => a - b);
    for (let i = 0; i < near.length; i += 1) {
      let count = 0;
      for (let j = i; j < near.length && near[j] < near[i] + FPS; j += 1) count += 1;
      if (count > FLASH_LIMIT) return false;
    }
    return true;
  }

  function insertSorted(list, value) {
    list.splice(after(list, value), 0, value);
  }

  // planEffects(graphics, { level, glitch }) -> the plan, or null for `off`. `graphics` is the resolved data of the whole film (graphics.js
  // resolveGraphics); `glitch` the slider of the node (0 to 1, 0.6 by default: the strength of the glitch kinds; 0 leaves them out).
  //   from, to, fromF, toF  the song time (and frame) of the first frame of the film and of the end card (nothing at or after `to`)
  //   seed       the seed of the song
  //   parts      [{ f0, f1, k, n, g: [brightness, contrast, saturation], m, palette }] in frames of the song (k: break, verse, chorus, bridge, drop;
  //              n: the how-many-th of its kind; m: the shake that is always there)
  //   quiet      [[a, b)]: the frames of the sung words of the lip-sync cuts; fresh: the first half second of the graphics of the HUD
  //   events     [{ k, f, ... }] sorted by the frame f: one kind of KINDS (n: frames, a: the amplitude, v: the variant, ...); x: the number of the
  //              accent (w: 1 for the zoom punch or shake that comes with a burst); the flashes of the sections and the strobe have none
  //   spans      [{ k, f, n, a, ... }] the stretches over bars: split (the RGB split of the drop), noise (into the bridge), scan (a break)
  //   copies     [{ f, n, m, r, s }] the copies of the footage: from frame f for n frames the clip shows the footage from the song frame m at the
  //              playback rate r (0.1 holds the frame), with the style s (COPY_STYLES)
  //   look       { colors, invert } of the style
  function planEffects(graphics, options = {}) {
    const level = normalizeLevel(options.level);
    if (level === 'off') return null;
    const g = graphics;
    const rules = LEVEL[level];
    const slider = clamp(num(options.glitch, GLITCH_DEFAULT), 0, 1);
    const glitchGain = slider / GLITCH_DEFAULT;
    const music = g.music || {};
    const fromF = frameOf(num(g.start, 0));
    const toF = Math.round(num(g.endFrame, frameOf(num(g.duration, 0))));
    const seed = songSeed(g);
    const beats = beatsOf(g);
    const bars = barsOf(g, beats);
    const barRank = barRanks(g, bars);
    const runs = partsOf(g, bars, barRank);
    const quiet = quietOf(g);
    const lip = lipOf(g);
    const fresh = freshOf(g);
    const seams = seamsOf(g);
    const look = lookOf(g);
    const barFrames = (b) => Math.max(1, frameOf(bars[b].end) - frameOf(bars[b].start));
    const beatFrames = Math.max(6, Math.round(FPS * clamp(60 / num(music.bpm, 120), 0.25, 1.5)));

    const parts = runs.map((run) => {
      const base = GRADES[run.kind];
      const again = Math.min(2, run.n - 1);
      const grade = base.map((value, i) => r3(1 + (value - 1) * rules.grade + (i === 2 ? 0.04 * again : i === 1 ? 0.02 * again : 0)));
      return { f0: frameOf(bars[run.b0].start), f1: frameOf(bars[run.b1 - 1].end), k: run.kind, n: run.n, g: grade, m: run.kind === 'drop' ? rules.micro : 0, b0: run.b0, b1: run.b1 };
    });
    for (const part of parts) {
      let frames = 0;
      for (const [a, b] of quiet) frames += Math.max(0, Math.min(b, part.f1) - Math.max(a, part.f0));
      part.sung = frames / Math.max(1, part.f1 - part.f0);
    }
    palettesOf(parts, level, seed, slider > 0);
    const partFrames = parts.map((part) => part.f0);
    const partAt = (f) => parts[Math.max(0, after(partFrames, f) - 1)];

    const live = (f, n = 1) => f >= fromF && f + n <= toF;
    // may a kind be drawn in the frames [f, f + n)? (the film, the face in a lip-sync cut, a new graphic of the HUD)
    const allowed = (kind, f, n) => {
      const spec = KINDS[kind];
      if (!live(f, n)) return false;
      if (spec.lip === false && touchesSpans(lip, f, n)) return false;
      if (spec.sung === false && touchesSpans(quiet, f, n)) return false;
      if (spec.layer === 'all' && touchesSpans(fresh, f, n)) return false;
      return true;
    };
    // the frames [a, b) lie in one piece of the footage (no point where the film may be cut into chunks lies inside)
    const oneSeam = (a, b) => {
      const index = after(seams, a);
      return index >= seams.length || seams[index] >= b;
    };

    const events = [];
    const spans = [];
    const copies = [];
    const taken = fixedFlashFrames(g);
    // the white of a cut with the flash of the HUD: its first two frames (and the frame before them) take no flash and no accent, under it nothing is seen
    const whites = (g.cuts || []).filter((cut, index) => index + (g.cutsBefore || 0) > 0 && cut.transition === 'flash').map((cut) => frameOf(cut.start));
    const onWhite = (f) => whites.find((white) => f >= white - 1 && f <= white + 1);

    // the flashes of the sections (the start of a chorus or a drop that is louder than the part before it), the negative flash and the strobe of a drop
    const flashes = [];
    const order = (kind) => PART_KINDS.indexOf(kind);
    parts.forEach((part, index) => {
      if (index === 0 || part.f0 <= fromF) return;
      const louder = order(part.k) > order(parts[index - 1].k) || (part.k === 'chorus' && parts[index - 1].k !== 'chorus');
      if ((part.k === 'chorus' || part.k === 'drop') && louder && rules.sectionFlash) flashes.push({ weight: 0, f: part.f0, c: 0, a: rules.sectionFlash, n: 2, m: 0 });
    });
    let lastStrobe = -Infinity;
    parts.forEach((part) => {
      if (part.k !== 'drop' || part.b1 - part.b0 < 2) return;
      if (part.f0 - lastStrobe < 12 * barFrames(part.b0)) return;
      lastStrobe = part.f0;
      if (rules.negative) flashes.push({ weight: 1, f: frameOf(bars[part.b0 + 1].start), invert: true, n: 2 });
      if (rules.strobe) {
        const until = frameOf(bars[Math.min(part.b1, part.b0 + rules.strobe) - 1].end);
        for (const time of beats) {
          const f = frameOf(time);
          if (f >= part.f0 && f < until) flashes.push({ weight: 3, f, c: 0, a: 0.5, n: 1, m: 0 });
        }
      }
    });
    flashes.sort((a, b) => a.weight - b.weight || a.f - b.f);
    const flashAt = new Set();
    for (const item of flashes) {
      if (!live(item.f, item.n) || flashAt.has(item.f) || onWhite(item.f) !== undefined || !flashFits(taken, item.f)) continue;
      flashAt.add(item.f);
      insertSorted(taken, item.f);
      if (item.invert) events.push({ k: 'negative', f: item.f, n: item.n });
      else events.push({ k: 'flash', f: item.f, c: item.c, a: item.a, n: item.n, m: item.m });
    }

    // the accents: the downbeats of loud bars (and the third beat in a loud drop), the strong hits, the cuts, the starts of the parts
    const candidates = [];
    const downFrames = bars.map((bar) => frameOf(bar.start));
    parts.forEach((part) => {
      const want = rules.accents[part.k];
      for (let b = part.b0; b < part.b1; b += 1) {
        const f = downFrames[b];
        const first = b === part.b0;
        if (first && f > fromF) candidates.push({ f, on: 'start', s: 1, burst: true });
        else if (want.every && (b - part.b0) % want.every === 0 && barRank[b] >= want.from) candidates.push({ f, on: 'down', s: 0.5 + 0.5 * barRank[b], loud: barRank[b] >= 0.5 });
        if (want.third !== undefined && barRank[b] >= want.third) {
          const inBar = beats.filter((t) => t >= bars[b].start - 1e-6 && t < bars[b].end - 1e-6);
          if (inBar.length >= 3) candidates.push({ f: frameOf(inBar[2]), on: 'beat', s: 0.4 + 0.4 * barRank[b] });
        }
      }
    });
    const hits = (music.hits || []).filter((hit) => Number.isFinite(Number(hit.t)));
    const hitRank = ranks(hits.map((hit) => clamp(num(hit.strength, 0), 0, 1)));
    hits.forEach((hit, index) => {
      const f = frameOf(hit.t);
      const part = partAt(f);
      if (hitRank[index] >= rules.accents[part.k].hit) candidates.push({ f, on: 'hit', s: hitRank[index], burst: hitRank[index] >= rules.burstFrom, rank: hitRank[index] });
    });
    const cutCount = new Map();
    (g.cuts || []).forEach((cut, index) => {
      if (index === 0) return;
      const f = frameOf(cut.start);
      const part = partAt(f);
      const every = rules.accents[part.k].cut;
      const count = cutCount.get(part) || 0;
      cutCount.set(part, count + 1);
      // a cut with the white flash of the HUD has the flash for its accent
      if (cut.transition === 'flash') return;
      if (cut.transition === 'glitch') candidates.push({ f, on: 'cut', s: 0.9, burst: true, cut: true });
      else if (every && count % every === 0) candidates.push({ f, on: 'cut', s: 0.6, cut: true });
    });
    // an accent of a hit, a downbeat or a start on the white of such a cut moves to the frame after the white
    for (const item of candidates) {
      const white = onWhite(item.f);
      if (white !== undefined) item.f = white + 2;
    }
    // one accent where several meet: the stronger one (a start, then a burst), with the ways in of both
    candidates.sort((a, b) => a.f - b.f);
    const accents = [];
    const weight = (item) => (item.on === 'start' ? 3 : 0) + (item.burst ? 2 : 0) + item.s;
    for (const item of candidates) {
      const last = accents[accents.length - 1];
      if (last && item.f - last.f < rules.gap) {
        const keep = weight(item) > weight(last) ? item : last;
        const other = keep === item ? last : item;
        accents[accents.length - 1] = { ...keep, ons: [...new Set([...(keep.ons || [keep.on]), ...(other.ons || [other.on])])], burst: keep.burst || other.burst, cut: keep.cut || other.cut, loud: keep.loud || other.loud };
      } else accents.push({ ...item, ons: [item.on] });
    }

    // one kind for every accent
    const used = new Map();
    const capOf = (kind) => Math.max(1, Math.round(CAPS[kind] * rules.caps));
    const capped = (kind, f) => {
      const list = used.get(kind) || [];
      let count = 0;
      for (let i = list.length - 1; i >= 0 && list[i] > f - 60 * FPS; i -= 1) count += 1;
      return count >= capOf(kind);
    };
    const note = (kind, f) => {
      if (!used.has(kind)) used.set(kind, []);
      used.get(kind).push(f);
    };
    const amp = (kind, accent) => {
      if (!AMP[kind]) return 0;
      const [lo, hi] = AMP[kind];
      const s = accent.burst || accent.ons.includes('start') ? 1 : clamp((accent.s - 0.5) / 0.5, 0, 1);
      const gain = KINDS[kind].glitch ? rules.gain * clamp(glitchGain, 0, 1.67) : rules.gain;
      return (lo + (hi - lo) * s) * gain;
    };
    const lengthOf = (kind, accent) => {
      const spec = KINDS[kind];
      const top = Math.min(rules.burstMax, spec.max || BURST_FRAMES[1]);
      if (accent.burst) {
        const over = accent.rank !== undefined ? clamp((accent.rank - rules.burstFrom) / Math.max(0.01, 1 - rules.burstFrom), 0, 1) : 0.5;
        return clamp(Math.round(BURST_FRAMES[0] + (BURST_FRAMES[1] - BURST_FRAMES[0]) * over), BURST_FRAMES[0], top);
      }
      if (spec.long) return clamp(Math.round(6 + 4 * clamp((accent.s - 0.5) / 0.5, 0, 1)), BURST_FRAMES[0], top);
      return clamp(Math.round(SHORT_FRAMES[0] + (SHORT_FRAMES[1] - SHORT_FRAMES[0]) * clamp((accent.s - 0.5) / 0.5, 0, 1)), SHORT_FRAMES[0], SHORT_FRAMES[1]);
    };
    let spin = 1;
    // the event (and the copies) of a kind on an accent, or null when it does not fit there
    const make = (kind, accent) => {
      const spec = KINDS[kind];
      if (!spec.on.some((on) => accent.ons.includes(on))) return null;
      // zoom punch and exposure pulse: only on a downbeat of a loud bar (the upper half of the song), a strong hit or the start of a part
      if ((kind === 'punch' || kind === 'pulse') && !(accent.loud || accent.ons.includes('hit') || accent.ons.includes('start'))) return null;
      let f = accent.f;
      let n;
      const a = amp(kind, accent);
      let event;
      const out = { events: [], copies: [] };
      switch (kind) {
        case 'punch':
        case 'pulse':
          n = 10;
          event = { k: kind, f, a: r4(a) };
          break;
        case 'shake':
        case 'bulge':
        case 'wave':
          n = 10;
          event = { k: kind, f, a: r1(a) };
          break;
        case 'turn':
          n = 12;
          event = { k: kind, f, a: r3(a * spin) };
          break;
        case 'chroma':
          n = 4;
          event = { k: kind, f, a: r1(a), n };
          break;
        case 'blur': {
          // a zoom blur or a blur sideways, from the frame before the cut to two after it
          f -= 1;
          n = 3;
          const zoom = hash(f, 3, seed) < 0.5;
          event = { k: kind, f, a: r1((zoom ? AMP.blur[1] : AMP.blur[0]) * rules.gain), d: zoom ? 2 : 1, n };
          break;
        }
        case 'flash':
          n = 2;
          event = { k: kind, f, c: 1, a: r3(clamp(a, 0, 1)), n, m: 1 };
          break;
        case 'rgb':
        case 'blocks':
        case 'slices':
          n = lengthOf(kind, accent);
          // over a cut: from the frame before it (a glitch that carries the picture over)
          if (accent.cut && accent.ons.includes('cut')) f -= 1;
          event = { k: kind, f, n, a: r1(a), v: Math.floor(hash(f, 7, seed) * (kind === 'blocks' ? 3 : 1000)) };
          break;
        case 'noise':
        case 'snow':
          n = lengthOf(kind, accent);
          event = { k: kind, f, n, a: r3(clamp(a, 0, 0.8)), v: kind === 'snow' || accent.burst ? 1 : 0 };
          break;
        case 'pixel':
          n = lengthOf(kind, accent);
          event = { k: kind, f, n, a: 2 * Math.round(a / 2) };
          break;
        case 'scan':
          n = lengthOf(kind, accent);
          event = { k: kind, f, n, a: r3(clamp(a, 0, 0.6)), j: r1(10 + 8 * clamp(glitchGain, 0, 1.67) * rules.gain) };
          break;
        case 'vhs': {
          n = lengthOf(kind, accent);
          const h = Math.round(80 + 70 * hash(f, 11, seed));
          const y0 = Math.round(60 + 500 * hash(f, 12, seed));
          event = { k: kind, f, n, a: r1(a), h, y0, y1: Math.min(HEIGHT - h, y0 + Math.round(300 + 300 * hash(f, 13, seed))) };
          break;
        }
        case 'roll':
          n = lengthOf(kind, accent);
          event = { k: kind, f, n };
          break;
        case 'smear':
        case 'stutter':
        case 'echo':
        case 'mirror': {
          n = lengthOf(kind, accent);
          let variant = Math.floor(hash(f, 17, seed) * 3);
          if (kind === 'mirror' && variant === 2 && !(accent.ons.includes('start') || level === 'wild')) variant = Math.floor(hash(f, 18, seed) * 2);
          // the stutter: 0 the four frames before it twice (it skips back), 1 a held frame, 2 every third frame held (a judder)
          if (kind === 'stutter' && variant === 0) n = 8;
          // the frames the copies show lie in the footage of one chunk: from `back` frames before the copy to its end, no point where the film may
          // be cut into chunks (a stutter that cannot go back holds instead)
          let back = kind === 'echo' ? 4 : kind === 'stutter' && variant === 0 ? 4 : 0;
          if (back && (f - back < fromF || !oneSeam(f - back, f + n))) {
            if (kind === 'echo') return null;
            variant = 1;
            back = 0;
          }
          if (!oneSeam(f, f + n)) return null;
          const hold = (from, frames, media) => {
            for (let k = 0; k < frames; k += HOLD_FRAMES) out.copies.push({ f: from + k, n: Math.min(HOLD_FRAMES, frames - k), m: media, r: 0.1, s: 'plain' });
          };
          if (kind === 'smear') {
            hold(f, n, f);
            event = { k: kind, f, n, a: r1(a) };
          } else if (kind === 'stutter') {
            if (variant === 0) for (let k = 0; k < n; k += 4) out.copies.push({ f: f + k, n: Math.min(4, n - k), m: f - 4, r: 1, s: 'plain' });
            else if (variant === 1) hold(f, n, f);
            else for (let k = 0; k < n; k += 3) out.copies.push({ f: f + k, n: Math.min(3, n - k), m: f + k, r: 0.1, s: 'plain' });
            event = { k: kind, f, n, v: variant };
          } else if (kind === 'echo') {
            out.copies.push({ f, n, m: f - 4, r: 1, s: 'echo' });
            event = { k: kind, f, n };
          } else {
            const styles = variant === 2 ? ['kx', 'ky', 'kxy'] : [variant === 0 ? 'left' : 'right'];
            for (const style of styles) out.copies.push({ f, n, m: f, r: 1, s: style });
            event = { k: kind, f, n, v: variant };
          }
          break;
        }
        default:
          return null;
      }
      if (!allowed(kind, f, n)) return null;
      if (spec.flash && !flashFits(taken, f)) return null;
      out.events.push(event);
      return out;
    };

    let previous = [];
    let accentNo = 0;
    let companion = 0;
    for (const accent of accents) {
      const part = partAt(accent.f);
      if (!part.palette.length) continue;
      if (part.cursor === undefined) part.cursor = 0;
      // the start of a part opens with its leading kind (into a bridge a VHS band, into a drop a block glitch, when they fit); otherwise the kind of
      // the palette that the film has used least so far, then the one whose turn it is
      const lead = accent.ons.includes('start') ? [...(part.k === 'bridge' ? ['vhs'] : part.k === 'drop' ? ['blocks'] : []), part.palette[0]] : [];
      const turn = part.palette.map((_kind, i) => part.palette[(part.cursor + i) % part.palette.length]);
      const count = (kind) => (used.get(kind) || []).length;
      const tries = [...lead.filter((kind) => !rules.never.includes(kind) && (slider > 0 || !KINDS[kind].glitch)), ...turn.slice().sort((a, b) => count(a) - count(b) || turn.indexOf(a) - turn.indexOf(b))];
      let chosen = null;
      for (const kind of tries) {
        if (previous.includes(kind) || capped(kind, accent.f)) continue;
        const made = make(kind, accent);
        if (!made) continue;
        chosen = { kind, made };
        const at = part.palette.indexOf(kind);
        if (at >= 0) part.cursor = (at + 1) % part.palette.length;
        break;
      }
      if (!chosen) continue;
      const kinds = [chosen.kind];
      accentNo += 1;
      chosen.made.events.forEach((event) => events.push({ ...event, x: accentNo }));
      copies.push(...chosen.made.copies);
      note(chosen.kind, accent.f);
      if (chosen.kind === 'turn') spin = -spin;
      if (KINDS[chosen.kind].flash) insertSorted(taken, chosen.made.events[0].f);
      // a burst on a strong hit, or at the start of a loud part, hits harder: a zoom punch or a shake with it (one that is not in the palette of the
      // part, so it takes no turn from the palette)
      const loud = part.k === 'chorus' || part.k === 'drop' || part.k === 'bridge';
      if (accent.burst && level !== 'subtle' && (accent.ons.includes('hit') || (loud && accent.ons.includes('start')))) {
        // punch and shake take turns
        companion += 1;
        for (const kind of companion % 2 ? ['punch', 'shake'] : ['shake', 'punch']) {
          if (previous.includes(kind) || kind === chosen.kind || part.palette.includes(kind) || capped(kind, accent.f)) continue;
          const made = make(kind, { ...accent, ons: [...accent.ons, 'hit'] });
          if (!made) continue;
          made.events.forEach((event) => events.push({ ...event, x: accentNo, w: 1 }));
          note(kind, accent.f);
          kinds.push(kind);
          break;
        }
      }
      previous = kinds;
    }

    // the stretches over bars (glitch kinds: only with the slider above 0)
    if (slider > 0) {
      const gain = rules.gain * clamp(glitchGain, 0, 1.67);
      parts.forEach((part) => {
        // the drop: the RGB split on the footage over its first bars, again every 8 bars; its direction wanders round in two bars
        if (part.k === 'drop') {
          for (let b = part.b0; b < part.b1; b += 8) {
            const f = Math.max(fromF, frameOf(bars[b].start));
            const end = Math.min(toF, frameOf(bars[Math.min(part.b1, b + rules.split) - 1].end));
            if (end - f >= 12) spans.push({ k: 'split', f, n: end - f, a: r1(rules.splitPx * clamp(glitchGain, 0, 1.67)), v: r3(hash(f, 21, seed)), p: 2 * barFrames(b) });
          }
        }
        // the way into a bridge: noise from the bar before it to the end of its first bar, the strongest at its start
        if (part.k === 'bridge' && part.b0 > 0) {
          const f = Math.max(fromF, frameOf(bars[part.b0 - 1].start));
          const end = Math.min(toF, frameOf(bars[Math.min(part.b1, part.b0 + 1) - 1].end));
          if (end - f >= 12) spans.push({ k: 'noise', f, n: end - f, a: r3(clamp(0.34 * gain, 0, 0.6)), v: 1, top: part.f0 - f });
        }
        // a break: scanlines over the footage, light
        if (part.k === 'break' && rules.scan) {
          const f = Math.max(fromF, part.f0);
          const end = Math.min(toF, part.f1);
          if (end - f >= 2 * FPS) spans.push({ k: 'scan', f, n: end - f, a: r3(clamp(rules.scan * clamp(glitchGain, 0, 1.67), 0, 0.4)) });
        }
      });
    }

    events.sort((a, b) => a.f - b.f || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
    spans.sort((a, b) => a.f - b.f);
    copies.sort((a, b) => a.f - b.f || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
    return {
      version: 2,
      level,
      glitch: slider,
      seed,
      from: fromF / FPS,
      to: toF / FPS,
      fromF,
      toF,
      beat: beatFrames,
      look,
      parts: parts.map((part) => ({ f0: part.f0, f1: part.f1, k: part.k, n: part.n, g: part.g, m: part.m, palette: part.palette })),
      quiet,
      fresh,
      events,
      spans,
      copies
    };
  }

  // The part of the plan that the frames from `from` to `to` (song seconds) need: the events that still run at `from` included.
  function sliceEffects(plan, from, to) {
    if (!plan) return null;
    const a = Math.floor(from * FPS) - LONGEST_FRAMES - 1;
    const b = Math.ceil(to * FPS) + 1;
    return {
      ...plan,
      parts: plan.parts.filter((part) => part.f1 >= a - BLEND_FRAMES && part.f0 <= b),
      quiet: plan.quiet.filter((span) => span[1] >= a && span[0] <= b),
      fresh: plan.fresh.filter((span) => span[1] >= a && span[0] <= b),
      events: plan.events.filter((event) => event.f >= a && event.f <= b),
      spans: plan.spans.filter((span) => span.f + span.n >= a && span.f <= b),
      copies: plan.copies.filter((copy) => copy.f + copy.n > Math.floor(from * FPS) - 1 && copy.f <= b)
    };
  }

  /* ---------- one frame ---------- */

  const NEUTRAL = Object.freeze({
    zoom: 1, x: 0, y: 0, rot: 0, bulge: 0, wave: 0, phase: 0, blur: 0, dir: 0, chroma: 0, b: 1, c: 1, s: 1, flash: null, invert: '',
    split: null, jitter: null, pixel: 0, smear: null, noise: null, scan: 0, rgb: null, slices: null, blocks: null, vhs: null, roll: 0, snow: null
  });

  // The smallest zoom (round the middle) at which the picture, moved by (x, y) px and turned by `rot` degrees, still covers the whole screen with
  // the part of it that lies `margin` px (of the picture) inside its left and right edges. Both directions of the turn are checked (the move and the
  // turn may go either way).
  function coverZoom(x, y, rot, margin = 0) {
    let need = 1;
    for (const sign of [-1, 1]) {
      const angle = (sign * rot * Math.PI) / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      for (const [cx, cy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const vx = (cx * WIDTH) / 2 - x;
        const vy = (cy * HEIGHT) / 2 - y;
        const rx = vx * cos + vy * sin;
        const ry = -vx * sin + vy * cos;
        need = Math.max(need, Math.abs(rx) / (WIDTH / 2 - margin), Math.abs(ry) / (HEIGHT / 2));
      }
    }
    return need;
  }

  // the noise texture of a frame: [opacity, the size of the tile, x, y] (the tile moves with every frame, so the noise lives)
  const noiseAt = (alpha, coarse, f, salt) => {
    const size = coarse ? 384 : 128;
    return [r3(alpha), size, Math.floor(hash(f, salt, 1) * size), Math.floor(hash(f, salt, 2) * size)];
  };

  // frameEffects(plan, t) -> the state of the frame at the song time t:
  //   zoom, x, y, rot   the transform of the footage (round the middle of the screen); the zoom always covers the screen
  //   bulge, wave       the displacement of the bulge and of the wave in px (phase: where the wave stands), blur: px of the blur (dir 1 sideways, 2 zoom)
  //   chroma            px of the chromatic edges; b, c, s: brightness, contrast, saturation; flash: { color, alpha, screen } or null; invert: the CSS
  //                     filter of the negative flash, or ''
  //   split             [dx, dy] of the RGB split of the footage; jitter: [px, row] the line offset; pixel: the cell; smear: [px, x]; noise: the noise
  //                     over the footage (noiseAt); scan: the opacity of the scanlines
  //   rgb, slices ...   over the whole picture: rgb [dx, dy]; slices [[y, h, dx] x 4]; blocks [map, px]; vhs [y, h, px, row]; roll: px; snow (noiseAt)
  function frameEffects(plan, time) {
    if (!plan) return { ...NEUTRAL };
    const f = Math.round(num(time, 0) * FPS);
    if (f < plan.fromF || f >= plan.toF) return { ...NEUTRAL };
    const out = { ...NEUTRAL };
    // the colour of the part, blended from the part before it over BLEND_FRAMES
    const parts = plan.parts;
    const pi = after(parts, f, 'f0') - 1;
    let micro = 0;
    if (pi >= 0) {
      const part = parts[pi];
      let grade = part.g;
      const into = f - part.f0;
      if (into < BLEND_FRAMES && pi > 0 && parts[pi - 1].f1 >= part.f0 - 1) {
        const w = into / BLEND_FRAMES;
        grade = grade.map((value, i) => parts[pi - 1].g[i] + (value - parts[pi - 1].g[i]) * w);
      }
      [out.b, out.c, out.s] = grade;
      micro = part.m || 0;
    }
    const quiet = inSpans(plan.quiet, f);
    const fresh = inSpans(plan.fresh, f);
    let punch = 0;
    let pulse = 0;
    let shake = micro;
    let split = 0;
    let splitAngle = 0;
    for (let i = after(plan.events, f - LONGEST_FRAMES - 1, 'f'); i < plan.events.length && plan.events[i].f <= f; i += 1) {
      const e = plan.events[i];
      const age = f - e.f;
      switch (e.k) {
        case 'punch':
          if (age < 10) punch = Math.max(punch, e.a * Math.exp(-age / 2.2));
          break;
        case 'pulse':
          if (age < 9) pulse = Math.max(pulse, e.a * Math.exp(-age / 2.4));
          break;
        case 'shake':
          if (age < 10) shake = Math.max(shake, e.a * Math.exp(-age / 3));
          break;
        case 'turn':
          if (age < 12) out.rot += e.a * Math.exp(-age / 3.2) * Math.cos(age * 0.85);
          break;
        case 'bulge':
          if (age < 6) out.bulge = Math.max(out.bulge, e.a * Math.exp(-age / 1.6));
          break;
        case 'wave':
          if (age < 8) out.wave = Math.max(out.wave, e.a * Math.sin((Math.PI * (age + 1)) / 9));
          break;
        case 'chroma':
          if (age < e.n) out.chroma = Math.max(out.chroma, e.a * (1 - age / e.n));
          break;
        case 'blur':
          if (age < 3) {
            const amount = e.a * [0.55, 1, 0.5][age];
            if (amount > out.blur) {
              out.blur = amount;
              out.dir = e.d;
            }
          }
          break;
        case 'flash':
          if (age < e.n) out.flash = { color: plan.look.colors[e.c] || plan.look.colors[0], alpha: r3(age === 0 ? e.a : e.a * 0.4), screen: e.m === 1 };
          break;
        case 'negative':
          if (age < e.n) out.invert = plan.look.invert;
          break;
        case 'rgb':
          if (age < e.n) {
            // a short hit eases off in one direction; a burst flickers and jumps every two frames
            const burst = e.n > SHORT_FRAMES[1];
            const strength = burst ? 0.6 + 0.4 * hash(f, 31, e.f) : 1 - (0.5 * age) / (e.n + 1);
            const angle = 2 * Math.PI * (burst ? hash(f >> 1, 32, e.f) : (e.v % 1000) / 1000);
            out.rgb = [r1(e.a * strength * Math.cos(angle)), r1(e.a * strength * Math.sin(angle) * 0.35)];
          }
          break;
        case 'slices':
          if (age < e.n) {
            const key = e.n > SHORT_FRAMES[1] ? e.f * 131 + (age >> 1) : e.f * 131;
            out.slices = [0, 1, 2, 3].map((k) => [Math.floor(hash(key, k, 41) * 1000), 20 + Math.floor(hash(key, k, 42) * 120), Math.round((2 * hash(key, k, 43) - 1) * e.a)]);
          }
          break;
        case 'blocks':
          if (age < e.n) out.blocks = [(e.v + (age >> 1)) % 3, Math.round(e.a * (0.7 + 0.3 * hash(f, 51, e.f)))];
          break;
        case 'vhs':
          if (age < e.n) {
            const at = e.n > 1 ? age / (e.n - 1) : 0;
            out.vhs = [Math.round(e.y0 + (e.y1 - e.y0) * at), e.h, e.a, Math.floor(hash(f, 61, 1) * HEIGHT)];
          }
          break;
        case 'roll':
          if (age < e.n) {
            const at = (age + 1) / (e.n + 1);
            out.roll = Math.round(HEIGHT * at * at * (3 - 2 * at));
          }
          break;
        case 'snow':
          if (age < e.n) out.snow = noiseAt(e.a * (age === 0 ? 1 : 0.8), true, f, 71);
          break;
        case 'noise':
          if (age < e.n) out.noise = noiseAt(Math.max(out.noise ? out.noise[0] : 0, e.a * (age === 0 ? 1 : 0.85)), e.v === 1, f, 81);
          break;
        case 'scan':
          if (age < e.n) {
            out.scan = Math.max(out.scan, e.a);
            out.jitter = [e.j, Math.floor(hash(f, 91, 1) * HEIGHT)];
          }
          break;
        case 'pixel':
          if (age < e.n) out.pixel = Math.max(8, 2 * Math.round((e.a * (1 - (0.5 * age) / e.n)) / 2));
          break;
        case 'smear':
          if (age < e.n) out.smear = [Math.round((e.a * (age + 1)) / e.n), age * 9];
          break;
        default:
          break;
      }
    }
    // the stretches over bars: a soft start and end
    for (const s of plan.spans) {
      if (f < s.f || f >= s.f + s.n) continue;
      const age = f - s.f;
      const fade = Math.min(1, (age + 1) / 4, (s.n - age) / 6);
      if (s.k === 'split') {
        split = s.a * fade;
        splitAngle = 2 * Math.PI * (s.v + age / Math.max(1, s.p));
      } else if (s.k === 'noise') {
        // the noise grows to the start of the bridge and fades after it
        const peak = s.top > 0 ? (age <= s.top ? 0.35 + (0.65 * age) / s.top : 1 - (0.6 * (age - s.top)) / Math.max(1, s.n - s.top)) : 1;
        const alpha = s.a * fade * peak;
        if (!out.noise || out.noise[0] < alpha) out.noise = noiseAt(alpha, s.v === 1, f, 81);
      } else if (s.k === 'scan') out.scan = Math.max(out.scan, r3(s.a * fade));
    }
    // while a word is sung in a lip-sync cut: nothing that pulls the face out of shape (the plan puts none there); less shake, light noise, at most
    // SUNG_SPLIT_PX of colour edges and RGB split, no line offset
    if (quiet) {
      out.bulge = 0;
      out.wave = 0;
      out.blur = 0;
      out.dir = 0;
      out.chroma = Math.min(out.chroma, SUNG_SPLIT_PX);
      split = Math.min(split, SUNG_SPLIT_PX);
      shake *= 0.4;
      out.jitter = null;
      out.pixel = 0;
      out.smear = null;
      if (out.noise && out.noise[0] > 0.25) out.noise = [0.25, out.noise[1], out.noise[2], out.noise[3]];
      out.rgb = null;
      out.slices = null;
      out.blocks = null;
      out.vhs = null;
      out.roll = 0;
      out.snow = null;
    }
    // the first half second of a new graphic: nothing over the whole picture (the plan puts nothing there)
    if (fresh) {
      out.rgb = null;
      out.slices = null;
      out.blocks = null;
      out.vhs = null;
      out.roll = 0;
      out.snow = null;
    }
    if (split > 0) out.split = [r1(split * Math.cos(splitAngle)), r1(split * Math.sin(splitAngle) * 0.5)];
    out.b += pulse;
    out.c += pulse * 0.7;
    if (shake > 0) {
      out.x = shake * (2 * hash(f, 7, 41) - 1);
      out.y = shake * 0.62 * (2 * hash(f, 8, 41) - 1);
    }
    out.phase = out.wave > 0 ? (f * 23) % 180 : 0;
    out.x = r1(out.x);
    out.y = r1(out.y);
    out.rot = r3(out.rot);
    out.bulge = r1(out.bulge);
    out.wave = r1(out.wave);
    out.blur = r1(out.blur);
    if (!out.blur) out.dir = 0;
    // the zoom: the punch, at least as much as covers the screen when the picture moves, turns or waves, and when a blur sideways would show the dark
    // edges it draws there (the browser does not repeat the edge: 2.5 deviations of the blur are pushed out of the picture); rounded up
    const margin = out.wave / 2 + (out.dir === 1 ? out.blur * 2.5 : 0);
    out.zoom = Math.ceil(Math.max(1 + punch, coverZoom(out.x, out.y, out.rot, margin)) * 10000 - 1e-6) / 10000;
    out.chroma = r1(out.chroma);
    out.b = r3(out.b);
    out.c = r3(out.c);
    out.s = r3(out.s);
    return out;
  }

  /* ---------- the drawing ---------- */

  // view(state) -> { fx, all, light, grain, scan, snow, svg }: the style attribute of #fx (the wrapper of the footage), of #fxall (the wrapper of the
  // whole picture), of the layers #fx-light, #fx-grain (noise over the footage), #fx-scan (scanlines over the footage) and #fx-snow (snow over the
  // whole picture), and the attributes of the SVG filters that are in use ([id, attribute, value]; the ids of fxsvg.js).
  function view(state) {
    const s = state || NEUTRAL;
    const filters = [];
    const whole = [];
    const svg = [];
    const set = (id, attribute, value) => svg.push([id, attribute, String(value)]);
    if (s.bulge > 0) {
      filters.push('url(#fx-bulge)');
      set('fx-bulge-d', 'scale', s.bulge);
    }
    if (s.wave > 0) {
      filters.push('url(#fx-wave)');
      set('fx-wave-i', 'y', -s.phase);
      set('fx-wave-d', 'scale', s.wave);
    }
    if (s.smear) {
      filters.push('url(#fx-smear)');
      set('fx-smear-i', 'x', -s.smear[1]);
      set('fx-smear-d', 'scale', s.smear[0]);
    }
    if (s.blur > 0 && s.dir === 2) {
      filters.push('url(#fx-zoom)');
      set('fx-zoom-1', 'scale', r1(s.blur / 3));
      set('fx-zoom-2', 'scale', r1((2 * s.blur) / 3));
      set('fx-zoom-3', 'scale', s.blur);
    } else if (s.blur > 0) {
      filters.push('url(#fx-blur)');
      set('fx-blur-g', 'stdDeviation', `${s.blur} 0`);
    }
    if (s.chroma > 0) {
      filters.push('url(#fx-chroma)');
      set('fx-chroma-r', 'scale', s.chroma);
      set('fx-chroma-b', 'scale', r1(s.chroma * 0.45));
    }
    if (s.split) {
      filters.push('url(#fx-split)');
      set('fx-split-r', 'dx', s.split[0]);
      set('fx-split-r', 'dy', s.split[1]);
      set('fx-split-b', 'dx', r1(-s.split[0]));
      set('fx-split-b', 'dy', r1(-s.split[1]));
    }
    if (s.jitter) {
      filters.push('url(#fx-jitter)');
      set('fx-jitter-i', 'y', -s.jitter[1]);
      set('fx-jitter-d', 'scale', s.jitter[0]);
    }
    if (s.pixel) {
      filters.push('url(#fx-pixel)');
      const half = s.pixel / 2;
      set('fx-pixel-dot', 'x', half - 1);
      set('fx-pixel-dot', 'y', half - 1);
      set('fx-pixel-cell', 'width', s.pixel);
      set('fx-pixel-cell', 'height', s.pixel);
      set('fx-pixel-grow', 'radius', half);
    }
    if (s.invert) filters.push(s.invert);
    if (s.b !== 1 || s.c !== 1 || s.s !== 1) filters.push(`brightness(${s.b}) contrast(${s.c}) saturate(${s.s})`);
    // the whole picture
    if (s.rgb) {
      whole.push('url(#fa-rgb)');
      set('fa-rgb-r', 'dx', s.rgb[0]);
      set('fa-rgb-r', 'dy', s.rgb[1]);
      set('fa-rgb-b', 'dx', r1(-0.8 * s.rgb[0]));
      set('fa-rgb-b', 'dy', r1(-0.8 * s.rgb[1]));
    }
    if (s.slices) {
      whole.push('url(#fa-slices)');
      s.slices.forEach(([y, h, dx], i) => {
        set(`fa-sl${i}`, 'y', y);
        set(`fa-sl${i}`, 'height', h);
        set(`fa-sl${i}`, 'dx', dx);
      });
      set('fa-seam', 'y', Math.max(0, s.slices[0][0] - 1));
    }
    if (s.blocks) {
      whole.push(`url(#fa-blocks${s.blocks[0]})`);
      set(`fa-blocks${s.blocks[0]}-d`, 'scale', s.blocks[1]);
    }
    if (s.vhs) {
      whole.push('url(#fa-vhs)');
      set('fa-vhs-i', 'y', -s.vhs[3]);
      set('fa-vhs-d', 'y', s.vhs[0]);
      set('fa-vhs-d', 'height', s.vhs[1]);
      set('fa-vhs-d', 'scale', s.vhs[2]);
      set('fa-vhs-l', 'y', s.vhs[0]);
    }
    if (s.roll) {
      whole.push('url(#fa-roll)');
      set('fa-roll-a', 'dy', s.roll);
      set('fa-roll-b', 'dy', s.roll - HEIGHT);
      set('fa-roll-bar', 'y', Math.max(0, s.roll - 28));
    }
    const moved = s.zoom !== 1 || s.x !== 0 || s.y !== 0 || s.rot !== 0;
    const transform = moved ? `translate(${s.x}px,${s.y}px) rotate(${s.rot}deg) scale(${s.zoom})` : 'none';
    const light = s.flash ? `opacity:${s.flash.alpha};background:${s.flash.color}${s.flash.screen ? ';mix-blend-mode:screen' : ''}` : 'opacity:0';
    const texture = (noise) => (noise ? `opacity:${noise[0]};background-size:${noise[1]}px ${noise[1]}px;background-position:${noise[2]}px ${noise[3]}px${noise[1] > 128 ? ';image-rendering:pixelated' : ''}` : 'opacity:0');
    return {
      fx: `transform:${transform};filter:${filters.length ? filters.join(' ') : 'none'}`,
      all: `filter:${whole.length ? whole.join(' ') : 'none'}`,
      light,
      grain: texture(s.noise),
      scan: s.scan ? `opacity:${s.scan}` : 'opacity:0',
      snow: texture(s.snow),
      svg
    };
  }

  /* ---------- checks ---------- */

  // Every flash of the film as the frames it starts on: the planned ones (light, negative and snow) and the ones the HUD draws itself (fixedFlashFrames).
  function flashFrames(plan, graphics) {
    const own = plan ? plan.events.filter((event) => event.k === 'flash' || event.k === 'negative' || event.k === 'snow').map((event) => event.f) : [];
    return [...own, ...fixedFlashFrames(graphics)].sort((a, b) => a - b);
  }

  // The accents of a plan in order: [{ x, f, kind, kinds }] (x: its number; kind: the kind of its palette it took, kinds: with the companion of a burst)
  function accentsOf(plan) {
    const byNo = new Map();
    for (const event of plan ? plan.events : []) {
      if (!event.x) continue;
      if (!byNo.has(event.x)) byNo.set(event.x, { x: event.x, f: event.f, kind: null, kinds: [] });
      const item = byNo.get(event.x);
      if (!event.w) {
        item.kind = event.k;
        item.f = event.f;
      }
      item.kinds.push(event.k);
    }
    return [...byNo.values()].sort((a, b) => a.x - b.x);
  }

  return {
    FPS,
    LEVELS,
    DEFAULT_LEVEL,
    PART_KINDS,
    KINDS,
    KIND_NAMES,
    SPAN_KINDS,
    WHOLE_KINDS,
    CAPS,
    PALETTES,
    LEVEL,
    COPY_STYLES,
    FLASH_LIMIT,
    LONGEST_FRAMES,
    FRESH_FRAMES,
    SEAM_FRAMES,
    SHORT_FRAMES,
    BURST_FRAMES,
    HOLD_FRAMES,
    GLITCH_DEFAULT,
    SUNG_SPLIT_PX,
    normalizeLevel,
    planEffects,
    sliceEffects,
    frameEffects,
    view,
    flashFrames,
    fixedFlashFrames,
    flashFits,
    accentsOf,
    partsOf,
    barsOf,
    beatsOf,
    barRanks,
    wordsOf,
    repeatedWords,
    quietOf,
    lipOf,
    freshOf,
    seamsOf,
    songSeed,
    ranks,
    energyAt,
    coverZoom,
    isRed,
    safeFlashColor,
    lookOf,
    hash
  };
});
