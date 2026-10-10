'use strict';

// The HTML page of one chunk of the music video (WP44): the footage cut for the chunk (<video>, a file beside the page), the layers of the HUD,
// the faces as data URLs, the style sheet, themes.js + state.js + view.js + the runtime inline, the data of the chunk as JSON, and GSAP from jsDelivr
// as the clock (the contract of the render node, lib/explainer-scene.js). One page for one chunk of at most 24 s; the render node takes at most 2 MB of
// HTML. The style of the graphics (`graphics.theme`, themes.js) decides which faces and which style sheets the page carries: only the ones of its
// own style, so that a page of the second style does not carry the faces of the first.
// With the beat effects on (WP45, WP49; options.effects `subtle`, `strong` or `wild`, effects.js) the page has more: the stage in a wrapper #fxall for
// the effects over the whole picture, the footage in a wrapper #fx that the effects move and filter, the copies of the footage (<video> clips that
// HyperFrames plays from their own place in the footage: freeze, stutter, echo, mirror), the layers of noise, scanlines and light over the footage
// (under the HUD) and of snow over everything, the SVG filters and the noise texture (fxsvg.js), the part of the plan of the effects that the chunk
// needs (sliced from the plan of the whole film, so the chunks join without a seam), effects.js and its runtime. With the effects off (the default
// of this module) the page is the one of before, byte for byte.

const fs = require('fs');
const path = require('path');

const sceneLib = require('../explainer-scene');
const graphicsLib = require('./graphics');
const metricsLib = require('./metrics');
const themes = require('./themes');
const effectsLib = require('./effects');
const fxSvg = require('./fxsvg');

const MAX_HTML_BYTES = 1.8 * 1024 * 1024;
const FPS = 24;
const FONT_DIR = path.join(__dirname, '..', 'fonts');

const FONTS = Object.freeze([
  { family: 'Anton', file: 'anton/Anton-Regular.ttf', weight: '400', style: 'normal', mime: 'font/ttf', format: 'truetype' },
  { family: 'Instrument Serif', file: 'instrument-serif/InstrumentSerif-Italic.ttf', weight: '400', style: 'italic', mime: 'font/ttf', format: 'truetype' },
  { family: 'JetBrains Mono', file: 'jetbrains-mono/JetBrainsMono-Medium.ttf', weight: '500', style: 'normal', mime: 'font/ttf', format: 'truetype' },
  { family: 'JetBrains Mono', file: 'jetbrains-mono/JetBrainsMono-Bold.ttf', weight: '700', style: 'normal', mime: 'font/ttf', format: 'truetype' },
  { family: 'Inter Tight', file: 'inter-tight/InterTight-latin-variable.woff2', weight: '100 900', style: 'normal', mime: 'font/woff2', format: 'woff2' }
]);

// The faces of the second style (Kuble): Montserrat (one variable file, the weights 600, 800 and 900 are used), the quiet lines in Instrument Serif
// Italic and the labels in JetBrains Mono. Anton and Inter Tight are not in its page.
const KUBLE_FONTS = Object.freeze([
  { family: 'Montserrat', file: 'montserrat/Montserrat-Variable.ttf', weight: '100 900', style: 'normal', mime: 'font/ttf', format: 'truetype' },
  FONTS[1],
  FONTS[2],
  FONTS[3]
]);
const THEME_FONTS = Object.freeze({ hud: FONTS, kuble: KUBLE_FONTS });

const parts = {};

// The custom properties of a style that its style sheet reads: the colours of the table (also as the three numbers of an rgba()), the width of the
// cell of a digit. The accent comes with the page (it can be set by the node).
function themeCss(theme) {
  if (theme.id !== 'kuble') return '';
  const c = theme.colors;
  const vars = {
    '--night': c.night,
    '--night-rgb': themes.rgb(c.night),
    '--night-2': c.night2,
    '--night-3': c.night3,
    '--ink-c': c.ink,
    '--ink-rgb': themes.rgb(c.ink),
    '--ink-2': c.ink2,
    '--ink-3': c.ink3,
    '--amber': c.amber,
    '--amber-rgb': themes.rgb(c.amber),
    '--hairline': `rgba(${themes.rgb(c.ink)},.28)`,
    '--sub': `rgba(${themes.rgb(c.ink)},.9)`,
    '--dial-face': `rgba(${themes.rgb(c.night)},.5)`,
    '--dial-ring': `rgba(${themes.rgb(c.ink)},.5)`,
    '--dial-inner': `rgba(${themes.rgb(c.ink)},.06)`,
    '--dial-inner-ring': `rgba(${themes.rgb(c.ink)},.34)`,
    '--cell': `${metricsLib.load()[theme.faces.number].cell}em`
  };
  return `#main-composition{${Object.entries(vars).map(([name, value]) => `${name}:${value}`).join(';')}}`;
}

// The accent of a page as custom properties: the colour, its numbers, and the lighter form for writing and glow (the table's own when the accent is the
// style's blue).
function accentVars(theme, accent) {
  if (theme.id !== 'kuble') return `--acc:${accent}`;
  const text = String(accent).toUpperCase() === theme.colors.blue.toUpperCase() ? theme.colors.blueText : themes.lighten(accent, 0.16);
  return `--acc:${accent};--acc-rgb:${themes.rgb(accent)};--blue-t:${text};--blue-t-rgb:${themes.rgb(text)}`;
}

// What does not change from chunk to chunk, read once for each style: the @font-face rules, the style sheet and the scripts.
function loadParts(themeId = themes.DEFAULT) {
  if (parts[themeId]) return parts[themeId];
  const theme = themes.get(themeId);
  const faces = THEME_FONTS[theme.id].map((font) => {
    const base64 = fs.readFileSync(path.join(FONT_DIR, font.file)).toString('base64');
    return `@font-face{font-family:'${font.family}';src:url(data:${font.mime};base64,${base64}) format('${font.format}');font-weight:${font.weight};font-style:${font.style}}`;
  }).join('\n');
  const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
  // the sheet of the second style comes after the first one and changes what it needs to change
  const css = theme.id === 'kuble' ? `${read('styles.css')}\n${read('styles.kuble.css')}\n${themeCss(theme)}` : read('styles.css');
  parts[theme.id] = {
    faces,
    css,
    themes: read('themes.js'),
    state: read('state.js'),
    view: read('view.js'),
    runtime: read('runtime.browser.js'),
    fxCss: read('styles.fx.css'),
    effects: read('effects.js'),
    fxRuntime: read('runtime.fx.browser.js')
  };
  return parts[theme.id];
}

// The plan of the effects of a film, made once for each level and strength of the glitch (every chunk of the film reads its part of the same plan).
const fxPlans = new WeakMap();
function effectsPlan(graphics, level, glitch) {
  if (!fxPlans.has(graphics)) fxPlans.set(graphics, {});
  const known = fxPlans.get(graphics);
  const key = `${level} ${glitch === undefined ? '' : glitch}`;
  if (!(key in known)) known[key] = effectsLib.planEffects(graphics, { level, glitch });
  return known[key];
}

// The time of a frame of the page for the start of a clip of HyperFrames: rounded down to the microsecond, never up. HyperFrames snaps the window
// of a clip to the frames, but takes the frame of the footage as floor((time - start) * fps): a start rounded up by a fraction of a microsecond
// shows the frame before the right one (checked in 0.8.139).
const frameAttr = (frame) => (Math.floor((frame / FPS) * 1e6 + 1e-6) / 1e6).toFixed(6);

// The copies of the footage in the page of a chunk: a <video> clip of the footage of the chunk for every copy of the plan that lies in it (the plan
// keeps every copy inside the footage of one chunk, effects.js seamsOf), with its own place in the footage (data-media-start), the playback rate
// that holds a frame (0.1) and its style; every clip on a track of its own.
function copiesHtml(fx, chunkStartFrame, pageFrames, clipFile) {
  return fx.copies
    .filter((copy) => copy.f >= chunkStartFrame && copy.f + copy.n <= chunkStartFrame + pageFrames && copy.m >= chunkStartFrame)
    .map((copy, index) => {
      const rate = copy.r === 1 ? '' : ` data-playback-rate="${copy.r}"`;
      const style = effectsLib.COPY_STYLES[copy.s] || '';
      return `<video id="fxc${index + 1}" class="clip" src="${clipFile}" muted playsinline data-start="${frameAttr(copy.f - chunkStartFrame)}" data-duration="${durationAttr(copy.n / FPS)}" data-media-start="${frameAttr(copy.m - chunkStartFrame)}"${rate} data-track-index="${index + 1}"${style ? ` style="${style}"` : ''}></video>`;
    })
    .join('');
}

// JSON for a <script> element: nothing in it can end the element or the line.
function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// The code of the scripts is put in as it is; a closing tag in it would end the element (the files are ours: this is a check, not a filter).
function scriptBody(code) {
  if (/<\/script/i.test(code)) throw new Error('a script of the HUD contains a closing script tag');
  return code;
}

// The attribute of the render: a hundredth of a frame below the whole frames, so that the render makes exactly the frames of the chunk
// (see durationAttr in lib/explainer-scene.js).
const durationAttr = (seconds) => sceneLib.durationAttr(seconds, FPS);

// The page of a chunk.
//   graphics   the resolved data of the whole film (resolveGraphics)
//   chunk      { start, duration, clipSeconds } (planChunks): where the chunk starts in the song, how long the page is (with the end card) and how
//              long the footage
//   clipFile   the name of the footage beside the page (an asset of the render job)
//   options    { karaoke: true, endcard: true, effects: 'off', glitch } (effects: the level of the beat effects, effects.js; anything but `subtle`, `strong`
//              and `wild` is off; glitch: the slider of the node, the strength of the glitch; plan: a plan of the effects made elsewhere, for the tools)
function buildChunkHtml({ graphics, chunk, clipFile = 'vid-001.mp4', options = {} }) {
  const theme = themes.get(graphics.theme);
  const p = loadParts(theme.id);
  const level = effectsLib.normalizeLevel(options.effects);
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(clipFile)) throw new Error('the name of the footage is not a plain file name');
  const seconds = Number(chunk.duration ?? chunk.seconds);
  const clipSeconds = Number(chunk.clipSeconds ?? seconds);
  const frames = Math.max(1, Math.round(seconds * FPS));
  const data = {
    t0: chunk.start,
    duration: frames / FPS,
    graphics: graphicsLib.sliceGraphics(graphics, chunk.start, chunk.start + seconds),
    options: { karaoke: options.karaoke !== false, endcard: options.endcard !== false }
  };
  const accent = graphics.accent || (theme.id === 'kuble' ? theme.accent : graphicsLib.DEFAULT_ACCENT);
  // the beat effects: the part of the plan of the whole film that this page needs, and the pieces of the page that carry them (all empty when off)
  const plan = level === 'off' ? null : options.plan || effectsPlan(graphics, level, options.glitch);
  const fx = plan ? effectsLib.sliceEffects(plan, chunk.start, chunk.start + seconds) : null;
  const fxStyle = fx ? `\n${p.fxCss}\n#fx-grain,#fx-snow{background-image:url(${fxSvg.maps().noise})}` : '';
  // the filters in the colours of the style: a style whose glitch is a prism (Kuble) has the RGB split as a prism of amber and blue, and its blue for
  // the seam of the slices, the line of the VHS band and the negative blocks
  const prism = theme.post.glitch === 'prism';
  const fxDefs = fx ? `${fxSvg.svgDefs(prism ? { light: theme.colors.blue, prism, negative: theme.colors.blue } : {})}\n` : '';
  const fxAllOpen = fx ? '<div id="fxall">' : '';
  const fxAllClose = fx ? '<div id="fx-snow" class="layer"></div></div>' : '';
  const fxOpen = fx ? '<div id="fx">' : '';
  const fxCopies = fx ? copiesHtml(fx, Math.round(chunk.start * FPS), frames, clipFile) : '';
  const fxClose = fx ? '</div><div id="fx-grain" class="layer"></div><div id="fx-scan" class="layer"></div><div id="fx-light" class="layer"></div>' : '';
  const fxScripts = fx ? `<script>window.__HUD_FX=${jsonForScript(fx)};</script>\n<script>${scriptBody(p.effects)}</script>\n<script>${scriptBody(p.fxRuntime)}</script>\n` : '';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
${sceneLib.CSP_META}
<style>${p.faces}
${p.css}${fxStyle}</style>
<script src="${sceneLib.GSAP_URL}"></script>
</head><body>
<div id="main-composition" data-composition-id="main" data-width="${graphicsLib.WIDTH}" data-height="${graphicsLib.HEIGHT}" data-start="0" data-duration="${durationAttr(seconds)}" data-fps="${FPS}"${theme.id === 'hud' ? '' : ` data-theme="${theme.id}"`} style="${accentVars(theme, accent)}">
${fxDefs}${fxAllOpen}<div id="stage">${fxOpen}<div id="cam"><video id="v1" class="clip" src="${clipFile}" muted playsinline data-start="0" data-duration="${durationAttr(clipSeconds)}" data-track-index="0"></video>${fxCopies}</div>${fxClose}
<div id="scrim" class="layer"></div><div id="vig" class="layer"></div>
<div id="l-dev" class="layer"></div><div id="l-hud" class="layer"></div><div id="l-kar" class="layer"></div></div>${fxAllClose}
<div id="l-over" class="layer"></div><div id="l-end" class="layer"></div>
<script>window.__HUD_DATA=${jsonForScript(data)};</script>
<script>${scriptBody(p.themes)}</script>
<script>${scriptBody(p.state)}</script>
<script>${scriptBody(p.view)}</script>
<script>${scriptBody(p.runtime)}</script>
${fxScripts}</div></body></html>
`;
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > MAX_HTML_BYTES) {
    const err = new Error(`the page of the chunk is ${Math.round(bytes / 1024)} KB, the limit is ${Math.round(MAX_HTML_BYTES / 1024)} KB`);
    err.code = 'HUD_CHUNK_TOO_LARGE';
    err.data = { kb: Math.round(bytes / 1024), limit: Math.round(MAX_HTML_BYTES / 1024) };
    throw err;
  }
  return html;
}

module.exports = { buildChunkHtml, effectsPlan, copiesHtml, frameAttr, durationAttr, jsonForScript, FONTS, KUBLE_FONTS, THEME_FONTS, MAX_HTML_BYTES, FPS };
