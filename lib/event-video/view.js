'use strict';

// The drawing of one frame of the graphics of the event video (WP53, spec §5c, §7): render(data, t) turns the data of a page (composition.js
// pageData) and a time of the film into the HTML and the styles of the layers: the tint and the light spot over the footage, the dip and the flash at a
// cut, the title, the lower thirds, the intertitles, the subtitles of the soundbites and the end card. Pure like the view of the HUD: the same data
// and time give the same strings, nothing is kept between frames, so a frame can be drawn in any order (HyperFrames seeks). The eases are computed
// here (the GSAP timeline of the page is only the clock), with the names GSAP gives them.
// UMD: runs in Node (the tests, the subtitles of the node) and in the browser (inlined in the page of a chunk).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EventView = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const r2 = (value) => Math.round(value * 100) / 100;
  const r3 = (value) => Math.round(value * 1000) / 1000;
  const esc = (text) => String(text === undefined || text === null ? '' : text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  // The eases of GSAP that the plan names (contract TITLE_ANIMS, LOOK_EASES), as functions of 0..1 (in GSAP power2 is the cubic, power3 the quartic,
  // power4 the quintic curve)
  const EASES = {
    none: (x) => x,
    'power2.out': (x) => 1 - (1 - x) ** 3,
    'power3.out': (x) => 1 - (1 - x) ** 4,
    'power4.out': (x) => 1 - (1 - x) ** 5,
    'expo.out': (x) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x)),
    'sine.out': (x) => Math.sin((x * Math.PI) / 2),
    'power2.inOut': (x) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2)
  };
  function ease(name) {
    if (EASES[name]) return EASES[name];
    const back = /^back\.out\(([\d.]+)\)$/.exec(String(name || ''));
    if (back) {
      const s = Number(back[1]);
      return (x) => 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2;
    }
    return EASES['power3.out'];
  }
  // progress of a move of `seconds` that starts `delay` after `from`, eased
  const moveAt = (fn, t, from, seconds, delay = 0) => fn(clamp((t - from - delay) / Math.max(1e-6, seconds), 0, 1));

  // the seconds of the ways out: the title and the intertitles fade, the lower third leaves in the mirror of its way in
  const OUT_SECONDS = 0.45;
  const LOWER = { bar: 0.4, textDelay: 0.1 };
  const ENDCARD_FADE = 0.5;
  const ACTS_WITH_GLOW = ['hook', 'peak', 'close'];

  /* ---------- subtitles (also the SRT of the node) ---------- */

  // The lines of a soundbite in the times of the film: words (times relative to the soundbite, D13) gathered to at most `maxChars` characters, a new
  // line after the end of a sentence; a line stands from its first word to a little after its last one, never into the next line or past the soundbite.
  function subtitleLines(bite, maxChars) {
    const lines = [];
    let words = [];
    const flush = () => {
      if (!words.length) return;
      lines.push({ text: words.map((word) => word.w).join(' '), start: bite.start + words[0].s, end: bite.start + words[words.length - 1].e });
      words = [];
    };
    for (const word of bite.words || []) {
      const text = words.map((item) => item.w).concat(word.w).join(' ');
      if (words.length && [...text].length > maxChars) flush();
      words.push(word);
      if (/[.!?…]["»”]?$/.test(word.w) && words.length >= 2) flush();
    }
    flush();
    return lines.map((line, index) => {
      const next = lines[index + 1];
      const end = Math.min(line.end + 0.3, next ? next.start - 0.04 : bite.end, bite.end);
      return { text: line.text, start: r3(line.start), end: r3(Math.max(line.start + 0.2, end)) };
    });
  }

  /* ---------- the layers ---------- */

  const fontCss = (face) => `font-family:'${face.family}';font-weight:${face.weight};font-style:${face.italic ? 'italic' : 'normal'}`;

  // The light spot (glow above 0.5, spec §5c) in hook, peak and close: it fades in and out over half a second at the borders of these acts and drifts
  // slowly.
  function glowStyle(data, t) {
    const look = data.look;
    if (!(look.glow > 0)) return 'display:none';
    // the acts with the light, joined where they follow each other (peak and close), faded in and out at the borders of what is joined
    const spans = [];
    for (const act of data.acts) {
      if (!ACTS_WITH_GLOW.includes(act.act)) continue;
      const last = spans[spans.length - 1];
      if (last && Math.abs(last.end - act.start) < 1e-3) last.end = act.end;
      else spans.push({ start: act.start, end: act.end });
    }
    const span = spans.find((item) => t >= item.start && t < item.end);
    const share = span ? clamp(Math.min(t - span.start, span.end - t) / 0.5, 0, 1) : 0;
    if (share <= 0) return 'display:none';
    const x = 30 + 18 * Math.sin(t * 0.35);
    const y = 24 + 10 * Math.cos(t * 0.27);
    return `opacity:${r3(look.glow * share)};background:radial-gradient(circle at ${r2(x)}% ${r2(y)}%,rgba(255,236,200,.95) 0%,rgba(255,214,160,.45) 22%,rgba(255,200,140,0) 55%)`;
  }

  // The dip (to black and back, centred on the cut) and the flash (white at the cut, fading): layers of the page at a cut (D5).
  function transitionStyle(data, t) {
    for (const item of data.transitions) {
      const span = item.frames / data.fps;
      if (item.type === 'dip') {
        const half = span / 2;
        if (Math.abs(t - item.at) < half) return `background:#000;opacity:${r3(1 - Math.abs(t - item.at) / half)}`;
      } else if (item.type === 'flash') {
        if (t >= item.at && t < item.at + span) return `background:#fff;opacity:${r3(0.85 * (1 - (t - item.at) / span) ** 2)}`;
      }
    }
    return 'display:none';
  }

  // How much of a text that stands from `start` to `end` is still there on its way out (1 before, 0 at the end)
  const outOf = (t, end, seconds = OUT_SECONDS) => clamp((end - t) / seconds, 0, 1);

  function titleHtml(data, t) {
    const title = data.title;
    if (!title || t < title.start || t >= title.end) return '';
    const look = data.look;
    const fn = ease(title.ease);
    const u = t - title.start;
    const seconds = look.titleSeconds;
    const out = outOf(t, title.end);
    const face = fontCss(data.type.title);
    let body = '';
    const lineStyle = `font-size:${title.size}px;line-height:1.08`;
    if (title.anim === 'words_up' || title.anim === 'char_slam') {
      const stagger = title.anim === 'words_up' ? 0.06 : 0.02;
      let index = 0;
      body = title.lines
        .map((line) => {
          const pieces = title.anim === 'words_up' ? line.split(' ') : [...line];
          const spans = pieces.map((piece) => {
            const p = moveAt(fn, u, 0, title.anim === 'words_up' ? seconds : seconds * 0.6, index * stagger);
            index += 1;
            if (title.anim === 'words_up') return `<span class="w" style="opacity:${r3(clamp(p, 0, 1))};transform:translateY(${r3((1 - p) * 0.6)}em)">${esc(piece)}</span>`;
            const shown = piece === ' ' ? '&nbsp;' : esc(piece);
            return `<span class="c" style="opacity:${r3(clamp(p * 1.5, 0, 1))};transform:scale(${r3(1.6 - 0.6 * p)})">${shown}</span>`;
          });
          return `<div class="tl" style="${lineStyle}">${spans.join(title.anim === 'words_up' ? ' ' : '')}</div>`;
        })
        .join('');
      body = `<div style="opacity:${r3(out)}">${body}</div>`;
    } else {
      const p = moveAt(fn, u, 0, seconds);
      let style = `opacity:${r3(clamp(p, 0, 1) * out)}`;
      let line = '';
      if (title.anim === 'fade_rise') style += `;transform:translateY(${r2((1 - p) * 20 * data.unit)}px)`;
      else if (title.anim === 'tracking') style += `;letter-spacing:${r3(0.1 * (1 - p))}em`;
      else if (title.anim === 'scale_blur') style += `;transform:scale(${r3(1.15 - 0.15 * p)});filter:blur(${r2(12 * (1 - p) * data.unit)}px)`;
      else if (title.anim === 'line_draw') {
        const drawn = moveAt(fn, u, 0, seconds * 0.6);
        const shown = moveAt(fn, u, 0, seconds * 0.65, seconds * 0.35);
        style = `opacity:${r3(out)};clip-path:inset(0 ${r2((1 - shown) * 100)}% 0 0)`;
        line = `<div class="tline" style="transform:scaleX(${r3(drawn)});opacity:${r3(out)}"></div>`;
      }
      body = `<div style="${style}">${title.lines.map((text) => `<div class="tl" style="${lineStyle}">${esc(text)}</div>`).join('')}</div>${line}`;
    }
    let sub = '';
    if (title.sub) {
      const p = moveAt(ease(look.ease), u, 0, 0.4, seconds * 0.5);
      sub = `<div class="tsub" style="${fontCss(data.type.body)};font-size:${title.sub.size}px;opacity:${r3(p * out)};transform:translateY(${r2((1 - p) * 10 * data.unit)}px)">${esc(title.sub.text)}</div>`;
    }
    return `<div class="title" style="${face};top:${title.top}px">${body}${sub}</div>`;
  }

  // The lower thirds: the bar grows from the left in 0.4 s (scaleX), the text follows 0.1 s later; the way out is the mirror (spec §7).
  function lowerHtml(data, t) {
    const fn = ease(data.look.ease);
    return data.lowerThirds
      .filter((item) => t >= item.start && t < item.end)
      .map((item) => {
        const barIn = moveAt(fn, t, item.start, LOWER.bar);
        const textIn = moveAt(fn, t, item.start, LOWER.bar, LOWER.textDelay);
        const barOut = clamp((item.end - t) / LOWER.bar, 0, 1);
        const textOut = clamp((item.end - t - LOWER.textDelay) / LOWER.bar, 0, 1);
        const bar = Math.min(barIn, fn(barOut));
        const text = Math.min(textIn, fn(textOut));
        const lines = [];
        lines.push(`<div class="ln" style="${fontCss(data.type.title)};font-size:${item.nameSize}px">${esc(item.name)}</div>`);
        if (item.role) lines.push(`<div class="lr" style="${fontCss(data.type.body)};font-size:${item.roleSize}px">${esc(item.role)}</div>`);
        return (
          `<div class="lower" style="left:${data.layout.margin}px;bottom:${data.layout.lowerBottom}px;color:${data.look.onAccent}">` +
          `<div class="lbar" style="background:${data.look.accent};transform:scaleX(${r3(bar)})"></div>` +
          `<div class="ltext" style="opacity:${r3(text)};transform:translateX(${r2((1 - text) * -12 * data.unit)}px)">${lines.join('')}</div></div>`
        );
      })
      .join('');
  }

  function interHtml(data, t) {
    const fn = ease(data.look.ease);
    return data.intertitles
      .filter((item) => t >= item.start && t < item.end)
      .map((item) => {
        const p = moveAt(fn, t, item.start, 0.5);
        const out = outOf(t, item.end, 0.35);
        return (
          `<div class="inter" style="${fontCss(data.type.title)};opacity:${r3(p * out)};transform:translate(-50%,-50%) translateY(${r2((1 - p) * 18 * data.unit)}px)">` +
          `${item.lines.map((line) => `<div class="tl" style="font-size:${item.size}px">${esc(line)}</div>`).join('')}</div>`
        );
      })
      .join('');
  }

  function subtitleHtml(data, t) {
    const line = data.subtitles.find((item) => t >= item.start && t < item.end);
    if (!line) return '';
    const fade = clamp(Math.min(t - line.start, line.end - t) / 0.08, 0, 1);
    return `<div class="sub" style="${fontCss(data.type.body)};font-size:${data.layout.subSize}px;bottom:${data.layout.subBottom}px;opacity:${r3(fade)}"><span>${esc(line.text)}</span></div>`;
  }

  // The end card on the last seconds of the film, over the footage of the close (D3): a dark veil, the logo, the line, the sub line and the address.
  // The veil and the logo are elements of the page that stay (a picture made anew for every frame would not be loaded when the frame is taken): the
  // view gives their styles; the texts are HTML.
  function endFrame(data, t) {
    const card = data.endcard;
    if (!card || t < card.start) return { veil: 'display:none', logo: 'display:none', text: '' };
    const fn = ease(data.look.ease);
    const veil = moveAt(EASES['power2.out'], t, card.start, ENDCARD_FADE);
    const logo = moveAt(fn, t, card.start, 0.6, 0.15);
    const line = moveAt(fn, t, card.start, 0.6, 0.3);
    const rest = moveAt(fn, t, card.start, 0.6, 0.45);
    const parts = [];
    parts.push(`<div class="eline" style="${fontCss(data.type.title)};font-size:${card.lineSize}px;opacity:${r3(line)};transform:translateY(${r2((1 - line) * 14 * data.unit)}px)">${card.lines.map(esc).join('<br>')}</div>`);
    if (card.sub) parts.push(`<div class="esub" style="${fontCss(data.type.body)};font-size:${card.subSize}px;opacity:${r3(rest)}">${esc(card.sub)}</div>`);
    if (card.url) parts.push(`<div class="eurl" style="${fontCss(data.type.body)};font-size:${card.urlSize}px;color:${data.look.accentText};opacity:${r3(rest)}">${esc(card.url)}</div>`);
    return {
      veil: `opacity:${r3(0.82 * veil)}`,
      logo: card.logo ? `max-width:${card.logoW}px;max-height:${card.logoH}px;opacity:${r3(logo)};transform:scale(${r3(0.96 + 0.04 * logo)})` : 'display:none',
      text: parts.join('')
    };
  }

  // Everything of one frame: { glow, flash, endVeil, endLogo (styles), title, lower, inter, sub, end (HTML) }. `t` is the time of the film.
  function render(data, t) {
    const end = endFrame(data, t);
    return {
      endVeil: end.veil,
      endLogo: end.logo,
      glow: glowStyle(data, t),
      flash: transitionStyle(data, t),
      title: titleHtml(data, t),
      lower: lowerHtml(data, t),
      inter: interHtml(data, t),
      sub: subtitleHtml(data, t),
      end: end.text
    };
  }

  return { render, subtitleLines, ease, EASES, OUT_SECONDS, LOWER, ACTS_WITH_GLOW };
});
