'use strict';

// The end card of an advertising spot: the logo, the claim, the call to action and the web address in the colours and fonts of the brand,
// as an HTML/GSAP composition for the render node (HyperFrames). Written by code, never by a model: the card is the one picture of the
// film that must be exact (the words of the claim, the logo untouched), and it costs nothing. Everything has arrived after 1.3 seconds,
// so a card of two seconds can be read too.
//   endcardHtml({ format, duration, tokens, claim, cta, url, name, logo }) -> the document; `logo: true` puts {{asset:1}} in.

const motionHtml = require('../public/nodes/motion-html');
const sceneLib = require('./explainer-scene');

const MAX_CLAIM_LINES = 3;
// the width of a letter of a bold grotesque as a share of its size (the same estimate the explainer scenes use)
const LETTER = 0.58;

function esc(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sizeOf(format) {
  const size = motionHtml.FORMATS[format] || motionHtml.FORMATS.landscape;
  const [width, height] = Array.isArray(size) ? size : [size.width, size.height];
  return { width, height, format: motionHtml.FORMATS[format] ? format : 'landscape' };
}

// The words of the claim in lines of about the same length: as few lines as the width allows at the wanted size, at most three.
function claimLines(claim, { available, size }) {
  const words = String(claim || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const widthOf = (line) => line.join(' ').length * LETTER * size;
  for (let count = 1; count <= MAX_CLAIM_LINES; count += 1) {
    if (count > words.length) break;
    // the best split into `count` lines: the one whose longest line is shortest
    let best = null;
    const walk = (start, left, lines) => {
      if (left === 1) {
        const all = [...lines, words.slice(start)];
        const longest = Math.max(...all.map(widthOf));
        if (!best || longest < best.longest) best = { lines: all, longest };
        return;
      }
      for (let end = start + 1; end <= words.length - (left - 1); end += 1) walk(end, left - 1, [...lines, words.slice(start, end)]);
    };
    walk(0, count, []);
    if (best && (best.longest <= available || count === Math.min(MAX_CLAIM_LINES, words.length))) return best.lines;
  }
  return [words];
}

function endcardHtml({ format = 'landscape', duration = 3, tokens = sceneLib.brandTokens(null), claim = '', cta = '', url = '', name = '', logo = false } = {}) {
  const { width, height, format: key } = sizeOf(format);
  const short = Math.min(width, height);
  const margin = Math.round(width * 0.08);
  const available = width - 2 * margin;
  const headline = String(claim || '').trim() || String(name || '').trim();
  const wanted = Math.round(short * (key === 'landscape' ? 0.115 : 0.105));
  const lines = claimLines(headline, { available, size: wanted });
  const longest = Math.max(1, ...lines.map((line) => line.join(' ').length));
  // a line that is still too wide makes the whole claim smaller, never below a size that can be read on a phone
  const claimSize = Math.max(Math.round(short * 0.05), Math.min(wanted, Math.floor(available / (longest * LETTER))));
  const smallSize = Math.round(short * 0.036);
  const logoHeight = Math.round(short * (key === 'landscape' ? 0.16 : 0.13));
  const bar = Math.round(short * 0.14);
  const gap = Math.round(short * 0.04);
  // without a logo the name of the brand stands above the claim (unless the name is the headline already)
  const showName = !logo && String(name || '').trim() && headline !== String(name).trim();

  let wordIndex = 0;
  const claimHtml = lines
    .map((line) => `<div class="cl">${line.map((word) => `<span class="w" id="w${wordIndex++}">${esc(word)}</span>`).join(' ')}</div>`)
    .join('\n      ');
  const total = wordIndex;
  const last = Math.max(0.5, Number(duration) || 3);
  // the entrances: logo 0.1 s, the words of the claim from 0.3 s (all there by 0.9 s), the bar, then the call to action and the address
  const wordStep = total > 1 ? Math.min(0.09, 0.5 / (total - 1)) : 0;
  const at = { logo: 0.1, words: 0.3, bar: 0.55, cta: 0.95, url: 1.1 };
  const seconds = (value) => String(Math.round(value * 1000) / 1000);
  const timeline = [
    'const tl = gsap.timeline({paused:true});',
    `tl.fromTo('#glow',{opacity:0,scale:0.7},{opacity:1,scale:1,duration:0.9,ease:'power2.out'},0);`,
    logo ? `tl.fromTo('#logo',{opacity:0,scale:0.86,y:${Math.round(short * 0.02)}},{opacity:1,scale:1,y:0,duration:0.5,ease:'back.out(1.6)'},${seconds(at.logo)});` : '',
    showName ? `tl.fromTo('#name',{opacity:0,y:${Math.round(short * 0.02)}},{opacity:1,y:0,duration:0.4,ease:'power2.out'},${seconds(at.logo)});` : '',
    ...Array.from({ length: total }, (_item, index) => `tl.fromTo('#w${index}',{opacity:0,y:${Math.round(claimSize * 0.45)},rotate:3},{opacity:1,y:0,rotate:0,duration:0.4,ease:'power3.out'},${seconds(at.words + index * wordStep)});`),
    `tl.fromTo('#bar',{width:0},{width:${bar},duration:0.5,ease:'power3.out'},${seconds(at.bar)});`,
    cta ? `tl.fromTo('#cta',{opacity:0,scale:0.9},{opacity:1,scale:1,duration:0.35,ease:'back.out(1.8)'},${seconds(at.cta)});` : '',
    url ? `tl.fromTo('#url',{opacity:0},{opacity:1,duration:0.35,ease:'power1.out'},${seconds(at.url)});` : '',
    // the card never stands still: a slow drift to the last frame
    `tl.fromTo('#stage',{scale:1},{scale:1.035,duration:${seconds(last)},ease:'none'},0);`,
    `tl.to({}, {duration:0.01}, ${Math.max(0.02, Math.round((Number(sceneLib.durationAttr(last)) - 0.01) * 1000) / 1000)});`,
    'window.__timelines = window.__timelines || {};',
    "window.__timelines['main'] = tl;"
  ]
    .filter(Boolean)
    .join('\n    ');

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<script src="${sceneLib.GSAP_URL}"></script>
<style>
  body, html { margin:0; width:${width}px; height:${height}px; overflow:hidden; background:${tokens.bg}; }
  #main-composition { position:relative; width:${width}px; height:${height}px; overflow:hidden; background:${tokens.bg}; font-family:${tokens.body}; color:${tokens.fg}; }
  #glow { position:absolute; left:${Math.round(width / 2 - short * 0.75)}px; top:${Math.round(height / 2 - short * 0.75)}px; width:${Math.round(short * 1.5)}px; height:${Math.round(short * 1.5)}px; border-radius:50%; background:radial-gradient(circle, ${tokens.accent}38 0%, ${tokens.accent}12 38%, ${tokens.accent}00 68%); opacity:0; }
  #stage { position:absolute; left:${margin}px; top:0; width:${available}px; height:${height}px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:${gap}px; text-align:center; }
  #logo { max-height:${logoHeight}px; max-width:${Math.round(available * 0.6)}px; object-fit:contain; opacity:0; }
  #name { font-family:${tokens.headline}; font-weight:700; font-size:${smallSize}px; letter-spacing:0.14em; text-transform:uppercase; color:${tokens.accent}; opacity:0; }
  #claim { font-family:${tokens.headline}; font-weight:800; font-size:${claimSize}px; line-height:1.06; letter-spacing:-0.015em; }
  .cl { white-space:nowrap; }
  .w { display:inline-block; opacity:0; transform-origin:0 100%; }
  #bar { height:${Math.max(6, Math.round(short * 0.009))}px; width:0; background:${tokens.accent}; border-radius:${Math.round(short * 0.005)}px; }
  #cta { font-family:${tokens.headline}; font-weight:700; font-size:${smallSize}px; line-height:1; padding:${Math.round(smallSize * 0.62)}px ${Math.round(smallSize * 1.1)}px; border-radius:${smallSize * 2}px; background:${tokens.accent}; color:${sceneLib.contrast(tokens.accent, '#ffffff') >= sceneLib.contrast(tokens.accent, '#111111') ? '#ffffff' : '#111111'}; opacity:0; }
  #url { font-size:${Math.round(smallSize * 0.86)}px; letter-spacing:0.04em; color:${tokens.muted}; opacity:0; }
</style>
</head>
<body>
<div id="main-composition" data-composition-id="main" data-width="${width}" data-height="${height}" data-start="0" data-duration="${sceneLib.durationAttr(last)}">
  <div id="glow"></div>
  <div id="stage">
    ${logo ? '<img id="logo" src="{{asset:1}}" alt="">' : showName ? `<div id="name">${esc(name)}</div>` : ''}
    <div id="claim">
      ${claimHtml}
    </div>
    <div id="bar"></div>
    ${cta ? `<div id="cta">${esc(cta)}</div>` : ''}
    ${url ? `<div id="url">${esc(url)}</div>` : ''}
  </div>
  <script>
    ${timeline}
  </script>
</div>
</body>
</html>`;
  return sceneLib.withCsp(html);
}

module.exports = { endcardHtml, claimLines, sizeOf };
