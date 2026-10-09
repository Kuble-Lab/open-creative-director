'use strict';

// The beat effects of the music video with the HUD (WP45): glitch, distortion, motion, light and colour on the music, dense in the chorus and the
// drop, calmer in the verse, nothing on the end card. Made by code from the data of the song, without a language model:
//   planEffects(graphics, { level })   the plan of the whole film: the zones of the song (break, verse, chorus, drop: from the loudness of every
//                                      bar, as a percentile of the song), the events on the beats, downbeats, hits (their strength as a percentile
//                                      of the song, never a fixed number) and cuts, the moments of the glitch over the whole picture for the
//                                      post-pass, and the look of the style. null for the level `off`. A pure function: the same graphics and the
//                                      same level give the same plan.
//   sliceEffects(plan, from, to)       the part of the plan a chunk of the film needs (the events that are still running at its start included)
//   frameEffects(plan, t)              what the effects do to the frame at the song time t: zoom, shake, turn, the distortions, the colour, the light.
//                                      A pure function of the plan and of t (noise comes from a hash of the frame number), so a chunk drawn on any
//                                      render node shows the frames the whole film shows, also across the seams of the chunks.
//   view(state)                        the CSS of the wrapper of the footage (#fx), of the light layer (#fx-light) and the values of the SVG filters
//   flashFrames(plan, graphics)        every flash of the film (the planned ones and those the HUD draws itself), for the limit of 3 a second
// Where it is drawn: everything except the glitch over the whole picture is done in the page of the render node, on the footage only (the HUD
// layers lie above it and stay as they are): the transform and the CSS filters of #fx, SVG filters (a displacement map for the bulge, the wave and the
// zoom blur, a Gaussian blur, the split colour channels of the chromatic edges) and a light layer between the footage and the HUD. The glitch over
// everything (colour channels, displaced blocks, a torn line, a VHS track, digital noise) is drawn by the post-pass (postpass.js) in the windows of
// `plan.glitch`, at most 4 frames each.
// The limits: no bulge and no wave in a lip-sync cut, no other distortion while a word is sung in it (zoom and light are allowed, a glitch only in the
// gaps between the words); at most 3 flashes in any second, no red flash (an accent colour that is red flashes white instead); nothing on the end card.
// UMD: runs in Node (the plan, the tests, the post-pass) and in the browser (inlined in the page of a chunk after themes.js, when the effects are on).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./themes'));
  else root.HudEffects = factory(root.HudThemes);
})(typeof self !== 'undefined' ? self : this, function (themes) {
  const FPS = 24;
  const WIDTH = 1920;
  const HEIGHT = 1080;
  const LEVELS = Object.freeze(['off', 'subtle', 'strong']);
  // the default of the parameter of the node; the modules read a missing level as `off`, so a page or a command made without it is the one of before
  const DEFAULT_LEVEL = 'strong';
  const ZONE_KINDS = Object.freeze(['break', 'verse', 'chorus', 'drop']);
  // a glitch over the whole picture (the HUD included) lasts at most this many frames
  const GLITCH_MAX_FRAMES = 4;
  // between two glitch windows at least this many frames without one (two windows never join into a longer one)
  const GLITCH_GAP_FRAMES = 6;
  // the flashes: at most this many in any second
  const FLASH_LIMIT = 3;
  // the longest event (frames): how far a chunk looks back for the events that still run at its start
  const LONGEST_FRAMES = 12;
  // the change of the colour from one zone to the next (frames)
  const BLEND_FRAMES = 10;
  const GLITCH_KINDS = Object.freeze(['rgb', 'blocks', 'tear', 'vhs', 'noise']);

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

  /* ---------- what each level does in each zone ---------- */

  // grade: [brightness, contrast, saturation] of the footage in the zone. punch: the zoom on the beat (`on`: down = the downbeats, half = the downbeats
  // and the third beat, all = every beat). pulse: the exposure on the beat (the contrast takes 0.7 of it). bulge: the lens bulge on the kick (px of the
  // displacement). chromaCut / chromaDown: the chromatic edges on a cut / on a downbeat (px). blurCut: the zoom or the directional blur at a cut.
  // shake: from which percentile of the hits the picture shakes and how far (px). flashHit: from which percentile a hit flashes in the accent colour.
  // wave: the wave on the hits from a percentile (px, and at most one in `bars` bars). glitch: from which percentile a hit glitches the whole picture,
  // `perBar` windows a bar at most, of the kinds `kinds`. spin: the turn on the downbeats (degrees; `start`: only at the start of the zone).
  // micro: the shake that is always there (px). strobe: the bars of a drop with a flash on every beat. invert: one negative flash in a drop.
  // sectionFlash: the white flash at the start of the zone (alpha).
  const TABLE = Object.freeze({
    strong: {
      break: { grade: [0.95, 0.97, 0.84] },
      verse: {
        grade: [1, 1, 0.97],
        punch: { on: 'down', down: 0.022, beat: 0 },
        pulse: { on: 'down', down: 0.04, beat: 0 },
        chromaCut: 6,
        shake: { from: 0.95, px: 8 },
        glitch: { from: 0.93, perBar: 0.5, kinds: ['rgb', 'tear'] },
        sectionFlash: 0.7
      },
      chorus: {
        grade: [1.05, 1.08, 1.16],
        punch: { on: 'half', down: 0.042, beat: 0.02 },
        pulse: { on: 'all', down: 0.07, beat: 0.045 },
        bulge: { on: 'down', px: 80 },
        chromaCut: 12,
        blurCut: true,
        shake: { from: 0.85, px: 12 },
        flashHit: 0.97,
        wave: { from: 0.93, px: 14, bars: 4 },
        glitch: { from: 0.82, perBar: 1, kinds: ['rgb', 'blocks', 'tear', 'vhs'] },
        spin: { deg: 1, start: true },
        sectionFlash: 0.85
      },
      drop: {
        grade: [1.08, 1.14, 1.26],
        punch: { on: 'all', down: 0.065, beat: 0.035 },
        pulse: { on: 'all', down: 0.08, beat: 0.06 },
        bulge: { on: 'half', px: 110 },
        chromaCut: 16,
        chromaDown: 9,
        blurCut: true,
        shake: { from: 0.72, px: 18 },
        flashHit: 0.94,
        wave: { from: 0.88, px: 18, bars: 2 },
        glitch: { from: 0.7, perBar: 2, kinds: ['rgb', 'blocks', 'tear', 'vhs', 'noise'] },
        spin: { deg: 1.6, start: false },
        micro: 2.5,
        strobe: 2,
        invert: true,
        sectionFlash: 0.9
      }
    },
    subtle: {
      break: { grade: [0.97, 0.98, 0.92] },
      verse: {
        grade: [1, 1, 0.99],
        punch: { on: 'down', down: 0.012, beat: 0 },
        pulse: { on: 'down', down: 0.025, beat: 0 }
      },
      chorus: {
        grade: [1.03, 1.04, 1.08],
        punch: { on: 'down', down: 0.024, beat: 0 },
        pulse: { on: 'half', down: 0.045, beat: 0.025 },
        chromaCut: 7,
        shake: { from: 0.93, px: 7 },
        glitch: { from: 0.92, perBar: 0.25, kinds: ['rgb', 'tear'] },
        sectionFlash: 0.5
      },
      drop: {
        grade: [1.05, 1.08, 1.14],
        punch: { on: 'half', down: 0.035, beat: 0.018 },
        pulse: { on: 'all', down: 0.055, beat: 0.035 },
        bulge: { on: 'down', px: 55 },
        chromaCut: 10,
        blurCut: true,
        shake: { from: 0.85, px: 10 },
        glitch: { from: 0.85, perBar: 0.5, kinds: ['rgb', 'blocks', 'tear'] },
        sectionFlash: 0.6
      }
    }
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

  /* ---------- the song: bars, zones, sung words ---------- */

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

  // The zones of the song: every bar gets the mean loudness of four points in it; its percentile among all bars of the song gives the zone (under
  // 0.2 a break, under 0.55 a verse, under 0.85 a chorus, above a drop). A bar takes the middle one of its own zone and those of its two neighbours (a
  // single quiet or loud bar does not change the zone), a drop of a single bar is a chorus, and the bar of a drop of the plan (hud.drops) and the three
  // after it are a drop where they are loud enough for a chorus. [{ start, end, kind, rank }]
  function zonesOf(g, bars) {
    const music = g.music || {};
    const loud = bars.map((bar) => {
      let sum = 0;
      for (let i = 0; i < 4; i += 1) sum += energyAt(music, bar.start + ((i + 0.5) / 4) * (bar.end - bar.start));
      return sum / 4;
    });
    const rank = ranks(loud);
    const raw = rank.map((value) => (value < 0.2 ? 0 : value < 0.55 ? 1 : value < 0.85 ? 2 : 3));
    const kinds = raw.map((value, i) => [i > 0 ? raw[i - 1] : value, value, i + 1 < raw.length ? raw[i + 1] : value].sort((a, b) => a - b)[1]);
    for (let i = 0; i < kinds.length; i += 1) if (kinds[i] === 3 && (i === 0 || kinds[i - 1] !== 3) && (i + 1 >= kinds.length || kinds[i + 1] !== 3)) kinds[i] = 2;
    for (const at of (g.hud && g.hud.drops) || []) {
      const first = Math.max(0, after(bars, at + 1e-6, 'start') - 1);
      for (let i = first; i < Math.min(bars.length, first + 4); i += 1) if (rank[i] >= 0.55) kinds[i] = 3;
    }
    const zones = [];
    bars.forEach((bar, i) => {
      const last = zones[zones.length - 1];
      if (last && last.kind === ZONE_KINDS[kinds[i]]) last.end = bar.end;
      else zones.push({ start: bar.start, end: bar.end, kind: ZONE_KINDS[kinds[i]], rank: rank[i] });
    });
    return zones;
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

  // planEffects(graphics, { level }) -> the plan, or null for `off`. `graphics` is the resolved data of the whole film (graphics.js resolveGraphics).
  //   from, to    the song time of the first frame of the film and of the end card (nothing at or after `to`)
  //   zones       [{ f0, f1, k, g: [brightness, contrast, saturation], m }] in frames of the song (k: the kind, m: the shake that is always there)
  //   quiet       [[a, b)]: the frames of the sung words of the lip-sync cuts
  //   events      [{ k, f, a, ... }] sorted by the frame f: p punch, u pulse, s shake, r turn, b bulge, w wave, c chroma, z zoom blur, h directional
  //               blur, f flash (c: colour, n: frames, m: 1 blend screen), i negative flash (n: frames)
  //   glitch      [{ f, n, kind, variant, s }] the windows of the glitch over the whole picture (frames of the song, n frames)
  //   look        { colors, invert } of the style
  function planEffects(graphics, options = {}) {
    const level = normalizeLevel(options.level);
    if (level === 'off') return null;
    const g = graphics;
    const table = TABLE[level];
    const music = g.music || {};
    const fromF = frameOf(num(g.start, 0));
    const toF = Math.round(num(g.endFrame, frameOf(num(g.duration, 0))));
    const beats = beatsOf(g);
    const bars = barsOf(g, beats);
    const zones = zonesOf(g, bars);
    const quiet = quietOf(g);
    const look = lookOf(g);
    const events = [];
    // the zone of a moment by its frame, as the frames of the plan count (a cut a hair before the start of a zone in the same frame is in it)
    const zoneFrames = zones.map((zone) => frameOf(zone.start));
    const zoneAt = (t) => zones[Math.max(0, after(zoneFrames, frameOf(t)) - 1)];
    const rulesAt = (t) => table[zoneAt(t).kind] || {};
    const barAt = (t) => bars[Math.max(0, after(bars, t + 1e-6, 'start') - 1)];
    const live = (f, n = 1) => f >= fromF && f + n <= toF;
    const quietAt = (f, n = 1) => touchesSpans(quiet, f, n);
    // the bulge and the wave pull the face out of shape: never in a lip-sync cut
    const lip = lipOf(g);
    const lipAt = (f, n = 1) => touchesSpans(lip, f, n);
    const add = (event) => {
      if (live(event.f)) events.push(event);
    };

    // the beats: punch, pulse, bulge, chroma and turn on the downbeats
    const downFrames = new Set(((music.downbeats || []).length ? music.downbeats : bars.map((bar) => bar.start)).map(frameOf));
    let sinceDown = 0;
    let spinSign = 1;
    beats.forEach((time) => {
      const f = frameOf(time);
      const down = downFrames.has(f) || downFrames.has(f - 1) || downFrames.has(f + 1);
      sinceDown = down ? 0 : sinceDown + 1;
      const third = !down && sinceDown === 2;
      const rules = rulesAt(time);
      const takes = (on) => on === 'all' || (on === 'half' && (down || third)) || (on === 'down' && down);
      if (rules.punch && takes(rules.punch.on)) add({ k: 'p', f, a: r4(down ? rules.punch.down : rules.punch.beat) });
      if (rules.pulse && takes(rules.pulse.on)) add({ k: 'u', f, a: r4(down ? rules.pulse.down : rules.pulse.beat) });
      if (rules.bulge && takes(rules.bulge.on) && !lipAt(f, 6)) add({ k: 'b', f, a: rules.bulge.px * (down ? 1 : 0.7) });
      if (rules.chromaDown && down && !quietAt(f, 4)) add({ k: 'c', f, a: rules.chromaDown, n: 4 });
      if (rules.spin && !rules.spin.start && down) {
        add({ k: 'r', f, a: r3(rules.spin.deg * spinSign) });
        spinSign = -spinSign;
      }
    });

    // the hits: their strength as a percentile of all hits of the song
    const hits = ((music.hits || []).filter((hit) => Number.isFinite(Number(hit.t))));
    const hitRank = ranks(hits.map((hit) => clamp(num(hit.strength, 0), 0, 1)));
    const waveFrames = [];
    hits.forEach((hit, index) => {
      const rank = hitRank[index];
      const f = frameOf(hit.t);
      const rules = rulesAt(hit.t);
      if (rules.shake && rank >= rules.shake.from) {
        const over = (rank - rules.shake.from) / Math.max(0.01, 1 - rules.shake.from);
        add({ k: 's', f, a: r1(rules.shake.px * (0.55 + 0.45 * over)) });
      }
      if (rules.wave && rank >= rules.wave.from && !lipAt(f, 8)) {
        const bar = barAt(hit.t);
        const gap = Math.round((bar.end - bar.start) * rules.wave.bars * FPS);
        if (!waveFrames.some((other) => Math.abs(other - f) < gap)) {
          waveFrames.push(f);
          add({ k: 'w', f, a: rules.wave.px });
        }
      }
    });

    // the cuts: chromatic edges and a zoom blur or a directional blur (one frame before the cut to two after it)
    (g.cuts || []).forEach((cut, index) => {
      if (index === 0) return;
      const f = frameOf(cut.start);
      const rules = rulesAt(cut.start);
      if (rules.chromaCut) add({ k: 'c', f, a: rules.chromaCut, n: 4 });
      if (rules.blurCut && live(f - 1)) add({ k: index % 2 ? 'z' : 'h', f: f - 1, a: index % 2 ? 54 : 13 });
    });

    // the starts of the sections: a zone that is louder than the one before it, and a chapter of the plan (not the first one)
    const starts = [];
    zones.forEach((zone, index) => {
      if (index > 0 && ZONE_KINDS.indexOf(zone.kind) > ZONE_KINDS.indexOf(zones[index - 1].kind) && ZONE_KINDS.indexOf(zone.kind) >= 1) starts.push({ t: zone.start, zone });
    });
    for (const chapter of (g.hud && g.hud.chapters) || []) {
      if (chapter.start <= num(g.start, 0) + 0.05) continue;
      const bar = barAt(chapter.start);
      if (!starts.some((item) => Math.abs(item.t - chapter.start) < bar.end - bar.start)) starts.push({ t: chapter.start, zone: zoneAt(chapter.start) });
    }
    starts.sort((a, b) => a.t - b.t);

    // the flashes, by their weight: the starts of the sections, the negative flash of a drop, the strongest hits, the strobe of a drop. One is only
    // taken when every second keeps at most 3 (the flashes the HUD draws itself count too).
    const taken = fixedFlashFrames(g);
    const flashes = [];
    for (const start of starts) {
      const rules = table[start.zone.kind] || {};
      if (rules.sectionFlash) flashes.push({ weight: 0, f: frameOf(start.t), c: 0, a: rules.sectionFlash, n: 2, m: 0 });
      if (rules.spin && rules.spin.start) add({ k: 'r', f: frameOf(start.t), a: rules.spin.deg });
    }
    // the strobe and the negative flash: at the start of a drop, but not again within 12 bars (a drop that comes back after a short dip is the same one)
    let lastStrobe = -Infinity;
    zones.forEach((zone) => {
      const rules = table[zone.kind] || {};
      if (zone.kind !== 'drop') return;
      const first = after(bars, zone.start - 1e-6, 'start');
      const inside = bars.slice(first).filter((bar) => bar.start < zone.end - 1e-6);
      const bar = barAt(zone.start);
      if (zone.start - lastStrobe < 12 * (bar.end - bar.start)) return;
      lastStrobe = zone.start;
      if (rules.invert && inside.length >= 2) flashes.push({ weight: 1, f: frameOf(inside[1].start), invert: true, n: 2 });
      if (rules.strobe) {
        const until = inside.length > rules.strobe ? inside[rules.strobe].start : zone.end;
        for (const time of beats) if (time >= zone.start - 1e-6 && time < until - 1e-6) flashes.push({ weight: 3, f: frameOf(time), c: 0, a: 0.5, n: 1, m: 0 });
      }
    });
    const hitFlashes = [];
    hits.forEach((hit, index) => {
      const rules = rulesAt(hit.t);
      if (rules.flashHit && hitRank[index] >= rules.flashHit) hitFlashes.push({ weight: 2, f: frameOf(hit.t), c: 1, a: 0.6, n: 2, m: 1, rank: hitRank[index] });
    });
    hitFlashes.sort((a, b) => b.rank - a.rank || a.f - b.f);
    const hitTaken = [];
    for (const item of hitFlashes) {
      const bar = barAt(item.f / FPS);
      if (hitTaken.some((other) => Math.abs(other - item.f) < Math.round(2 * (bar.end - bar.start) * FPS))) continue;
      hitTaken.push(item.f);
      flashes.push(item);
    }
    flashes.sort((a, b) => a.weight - b.weight || a.f - b.f);
    const planned = new Set();
    for (const item of flashes) {
      if (!live(item.f, item.n) || planned.has(item.f) || !flashFits(taken, item.f)) continue;
      planned.add(item.f);
      insertSorted(taken, item.f);
      if (item.invert) add({ k: 'i', f: item.f, n: item.n });
      else add({ k: 'f', f: item.f, c: item.c, a: item.a, n: item.n, m: item.m });
    }

    events.sort((a, b) => a.f - b.f || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));

    // the glitch over the whole picture: on the cuts the plan asks it for, just before the start of a drop, and on the hits from the percentile of the
    // zone; at most `perBar` windows in a bar, never closer than GLITCH_GAP_FRAMES to another one, and in a lip-sync cut only between the words
    const glitch = [];
    const candidates = [];
    (g.cuts || []).forEach((cut, index) => {
      if (index > 0 && cut.transition === 'glitch') candidates.push({ weight: 0, f: frameOf(cut.start), n: 3, s: 1, kinds: ['rgb', 'blocks'], gapBars: 0 });
    });
    for (const start of starts) {
      if (start.zone.kind === 'drop' && table.drop.glitch) candidates.push({ weight: 1, f: frameOf(start.t) - 3, n: 3, s: 1, kinds: ['blocks', 'rgb'], gapBars: 0 });
    }
    hits.forEach((hit, index) => {
      const rules = rulesAt(hit.t);
      if (!rules.glitch || hitRank[index] < rules.glitch.from) return;
      const over = (hitRank[index] - rules.glitch.from) / Math.max(0.01, 1 - rules.glitch.from);
      candidates.push({ weight: 2, rank: hitRank[index], f: frameOf(hit.t), n: 2 + Math.round(2 * over), s: r3(0.6 + 0.4 * over), kinds: rules.glitch.kinds, gapBars: 1 / rules.glitch.perBar });
    });
    candidates.sort((a, b) => a.weight - b.weight || (b.rank || 0) - (a.rank || 0) || a.f - b.f);
    for (const item of candidates) {
      let f = item.f;
      let n = Math.min(GLITCH_MAX_FRAMES, item.n);
      // in a lip-sync cut: the first gap between the words within 6 frames, at least 2 frames long
      if (quietAt(f, n)) {
        let found = null;
        for (let shift = 1; shift <= 6 && found === null; shift += 1) {
          for (let size = n; size >= 2 && found === null; size -= 1) if (!quietAt(f + shift, size)) found = [f + shift, size];
        }
        if (!found) continue;
        [f, n] = found;
      }
      if (!live(f, n)) continue;
      const bar = barAt(f / FPS);
      const gap = Math.max(GLITCH_GAP_FRAMES, Math.round(item.gapBars * (bar.end - bar.start) * FPS));
      if (glitch.some((other) => f < other.f + other.n + GLITCH_GAP_FRAMES && other.f < f + n + GLITCH_GAP_FRAMES)) continue;
      if (item.gapBars && glitch.some((other) => other.hit && Math.abs(other.f - f) < gap)) continue;
      glitch.push({ f, n, s: item.s, kinds: item.kinds, hit: item.weight === 2 });
    }
    glitch.sort((a, b) => a.f - b.f);
    // the kind of every window: by a hash of its frame from the kinds of its zone, never the same kind twice in a row; the variants of a kind in turn
    let previous = '';
    const turns = {};
    const windows = glitch.map((item) => {
      let kind = item.kinds[Math.floor(hash(item.f, 31, 7) * item.kinds.length)];
      if (kind === previous && item.kinds.length > 1) kind = item.kinds[(item.kinds.indexOf(kind) + 1) % item.kinds.length];
      previous = kind;
      const variant = turns[kind] || 0;
      turns[kind] = variant + 1;
      // digital noise is short: 2 frames
      return { f: item.f, n: kind === 'noise' ? Math.min(2, item.n) : item.n, kind, variant, s: item.s };
    });

    const gradeOf = (kind) => (table[kind] && table[kind].grade) || [1, 1, 1];
    return {
      version: 1,
      level,
      from: fromF / FPS,
      to: toF / FPS,
      fromF,
      toF,
      look,
      zones: zones.map((zone) => ({ f0: frameOf(zone.start), f1: frameOf(zone.end), k: zone.kind, g: gradeOf(zone.kind), m: (table[zone.kind] && table[zone.kind].micro) || 0 })),
      quiet,
      events,
      glitch: windows
    };
  }

  // The part of the plan that the frames from `from` to `to` (song seconds) need: the events that still run at `from` included.
  function sliceEffects(plan, from, to) {
    if (!plan) return null;
    const a = Math.floor(from * FPS) - LONGEST_FRAMES - 1;
    const b = Math.ceil(to * FPS) + 1;
    return {
      ...plan,
      zones: plan.zones.filter((zone) => zone.f1 >= a - BLEND_FRAMES && zone.f0 <= b),
      quiet: plan.quiet.filter((span) => span[1] >= a && span[0] <= b),
      events: plan.events.filter((event) => event.f >= a && event.f <= b),
      glitch: plan.glitch.filter((item) => item.f + item.n >= a && item.f <= b)
    };
  }

  /* ---------- one frame ---------- */

  const NEUTRAL = Object.freeze({ zoom: 1, x: 0, y: 0, rot: 0, bulge: 0, wave: 0, phase: 0, blur: 0, dir: 0, chroma: 0, b: 1, c: 1, s: 1, flash: null, invert: '' });

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

  // frameEffects(plan, t) -> { zoom, x, y, rot, bulge, wave, phase, blur, dir, chroma, b, c, s, flash, invert } for the song time t.
  //   zoom, x, y, rot   the transform of the footage (round the middle of the screen); the zoom always covers the screen
  //   bulge, wave       the displacement of the bulge and of the wave in px (phase: where the wave stands), blur: px of the blur (dir 1 sideways, 2 zoom)
  //   chroma            px of the chromatic edges; b, c, s: brightness, contrast, saturation; flash: { color, alpha, screen } or null; invert: the CSS
  //                     filter of the negative flash, or ''
  function frameEffects(plan, time) {
    if (!plan) return { ...NEUTRAL };
    const f = Math.round(num(time, 0) * FPS);
    if (f < plan.fromF || f >= plan.toF) return { ...NEUTRAL };
    const out = { ...NEUTRAL };
    // the colour of the zone, blended from the zone before it over BLEND_FRAMES
    const zones = plan.zones;
    const zi = after(zones, f, 'f0') - 1;
    let micro = 0;
    if (zi >= 0) {
      const zone = zones[zi];
      let grade = zone.g;
      const into = f - zone.f0;
      if (into < BLEND_FRAMES && zi > 0 && zones[zi - 1].f1 >= zone.f0 - 1) {
        const w = into / BLEND_FRAMES;
        grade = grade.map((value, i) => zones[zi - 1].g[i] + (value - zones[zi - 1].g[i]) * w);
      }
      [out.b, out.c, out.s] = grade;
      micro = zone.m || 0;
    }
    const quiet = inSpans(plan.quiet, f);
    let punch = 0;
    let pulse = 0;
    let shake = micro;
    for (let i = after(plan.events, f - LONGEST_FRAMES - 1, 'f'); i < plan.events.length && plan.events[i].f <= f; i += 1) {
      const e = plan.events[i];
      const age = f - e.f;
      if (e.k === 'p' && age < 10) punch = Math.max(punch, e.a * Math.exp(-age / 2.2));
      else if (e.k === 'u' && age < 9) pulse = Math.max(pulse, e.a * Math.exp(-age / 2.4));
      else if (e.k === 's' && age < 10) shake = Math.max(shake, e.a * Math.exp(-age / 3));
      else if (e.k === 'r' && age < 12) out.rot += e.a * Math.exp(-age / 3.2) * Math.cos(age * 0.85);
      else if (e.k === 'b' && age < 6) out.bulge = Math.max(out.bulge, e.a * Math.exp(-age / 1.6));
      else if (e.k === 'w' && age < 8) out.wave = Math.max(out.wave, e.a * Math.sin((Math.PI * (age + 1)) / 9));
      else if (e.k === 'c' && age < e.n) out.chroma = Math.max(out.chroma, e.a * (1 - age / e.n));
      else if ((e.k === 'z' || e.k === 'h') && age < 3) {
        const amount = e.a * [0.55, 1, 0.5][age];
        if (amount > out.blur) {
          out.blur = amount;
          out.dir = e.k === 'z' ? 2 : 1;
        }
      } else if (e.k === 'f' && age < e.n) out.flash = { color: plan.look.colors[e.c] || plan.look.colors[0], alpha: r3(age === 0 ? e.a : e.a * 0.4), screen: e.m === 1 };
      else if (e.k === 'i' && age < e.n) out.invert = plan.look.invert;
    }
    // while a word is sung in a lip-sync cut: no distortion, a smaller shake
    if (quiet) {
      out.bulge = 0;
      out.wave = 0;
      out.blur = 0;
      out.dir = 0;
      out.chroma = 0;
      shake *= 0.4;
    }
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

  // view(state) -> { fx, light, svg }: the style attribute of #fx (the wrapper of the footage) and of #fx-light, and the attributes of the SVG filters
  // that are in use ([id, attribute, value]). The ids are the ones of the filters of the page (fxsvg.js).
  function view(state) {
    const s = state || NEUTRAL;
    const filters = [];
    const svg = [];
    if (s.bulge > 0) {
      filters.push('url(#fx-bulge)');
      svg.push(['fx-bulge-d', 'scale', String(s.bulge)]);
    }
    if (s.wave > 0) {
      filters.push('url(#fx-wave)');
      svg.push(['fx-wave-i', 'y', String(-s.phase)], ['fx-wave-d', 'scale', String(s.wave)]);
    }
    if (s.blur > 0 && s.dir === 2) {
      filters.push('url(#fx-zoom)');
      svg.push(['fx-zoom-1', 'scale', String(r1(s.blur / 3))], ['fx-zoom-2', 'scale', String(r1((2 * s.blur) / 3))], ['fx-zoom-3', 'scale', String(s.blur)]);
    } else if (s.blur > 0) {
      filters.push('url(#fx-blur)');
      svg.push(['fx-blur-g', 'stdDeviation', `${s.blur} 0`]);
    }
    if (s.chroma > 0) {
      filters.push('url(#fx-chroma)');
      svg.push(['fx-chroma-r', 'scale', String(s.chroma)], ['fx-chroma-b', 'scale', String(r1(s.chroma * 0.45))]);
    }
    if (s.invert) filters.push(s.invert);
    if (s.b !== 1 || s.c !== 1 || s.s !== 1) filters.push(`brightness(${s.b}) contrast(${s.c}) saturate(${s.s})`);
    const moved = s.zoom !== 1 || s.x !== 0 || s.y !== 0 || s.rot !== 0;
    const transform = moved ? `translate(${s.x}px,${s.y}px) rotate(${s.rot}deg) scale(${s.zoom})` : 'none';
    const light = s.flash ? `opacity:${s.flash.alpha};background:${s.flash.color}${s.flash.screen ? ';mix-blend-mode:screen' : ''}` : 'opacity:0';
    return { fx: `transform:${transform};filter:${filters.length ? filters.join(' ') : 'none'}`, light, svg };
  }

  /* ---------- checks ---------- */

  // Every flash of the film as the frames it starts on: the planned ones (light and negative) and the ones the HUD draws itself (fixedFlashFrames).
  function flashFrames(plan, graphics) {
    const own = plan ? plan.events.filter((event) => event.k === 'f' || event.k === 'i').map((event) => event.f) : [];
    return [...own, ...fixedFlashFrames(graphics)].sort((a, b) => a - b);
  }

  return {
    FPS,
    LEVELS,
    DEFAULT_LEVEL,
    ZONE_KINDS,
    GLITCH_KINDS,
    GLITCH_MAX_FRAMES,
    GLITCH_GAP_FRAMES,
    FLASH_LIMIT,
    LONGEST_FRAMES,
    TABLE,
    normalizeLevel,
    planEffects,
    sliceEffects,
    frameEffects,
    view,
    flashFrames,
    fixedFlashFrames,
    flashFits,
    zonesOf,
    barsOf,
    beatsOf,
    quietOf,
    lipOf,
    ranks,
    energyAt,
    coverZoom,
    isRed,
    safeFlashColor,
    lookOf,
    hash
  };
});
