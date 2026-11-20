'use strict';

// The picture of the Composer node (image.composer): an SVG of the stage, drawn with resvg. Text is not left to resvg: every glyph is
// laid out with fontkit (kerning, the weight of a variable font, brand fonts as TTF, OTF, WOFF or WOFF2) and written as a path, so the
// result has the weight the editor shows and needs no font installed on the server. Lines wrap and stand like in the editor
// (public/nodes/composer-model.js: wrapLines, baselines). Images arrive as data URLs (lib/nodes/nodes-composer.js prepares them).

const fs = require('fs');
const path = require('path');

const model = require('../public/nodes/composer-model');

const FONT_DIR = path.join(__dirname, 'fonts');
// Ligatures are switched off where letters are spaced, as the browser does
const NO_LIGATURES = () => ({ liga: false, clig: false, dlig: false, calt: false });

let fontkitModule;
function loadFontkit() {
  if (fontkitModule === undefined) {
    try {
      fontkitModule = require('fontkit');
    } catch (_) {
      fontkitModule = null;
    }
  }
  return fontkitModule;
}

let resvgModule;
function loadResvg() {
  if (resvgModule === undefined) {
    try {
      resvgModule = require('@resvg/resvg-js');
    } catch (_) {
      resvgModule = null;
    }
  }
  return resvgModule;
}

// Can the node draw here? true or the reason.
function available() {
  if (!loadResvg()) return '@resvg/resvg-js is not installed';
  if (!loadFontkit()) return 'fontkit is not installed';
  return true;
}

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const num = (value) => String(Math.round(value * 1000) / 1000);

/* ---------- fonts ---------- */

// The fonts of one picture. `brand` are the font files of the brand ({ family, weight, buffer, file }), the fonts of the app are read
// from lib/fonts. get(family, weight, sizePx) answers { font, key, family } with the face for that weight (a variable font is set to it),
// or the default font where the family is unknown (said once in the log).
function createFontStore({ brand = [], log = () => {} } = {}) {
  const fontkit = loadFontkit();
  if (!fontkit) throw new Error('fontkit is not installed');
  const opened = new Map();
  const faces = new Map();
  const said = new Set();
  const once = (key, line) => {
    if (said.has(key)) return;
    said.add(key);
    log(line);
  };

  function open(key, read) {
    if (!opened.has(key)) {
      let font = null;
      try {
        font = fontkit.create(read());
        if (font && Array.isArray(font.fonts)) font = font.fonts[0] || null;
      } catch (_) {
        font = null;
      }
      opened.set(key, font);
    }
    return opened.get(key);
  }

  // A face of a font at a weight (and, where it has the axis, at the optical size of the font size)
  function face(base, key, weight, sizePx, label) {
    const axes = base.variationAxes || {};
    const settings = {};
    if (axes.wght) settings.wght = Math.max(axes.wght.min, Math.min(axes.wght.max, weight));
    if (axes.opsz) settings.opsz = Math.max(axes.opsz.min, Math.min(axes.opsz.max, Math.round(sizePx)));
    const faceKey = `${key}|${settings.wght || ''}|${settings.opsz || ''}`;
    if (faces.has(faceKey)) return faces.get(faceKey);
    let font = base;
    if (Object.keys(settings).length) {
      if (base.type === 'WOFF2') {
        // fontkit cannot set the axes of a WOFF2 font; the default instance is drawn
        once(`woff2:${key}`, `The font ${label} is a variable WOFF2 file: it is drawn at its default weight. Upload it as TTF for every weight.`);
      } else {
        try {
          font = base.getVariation(settings);
        } catch (_) {
          font = base;
        }
      }
    }
    const value = { font, key: faceKey, family: label };
    faces.set(faceKey, value);
    return value;
  }

  function fromBrand(family, weight, sizePx) {
    const wanted = family.toLowerCase();
    const candidates = brand.filter((entry) => entry.family.toLowerCase() === wanted && entry.buffer);
    if (!candidates.length) return null;
    candidates.sort((a, b) => Math.abs(a.weight - weight) - Math.abs(b.weight - weight));
    for (const entry of candidates) {
      const key = `brand:${entry.file}`;
      const base = open(key, () => entry.buffer);
      if (base) return face(base, key, base.variationAxes?.wght ? weight : entry.weight, sizePx, entry.family);
      once(key, `The font file ${entry.file} could not be read: another font is used for ${entry.family}`);
    }
    return null;
  }

  function fromApp(family, weight, sizePx) {
    const font = model.bundledFont(family);
    if (!font) return null;
    const choice = model.fontFileFor(font, weight);
    const key = `app:${choice.file}`;
    const base = open(key, () => fs.readFileSync(path.join(FONT_DIR, choice.file)));
    return base ? face(base, key, choice.weight, sizePx, font.family) : null;
  }

  function get(family, weight, sizePx) {
    const name = String(family || '').trim() || model.DEFAULT_FONT;
    const found = fromBrand(name, weight, sizePx) || fromApp(name, weight, sizePx);
    if (found) return found;
    once(`missing:${name.toLowerCase()}`, `The font ${name} is neither a brand font nor a font of the app: ${model.DEFAULT_FONT} is used`);
    return fromApp(model.DEFAULT_FONT, weight, sizePx);
  }

  // The fonts that stand in for characters the chosen font does not have (the fonts of the app, the default first)
  function fallbacks(weight, sizePx, except) {
    const families = [model.DEFAULT_FONT, ...model.FONTS.map((font) => font.family).filter((name) => name !== model.DEFAULT_FONT)];
    return families.map((name) => fromApp(name, weight, sizePx)).filter((value) => value && value.key !== except);
  }

  return { get, fallbacks };
}

/* ---------- text ---------- */

const hasGlyph = (font, codePoint) => {
  try {
    return font.glyphForCodePoint(codePoint).id !== 0;
  } catch (_) {
    return false;
  }
};

// The text of a line cut into runs of one font each: the chosen font where it has the character, else the first stand-in that has it.
// White space stays with the run before it.
function runsOf(text, primary, standIns) {
  const runs = [];
  for (const char of Array.from(text)) {
    const code = char.codePointAt(0);
    let face = primary;
    if (!/\s/.test(char) && !hasGlyph(primary.font, code)) face = standIns().find((candidate) => hasGlyph(candidate.font, code)) || primary;
    if (/\s/.test(char) && runs.length) face = runs[runs.length - 1].face;
    const last = runs[runs.length - 1];
    if (last && last.face.key === face.key) last.text += char;
    else runs.push({ face, text: char });
  }
  return runs;
}

// Lays out the text of a text layer: { lines: [{ glyphs: [{ face, glyph, x }], width }], baselines, height, size } in pixels of the
// stage, x from the left edge of the box (before the alignment).
function layoutText(layer, canvas, texts, fonts) {
  const size = model.fontPx(layer, canvas);
  const spacing = (layer.letter_spacing || 0) * size;
  const primary = fonts.get(layer.font, layer.weight, size);
  let standInList = null;
  const standIns = () => {
    if (!standInList) standInList = fonts.fallbacks(layer.weight, size, primary.key);
    return standInList;
  };
  const boxWidth = (layer.w / 100) * canvas.width;
  const cache = new Map();
  const shape = (run) => {
    const key = `${run.face.key}\u0000${run.text}`;
    if (!cache.has(key)) cache.set(key, run.face.font.layout(run.text, spacing ? NO_LIGATURES() : undefined));
    return cache.get(key);
  };
  const measure = (text) => {
    let width = 0;
    for (const run of runsOf(text, primary, standIns)) {
      width += shape(run).advanceWidth * (size / run.face.font.unitsPerEm);
      width += spacing * Array.from(run.text).length;
    }
    return width;
  };
  const text = model.layerText(layer, texts);
  const wrapped = model.wrapLines(text, boxWidth, measure);
  const lines = wrapped.map((line) => {
    const glyphs = [];
    let x = 0;
    for (const run of runsOf(line, primary, standIns)) {
      const scale = size / run.face.font.unitsPerEm;
      const laid = shape(run);
      // a cluster of several characters (a ligature) gets the spacing of each of them, like in the browser
      const codePoints = laid.glyphs.map((glyph) => Math.max(1, (glyph.codePoints || []).length));
      laid.glyphs.forEach((glyph, index) => {
        const position = laid.positions[index];
        glyphs.push({ face: run.face, glyph, x: x + position.xOffset * scale, y: -position.yOffset * scale, scale });
        x += position.xAdvance * scale + spacing * codePoints[index];
      });
    }
    return { glyphs, width: x };
  });
  const font = primary.font;
  const ascent = font.ascent / font.unitsPerEm;
  const descent = -font.descent / font.unitsPerEm;
  const lineHeight = layer.line_height;
  return {
    lines,
    size,
    baselines: model.baselines(lines.length, size, lineHeight, ascent, descent),
    height: lines.length * size * lineHeight
  };
}

/* ---------- SVG ---------- */

// The SVG of the stage. `images` are { href, width, height } (data URLs) in the order of the input "images", `texts` the texts of the
// input "texts". Returns { svg, notes }: notes for the log (a layer that names an image that is not connected).
function buildSvg({ canvas, background, transparent, layers, images = [], texts = [], fonts, log = () => {} }) {
  const defs = [];
  const body = [];
  const glyphIds = new Map();
  let clipCount = 0;
  let gradientCount = 0;

  // a gradient as a paint server in defs; returns its id. Linear: the CSS gradient line of `box` in pixels (userSpaceOnUse), radial: the
  // box itself (CSS "ellipse farthest-corner at 50% 50%" is r = 1/sqrt(2) in objectBoundingBox). resvg blends the stops without
  // premultiplying, CSS with: expandStops adds the in-between stops so a fade to transparent looks the same in both.
  const gradientDef = (gradient, box) => {
    const id = `gr${gradientCount++}`;
    const stops = model
      .expandStops(gradient.stops)
      .map((stop) => `<stop offset="${num(stop.at)}" stop-color="${stop.rgb}" stop-opacity="${num(stop.alpha)}"/>`)
      .join('');
    if (gradient.type === 'radial') {
      defs.push(`<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.70710678" fx="0.5" fy="0.5">${stops}</radialGradient>`);
    } else {
      const line = model.gradientLine(gradient, box);
      defs.push(
        `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(line.x1)}" y1="${num(line.y1)}" x2="${num(line.x2)}" y2="${num(line.y2)}">${stops}</linearGradient>`
      );
    }
    return id;
  };

  if (!transparent) {
    const color = model.splitColor(background, '#ffffff');
    body.push(`<rect x="0" y="0" width="${canvas.width}" height="${canvas.height}" fill="${color.rgb}" fill-opacity="${color.alpha}"/>`);
  }

  const glyphRef = (face, glyph) => {
    const key = `${face.key}\u0000${glyph.id}`;
    if (!glyphIds.has(key)) {
      const id = `g${glyphIds.size}`;
      glyphIds.set(key, id);
      defs.push(`<path id="${id}" d="${glyph.path.toSVG()}"/>`);
    }
    return glyphIds.get(key);
  };

  layers.forEach((layer, index) => {
    if (layer.hidden || layer.opacity <= 0) return;
    const box = model.boxPx(layer, canvas);
    if (layer.type === 'image') {
      const image = images[layer.input];
      if (!image) {
        log(`Layer ${index + 1} (${layer.name || 'image'}) shows image ${layer.input + 1}, but only ${images.length} ${images.length === 1 ? 'image is' : 'images are'} connected: it is left out`);
        return;
      }
      const clipId = `c${clipCount++}`;
      const radius = (layer.radius / 100) * Math.min(box.w, box.h);
      defs.push(`<clipPath id="${clipId}"><rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}" rx="${num(radius)}" ry="${num(radius)}"/></clipPath>`);
      const aspect = layer.fit === 'contain' ? 'xMidYMid meet' : layer.fit === 'fill' ? 'none' : 'xMidYMid slice';
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      const flip = layer.flip_x || layer.flip_y ? ` transform="translate(${num(cx)} ${num(cy)}) scale(${layer.flip_x ? -1 : 1} ${layer.flip_y ? -1 : 1}) translate(${num(-cx)} ${num(-cy)})"` : '';
      body.push(
        `<g${turn(layer, box)} opacity="${layer.opacity}"><g clip-path="url(#${clipId})">` +
          `<image x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}" preserveAspectRatio="${aspect}" href="${image.href}"${flip}/>` +
          '</g></g>'
      );
      return;
    }
    if (layer.type === 'shape') {
      const fill = model.splitColor(layer.fill, '#111111');
      const paint = layer.gradient ? `fill="url(#${gradientDef(layer.gradient, box)})"` : `fill="${fill.rgb}" fill-opacity="${fill.alpha}"`;
      const shape =
        layer.shape === 'ellipse'
          ? `<ellipse cx="${num(box.x + box.w / 2)}" cy="${num(box.y + box.h / 2)}" rx="${num(box.w / 2)}" ry="${num(box.h / 2)}" ${paint}/>`
          : `<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}" rx="${num((layer.radius / 100) * Math.min(box.w, box.h))}" ${paint}/>`;
      body.push(`<g${turn(layer, box)} opacity="${layer.opacity}">${shape}</g>`);
      return;
    }
    // text
    const laid = layoutText(layer, canvas, texts, fonts);
    const textBox = { ...box, h: laid.height };
    const color = model.splitColor(layer.color, '#111111');
    const uses = [];
    laid.lines.forEach((line, lineIndex) => {
      const offset = layer.align === 'center' ? (box.w - line.width) / 2 : layer.align === 'right' ? box.w - line.width : 0;
      const baseline = box.y + laid.baselines[lineIndex];
      for (const item of line.glyphs) {
        if (!item.glyph.path || !item.glyph.path.commands || !item.glyph.path.commands.length) continue;
        const id = glyphRef(item.face, item.glyph);
        uses.push(`<use href="#${id}" transform="matrix(${num(item.scale)} 0 0 ${num(-item.scale)} ${num(box.x + offset + item.x)} ${num(baseline + item.y)})"/>`);
      }
    });
    if (!uses.length) return;
    let filter = '';
    if (layer.shadow) {
      // the shadow follows the font size (the editor: text-shadow 0 0.04em 0.12em): one filter per layer, in pixels
      filter = ` filter="url(#shadow-${index})"`;
      defs.push(
        `<filter id="shadow-${index}" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="${num(laid.size * 0.04)}" stdDeviation="${num(laid.size * 0.06)}" flood-color="#000000" flood-opacity="0.45"/></filter>`
      );
    }
    if (layer.gradient) {
      // gradient text: the glyphs (in their own transformed space) mask a rectangle of the text box painted with the gradient, like
      // background-clip: text in the editor
      const maskId = `m${index}`;
      defs.push(
        `<mask id="${maskId}"><g fill="#ffffff">${uses.join('')}</g></mask>`
      );
      const paint = gradientDef(layer.gradient, textBox);
      body.push(
        `<g${turn(layer, textBox)} opacity="${layer.opacity}"><g${filter}>` +
          `<rect x="${num(textBox.x)}" y="${num(textBox.y)}" width="${num(textBox.w)}" height="${num(textBox.h)}" fill="url(#${paint})" mask="url(#${maskId})"/>` +
          '</g></g>'
      );
      return;
    }
    body.push(`<g${turn(layer, textBox)} opacity="${layer.opacity}"><g fill="${color.rgb}" fill-opacity="${color.alpha}"${filter}>${uses.join('')}</g></g>`);
  });

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">` +
    `<defs>${defs.join('')}</defs>${body.join('')}</svg>`;
  return { svg };
}

function turn(layer, box) {
  if (!layer.rotation) return '';
  return ` transform="rotate(${layer.rotation} ${num(box.x + box.w / 2)} ${num(box.y + box.h / 2)})"`;
}

// The PNG of the stage: { png, width, height, svg }
function render(options) {
  const resvg = loadResvg();
  if (!resvg) throw new Error('@resvg/resvg-js is not installed');
  const { svg } = buildSvg(options);
  let renderer;
  try {
    renderer = new resvg.Resvg(svg, { fitTo: { mode: 'original' }, font: { loadSystemFonts: false } });
  } catch (err) {
    throw new Error(`composer: the picture could not be drawn (${String(err.message || err).slice(0, 200)})`);
  }
  const rendered = renderer.render();
  return { png: rendered.asPng(), width: rendered.width, height: rendered.height, svg };
}

module.exports = { available, createFontStore, layoutText, buildSvg, render, escapeXml, FONT_DIR };
