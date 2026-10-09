'use strict';

// The styles of the HUD of the music video (WP44). A style is a table: its colours, the faces that the layout measures, the sizes of the devices
// that differ from the base ones (view.js SIZES), the variant of the frame of the HUD, the effects that lie over the film, and what the post-pass
// does to the film itself (grain, vignette, glitch, bloom). There is one engine (state.js, view.js, graphics.js, postpass.js): a style changes the
// numbers it reads and, in a few places, the shape of what is drawn (the variants of the view).
//   hud     HUD Blue, the first style and the default: today's look, nothing in this row changes what it draws
//   kuble   Kuble v2 (dark first): Night Ink, Kuble Blue as the signal, Amber as the one warm counterpoint (one element of a picture at most),
//           Montserrat for the big words, cards for the devices, a loud but clean set of effects
// The name of a style travels in the data as `theme` (graphics v1: absent or "hud" is the first style; the node has a parameter that wins).
// UMD: runs in Node (the layout, the page builder, the post-pass, the tests) and in the browser (inlined in the page of a chunk).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HudThemes = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT = 'hud';

  /* ---------- HUD Blue (as it was before there was a second style) ---------- */

  const HUD = {
    id: 'hud',
    label: 'HUD Blue',
    // the colour of the accent when the node's parameter has its default
    accent: '#3B82F6',
    // the faces the layout measures (lib/music-video-hud/metrics.js): the big words, the numbers, the sentences of bubbles and notifications
    faces: { display: 'anton', number: 'anton', sans: 'sans' },
    // differences to the base sizes of view.js: none
    sizes: {},
    // devices that stand on a card (with a padding that is part of their size): none
    cards: [],
    frame: 'hud',
    fx: null,
    post: {
      glitch: 'rgb',
      // the share of the grain slider that is drawn (1: the slider says how much)
      grain: 1,
      // the lens angle of the vignette of ffmpeg: smaller is lighter
      vignette: 'PI/7',
      bloom: null
    }
  };

  /* ---------- Kuble ---------- */

  const KUBLE = {
    id: 'kuble',
    label: 'Kuble',
    // Kuble Blue: the colour that fills (an accent card, the box of a big word, the blue word of the karaoke line is its lighter text form)
    accent: '#2E5CFF',
    colors: {
      night: '#05070C', // Night Ink: the stage, the cards (72 %), the vignette
      night2: '#0A0E17',
      night3: '#10141F',
      ink: '#F2F4F8',
      ink2: '#B4BCCC',
      ink3: '#8892A6',
      blue: '#2E5CFF',
      // blue as writing and as glow
      blueText: '#4E7BFF',
      // the warm counterpoint: one element of a picture at most, under 15 % of its area
      amber: '#F7901F'
    },
    faces: { display: 'mont9', number: 'mont9', sans: 'mont6' },
    // The sizes of the devices: Montserrat Black is about 1.6 times as wide as Anton, so the numbers and the words are smaller than in HUD Blue;
    // the big words still take the width that is free (the layout shrinks a row that does not fit), and a short word gets up to 300 px.
    sizes: {
      display: { xl: 260, l: 188, m: 108, serifXl: 150, serifL: 118, serifM: 84, line: 0.98, serifLine: 1.08, boxPad: 0.14, min: 64, serifMin: 60, tracking: -0.02 },
      counter: { label: 24, gap: 4, int: 118, percent: 126, money: 74, clock: 78, fraction: 96, multiplier: 138, multPadX: 28, multPadY: 4, line: 1.0 },
      tag: { h: 36, padX: 14, font: 14, tracking: 0.14 },
      stamp: { font: 40, tracking: 0.16, padX: 20, padY: 8, border: 4, gap: 18 },
      strike: { font: 84, line: 1.0 },
      spec: { w: 470, title: 38, row: 46, pad: 6 },
      terminal: { w: 560, bar: 38, line: 27, pad: 16 },
      chat: { h: 58, gap: 14, font: 28, padX: 24, padY: 14, maxW: 580 },
      notification: { w: 500, h: 112 },
      clock: { dial: 210, gap: 26, font: 108, label: 28 },
      stopwatch: { label: 28, font: 72, line: 1.0 },
      toggle: { label: 28, trackW: 124, trackH: 62, gap: 24, font: 54 },
      progress: { w: 500, label: 28, bar: 14, font: 62, rowH: 62 },
      voice: { w: 580, h: 114 },
      // the karaoke line: Montserrat is wider than Inter Tight, so the letters are a little smaller
      karaoke: { big: 46, mid: 41, small: 36 },
      // the card: the padding is part of the size of the device, the radius is Kuble's 14 px
      card: { pad: 16, radius: 14 }
    },
    cards: ['counter', 'spec', 'list', 'voice', 'clock', 'stopwatch', 'toggle', 'progress', 'blueprint'],
    frame: 'kuble',
    // the brightness of the picture (0 to 1) from which the big words and the numbers turn from Ink to Night Ink (the first style: 0.58)
    inkThreshold: 0.5,
    // the faint eyebrow line, the beat bar and the typed status line of the frame
    frameSizes: { beatCell: 12, beatGap: 5, statusSeconds: 4 },
    fx: {
      // a flash of Kuble Blue over the whole picture on a hit: 3 frames, the strength of the hit (from `from` to 1) gives 0.15 to 0.35 of opacity
      pulse: { from: 0.5, frames: 3, min: 0.15, max: 0.35 },
      // a diagonal band of light (blue to white) over the picture at a change of chapter and at a wipe
      sweep: { frames: 10 },
      // sparks (24 to 40 small amber dots, 0.6 s) on the strongest hits and on a drop
      sparks: { from: 0.9, seconds: 0.6, min: 24, max: 40 },
      // a word of a block enters on the sixteenths, with an overshoot and a blue glow that fades
      kinetic: { glowSeconds: 0.35 }
    },
    post: {
      glitch: 'prism',
      // the grain of Kuble is 0.2 where HUD Blue has 0.35 (the slider of the node has its default at 0.35)
      grain: 0.2 / 0.35,
      vignette: 'PI/6',
      // a light bloom on the highlights: drawn small and scaled up, so it costs little
      bloom: { opacity: 0.22, sigma: 9, threshold: 196 }
    }
  };

  const THEMES = Object.freeze({ hud: Object.freeze(HUD), kuble: Object.freeze(KUBLE) });
  const NAMES = Object.freeze(Object.keys(THEMES));

  // a name of a style (and not a key that every object has: 'constructor', '__proto__')
  const isStyle = (name) => typeof name === 'string' && Object.prototype.hasOwnProperty.call(THEMES, name);

  // the table of a style by its name (the first style for anything that is not one)
  function get(name) {
    return isStyle(name) ? THEMES[name] : THEMES[DEFAULT];
  }

  // the name of a style: `value` when it is one, else `fallback`, else the first style
  function resolve(value, fallback) {
    const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (isStyle(name)) return name;
    const other = typeof fallback === 'string' ? fallback.trim().toLowerCase() : '';
    return isStyle(other) ? other : DEFAULT;
  }

  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

  // '#2E5CFF' -> '46,92,255' (the colour as the three numbers of a CSS rgba())
  function rgb(hex) {
    const value = String(hex).replace('#', '');
    return [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16)).join(',');
  }

  // The colour mixed with white: amount 0 is the colour, 1 is white ('#2E5CFF', 0.16 -> a lighter blue for writing and glow)
  function lighten(hex, amount) {
    const value = String(hex).replace('#', '');
    const mixed = [0, 2, 4].map((at) => Math.round(parseInt(value.slice(at, at + 2), 16) * (1 - amount) + 255 * amount));
    return `#${mixed.map((part) => part.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  }

  // the base sizes with what a style changes (group by group; a group a style does not name stays as it is)
  function mergeSizes(base, changes) {
    const out = {};
    for (const key of Object.keys(base)) out[key] = isObject(base[key]) ? { ...base[key], ...(changes && isObject(changes[key]) ? changes[key] : {}) } : base[key];
    for (const key of Object.keys(changes || {})) if (!(key in out) && isObject(changes[key])) out[key] = { ...changes[key] };
    return out;
  }

  return { DEFAULT, NAMES, THEMES, get, resolve, mergeSizes, rgb, lighten };
});
