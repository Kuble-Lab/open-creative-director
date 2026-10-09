'use strict';

// The drawing of one frame of the HUD (WP44): render(state) turns the state of lib/music-video-hud/state.js into HTML strings for the layers of
// the page. Pure, like the state: the same state gives the same string, nothing is kept between frames, so a frame can be drawn on any machine in
// any order. The look is in styles.css (the Stilblatt: Anton for the big words, Instrument Serif Italic for the quiet lines, JetBrains Mono for
// the HUD, Inter Tight for the karaoke line, one accent colour); the numbers that decide the size of a device are in SIZES, which the layout
// (graphics.js) reads too, so that a device is as big as it was measured.
// A style (themes.js) changes the numbers it reads (sizesOf) and, in a few places, the shape of what is drawn: the frame of the HUD, the karaoke
// line, the layers over the picture, the end card, the cards of the devices and the way a big word enters. The first style (HUD Blue) draws
// exactly what it drew before there was a second one; the look of the second one (Kuble) is in styles.kuble.css.
// UMD: runs in Node (the tests, the layout) and in the browser (inlined in the page of a chunk).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./themes'));
  else root.HudView = factory(root.HudThemes);
})(typeof self !== 'undefined' ? self : this, function (themes) {
  const WIDTH = 1920;
  const HEIGHT = 1080;

  // The sizes of the devices in px (1920 x 1080). `fs` is the font size, the other numbers are boxes and pitches that styles.css uses as well.
  const SIZES = Object.freeze({
    display: { xl: 240, l: 170, m: 100, serifXl: 150, serifL: 118, serifM: 84, line: 1.0, serifLine: 1.08, boxPad: 0.13, min: 84, serifMin: 60 },
    counter: { label: 24, gap: 6, int: 150, percent: 170, money: 96, clock: 100, fraction: 130, multiplier: 210, multPadX: 38, multPadY: 6, line: 0.96 },
    tag: { h: 34, padX: 12, font: 15, tracking: 0.12 },
    stamp: { font: 44, tracking: 0.14, padX: 22, padY: 10, border: 5, gap: 20 },
    strike: { font: 96, line: 1.0 },
    spec: { w: 430, title: 34, row: 46, pad: 6 },
    blueprint: { w: 560, h: 340 },
    // the chart hangs tilted like a board on a wall, the right side nearer: perspective(P) rotateY rotateZ (the layout reserves the outline on the screen).
    // The right edge is about 1.4 times as high as the left one, as on the reference; the text is a little larger than the other devices' to stay legible.
    chart: { w: 660, h: 380, perspective: 900, rotateY: -28, rotateZ: -3.5 },
    terminal: { w: 540, bar: 36, line: 27, pad: 16 },
    chat: { h: 58, gap: 14, font: 30, padX: 26, padY: 16, maxW: 600 },
    notification: { w: 480, h: 108 },
    voice: { w: 580, h: 92 },
    clock: { dial: 230, gap: 30, font: 190, label: 28 },
    stopwatch: { label: 28, font: 100, line: 0.96 },
    list: { row: 29, title: 36, w: 470, font: 17 },
    toggle: { label: 28, trackW: 132, trackH: 68, gap: 26, font: 64 },
    progress: { w: 500, label: 28, bar: 16, font: 72 },
    pin: { w: 380, h: 130, font: 17 },
    // the karaoke line: the size of the letters by the length of the line (up to 56 characters, up to 70, longer)
    karaoke: { big: 48, mid: 43, small: 38 }
  });

  // The sizes of a style: the base ones with what the style changes (themes.js). The first style has no changes: it is the base itself.
  const sizeCache = {};
  function sizesOf(name) {
    const theme = themes.get(name);
    if (!Object.keys(theme.sizes).length) return SIZES;
    if (!sizeCache[theme.id]) sizeCache[theme.id] = themes.mergeSizes(SIZES, theme.sizes);
    return sizeCache[theme.id];
  }

  // What the drawing of a frame needs to know of the style (`k`: it is Kuble; `amber`: the one element of the picture that is amber)
  function contextOf(name, amber) {
    const theme = themes.get(name);
    return { k: theme.id === 'kuble', theme, S: sizesOf(theme.id), amber: amber || null };
  }
  const HUD_CONTEXT = contextOf('hud');

  const INK = Object.freeze({
    light: '--ink:#F4F2EA;--dim:rgba(244,242,234,.62);--hair:rgba(255,255,255,.5);--shade:rgba(0,0,0,.4)',
    dark: '--ink:#0E1013;--dim:rgba(14,16,19,.6);--hair:rgba(14,16,19,.5);--shade:rgba(255,255,255,.35)'
  });
  // Kuble: Ink on Night Ink; on a bright picture the big words take Night Ink (a card is dark whatever the picture is: it keeps the light ink).
  // The colours are the ones of the table of the style.
  const KUBLE_COLORS = themes.get('kuble').colors;
  const INK_KUBLE = Object.freeze({
    light: `--ink:${KUBLE_COLORS.ink};--dim:rgba(${themes.rgb(KUBLE_COLORS.ink)},.66);--hair:rgba(${themes.rgb(KUBLE_COLORS.ink)},.2);--shade:rgba(${themes.rgb(KUBLE_COLORS.night)},.55)`,
    dark: `--ink:${KUBLE_COLORS.night};--dim:rgba(${themes.rgb(KUBLE_COLORS.night)},.66);--hair:rgba(${themes.rgb(KUBLE_COLORS.night)},.4);--shade:rgba(${themes.rgb(KUBLE_COLORS.ink)},.45)`
  });

  const esc = (text) => String(text === undefined || text === null ? '' : text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const r1 = (value) => Math.round(value * 10) / 10;
  const r2 = (value) => Math.round(value * 100) / 100;
  const r3 = (value) => Math.round(value * 1000) / 1000;
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const lerp = (a, b, x) => a + (b - a) * x;

  // A device that stands on a card in the style (themes.js `cards`): a counter that is a multiplier is a chip of its own and needs none.
  const isCard = (theme, d) => theme.cards.includes(d.type) && !(d.type === 'counter' && d.format === 'multiplier');

  // The digits of a number in cells of one width (Kuble: Montserrat has no tabular figures in the subset), so that a number that rolls or runs keeps
  // its width. The width of a cell is the CSS variable --cell (composition.js, from the widest digit of the face).
  const cells = (text) => Array.from(String(text)).map((char) => (char >= '0' && char <= '9' ? `<i class="dg">${char}</i>` : esc(char))).join('');

  /* ---------- the frame of the HUD (on every picture) ---------- */

  function titleHtml(hud) {
    const tiles = hud.title.tiles
      .map((tile) => `<i class="tile${tile.ch === ' ' ? ' sp' : ''}${tile.scrambled ? ' scr' : ''}${tile.num ? ` num${hud.title.pulse > 0 ? ' hot' : ''}` : ''}">${tile.ch === ' ' ? '' : esc(tile.ch)}</i>`)
      .join('');
    return `<div class="title${hud.title.pulse > 0 ? ' pulse' : ''}" style="--pulse:${r2(hud.title.pulse)}">${tiles}</div>`;
  }

  function consoleHtml(hud) {
    const fill = clamp(hud.progress, 0, 1) * 420;
    return (
      `<div class="console">${esc(hud.console)}</div>` +
      `<div class="progress"><b style="width:${r1(fill)}px"></b></div>`
    );
  }

  function topRightHtml(hud) {
    const instances = hud.instances;
    const head = [hud.figure, instances ? `${instances.label} ${instances.text}` : ''].filter(Boolean).join(' · ');
    const stats = hud.stats;
    const bars = hud.meter.bars.map((bar) => `<i${bar.on ? (bar.top ? ' class="top"' : ' class="on"') : ''} style="height:${bar.h}px"></i>`).join('');
    return (
      `<div class="inst${instances && instances.raised ? ' raised' : ''}">${esc(head)}</div>` +
      `<div class="stats"><span>CPU</span> <b>${stats.cpu}%</b> <span>GPU</span> <b>${stats.gpu}%</b> <span>TEMP</span> <b>${stats.temp}°</b> <span>PEERS</span> <b>${esc(stats.peers)}</b> <span>LAT</span> <b>${stats.lat}ms</b></div>` +
      `<div class="meter">${bars}</div>`
    );
  }

  const RULER_TOP = 175;
  const RULER_HEIGHT = 760;

  function rulerHtml(hud) {
    let ticks = '';
    for (let i = 0; i <= 42; i += 1) {
      const y = i * (RULER_HEIGHT / 42);
      const major = i % 3 === 0;
      ticks += `<i style="top:${r1(y)}px;width:${major ? 7 : 4}px;left:${major ? 0 : 3}px"></i>`;
    }
    const marker = RULER_TOP + hud.ruler.marker * RULER_HEIGHT;
    return (
      `<div class="ruler" style="top:${RULER_TOP}px;height:${RULER_HEIGHT}px">${ticks}</div>` +
      `<div class="ruler-mark" style="top:${r1(marker)}px"></div>` +
      `<div class="barbeat">${esc(hud.barBeat)}</div>`
    );
  }

  function tickerHtml(hud) {
    const ticker = hud.ticker;
    if (!ticker.text) return '<div class="tick-line"></div>';
    const repeats = Math.ceil((WIDTH + ticker.width) / ticker.width) + 1;
    return `<div class="tick-line"></div><div class="ticker"><span style="transform:translateX(${r1(-ticker.offset)}px)">${esc(ticker.text.repeat(repeats))}</span></div>`;
  }

  // The frame of Kuble: the title, the chapter and the line of progress on the left; the counter, the numbers of instances and the countdown to a drop on
  // the right; the status line and the beat bar of 16 squares at the bottom. No tiles, no ruler, no ticker, no REC.
  function kubleHudHtml(hud) {
    const k = hud.k;
    const fill = clamp(hud.progress, 0, 1) * 420;
    const meta = k.meta ? `<div class="k-meta${k.raised ? ' raised' : ''}">${esc(k.meta)}</div>` : '';
    // a hit makes the title, the number and the head of the progress line glow (--hit, 0 to 1)
    const hit = k.hit > 0 ? ` style="--hit:${r2(k.hit)}"` : '';
    const counter = k.counter
      ? `<div class="k-count${k.counter.rolling > 0 ? ' roll' : ''}" style="--roll:${r2(k.counter.rolling)}${k.hit > 0 ? `;--hit:${r2(k.hit)}` : ''}"><span class="k-clab">${esc(k.counter.label)}</span><span class="k-cnum">${cells(k.counter.text)}</span></div>`
      : '';
    const drop = hud.drop ? `<div class="k-drop${hud.drop.accent ? ' hot' : ''}">${esc(hud.drop.text)}</div>` : '';
    const status = k.status.text || k.status.cursor ? `<div class="k-status">${esc(k.status.text)}${k.status.cursor ? '<i class="k-cur"></i>' : ''}</div>` : '';
    let beats = '';
    for (let i = 0; i < 16; i += 1) {
      // the square of this sixteenth is lit, the two before it trail off; the downbeat is amber when the picture may have an amber element
      const age = (k.beats.lit - i + 16) % 16;
      const state = age === 0 ? (i === 0 && k.beats.amber ? 'on dn' : 'on') : age === 1 ? 't1' : age === 2 ? 't2' : '';
      beats += `<i${state ? ` class="${state}"` : ''}></i>`;
    }
    return (
      `<i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>` +
      `<div class="k-title"${hit}>${esc(k.title)}</div><div class="k-chap">${esc(k.chapter)}</div>` +
      `<div class="k-prog"><b style="width:${r1(fill)}px"></b><i style="left:${r1(fill)}px${k.hit > 0 ? `;--hit:${r2(k.hit)}` : ''}"></i></div>` +
      meta + counter + drop + status + `<div class="k-beats">${beats}</div>`
    );
  }

  function hudHtml(hud, cx = HUD_CONTEXT) {
    if (!hud) return '';
    if (cx.k) return kubleHudHtml(hud);
    const rec = `<div class="rec"><b${hud.rec.on ? '' : ' class="off"'}></b>${esc(hud.rec.text)}</div><div class="tc">${esc(hud.timecode)}</div>`;
    const drop = hud.drop ? `<div class="drop${hud.drop.accent ? ' hot' : ''}">${esc(hud.drop.text)}</div>` : '';
    return (
      `<i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>` +
      titleHtml(hud) + consoleHtml(hud) + topRightHtml(hud) + rulerHtml(hud) + drop + tickerHtml(hud) + rec
    );
  }

  /* ---------- the karaoke line ---------- */

  function karaokeHtml(k, cx = HUD_CONTEXT) {
    if (!k || k.alpha <= 0.001) return '';
    const words = k.words.map((word) => `<span class="${word.state === 'sung' ? 'sung' : word.state === 'current' ? 'cur' : 'next'}">${esc(word.text)}</span>`).join(' ');
    const long = k.words.reduce((sum, word) => sum + word.text.length + 1, 0);
    const size = long > 70 ? cx.S.karaoke.small : long > 56 ? cx.S.karaoke.mid : cx.S.karaoke.big;
    return `<div class="kar" style="opacity:${r2(k.alpha)}"><div class="band" style="font-size:${size}px">${words}</div></div>`;
  }

  /* ---------- the devices ---------- */

  const px = (value) => `${r1(value)}px`;

  // `pre` and `post` are transforms before and after the entrance move and the scale. A device that was made smaller to fit the free lane (d.scale)
  // is laid out at its natural size round the centre of its box and scaled down there. A tilted device (d.box) is laid out in its box before the
  // tilt: the rect that the layout holds for it is the outline on the screen, not the box.
  function frame(item, inner, pre = '', post = '', cx = HUD_CONTEXT) {
    const { rect } = item;
    const scale = (item.d && item.d.scale) || 1;
    const box = item.d && item.d.box;
    const w0 = box ? box.w : rect.w / scale;
    const h0 = box ? box.h : rect.h / scale;
    const left = box ? box.x : rect.x + (rect.w - w0) / 2;
    const top = box ? box.y : rect.y + (rect.h - h0) / 2;
    const alpha = clamp(item.enter * (1 - item.leave), 0, 1);
    const side = rect.x + rect.w / 2 < WIDTH / 2 ? -1 : 1;
    const dx = (1 - item.enter) * 36 * side + item.leave * 14 * side;
    const dy = (1 - item.enter) * 10;
    // a card is dark whatever the picture is, so it keeps the light ink
    const card = cx.k && item.d && isCard(cx.theme, item.d);
    const ink = cx.k ? (card ? INK_KUBLE.light : INK_KUBLE[item.ink] || INK_KUBLE.light) : INK[item.ink] || INK.light;
    return (
      `<div class="dv ${item.type}${item.accent ? ' acc' : ''}${card ? ' card' : ''}" style="left:${px(left)};top:${px(top)};width:${px(w0)};height:${px(h0)};` +
      `opacity:${r2(alpha)};transform:${pre}translate(${r1(dx)}px,${r1(dy)}px)${scale === 1 ? '' : ` scale(${r3(scale)})`}${post};${ink}">${inner}</div>`
    );
  }

  // The glow of a word of Kuble as it springs in: blue, strongest on its first frame
  const glowOf = (amount) => `text-shadow:0 0 ${r1(34 * amount)}px rgba(var(--blue-t-rgb),${r2(0.85 * amount)}),0 0 ${r1(10 * amount)}px rgba(var(--blue-t-rgb),${r2(0.7 * amount)})`;

  function displayHtml(item, cx = HUD_CONTEXT) {
    const d = item.d;
    const sub = item.sub;
    const D = cx.S.display;
    const parts = d.style === 'around' ? d.arounds : null;
    const rowHtml = (row, index) => {
      const s = sub.rows[index];
      const serif = d.style === 'serif';
      const tokens = s.tokens
        .map((token) => {
          if (cx.k) {
            // springs in: a strong overshoot of the move and the size, the glow of the accent fades over a third of a second
            const style = token.shown
              ? `opacity:${r2(clamp(token.p * 3, 0, 1))};transform:translateY(${r1((1 - token.p) * (serif ? 28 : 62))}px) scale(${r3(1 - (1 - token.p) * 0.16)})${token.glow > 0.01 ? `;${glowOf(token.glow)}` : ''}`
              : 'opacity:0';
            return `<span class="tok" style="${style}">${esc(token.text)}</span>`;
          }
          const style = token.shown ? `opacity:${r2(token.p)};transform:translateY(${r1((1 - token.p) * (serif ? 22 : 46))}px)` : 'opacity:0';
          return `<span class="tok" style="${style}">${esc(token.text)}</span>`;
        })
        .join(' ');
      const inner = row.box ? `<span class="dbox" style="transform:scaleX(${r2(s.boxP)})"><span class="boxback"></span><span class="boxtext">${tokens}</span></span>` : tokens;
      const accent = serif && row.accent;
      return `<div class="drow${accent ? ' acc' : ''}" style="font-size:${row.fs}px;height:${r1(row.fs * (serif ? D.serifLine : D.line))}px;line-height:${r1(row.fs * (serif ? D.serifLine : D.line))}px">${inner}</div>`;
    };
    if (parts) {
      return d.rows
        .map((row, index) => {
          const rect = parts[index];
          if (!rect) return '';
          const inner = frame({ ...item, rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h }, type: 'display' }, rowHtml(row, index), '', '', cx);
          return inner.replace('class="dv display', `class="dv display around ${index === 0 ? 'al' : 'ar'}`);
        })
        .join('');
    }
    const align = d.align === 'right' ? ' right' : '';
    return frame(item, d.rows.map(rowHtml).join(''), '', '', cx).replace('class="dv display', `class="dv display ${d.style}${align}`);
  }

  function counterHtml(item, cx = HUD_CONTEXT) {
    const d = item.d;
    const sub = item.sub;
    const C = cx.S.counter;
    const label = d.label ? `<div class="lab">${esc(d.label)}</div>` : '';
    const scale = 1 + 0.018 * sub.pulse;
    const shown = (text) => (cx.k ? cells(text) : esc(text));
    let body;
    if (d.format === 'multiplier') body = `<div class="mult" style="font-size:${C.multiplier}px;transform:scale(${r2(scale)})">${shown(sub.text)}</div>`;
    else if (d.format === 'fraction') body = `<div class="num" style="font-size:${C.fraction}px">${shown(sub.text)}<span class="tot">${esc(sub.total)}</span></div>`;
    else body = `<div class="num" style="font-size:${C[d.format] || C.int}px;transform:scale(${r2(scale)})">${shown(sub.text)}</div>`;
    return frame(item, label + body, '', '', cx);
  }

  function tagHtml(item, cx = HUD_CONTEXT) {
    return frame(item, `<span class="tagbox">${esc(item.d.text)}</span>`, '', '', cx);
  }

  // Kuble: is this device the one that may be amber in this picture (the arbiter of state.js decided: one element at most)
  const amberFor = (cx, kind, item) => Boolean(cx.k && cx.amber && cx.amber.kind === kind && cx.amber.id === item.id);

  function stampHtml(item, cx = HUD_CONTEXT) {
    const d = item.d;
    const P = cx.S.stamp;
    const amber = amberFor(cx, 'stamp', item);
    const pitch = P.font * 1.1 + P.padY * 2 + P.border * 2 + P.gap;
    const stamps = item.sub.stamps
      .map((stamp, index) => {
        if (stamp.p < 0) return '';
        const scale = 1 + (1 - clamp(stamp.p, 0, 1)) * 1.4;
        const jitter = stamp.shake * 5;
        const angle = [-7, 5, -4, 8][index % 4];
        const shift = [0, 36, -14, 52][index % 4];
        const dx = index % 2 ? 1 : -1;
        return `<div class="stampbox${amber ? ' amb' : ''}" style="top:${r1(index * pitch)}px;left:${r1(shift)}px;opacity:${r2(clamp(stamp.p * 3, 0, 1))};transform:translate(${r1(dx * jitter)}px,${r1(-jitter)}px) rotate(${angle}deg) scale(${r2(scale)})">${esc(d.text)}</div>`;
      })
      .join('');
    return frame(item, stamps, '', '', cx);
  }

  function strikeHtml(item, cx = HUD_CONTEXT) {
    const d = item.d;
    const p = item.sub.p;
    const bar = d.mode === 'redact'
      ? `<span class="redact" style="width:${r1(p * 100)}%"></span>`
      : `<span class="strikeline${amberFor(cx, 'strike', item) ? ' amb' : ''}" style="width:${r1(p * 100)}%"></span>`;
    return frame(item, `<div class="strk"><span class="strtext${d.mode === 'redact' && p > 0.6 ? ' hidden' : ''}">${esc(d.text)}</span>${bar}</div>`, '', '', cx);
  }

  function specHtml(item, cx = HUD_CONTEXT) {
    const d = item.d;
    const sub = item.sub;
    const cut = (text, count) => esc(Array.from(text).slice(0, count).join(''));
    const rows = d.rows
      .map((row, index) => {
        const typed = sub.rows[index];
        const redacted = d.redact === index;
        const value = redacted ? (typed.value >= Array.from(row.value).length ? '<span class="bar"></span>' : cut(row.value, typed.value)) : cut(row.value, typed.value);
        return `<div class="srow"><span>${cut(row.label, typed.label)}</span><span class="val">${value}</span></div>`;
      })
      .join('');
    return frame(item, `<div class="stitle">${cut(d.title, sub.title)}</div>${rows}`, '', '', cx);
  }

  function blueprintHtml(item, cx = HUD_CONTEXT) {
    const d = item.d;
    const p = item.sub.p;
    const labels = r2(clamp(item.sub.labels, 0, 1));
    const dash = (extra = '') => `pathLength="1" stroke-dasharray="1" stroke-dashoffset="${r2(1 - p)}" ${extra}`;
    const tall = Number(d.dims[0]).toFixed(2);
    const wide = Number(d.dims[1]).toFixed(2);
    // on a card the drawing has the width inside the padding of the card
    const w = item.rect.w / ((d.scale) || 1) - (cx.k && isCard(cx.theme, d) ? 2 * cx.S.card.pad : 0);
    const svg =
      `<svg viewBox="0 0 ${r1(w)} 340" width="${r1(w)}" height="340" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" overflow="visible" style="font-family:'JetBrains Mono',monospace;font-size:15px;letter-spacing:.14em">` +
      `<path ${dash()} d="M70 60 H250 V260 H70 Z"/>` +
      `<path ${dash('stroke-width="1.6"')} d="M92 82 H228 V170 H92 Z"/>` +
      `<path ${dash('stroke-width="9" stroke-linecap="butt"')} d="M160 232 L226 124"/>` +
      `<path ${dash('stroke-width="3"')} d="M214 108 L238 122 L226 142 L202 128 Z"/>` +
      `<circle cx="160" cy="232" r="10" ${dash()}/>` +
      `<path ${dash('stroke-width="1.6"')} d="M213.5 147.4 A100 100 0 0 1 260 232" stroke-dasharray="0.05 0.035" stroke-dashoffset="0" opacity="${r2(p)}"/>` +
      `<path ${dash('stroke-width="1.6"')} d="M40 60 V260 M33 60 H47 M33 260 H47"/>` +
      `<path ${dash('stroke-width="1.6"')} d="M70 288 H250 M70 281 V295 M250 281 V295"/>` +
      `<path ${dash('stroke-width="1.6"')} d="M238 122 L292 80 H330 M160 232 L292 268 H330"/>` +
      `<g stroke="none" fill="currentColor" opacity="${labels}">` +
      `<text x="70" y="30" fill="var(--a)" font-weight="500">${esc(d.title)}</text>` +
      `<text x="340" y="85">${esc(d.labels.a)}</text><text x="340" y="273">${esc(d.labels.b)}</text>` +
      `<text x="26" y="160" text-anchor="middle" transform="rotate(-90 26 160)">${tall} M</text>` +
      `<text x="160" y="318" text-anchor="middle">${wide} M</text></g>` +
      `</svg>`;
    return frame(item, svg, '', '', cx);
  }

  function chartHtml(item, cx = HUD_CONTEXT) {
    const d = item.d;
    const sub = item.sub;
    const w = 520;
    const h = 250;
    const x0 = 80;
    const y0 = 62;
    const n = d.values.length;
    const points = d.values.map((value, i) => [x0 + (i / (n - 1)) * w, y0 + h - (clamp(value, 0, 100) / 100) * h]);
    const shown = clamp(sub.p, 0, 1) * (n - 1);
    const whole = Math.floor(shown);
    const part = shown - whole;
    const drawn = points.slice(0, whole + 1);
    if (whole < n - 1) drawn.push([lerp(points[whole][0], points[whole + 1][0], part), lerp(points[whole][1], points[whole + 1][1], part)]);
    const last = drawn[drawn.length - 1];
    const poly = drawn.map((point) => `${r1(point[0])},${r1(point[1])}`).join(' ');
    const grid = [0, 50, 100]
      .map((value) => {
        const y = y0 + h - (value / 100) * h;
        return `<line x1="${x0}" y1="${r1(y)}" x2="${x0 + w}" y2="${r1(y)}" stroke="currentColor" stroke-opacity="${value === 0 ? 0.9 : 0.26}" stroke-width="${value === 0 ? 2 : 1}"/><text x="${x0 - 12}" y="${r1(y + 4)}" text-anchor="end">${value}%</text>`;
      })
      .join('');
    const top = y0;
    const markWidth = d.marker ? Array.from(d.marker).length * (20 * 0.6 + 1.6) + 30 : 0;
    // Kuble: the marker is amber when the arbiter allows it (dark writing on it), else the accent colour
    const amber = amberFor(cx, 'marker', item);
    const markFill = cx.k ? (amber ? 'var(--amber)' : 'var(--acc)') : 'var(--ac)';
    const markInk = cx.k ? (amber ? 'var(--night)' : 'var(--ink-c)') : '#fff';
    const marker = d.marker
      ? `<g opacity="${r2(clamp(sub.marker, 0, 1))}" transform="translate(${r1(last[0])},${r1(last[1] - 18 - (1 - clamp(sub.marker, 0, 1)) * 10)})"><rect x="${r1(-markWidth)}" y="-36" width="${r1(markWidth)}" height="40" fill="${markFill}"/><text x="${r1(-markWidth / 2)}" y="-8" text-anchor="middle" fill="${markInk}" font-size="20" font-weight="700" letter-spacing="1.6">${esc(d.marker)}</text></g>`
      : '';
    const head = cx.k
      ? '<rect class="kpanel" x="1" y="1" width="658" height="378" rx="14"/>'
      : '<path d="M26 64 V30 H60 M634 30 H600 M26 330 V364 H60 M634 364 H600 V330" stroke="currentColor" stroke-opacity=".85" stroke-width="2.4" fill="none"/>';
    const line = cx.k
      ? `<polyline class="kline" points="${poly}" fill="none" stroke="var(--acc)" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`
      : `<polyline points="${poly}" fill="none" stroke="var(--a)" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`;
    const svg =
      `<svg viewBox="0 0 660 380" width="660" height="380" font-family="'JetBrains Mono',monospace" font-size="14" letter-spacing="1.4" fill="currentColor" fill-opacity=".78">` +
      head +
      `<text x="30" y="52" fill="currentColor" fill-opacity="1" font-size="18" font-weight="700" letter-spacing="2">${esc(d.title)}</text>` +
      grid +
      `<line x1="${x0}" y1="${top + 18}" x2="${x0 + w}" y2="${top + 18}" stroke="currentColor" stroke-opacity=".6" stroke-dasharray="6 6"/>` +
      line +
      `<circle cx="${r1(last[0])}" cy="${r1(last[1])}" r="6" fill="${cx.k ? 'var(--acc)' : 'var(--a)'}"/>` +
      marker +
      `</svg>`;
    // scale first, then the perspective: the outline on the screen is the outline at scale 1 times the scale (what the layout measured)
    const tilt = cx.S.chart;
    return frame(item, svg, '', ` perspective(${tilt.perspective}px) rotateY(${tilt.rotateY}deg) rotateZ(${tilt.rotateZ}deg)`, cx);
  }

  // A line of a terminal is a command (with the prompt) when it is the first one or starts with the prompt itself; the others are output.
  function terminalHtml(item, cx = HUD_CONTEXT) {
    const d = item.d;
    const sub = item.sub;
    const rows = sub.lines
      .map((text, index) => {
        const cursor = index === sub.cursorRow && sub.cursorOn ? '<i class="cursor"></i>' : '';
        const full = d.lines[index] || '';
        const command = index === 0 || /^[$>#] /.test(full);
        const shown = /^[$>#] /.test(full) ? text.slice(Math.min(text.length, 2)) : text;
        return command ? `<div class="tline"><b>${esc(/^[$>#] /.test(full) ? full[0] : d.prompt)}</b> ${esc(shown)}${cursor}</div>` : `<div class="tline out">${esc(shown)}${cursor}</div>`;
      })
      .join('');
    const title = d.prompt.length > 3 ? d.prompt : 'TERMINAL';
    return frame(item, `<div class="tbar"><i class="r"></i><i class="g"></i><i class="b"></i><span>${esc(title)}</span></div><div class="tbody">${rows}</div>`, '', '', cx);
  }

  function chatHtml(item, cx = HUD_CONTEXT) {
    const d = item.d;
    const bubbles = d.messages
      .map((message, index) => {
        const p = item.sub.bubbles[index];
        if (!p.shown) return '';
        const scale = lerp(0.6, 1, clamp(p.p, 0, 1.08));
        return `<div class="bub ${message.from === 'her' ? 'her' : 'them'}" style="opacity:${r2(clamp(p.p * 2, 0, 1))};transform:scale(${r2(scale)})">${esc(message.text)}</div>`;
      })
      .join('');
    return frame(item, bubbles, '', '', cx);
  }

  function notificationHtml(item, cx = HUD_CONTEXT) {
    const d = item.d;
    const p = item.sub.p;
    const inner =
      `<div class="ncard" style="transform:translateY(${r1((1 - p) * -150)}px)"><i class="ico">${esc(Array.from(d.app)[0] || '·')}</i>` +
      `<div class="nmeta"><span>${esc(d.app)}</span><span>${esc(d.time)}</span></div><div class="ntitle">${esc(d.title)}</div><div class="ntext">${esc(d.text)}</div></div>`;
    return frame({ ...item, enter: 1, leave: 0 }, inner, '', '', cx);
  }

  function voiceHtml(item, cx = HUD_CONTEXT) {
    const d = item.d;
    const points = item.sub.points;
    const w = cx.S.voice.w;
    const mid = 60;
    const path = points.map((value, i) => `${r1((i / (points.length - 1)) * w)},${r1(mid - value * 30)}`).join(' ');
    const svg = `<svg viewBox="0 0 ${w} 92" width="${w}" height="92" overflow="visible"><line x1="0" y1="${mid}" x2="${w}" y2="${mid}" stroke="var(--hair)" stroke-width="1"/><polyline points="${path}" fill="none" stroke="var(--a2)" stroke-width="2" stroke-linejoin="round"/></svg>`;
    return frame(item, `<div class="vrow"><span>${esc(d.label)}</span><span>${esc(Number(d.db).toFixed(1))} dB</span></div>${svg}`, '', '', cx);
  }

  function clockHtml(item, cx = HUD_CONTEXT) {
    const d = item.d;
    const sub = item.sub;
    const size = cx.S.clock.dial;
    const c = size / 2;
    const ring = c - 16;
    const rad = (deg) => ((deg - 90) * Math.PI) / 180;
    const point = (deg, radius) => `${r1(c + Math.cos(rad(deg)) * radius)}`;
    const pointY = (deg, radius) => `${r1(c + Math.sin(rad(deg)) * radius)}`;
    const hand = (deg, length, width) => `<line x1="${c}" y1="${c}" x2="${point(deg, length)}" y2="${pointY(deg, length)}" stroke="currentColor" stroke-width="${width}" stroke-linecap="round"/>`;
    let ticks = '';
    for (let i = 0; i < 12; i += 1) {
      const long = i % 3 === 0;
      const deg = i * 30;
      const from = ring + 9;
      const to = ring + (long ? 22 : 14);
      ticks += `<line x1="${point(deg, from)}" y1="${pointY(deg, from)}" x2="${point(deg, to)}" y2="${pointY(deg, to)}" stroke="currentColor" stroke-width="${long ? 4 : 2}" opacity="${long ? 1 : 0.7}"/>`;
    }
    const arcLen = clamp(sub.arc, 0, 1);
    const end = rad(arcLen * 359.9);
    const large = arcLen > 0.5 ? 1 : 0;
    const arc = arcLen > 0.002 ? `<path d="M${c} ${c - ring} A${ring} ${ring} 0 ${large} 1 ${r1(c + Math.cos(end) * ring)} ${r1(c + Math.sin(end) * ring)}" stroke="${cx.k ? 'var(--blue-t)' : 'var(--a)'}" stroke-width="9" fill="none" stroke-linecap="round"/>` : '';
    // the face of the dial: the colours of Kuble are custom properties of the page (the table of the style)
    const face = cx.k ? 'fill="var(--dial-face)" stroke="var(--dial-ring)"' : 'fill="rgba(11,13,16,.42)" stroke="currentColor"';
    const inner = cx.k ? 'fill="var(--dial-inner)" stroke="var(--dial-inner-ring)"' : 'fill="rgba(244,242,234,.12)" stroke="currentColor"';
    const svg =
      `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" overflow="visible">` +
      `<circle cx="${c}" cy="${c}" r="${ring}" ${face} stroke-width="3" opacity=".92"/>` +
      `<circle cx="${c}" cy="${c}" r="${ring - 14}" ${inner} stroke-width="5" opacity=".9"/>` +
      `${ticks}${arc}${hand(sub.hour, 44, 8)}${hand(sub.minute, 66, 5)}<circle cx="${c}" cy="${c}" r="6" fill="currentColor"/></svg>`;
    const time = cx.k ? cells(sub.text) : esc(sub.text);
    return frame(item, `<div class="cdial">${svg}</div><div class="ctext"><div class="lab">${esc(d.label)}</div><div class="big" style="font-size:${cx.S.clock.font}px">${time}</div></div>`, '', '', cx);
  }

  function stopwatchHtml(item, cx = HUD_CONTEXT) {
    const time = cx.k ? cells(item.sub.text) : esc(item.sub.text);
    return frame(item, `<div class="lab">${esc(item.d.label)}</div><div class="big" style="font-size:${cx.S.stopwatch.font}px">${time}</div>`, '', '', cx);
  }

  function listHtml(item, cx = HUD_CONTEXT) {
    const d = item.d;
    const rows = d.rows.slice(0, item.sub.shown).map((row) => `<div class="lrow">${esc(row)}</div>`).join('');
    return frame(item, (d.title ? `<div class="stitle">${esc(d.title)}</div>` : '') + rows, '', '', cx);
  }

  function toggleHtml(item, cx = HUD_CONTEXT) {
    const sub = item.sub;
    const T = cx.S.toggle;
    const knob = 6 + sub.knob * (T.trackW - T.trackH);
    return frame(
      item,
      `<div class="lab">${esc(item.d.label)}</div><div class="trow"><div class="track${sub.on ? ' on' : ''}"><i style="left:${r1(knob)}px"></i></div><div class="tstate${sub.on ? '' : ' off'}" style="font-size:${T.font}px">${esc(sub.label)}</div></div>`,
      '', '', cx
    );
  }

  function progressHtml(item, cx = HUD_CONTEXT) {
    const sub = item.sub;
    const value = cx.k ? cells(sub.value) : sub.value;
    return frame(
      item,
      `<div class="prow"><span class="lab">${esc(item.d.label)}</span><span class="pnum" style="font-size:${cx.S.progress.font}px">${value}%</span></div><div class="pbar"><b style="width:${r1(clamp(sub.p, 0, 1) * 100)}%"></b></div>`,
      '', '', cx
    );
  }

  function pinHtml(item, cx = HUD_CONTEXT) {
    const d = item.d;
    const sub = item.sub;
    const drop = clamp(sub.drop, 0, 1.1);
    const ring = sub.pulse;
    const x = d.x * WIDTH;
    const y = d.y * HEIGHT;
    const alpha = clamp(item.enter * (1 - item.leave), 0, 1);
    const ink = cx.k ? INK_KUBLE[item.ink] || INK_KUBLE.light : INK[item.ink] || INK.light;
    const hair = cx.k ? 'var(--hairline)' : 'rgba(255,255,255,.3)';
    return (
      `<div class="dv pin acc" style="left:0;top:0;width:${WIDTH}px;height:${HEIGHT}px;opacity:${r2(alpha)};${ink}">` +
      `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" fill="none"><line x1="${r1(x)}" y1="0" x2="${r1(x)}" y2="${HEIGHT}" stroke="${hair}" stroke-width="1"/><line x1="0" y1="${r1(y)}" x2="${WIDTH}" y2="${r1(y)}" stroke="${hair}" stroke-width="1"/>` +
      `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(14 + ring * 46)}" stroke="${cx.k ? 'var(--blue-t)' : 'var(--acc)'}" stroke-width="2.5" opacity="${r2(1 - ring)}"/>` +
      `<g transform="translate(${r1(x)},${r1(y - (1 - drop) * 140)}) scale(1.35)"><path d="M0 0 C-16 -22 -20 -30 -20 -42 A20 20 0 0 1 20 -42 C20 -30 16 -22 0 0 Z" fill="var(--acc)"/><circle cx="0" cy="-42" r="7.5" fill="${cx.k ? 'var(--ink-c)' : '#fff'}"/></g></svg>` +
      `<div class="pintag" style="left:${r1(x + 44)}px;top:${r1(y - 88)}px;opacity:${r2(clamp(sub.drop, 0, 1))}"><span class="tagbox">${esc(d.label)}</span></div></div>`
    );
  }

  const DRAW = {
    display: displayHtml,
    counter: counterHtml,
    tag: tagHtml,
    stamp: stampHtml,
    strike: strikeHtml,
    spec: specHtml,
    blueprint: blueprintHtml,
    chart: chartHtml,
    terminal: terminalHtml,
    chat: chatHtml,
    notification: notificationHtml,
    voice: voiceHtml,
    clock: clockHtml,
    stopwatch: stopwatchHtml,
    list: listHtml,
    toggle: toggleHtml,
    progress: progressHtml,
    pin: pinHtml
  };

  // The brackets round the face and the leader line from a tag to it (a tag points at the figure).
  function subjectHtml(devices, subject, look = HUD_CONTEXT) {
    const tags = devices.filter((item) => item.type === 'tag');
    // a cut without the figure has nothing to point at
    if (!tags.length || subject === 'none') return '';
    const point = { left: [540, 430], center: [960, 430], right: [1380, 430] }[subject] || [960, 430];
    const [cx, cy] = point;
    const size = 150;
    const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]]
      .map(([sx, sy]) => `<path d="M${cx + sx * size} ${cy + sy * (size - 34)} V${cy + sy * size} H${cx + sx * (size - 34)}" />`)
      .join('');
    const lines = tags
      .map((item) => {
        const alpha = clamp(item.enter * (1 - item.leave), 0, 1);
        const { rect } = item;
        const fromX = rect.x + rect.w / 2 < cx ? rect.x + rect.w : rect.x;
        const fromY = rect.y + rect.h / 2;
        return `<path d="M${r1(fromX)} ${r1(fromY)} L${r1(cx + (fromX < cx ? -size : size))} ${r1(cy)}" opacity="${r2(alpha * 0.9)}" />`;
      })
      .join('');
    const alpha = Math.max(...tags.map((item) => clamp(item.enter * (1 - item.leave), 0, 1)));
    return `<svg class="subj" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" fill="none" stroke="${look.k ? 'var(--sub)' : 'rgba(255,255,255,.9)'}" stroke-width="2.2" style="opacity:${r2(alpha)}">${corners}${lines}</svg>`;
  }

  function devicesHtml(devices, subject, cx = HUD_CONTEXT) {
    let out = subjectHtml(devices, subject, cx);
    for (const item of devices) {
      const draw = DRAW[item.type];
      if (draw) out += draw(item, cx);
    }
    return out;
  }

  /* ---------- the layers over everything: the wipe and the flash ---------- */

  // Kuble: the flash of a transition, the band of light (a chapter, a wipe), the pulse on a hit and the sparks. All of it is lit by the state (state.fx).
  function kubleOverlayHtml(state) {
    const t = state.transition;
    const fx = state.fx || {};
    let out = '';
    if (t && t.kind === 'flash') out += `<div class="flash" style="opacity:${r2(t.alpha)}"></div>`;
    if (fx.sweep) {
      const wipe = fx.sweep.kind === 'wipe';
      const w = wipe ? 880 : 600;
      out += `<div class="k-sweep${wipe ? ' wipe' : ''}" style="left:${r1(lerp(-w - 340, WIDTH + 340, fx.sweep.p))}px;width:${w}px"></div>`;
    }
    if (fx.pulse && fx.pulse.alpha > 0.004) out += `<div class="k-pulse" style="opacity:${r3(fx.pulse.alpha)}"></div>`;
    if (fx.sparks && fx.sparks.length) {
      out += `<div class="k-sparks">${fx.sparks.map((dot) => `<i style="left:${r1(dot.x - dot.r)}px;top:${r1(dot.y - dot.r)}px;width:${r1(2 * dot.r)}px;height:${r1(2 * dot.r)}px;opacity:${dot.a}"></i>`).join('')}</div>`;
    }
    return out;
  }

  function overlayHtml(state, cx = HUD_CONTEXT) {
    if (cx.k) return kubleOverlayHtml(state);
    const t = state.transition;
    if (!t) return '';
    if (t.kind === 'flash') return `<div class="flash" style="opacity:${r2(t.alpha)}"></div>`;
    if (t.kind === 'wipe') {
      // three bars of the accent colour sweep over the picture from the left; each starts one frame after the one before
      const bars = [0, 1, 2]
        .map((i) => {
          const local = clamp((t.local - i / 24) / (6 / 24), 0, 1);
          const x = local < 0.5 ? lerp(-100, 0, local * 2) : lerp(0, 100, (local - 0.5) * 2);
          return `<i style="top:${i * 360}px;transform:translateX(${r1(x)}%)"></i>`;
        })
        .join('');
      return `<div class="wipe">${bars}</div>`;
    }
    return '';
  }

  /* ---------- the end card ---------- */

  function endcardHtml(card, cx = HUD_CONTEXT) {
    if (!card) return '';
    const lines = card.lines.map((line) => `<div class="eline">${esc(line)}</div>`).join('');
    if (cx.k) {
      // Night Ink, the title in Montserrat Black on one line, the lines in mono; one blue line and, when the title is typed, one amber dot
      const dot = card.dot > 0 ? `<i class="k-edot" style="opacity:${r2(clamp(card.dot * 2, 0, 1))};transform:scale(${r2(clamp(card.dot, 0, 1.2))})"></i>` : '';
      return (
        `<div class="end k" style="opacity:${r2(card.fade)}"><div class="k-eline"><b style="width:${r1(120 * card.line)}px"></b>${dot}</div>` +
        `<div class="etitle" style="font-size:${card.size}px;line-height:${r1(card.size * 1.12)}px">${esc(card.title)}${card.cursor && card.title.length < 60 ? '<i class="ecur"></i>' : ''}</div>${lines}</div>`
      );
    }
    return (
      `<div class="end" style="opacity:${r2(card.fade)}"><div class="eacc" style="width:${r1(90 * card.line)}px"></div>` +
      `<div class="etitle">${esc(card.title)}${card.cursor && card.title.length < 60 ? '<i class="ecur"></i>' : ''}</div>${lines}</div>`
    );
  }

  /* ---------- one frame ---------- */

  function render(state) {
    const cam = state.camera;
    const cx = state.theme === 'kuble' ? contextOf('kuble', state.amber) : HUD_CONTEXT;
    return {
      stage: `transform:scale(${r3(1 + cam.kick)})${cx.k && state.fx ? `;--sk:${r2(state.fx.scrim)}` : ''}`,
      cam: `transform:translate(${r1(cam.tx)}px,${r1(cam.ty)}px) scale(${r2(cam.scale)})`,
      dev: devicesHtml(state.devices, state.cut ? state.cut.subject : 'center', cx),
      hud: hudHtml(state.hud, cx),
      kar: karaokeHtml(state.karaoke, cx),
      over: overlayHtml(state, cx),
      end: endcardHtml(state.endcard, cx),
      ink: state.ink === 'dark' ? 'dark' : 'light',
      hideStage: Boolean(state.endcard)
    };
  }

  return { SIZES, INK, INK_KUBLE, WIDTH, HEIGHT, esc, sizesOf, contextOf, isCard, cells, render, devicesHtml, hudHtml, karaokeHtml, overlayHtml, endcardHtml };
});
