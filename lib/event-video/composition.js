'use strict';

// The HTML pages of the event video (WP53, node event_video.render, spec §7): the film of the cut is drawn in chunks of at most 24 s on the render
// nodes (lib/music-video-hud/chunks.js at the cuts, D3: no end card is added, it lies on the last seconds of the film), and every chunk is one page:
// the footage of the chunk (<video>, a file beside the page), the layers of the graphics (view.js: tint, light spot, dip and flash, title, lower
// thirds, intertitles, subtitles, end card), the faces as data URLs, the data of the chunk as JSON, view.js and a runtime inline, and GSAP from
// jsDelivr as the clock (the contract of the render node, lib/explainer-scene.js: its CSP, at most 2 MB of HTML).
// Everything that needs measuring is measured here in Node (lib/music-video-hud/metrics.js familyWidth): the lines of the title and of the
// intertitles, the sizes that make a text fit the format; the page only draws.
//
//   eventChunks(graphics)                                   the chunks of the film (planChunks with the cuts of the graphics, no end card)
//   pageData({ graphics, format, chunk, logoFile })         the data of one page (also the tests read it)
//   buildChunkPage({ graphics, format, chunk, clipFile, logoFile })   the HTML of one page
//   buildPages(graphics, format, assets)                    [{ html, seconds, chunk }] for the whole film (assets: { clipFiles, logoFile })
//   fontFamilies(graphics)                                  the families the pages draw

const fs = require('fs');
const path = require('path');

const contract = require('./contract');
const view = require('./view');
const sceneLib = require('../explainer-scene');
const chunksLib = require('../music-video-hud/chunks');
const metrics = require('../music-video-hud/metrics');

const FPS = contract.FPS;
const MAX_HTML_BYTES = 1.9 * 1024 * 1024;
const VIEW_CODE = fs.readFileSync(path.join(__dirname, 'view.js'), 'utf8');

// The sizes of the texts (spec §5c): fractions of the height of the frame; the title of 9:16 is 5 % of 1920. `max` is the width a text may take.
const TYPE = Object.freeze({
  '16:9': { title: 0.07, inter: 0.06, name: 0.028, role: 0.02, endLine: 0.04, endSub: 0.026, url: 0.022, sub: 0.034, subChars: 42, margin: 0.055, lowerBottom: 0.2, subBottom: 0.075 },
  '9:16': { title: 0.05, inter: 0.045, name: 0.028, role: 0.02, endLine: 0.04, endSub: 0.026, url: 0.022, sub: 0.028, subChars: 26, margin: 0.08, lowerBottom: 0.3, subBottom: 0.2 },
  '1:1': { title: 0.07, inter: 0.06, name: 0.028, role: 0.02, endLine: 0.04, endSub: 0.026, url: 0.022, sub: 0.036, subChars: 32, margin: 0.07, lowerBottom: 0.22, subBottom: 0.09 }
});
const TEXT_WIDTH = 0.84;
// a text that does not fit on its lines is made smaller, down to this share of its size
const MIN_SCALE = 0.6;

// The fonts in lib/fonts by the family that is drawn (metrics.drawnFamily: a family whose file is missing is drawn in its stand-in), with the weights
// and the style each file holds
const FONT_FILES = Object.freeze({
  Montserrat: { weight: '100 900', style: 'normal' },
  'Inter Tight': { weight: '100 900', style: 'normal' },
  Anton: { weight: '400', style: 'normal' },
  'Instrument Serif': { weight: '400', style: 'italic' },
  'DM Sans': { weight: '100 1000', style: 'normal' },
  'Space Grotesk': { weight: '300 700', style: 'normal' },
  'Playfair Display': { weight: '400 900', style: 'italic' }
});

const round2 = (value) => Math.round(value * 100) / 100;
const round3 = (value) => Math.round(value * 1000) / 1000;
const chars = (text) => [...String(text)].length;

// "Montserrat:700" -> the face that is drawn: { family, weight, italic } (a stand-in keeps its own weight and style where it has only one)
function faceOf(spec) {
  const font = contract.parseFont(spec) || contract.parseFont('Inter Tight:500');
  const family = metrics.drawnFamily(font.family);
  const entry = FONT_FILES[family];
  const single = entry && !entry.weight.includes(' ');
  return { family, weight: single ? Number(entry.weight) : font.weight, italic: entry && entry.style === 'italic' ? true : font.italic, asked: font.family };
}

function fontFamilies(graphics) {
  const type = (graphics.look && graphics.look.type) || {};
  return [...new Set([faceOf(type.title).family, faceOf(type.body).family])];
}

// The @font-face rules of the families a page draws (the files as data URLs)
const faceCache = new Map();
function fontFaces(families) {
  return families
    .map((family) => {
      if (faceCache.has(family)) return faceCache.get(family);
      const file = metrics.EVENT_FAMILIES[family].file;
      const woff2 = file.endsWith('.woff2');
      const base64 = fs.readFileSync(path.join(metrics.FONT_DIR, file)).toString('base64');
      const entry = FONT_FILES[family];
      const rule = `@font-face{font-family:'${family}';src:url(data:${woff2 ? 'font/woff2' : 'font/ttf'};base64,${base64}) format('${woff2 ? 'woff2' : 'truetype'}');font-weight:${entry.weight};font-style:${entry.style}}`;
      faceCache.set(family, rule);
      return rule;
    })
    .join('\n');
}

// A text set on at most `maxLines` lines that fit `maxWidth` at `size` px: broken at the spaces into lines of even width, then made smaller (down to
// MIN_SCALE) if a line is still too wide. Returns { lines, size }.
function fitText(text, face, size, maxWidth, maxLines = 2) {
  const words = String(text).trim().split(/\s+/);
  const width = (line, at) => metrics.familyWidth(face, line, at);
  let best = [words.join(' ')];
  if (width(best[0], size) > maxWidth && words.length > 1 && maxLines > 1) {
    // the break that makes the wider of the two lines the narrowest
    let bestWidth = Infinity;
    for (let at = 1; at < words.length; at += 1) {
      const lines = [words.slice(0, at).join(' '), words.slice(at).join(' ')];
      const widest = Math.max(...lines.map((line) => width(line, size)));
      if (widest < bestWidth) {
        bestWidth = widest;
        best = lines;
      }
    }
  }
  const widest = Math.max(...best.map((line) => width(line, size)));
  const scale = widest > maxWidth ? Math.max(MIN_SCALE, maxWidth / widest) : 1;
  return { lines: best, size: Math.round(size * scale * 10) / 10 };
}

// The colour of a text on the accent: dark on a light accent, white on a dark one
function onColour(hex) {
  const value = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!value) return '#FFFFFF';
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(value[1].slice(at, at + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111214' : '#FFFFFF';
}

// The chunks of the film: planChunks of the HUD at the cuts of the graphics, without an end card (D3)
function eventChunks(graphics) {
  return chunksLib.planChunks({ cuts: graphics.cuts.map((start) => ({ start })), endFrame: graphics.endFrame, start: 0 }, { endcardSeconds: 0 });
}

// The data of one page: what lies in the chunk (with a margin, so that a fade that began before is drawn), measured and laid out for the format.
function pageData({ graphics, format, chunk, logoFile = null }) {
  const size = contract.FORMAT_SIZES[format];
  if (!size) throw new Error(`Unknown format ${format}`);
  const { width: W, height: H } = size;
  const T = TYPE[format];
  const base = format === '9:16' ? 1920 : H;
  const unit = H / 1080;
  const look = graphics.look || {};
  const titleFace = faceOf(look.type && look.type.title);
  const bodyFace = faceOf(look.type && look.type.body);
  const maxWidth = W * TEXT_WIDTH;
  const from = chunk.start - 0.5;
  const to = chunk.start + chunk.duration + 0.5;
  const inside = (item) => item.end > from && item.start < to;

  let title = null;
  if (graphics.title && inside(graphics.title)) {
    const fitted = fitText(graphics.title.text, titleFace, base * T.title, maxWidth);
    const anim = contract.TITLE_ANIMS[graphics.title.anim] ? graphics.title.anim : 'fade_rise';
    const sub = graphics.title.sub ? { text: graphics.title.sub, size: fitText(graphics.title.sub, bodyFace, fitted.size * 0.42, maxWidth, 1).size } : null;
    const blockHeight = fitted.lines.length * fitted.size * 1.08 + (sub ? sub.size * 1.6 : 0);
    title = { lines: fitted.lines, size: fitted.size, sub, start: graphics.title.start, end: graphics.title.end, anim, ease: contract.TITLE_ANIMS[anim].ease, top: Math.round(H * 0.44 - blockHeight / 2) };
  }
  // a lower third: its first line is the name (or, without a name, the role or the label, in the size of a name), the second the role or the label
  const lowerThirds = (graphics.lower_thirds || []).filter(inside).map((item) => {
    const texts = [item.name, item.role, item.label].filter((text) => typeof text === 'string' && text.trim());
    const [first, second = null] = texts;
    const nameSize = fitText(first, titleFace, base * T.name, W * 0.7, 1).size;
    const roleSize = second ? fitText(second, bodyFace, base * T.role, W * 0.7, 1).size : nameSize;
    return { name: first, role: second, start: item.start, end: item.end, nameSize, roleSize };
  });
  const intertitles = (graphics.intertitles || []).filter(inside).map((item) => {
    const fitted = fitText(item.text, titleFace, base * T.inter, maxWidth);
    return { lines: fitted.lines, size: fitted.size, start: item.start, end: item.end };
  });
  const subtitles = (graphics.soundbites || []).flatMap((bite) => view.subtitleLines(bite, T.subChars)).filter(inside);
  let endcard = null;
  const card = graphics.endcard;
  if (card) {
    const start = round3(graphics.duration - card.seconds);
    if (start < to) {
      const line = fitText(card.line, titleFace, base * T.endLine, maxWidth);
      endcard = {
        start,
        lines: line.lines,
        lineSize: line.size,
        sub: card.sub || null,
        subSize: card.sub ? fitText(card.sub, bodyFace, base * T.endSub, maxWidth, 1).size : 0,
        url: card.url || null,
        urlSize: card.url ? fitText(card.url, bodyFace, base * T.url, maxWidth, 1).size : 0,
        logo: card.logo && logoFile ? logoFile : null,
        logoW: Math.round(W * (format === '16:9' ? 0.2 : 0.42)),
        logoH: Math.round(H * (format === '9:16' ? 0.1 : 0.14))
      };
    }
  }
  const accent = /^#[0-9a-f]{6}$/i.test(look.accent || '') ? look.accent : '#FFFFFF';
  return {
    t0: chunk.start,
    duration: chunk.duration,
    fps: FPS,
    width: W,
    height: H,
    format,
    unit: round3(unit),
    type: { title: titleFace, body: bodyFace },
    look: {
      tint: look.tint || 0,
      glow: look.glow || 0,
      accent,
      onAccent: onColour(accent),
      // the address on the dark veil of the end card: the accent where it is light enough, else white
      accentText: onColour(accent) === '#111214' ? accent : '#FFFFFF',
      ease: look.ease || 'power3.out',
      titleSeconds: look.title_seconds || 0.9
    },
    acts: graphics.acts || [],
    transitions: (graphics.transitions || []).filter((item) => item.at > from && item.at < to),
    title,
    lowerThirds,
    intertitles,
    subtitles,
    endcard,
    layout: {
      margin: Math.round(W * T.margin),
      lowerBottom: Math.round(H * T.lowerBottom),
      subBottom: Math.round(H * T.subBottom),
      subSize: round2(base * T.sub)
    }
  };
}

// The tint of the look (spec §5c): warm #FF9F45 or cool #4A7BFF in soft light, as strong as the tint is
function tintStyle(tint) {
  if (!tint) return 'display:none';
  return `background:${tint > 0 ? '#FF9F45' : '#4A7BFF'};opacity:${round3(Math.min(0.35, Math.abs(tint) * 2.2))}`;
}

const STYLE = `html,body{margin:0;padding:0;background:#000;overflow:hidden}
#main-composition{position:relative;overflow:hidden;background:#000;color:#fff}
#main-composition video{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover}
.layer{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}
#l-tint{mix-blend-mode:soft-light}
#l-glow{mix-blend-mode:screen}
.title{position:absolute;left:0;width:100%;text-align:center;text-shadow:0 2px 18px rgba(0,0,0,.45)}
.title .tl{white-space:nowrap}
.title .w,.title .c{display:inline-block}
.title .tline{height:4px;width:22%;margin:18px auto 0;background:#fff;transform-origin:left center}
.tsub{margin-top:.5em;letter-spacing:.02em}
.lower{position:absolute;display:inline-block}
.lbar{position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:left center}
.ltext{position:relative;padding:.5em 1.1em .55em .9em;white-space:nowrap}
.ltext .ln{line-height:1.12}
.ltext .lr{line-height:1.2;opacity:.86;margin-top:.15em}
.inter{position:absolute;left:50%;top:50%;text-align:center;white-space:nowrap;text-shadow:0 2px 22px rgba(0,0,0,.5)}
.sub{position:absolute;left:6%;width:88%;text-align:center}
.sub span{display:inline-block;padding:.18em .5em;background:rgba(0,0,0,.5);border-radius:.18em;line-height:1.25}
.veil{position:absolute;left:0;top:0;width:100%;height:100%;background:#07080a}
.ecard{position:absolute;left:0;top:0;width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
#l-end{display:flex;flex-direction:column;align-items:center;gap:.4em}
.elogo{display:block;object-fit:contain;margin-bottom:.6em}
.esub{opacity:.85}`;

// The runtime of a page: a paused GSAP timeline as the clock (like the HUD, lib/music-video-hud/runtime.browser.js): every frame is drawn from scratch
// by EventView.render() for its time in the film.
const RUNTIME = `(function () {
  'use strict';
  var data = window.__EVENT_DATA;
  var by = function (id) { return document.getElementById(id); };
  var layers = { title: by('l-title'), lower: by('l-lower'), inter: by('l-inter'), sub: by('l-sub'), end: by('l-end') };
  var glow = by('l-glow');
  var flash = by('l-flash');
  var veil = by('e-veil');
  var logo = by('e-logo');
  var last = {};
  function put(key, html) {
    if (last[key] === html) return;
    last[key] = html;
    layers[key].innerHTML = html;
  }
  function renderAt(local) {
    var frame = EventView.render(data, data.t0 + Math.max(0, local));
    glow.setAttribute('style', frame.glow);
    flash.setAttribute('style', frame.flash);
    veil.setAttribute('style', frame.endVeil);
    if (logo) logo.setAttribute('style', frame.endLogo);
    put('title', frame.title);
    put('lower', frame.lower);
    put('inter', frame.inter);
    put('sub', frame.sub);
    put('end', frame.end);
  }
  window.__eventRenderAt = renderAt;
  var proxy = { t: 0 };
  var timeline = gsap.timeline({ paused: true });
  timeline.to(proxy, { t: data.duration, duration: data.duration, ease: 'none', onUpdate: function () { renderAt(proxy.t); } }, 0);
  window.__timelines = window.__timelines || {};
  window.__timelines['main'] = timeline;
  renderAt(0);
})();`;

// JSON for a <script> element: nothing in it can end the element or the line.
function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function scriptBody(code) {
  if (/<\/script/i.test(code)) throw new Error('a script of the event video contains a closing script tag');
  return code;
}

const plainName = (name) => /^[A-Za-z0-9._-]{1,80}$/.test(name);

// The page of one chunk. `clipFile` is the footage beside the page, `logoFile` the logo (only the page with the end card shows it).
function buildChunkPage({ graphics, format, chunk, clipFile = 'vid-001.mp4', logoFile = null }) {
  if (!plainName(clipFile)) throw new Error('the name of the footage is not a plain file name');
  if (logoFile !== null && !plainName(logoFile)) throw new Error('the name of the logo is not a plain file name');
  const data = pageData({ graphics, format, chunk, logoFile });
  const seconds = chunk.duration;
  const durationAttr = sceneLib.durationAttr(seconds, FPS);
  const html = `<!doctype html>
<html lang="${graphics.language || 'en'}"><head><meta charset="utf-8">
${sceneLib.CSP_META}
<style>${fontFaces(fontFamilies(graphics))}
${STYLE}</style>
<script src="${sceneLib.GSAP_URL}"></script>
</head><body>
<div id="main-composition" data-composition-id="main" data-width="${data.width}" data-height="${data.height}" data-start="0" data-duration="${durationAttr}" data-fps="${FPS}" style="width:${data.width}px;height:${data.height}px">
<video id="v1" class="clip" src="${clipFile}" muted playsinline data-start="0" data-duration="${sceneLib.durationAttr(chunk.clipSeconds ?? seconds, FPS)}" data-track-index="0"></video>
<div id="l-tint" class="layer" style="${tintStyle(data.look.tint)}"></div><div id="l-glow" class="layer"></div>
<div id="l-sub" class="layer"></div><div id="l-lower" class="layer"></div><div id="l-inter" class="layer"></div><div id="l-title" class="layer"></div>
<div id="l-flash" class="layer"></div><div class="layer"><div id="e-veil" class="veil" style="display:none"></div><div class="ecard">${data.endcard && data.endcard.logo ? `<img id="e-logo" class="elogo" src="${data.endcard.logo}" alt="" style="display:none">` : ''}<div id="l-end"></div></div></div>
<script>window.__EVENT_DATA=${jsonForScript(data)};</script>
<script>${scriptBody(VIEW_CODE)}</script>
<script>${scriptBody(RUNTIME)}</script>
</div></body></html>
`;
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > MAX_HTML_BYTES) {
    const err = new Error(`the page of the chunk is ${Math.round(bytes / 1024)} KB, the limit is ${Math.round(MAX_HTML_BYTES / 1024)} KB`);
    err.code = contract.ERRORS.EVENTRENDER_CHUNK_FAILED;
    const chunks = eventChunks(graphics);
    err.data = { chunk: chunks.findIndex((item) => item.start === chunk.start) + 1, count: chunks.length };
    throw err;
  }
  return html;
}

// The pages of the whole film: [{ html, seconds, chunk }]. assets: { clipFiles: [name per chunk], logoFile } (defaults: vid-001.mp4, no logo); the logo
// goes only into the page that shows the end card.
function buildPages(graphics, format, assets = {}) {
  const chunks = eventChunks(graphics);
  const endStart = graphics.endcard ? graphics.duration - graphics.endcard.seconds : Infinity;
  return chunks.map((chunk, index) => {
    const clipFile = (assets.clipFiles && assets.clipFiles[index]) || 'vid-001.mp4';
    const withLogo = assets.logoFile && chunk.start + chunk.duration > endStart - 0.5 ? assets.logoFile : null;
    return { html: buildChunkPage({ graphics, format, chunk, clipFile, logoFile: withLogo }), seconds: chunk.duration, chunk, logo: Boolean(withLogo) };
  });
}

module.exports = { TYPE, FONT_FILES, MAX_HTML_BYTES, faceOf, fontFamilies, fitText, onColour, eventChunks, pageData, buildChunkPage, buildPages, tintStyle, jsonForScript };
