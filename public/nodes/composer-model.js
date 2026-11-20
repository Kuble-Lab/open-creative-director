'use strict';

// The model of the Composer node (image.composer): a stage of a chosen format with free layers (images from the inputs, texts, shapes)
// that a person moves, scales and turns with the mouse. Pure module (no DOM, no I/O), used by the server (lib/composer-render.js,
// lib/nodes/nodes-composer.js, the agent access) and by the editor of the node view (public/nodes/composer-ui.js), so that both read
// the layers, wrap the text and place the lines the same way. UMD: module.exports in Node, window.OCDNodes.composerModel in the browser.
//
// The value of the param `layers` is { layers: [ ... ] }, bottom layer first. Positions and sizes are percent of the stage, so a
// layout survives another resolution and, roughly, another format:
//   common  id, type ('image' | 'text' | 'shape'), name, x, y (top left corner of the unturned box, percent of width / height),
//           w (percent of the width), h (percent of the height; a text box has the height of its lines), rotation (degrees, about the
//           centre of the box), opacity (0..1), hidden, locked
//   image   input (0-based number of the image at the input "images"), fit ('cover' fills the box and crops, 'contain' shows all,
//           'fill' stretches), flip_x, flip_y, radius (rounded corners, percent of the shorter side of the box)
//   text    text, text_input (null, or the 0-based number of the text at the input "texts", which then replaces `text`), font (family),
//           weight (100..1000), size (percent of the stage width), color (#rrggbb or #rrggbbaa), align ('left' | 'center' | 'right'),
//           line_height (factor of the size), letter_spacing (em), uppercase, shadow
//   shape   shape ('rect' | 'ellipse'), fill (#rrggbb or #rrggbbaa), radius (percent of the shorter side of the box, rect only)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.OCDNodes = root.OCDNodes || {};
    root.OCDNodes.composerModel = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // Aspect ratios of the formats (width : height). The size of a format is given by its short edge (1080 makes 1080 x 1920 for 9:16).
  const FORMATS = Object.freeze({
    '1:1': [1, 1],
    '4:5': [4, 5],
    '3:4': [3, 4],
    '2:3': [2, 3],
    '9:16': [9, 16],
    '16:9': [16, 9],
    '4:3': [4, 3],
    '3:2': [3, 2],
    '21:9': [21, 9]
  });
  const FORMAT_OPTIONS = Object.freeze([...Object.keys(FORMATS), 'custom']);
  const SHORT_EDGES = Object.freeze([720, 1080, 1440, 2160]);
  const DEFAULT_FORMAT = '1:1';
  const DEFAULT_SHORT_EDGE = 1080;

  const LIMITS = Object.freeze({
    layers: 40,
    textChars: 2000,
    nameChars: 60,
    fontChars: 80,
    images: 16,
    texts: 8,
    minEdge: 64,
    maxEdge: 8192,
    maxPixels: 40 * 1000 * 1000,
    gradientStops: 6
  });

  const TYPES = Object.freeze(['image', 'text', 'shape']);
  const FITS = Object.freeze(['cover', 'contain', 'fill']);
  const ALIGNS = Object.freeze(['left', 'center', 'right']);
  const SHAPES = Object.freeze(['rect', 'ellipse']);
  const GRADIENTS = Object.freeze(['linear', 'radial']);

  // The fonts that come with the app (lib/fonts/, SIL Open Font License 1.1). `weights` is the range a variable font covers or the list
  // of the files of a static one; the editor offers these weights, the server draws them (lib/composer-render.js).
  const FONTS = Object.freeze([
    { family: 'Inter Tight', files: [{ file: 'inter-tight/InterTight-latin-variable.ttf', weights: [100, 900] }] },
    { family: 'DM Sans', files: [{ file: 'dm-sans/DMSans-Variable.ttf', weights: [100, 1000] }] },
    { family: 'Montserrat', files: [{ file: 'montserrat/Montserrat-Variable.ttf', weights: [100, 900] }] },
    { family: 'Space Grotesk', files: [{ file: 'space-grotesk/SpaceGrotesk-Variable.ttf', weights: [300, 700] }] },
    { family: 'Anton', files: [{ file: 'anton/Anton-Regular.ttf', weights: [400] }] },
    { family: 'Playfair Display', files: [{ file: 'playfair-display/PlayfairDisplay-Italic-Variable.ttf', weights: [400, 900] }] },
    { family: 'Instrument Serif', files: [{ file: 'instrument-serif/InstrumentSerif-Italic.ttf', weights: [400] }] },
    {
      family: 'JetBrains Mono',
      files: [
        { file: 'jetbrains-mono/JetBrainsMono-Medium.ttf', weights: [500] },
        { file: 'jetbrains-mono/JetBrainsMono-Bold.ttf', weights: [700] }
      ]
    }
  ]);
  const DEFAULT_FONT = 'Inter Tight';
  const FONT_FILES = Object.freeze(FONTS.flatMap((font) => font.files.map((entry) => entry.file)));

  const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
  const HEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
  const SHORT_HEX = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/;

  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const round = (value, digits = 3) => {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  };
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  // A colour as #rrggbb or #rrggbbaa (lower case), #rgb expanded; null where it is none.
  function hexColor(value) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    const short = SHORT_HEX.exec(text);
    if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
    return HEX.test(text) ? text.toLowerCase() : null;
  }

  // { rgb: '#rrggbb', alpha: 0..1 } of a colour of the model
  function splitColor(value, fallback = '#000000') {
    const hex = hexColor(value) || fallback;
    const alpha = hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1;
    return { rgb: hex.slice(0, 7), alpha: round(alpha, 4) };
  }


  /* ---------- gradients ---------- */
  // The fill of a shape or the colour of a text can be a gradient: { type: 'linear' | 'radial', angle, stops: [{ at, color }] }.
  // angle in degrees like CSS (0 = to the top, 90 = from left to right, 180 = from top to bottom), only for linear. A stop sits at
  // `at` percent of the way; its colour is #rrggbb or #rrggbbaa (aa = opacity, 00 = transparent). Linear runs along a line through
  // the middle of the box that reaches its corners (CSS linear-gradient), radial is an ellipse from the middle to the corners
  // (CSS radial-gradient, farthest-corner). null = no gradient.
  function normalizeGradient(raw, problem = () => {}, label = 'gradient') {
    if (raw === null || raw === undefined || raw === false || raw === '') return null;
    if (!isObject(raw)) {
      problem(`${label}: expected {"type","angle","stops"} or null, left out`);
      return null;
    }
    const type = GRADIENTS.includes(raw.type) ? raw.type : 'linear';
    if (raw.type !== undefined && !GRADIENTS.includes(raw.type)) problem(`${label}: type must be linear or radial, linear is used`);
    const list = Array.isArray(raw.stops) ? raw.stops : [];
    const stops = [];
    list.slice(0, LIMITS.gradientStops).forEach((stop, index) => {
      const color = isObject(stop) ? hexColor(stop.color) : null;
      if (!color) {
        problem(`${label}: stop ${index + 1} needs a color like #rrggbb or #rrggbbaa, left out`);
        return;
      }
      const fallback = list.length > 1 ? (index / (Math.min(list.length, LIMITS.gradientStops) - 1)) * 100 : 0;
      stops.push({ at: numberIn(stop.at, 0, 100, round(fallback, 2), 2), color });
    });
    if (list.length > LIMITS.gradientStops) problem(`${label}: at most ${LIMITS.gradientStops} stops, the rest is left out`);
    if (stops.length < 2) {
      problem(`${label}: needs at least 2 stops with a color, the plain color is used`);
      return null;
    }
    stops.sort((a, b) => a.at - b.at);
    let angleValue = Number(raw.angle);
    if (!Number.isFinite(angleValue)) angleValue = 180;
    angleValue = ((angleValue % 360) + 360) % 360;
    return { type, angle: round(angleValue, 2), stops };
  }

  // A new gradient from a plain colour: the colour fading to transparent
  function gradientFrom(color) {
    const hex = (hexColor(color) || '#111111').slice(0, 7);
    return { type: 'linear', angle: 180, stops: [{ at: 0, color: hex }, { at: 100, color: `${hex}00` }] };
  }

  const rgbaCss = (hex) => {
    const color = splitColor(hex);
    const r = parseInt(color.rgb.slice(1, 3), 16);
    const g = parseInt(color.rgb.slice(3, 5), 16);
    const b = parseInt(color.rgb.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${color.alpha})`;
  };

  // The CSS of a gradient (for the editor): the same geometry the renderer draws
  function gradientCss(gradient) {
    const stops = gradient.stops.map((stop) => `${rgbaCss(stop.color)} ${stop.at}%`).join(', ');
    return gradient.type === 'radial' ? `radial-gradient(ellipse farthest-corner at 50% 50%, ${stops})` : `linear-gradient(${gradient.angle}deg, ${stops})`;
  }

  // The line of a linear gradient in a box (pixels), like CSS: through the middle, long enough that the corners get the end colours
  function gradientLine(gradient, box) {
    const radians = (gradient.angle * Math.PI) / 180;
    const sin = Math.sin(radians);
    const cos = Math.cos(radians);
    const half = (Math.abs(box.w * sin) + Math.abs(box.h * cos)) / 2;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    return { x1: cx - sin * half, y1: cy + cos * half, x2: cx + sin * half, y2: cy - cos * half };
  }

  // The stops for a renderer that blends colours as they are (SVG): browsers blend with the opacity applied first (premultiplied),
  // so a colour that fades to transparent does not turn grey on the way. Between two stops of different opacity a few stops are
  // added that follow the browser. [{ at (0..1), rgb, alpha }]
  function expandStops(stops) {
    const parts = stops.map((stop) => {
      const color = splitColor(stop.color);
      return { at: stop.at / 100, rgb: [1, 3, 5].map((start) => parseInt(color.rgb.slice(start, start + 2), 16)), alpha: color.alpha };
    });
    const hex = (rgb) => `#${rgb.map((value) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
    const out = [];
    parts.forEach((part, index) => {
      out.push({ at: part.at, rgb: hex(part.rgb), alpha: part.alpha });
      const next = parts[index + 1];
      if (!next || next.alpha === part.alpha || next.at <= part.at) return;
      const steps = 8;
      for (let step = 1; step < steps; step += 1) {
        const t = step / steps;
        const alpha = part.alpha + (next.alpha - part.alpha) * t;
        const rgb = part.rgb.map((value, channel) =>
          alpha > 0 ? (value * part.alpha * (1 - t) + next.rgb[channel] * next.alpha * t) / alpha : (part.alpha > 0 ? value : next.rgb[channel])
        );
        out.push({ at: part.at + (next.at - part.at) * t, rgb: hex(rgb), alpha: round(alpha, 4) });
      }
    });
    return out;
  }

  /* ---------- the stage ---------- */

  // The size of the stage in pixels from the params of the node: { width, height }.
  function canvasSize(params) {
    const source = isObject(params) ? params : {};
    const format = FORMAT_OPTIONS.includes(source.format) ? source.format : DEFAULT_FORMAT;
    let width;
    let height;
    if (format === 'custom') {
      width = Math.round(Number(source.width)) || DEFAULT_SHORT_EDGE;
      height = Math.round(Number(source.height)) || DEFAULT_SHORT_EDGE;
    } else {
      const [rw, rh] = FORMATS[format];
      const edge = SHORT_EDGES.includes(Number(source.short_edge)) ? Number(source.short_edge) : DEFAULT_SHORT_EDGE;
      if (rw >= rh) {
        height = edge;
        width = Math.round((edge * rw) / rh);
      } else {
        width = edge;
        height = Math.round((edge * rh) / rw);
      }
    }
    width = clamp(width, LIMITS.minEdge, LIMITS.maxEdge);
    height = clamp(height, LIMITS.minEdge, LIMITS.maxEdge);
    if (width * height > LIMITS.maxPixels) {
      const factor = Math.sqrt(LIMITS.maxPixels / (width * height));
      width = Math.floor(width * factor);
      height = Math.floor(height * factor);
    }
    return { width, height };
  }

  /* ---------- layers ---------- */

  function numberIn(value, min, max, fallback, digits = 3) {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number)) return fallback;
    return round(clamp(number, min, max), digits);
  }

  function intIn(value, min, max, fallback) {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number)) return fallback;
    return clamp(Math.round(number), min, max);
  }

  const chars = (value) => Array.from(String(value));
  const clip = (value, max) => chars(value).slice(0, max).join('');

  // A rotation in (-180, 180]
  function angle(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    let turned = number % 360;
    if (turned > 180) turned -= 360;
    if (turned <= -180) turned += 360;
    return round(turned, 2);
  }

  const DEFAULTS = Object.freeze({
    image: { x: 10, y: 10, w: 80, h: 80, input: 0, fit: 'cover', flip_x: false, flip_y: false, radius: 0 },
    text: {
      x: 10,
      y: 40,
      w: 80,
      h: 10,
      text: 'Text',
      text_input: null,
      font: DEFAULT_FONT,
      weight: 700,
      size: 8,
      color: '#111111',
      align: 'center',
      line_height: 1.15,
      letter_spacing: 0,
      uppercase: false,
      shadow: false,
      gradient: null
    },
    shape: { x: 25, y: 25, w: 50, h: 50, shape: 'rect', fill: '#111111', radius: 0, gradient: null }
  });

  // One layer as it counts, or null where it cannot be one (no known type). `problem(text)` is told what was changed or left out.
  function normalizeLayer(raw, problem = () => {}, index = 0) {
    if (!isObject(raw)) {
      problem(`layer ${index + 1}: not an object`);
      return null;
    }
    const type = TYPES.includes(raw.type) ? raw.type : null;
    if (!type) {
      problem(`layer ${index + 1}: unknown type ${JSON.stringify(raw.type)} (image, text or shape)`);
      return null;
    }
    const base = DEFAULTS[type];
    const layer = {
      id: typeof raw.id === 'string' && ID_PATTERN.test(raw.id) ? raw.id : '',
      type,
      name: typeof raw.name === 'string' ? clip(raw.name.replace(/[\r\n\t]+/g, ' ').trim(), LIMITS.nameChars) : '',
      x: numberIn(raw.x, -500, 600, base.x),
      y: numberIn(raw.y, -500, 600, base.y),
      w: numberIn(raw.w, 0.1, 1000, base.w),
      h: numberIn(raw.h, 0.1, 1000, base.h),
      rotation: angle(raw.rotation),
      opacity: numberIn(raw.opacity, 0, 1, 1, 3),
      hidden: raw.hidden === true,
      locked: raw.locked === true
    };
    if (type === 'image') {
      layer.input = intIn(raw.input, 0, LIMITS.images - 1, base.input);
      layer.fit = FITS.includes(raw.fit) ? raw.fit : base.fit;
      layer.flip_x = raw.flip_x === true;
      layer.flip_y = raw.flip_y === true;
      layer.radius = numberIn(raw.radius, 0, 50, 0, 2);
    } else if (type === 'text') {
      const text = typeof raw.text === 'string' || typeof raw.text === 'number' ? String(raw.text).replace(/\r\n?/g, '\n') : base.text;
      if (chars(text).length > LIMITS.textChars) problem(`layer ${index + 1}: text cut to ${LIMITS.textChars} characters`);
      layer.text = clip(text, LIMITS.textChars);
      layer.text_input = raw.text_input === null || raw.text_input === undefined || raw.text_input === '' ? null : intIn(raw.text_input, 0, LIMITS.texts - 1, null);
      layer.font = typeof raw.font === 'string' && raw.font.trim() ? clip(raw.font.replace(/[^\p{L}\p{N} ,_'.-]/gu, '').trim(), LIMITS.fontChars) || base.font : base.font;
      layer.weight = intIn(raw.weight, 100, 1000, base.weight);
      layer.size = numberIn(raw.size, 0.2, 100, base.size);
      const color = hexColor(raw.color);
      if (raw.color !== undefined && !color) problem(`layer ${index + 1}: color must be #rrggbb or #rrggbbaa`);
      layer.color = color || base.color;
      layer.align = ALIGNS.includes(raw.align) ? raw.align : base.align;
      layer.line_height = numberIn(raw.line_height, 0.5, 4, base.line_height);
      layer.letter_spacing = numberIn(raw.letter_spacing, -0.2, 1, 0);
      layer.uppercase = raw.uppercase === true;
      layer.shadow = raw.shadow === true;
      layer.gradient = normalizeGradient(raw.gradient, problem, `layer ${index + 1}: gradient`);
    } else {
      layer.shape = SHAPES.includes(raw.shape) ? raw.shape : base.shape;
      const fill = hexColor(raw.fill);
      if (raw.fill !== undefined && !fill) problem(`layer ${index + 1}: fill must be #rrggbb or #rrggbbaa`);
      layer.fill = fill || base.fill;
      layer.radius = numberIn(raw.radius, 0, 50, 0, 2);
      layer.gradient = normalizeGradient(raw.gradient, problem, `layer ${index + 1}: gradient`);
    }
    return layer;
  }

  // The value of the param `layers` as it counts: { layers }, at most LIMITS.layers, every id unique. Takes the object, a list of layers
  // or the JSON text of either (agent access). `problems` (an array) collects what was changed or left out.
  function normalizeComposition(raw, problems) {
    const problem = (text) => {
      if (Array.isArray(problems)) problems.push(text);
    };
    let value = raw;
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) value = {};
      else {
        try {
          value = JSON.parse(text);
        } catch (_) {
          problem('layers: the text is not JSON');
          value = {};
        }
      }
    }
    const list = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.layers) ? value.layers : [];
    if (isObject(value) && value.layers !== undefined && !Array.isArray(value.layers)) problem('layers: "layers" must be a list');
    if (list.length > LIMITS.layers) problem(`layers: at most ${LIMITS.layers} layers, the rest is left out`);
    const layers = [];
    const used = new Set();
    list.slice(0, LIMITS.layers).forEach((item, index) => {
      const layer = normalizeLayer(item, problem, index);
      if (!layer) return;
      if (!layer.id || used.has(layer.id)) layer.id = freeId(used);
      used.add(layer.id);
      layers.push(layer);
    });
    return { layers };
  }

  function freeId(used) {
    let number = used.size + 1;
    while (used.has(`l${number}`)) number += 1;
    return `l${number}`;
  }

  // A new layer for the editor: the defaults of the type, a free id, `patch` on top.
  function newLayer(type, existing, patch) {
    const used = new Set((existing || []).map((layer) => layer.id));
    return normalizeLayer({ ...DEFAULTS[type], ...(patch || {}), type, id: freeId(used) });
  }

  // What a layer is called in the list of the editor when it has no name of its own (the interface translates the kind).
  function layerSummary(layer) {
    if (!layer) return '';
    if (layer.name) return layer.name;
    if (layer.type === 'text') return String(layer.text || '').split('\n')[0].trim().slice(0, 40);
    return '';
  }

  /* ---------- geometry ---------- */

  // The box of a layer in pixels of the stage: { x, y, w, h }. A text box has the height of its lines (textHeight, pixels) where given.
  function boxPx(layer, canvas, textHeight) {
    const box = {
      x: (layer.x / 100) * canvas.width,
      y: (layer.y / 100) * canvas.height,
      w: (layer.w / 100) * canvas.width,
      h: (layer.h / 100) * canvas.height
    };
    if (layer.type === 'text' && Number.isFinite(textHeight)) box.h = textHeight;
    return box;
  }

  // Pixels back into the percent of the model
  function fromPx(box, canvas) {
    return {
      x: round((box.x / canvas.width) * 100),
      y: round((box.y / canvas.height) * 100),
      w: round((box.w / canvas.width) * 100),
      h: round((box.h / canvas.height) * 100)
    };
  }

  // The four corners of a turned box (pixels)
  function corners(box, rotation) {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const rad = ((rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return [
      [-box.w / 2, -box.h / 2],
      [box.w / 2, -box.h / 2],
      [box.w / 2, box.h / 2],
      [-box.w / 2, box.h / 2]
    ].map(([dx, dy]) => ({ x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }));
  }

  // The upright bounds around a turned box: { x, y, w, h }
  function bounds(box, rotation) {
    if (!rotation) return { ...box };
    const points = corners(box, rotation);
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }

  // The lines a box snaps to: the edges and the middle of the stage and of every other box (bounds in pixels). { x: [..], y: [..] },
  // each { pos, from, to } where from/to is the extent of the thing the line belongs to on the other axis (for drawing the guide).
  function snapTargets(canvas, others) {
    const x = [
      { pos: 0, from: 0, to: canvas.height, stage: true },
      { pos: canvas.width / 2, from: 0, to: canvas.height, stage: true },
      { pos: canvas.width, from: 0, to: canvas.height, stage: true }
    ];
    const y = [
      { pos: 0, from: 0, to: canvas.width, stage: true },
      { pos: canvas.height / 2, from: 0, to: canvas.width, stage: true },
      { pos: canvas.height, from: 0, to: canvas.width, stage: true }
    ];
    for (const box of others || []) {
      for (const pos of [box.x, box.x + box.w / 2, box.x + box.w]) x.push({ pos, from: box.y, to: box.y + box.h });
      for (const pos of [box.y, box.y + box.h / 2, box.y + box.h]) y.push({ pos, from: box.x, to: box.x + box.w });
    }
    return { x, y };
  }

  // The best snap of some lines of a moving thing (values) to the targets of one axis: { delta, target, value } or null.
  function snapAxis(values, targets, threshold) {
    let best = null;
    for (const value of values) {
      for (const target of targets) {
        const delta = target.pos - value;
        if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, target, value };
      }
    }
    return best;
  }

  // Snaps a moving box (its upright bounds, pixels) to the targets: { dx, dy, guides }. A guide is { axis, pos, from, to } in pixels:
  // a vertical line at x = pos from y = from to y = to (axis 'x'), or a horizontal one.
  function snapMove(box, targets, threshold) {
    const sx = snapAxis([box.x, box.x + box.w / 2, box.x + box.w], targets.x, threshold);
    const sy = snapAxis([box.y, box.y + box.h / 2, box.y + box.h], targets.y, threshold);
    const dx = sx ? sx.delta : 0;
    const dy = sy ? sy.delta : 0;
    const moved = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h };
    return { dx, dy, guides: guidesFor(moved, targets, sx, sy) };
  }

  // Snaps the edges of a box that a resize moves: `edges` names them ('left', 'right', 'top', 'bottom'). { dx, dy, guides }, the delta
  // of the moved edge on each axis.
  function snapEdges(box, edges, targets, threshold) {
    const xs = [];
    const ys = [];
    if (edges.includes('left')) xs.push(box.x);
    if (edges.includes('right')) xs.push(box.x + box.w);
    if (edges.includes('top')) ys.push(box.y);
    if (edges.includes('bottom')) ys.push(box.y + box.h);
    const sx = xs.length ? snapAxis(xs, targets.x, threshold) : null;
    const sy = ys.length ? snapAxis(ys, targets.y, threshold) : null;
    return { dx: sx ? sx.delta : 0, dy: sy ? sy.delta : 0, guides: guidesFor(box, targets, sx, sy, true) };
  }

  function guidesFor(box, targets, sx, sy, shiftFromSnap = false) {
    const guides = [];
    if (sx) {
      const pos = sx.target.pos;
      const lines = targets.x.filter((target) => Math.abs(target.pos - pos) < 0.5);
      const top = Math.min(box.y, ...lines.map((line) => line.from));
      const bottom = Math.max(box.y + box.h + (shiftFromSnap && sy ? sy.delta : 0), ...lines.map((line) => line.to));
      guides.push({ axis: 'x', pos, from: top, to: bottom, stage: lines.some((line) => line.stage) });
    }
    if (sy) {
      const pos = sy.target.pos;
      const lines = targets.y.filter((target) => Math.abs(target.pos - pos) < 0.5);
      const left = Math.min(box.x, ...lines.map((line) => line.from));
      const right = Math.max(box.x + box.w + (shiftFromSnap && sx ? sx.delta : 0), ...lines.map((line) => line.to));
      guides.push({ axis: 'y', pos, from: left, to: right, stage: lines.some((line) => line.stage) });
    }
    return guides;
  }

  // Another format for the same layers: positions stay in percent; images and shapes keep the proportions of their box in pixels
  // (the box gets taller or flatter about its centre), so nothing is squeezed. Text keeps its width and size.
  function retarget(layers, from, to) {
    return (layers || []).map((layer) => {
      if (layer.type === 'text') return layer;
      const widthPx = (layer.w / 100) * from.width;
      const heightPx = (layer.h / 100) * from.height;
      if (!(widthPx > 0) || !(heightPx > 0)) return layer;
      const aspect = widthPx / heightPx;
      const newHeightPx = ((layer.w / 100) * to.width) / aspect;
      const h = round((newHeightPx / to.height) * 100);
      const centre = layer.y + layer.h / 2;
      return { ...layer, h: clamp(h, 0.1, 1000), y: round(centre - h / 2) };
    });
  }

  /* ---------- text ---------- */

  // The renderer has no colour emoji font: emoji (with their joiners, skin tones, flags, keycaps and variation selectors) are left out,
  // in the editor too, so that both show the same. The space that would be left twice goes with them.
  const EMOJI_RUN = /[\p{Emoji_Presentation}\p{Emoji_Modifier}‍️⃣\u{e0020}-\u{e007f}]+/gu;
  function stripEmoji(text) {
    return String(text ?? '')
      .replace(EMOJI_RUN, '\0')
      .replace(/ \0 /g, ' ')
      .replace(/^\0 | \0$/gm, '')
      .replace(/\0/g, '');
  }

  // The text a text layer shows: the connected text where it names one, else its own; upper case where it says so; without emoji.
  function layerText(layer, texts) {
    let text = layer.text || '';
    if (Number.isInteger(layer.text_input) && Array.isArray(texts) && typeof texts[layer.text_input] === 'string') text = texts[layer.text_input];
    text = stripEmoji(String(text).replace(/\r\n?/g, '\n'));
    return layer.uppercase ? text.toUpperCase() : text;
  }

  // Greedy wrap like the browser (white-space: pre-wrap, overflow-wrap: break-word): lines break at spaces, a line break in the
  // text always breaks, a word longer than the line is broken between characters. `measure(text)` is the width of a text in the
  // same unit as `maxWidth` (letter spacing included).
  function wrapLines(text, maxWidth, measure) {
    const lines = [];
    for (const paragraph of String(text).split('\n')) {
      const words = paragraph.split(' ');
      let line = null;
      for (const word of words) {
        const candidate = line === null ? word : `${line} ${word}`;
        if (line === null || measure(candidate) <= maxWidth + 0.01) {
          line = candidate;
          if (measure(line) > maxWidth + 0.01 && !line.includes(' ')) {
            const broken = breakWord(line, maxWidth, measure);
            lines.push(...broken.slice(0, -1));
            line = broken[broken.length - 1];
          }
          continue;
        }
        lines.push(line);
        line = word;
        if (measure(line) > maxWidth + 0.01) {
          const broken = breakWord(line, maxWidth, measure);
          lines.push(...broken.slice(0, -1));
          line = broken[broken.length - 1];
        }
      }
      lines.push(line === null ? '' : line);
    }
    return lines;
  }

  function breakWord(word, maxWidth, measure) {
    const parts = [];
    let part = '';
    for (const char of chars(word)) {
      if (part && measure(part + char) > maxWidth + 0.01) {
        parts.push(part);
        part = char;
      } else part += char;
    }
    parts.push(part);
    return parts;
  }

  // Where the lines of a text box stand (the CSS model of line boxes: the glyphs sit in the middle of their line height).
  // size: font size in px, ascent/descent: of the font in em (descent positive), returns the baseline of each line from the top of the box.
  function baselines(count, size, lineHeight, ascent, descent) {
    const lineBox = size * lineHeight;
    const content = size * (ascent + descent);
    const first = (lineBox - content) / 2 + size * ascent;
    return Array.from({ length: count }, (_unused, index) => first + index * lineBox);
  }

  // The font size of a text layer in pixels of the stage
  function fontPx(layer, canvas) {
    return (layer.size / 100) * canvas.width;
  }

  // The font of the app for a family name (case does not matter), or null
  function bundledFont(family) {
    const wanted = String(family || '').trim().toLowerCase();
    return FONTS.find((font) => font.family.toLowerCase() === wanted) || null;
  }

  // The file of a font of the app that draws a weight best: { file, weight } (the weight the file can show, nearest to the asked one)
  function fontFileFor(font, weight) {
    let best = null;
    for (const entry of font.files) {
      const [min, max] = entry.weights.length === 2 ? entry.weights : [entry.weights[0], entry.weights[0]];
      const shown = clamp(weight, min, max);
      const distance = Math.abs(shown - weight);
      if (!best || distance < best.distance) best = { file: entry.file, weight: shown, variable: entry.weights.length === 2, distance };
    }
    return best ? { file: best.file, weight: best.weight, variable: best.variable } : null;
  }

  // The weights the editor offers for a family of the app (in steps of 100)
  function weightsOf(font) {
    const out = new Set();
    for (const entry of font.files) {
      if (entry.weights.length === 2) for (let weight = Math.ceil(entry.weights[0] / 100) * 100; weight <= entry.weights[1]; weight += 100) out.add(weight);
      else out.add(entry.weights[0]);
    }
    return [...out].sort((a, b) => a - b);
  }

  // The brand fonts named by a brand profile (the output "brand" of input.branding): [{ family, weight, branding, file }] for the
  // fonts with a file of their own. The editor loads them, the server draws with them.
  function brandFonts(profile) {
    const list = isObject(profile) && Array.isArray(profile.fonts) ? profile.fonts : [];
    const out = [];
    for (const font of list) {
      if (!isObject(font) || !isObject(font.asset) || typeof font.asset.file !== 'string' || typeof font.asset.branding !== 'string') continue;
      if (!/\.(ttf|otf|woff2?)$/i.test(font.asset.file)) continue;
      const family = String(font.family || '').trim();
      if (!family) continue;
      const weight = Number(String(font.weights || '').match(/\d{3,4}/)?.[0]) || 400;
      out.push({ family, weight, branding: font.asset.branding, file: font.asset.file, role: String(font.role || '') });
    }
    return out;
  }

  // The colours of a brand profile: [{ hex, name, role }]
  function brandColors(profile) {
    const list = isObject(profile) && Array.isArray(profile.colors) ? profile.colors : [];
    return list.map((color) => ({ hex: hexColor(color && color.hex), name: String((color && color.name) || ''), role: String((color && color.role) || '') })).filter((color) => color.hex);
  }

  function parseProfile(text) {
    if (isObject(text)) return text;
    if (typeof text !== 'string' || !text.trim()) return null;
    try {
      const value = JSON.parse(text);
      return isObject(value) ? value : null;
    } catch (_) {
      return null;
    }
  }

  // A short description of the model for agents (the param brief of the agent access and the help of the assistant)
  const AGENT_FORMAT =
    'Object {"layers":[...]}, bottom layer first, at most 40. Units are percent of the stage: x, y = top left of the box (percent of width, height), ' +
    'w = percent of width, h = percent of height, rotation in degrees, opacity 0..1. Image layer: {"type":"image","input":0 (0-based number at the input images),"fit":"cover|contain|fill","radius":0..50}. ' +
    'Text layer: {"type":"text","text":"...","text_input":null or 0-based number at the input texts,"font":"Inter Tight|DM Sans|Montserrat|Space Grotesk|Anton|Playfair Display|Instrument Serif|JetBrains Mono or a brand font","weight":100..900,' +
    '"size":percent of the stage width,"color":"#rrggbb","align":"left|center|right","line_height":1.15,"letter_spacing":0,"uppercase":false,"shadow":false,"gradient":null} (a text box is as high as its lines). ' +
    'Shape layer: {"type":"shape","shape":"rect|ellipse","fill":"#rrggbb or #rrggbbaa","radius":0..50,"gradient":null}. ' +
    '"gradient" (shapes and texts) replaces fill or color when set: {"type":"linear|radial","angle":degrees like CSS (90 = left to right, 180 = top to bottom; linear only),' +
    '"stops":[{"at":0..100,"color":"#rrggbb or #rrggbbaa (aa = opacity, 00 = transparent)"}, ...] (2 to 6 stops)}; null = the plain fill or color.';

  return {
    FORMATS,
    FORMAT_OPTIONS,
    SHORT_EDGES,
    DEFAULT_FORMAT,
    DEFAULT_SHORT_EDGE,
    LIMITS,
    TYPES,
    FITS,
    ALIGNS,
    SHAPES,
    GRADIENTS,
    FONTS,
    FONT_FILES,
    DEFAULT_FONT,
    DEFAULTS,
    AGENT_FORMAT,
    hexColor,
    splitColor,
    normalizeGradient,
    gradientFrom,
    gradientCss,
    gradientLine,
    expandStops,
    canvasSize,
    normalizeLayer,
    normalizeComposition,
    newLayer,
    layerSummary,
    boxPx,
    fromPx,
    corners,
    bounds,
    snapTargets,
    snapMove,
    snapEdges,
    retarget,
    layerText,
    stripEmoji,
    wrapLines,
    baselines,
    fontPx,
    bundledFont,
    fontFileFor,
    weightsOf,
    brandFonts,
    brandColors,
    parseProfile,
    round,
    clamp
  };
});
