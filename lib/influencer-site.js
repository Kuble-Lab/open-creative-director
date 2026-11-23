'use strict';

// The page of an influencer (stage 2): a static site made from the saved influencer and the pieces the owner put on it. Pure: no file
// access, no network. The caller hands over the texts and the names of the media files; this module returns the text files of the site
// (index.html, assets/styles.css, assets/app.js, favicon.svg, canon.json) and says where each media file belongs.
//
//   buildSite({ influencer, images, items, lang, about, usage })
//     influencer  the saved influencer (lib/influencers.js)
//     images      the reference images as they are on the site: [{ path: 'assets/looks/1.jpg' }] (the first one is the portrait)
//     items       the pieces on the page, newest first: [{ id, kind: 'video' | 'image' | 'youtube', title, description, src, poster, date, facts }]
//                 a 'youtube' piece carries `youtube` (the id of the film) instead of `src` and is shown as an embedded player
//                 `src` and `poster` are paths on the site (assets/work/…) or https URLs; `facts` is [{ label, value }]
//     lang        'de' | 'en' | 'es' (the language of the fixed words; the texts of the influencer are shown as written)
//     about       a few sentences about the figure for people (optional; the tagline stands in)
//     usage       'open' (others may use the figure with the credit) or 'closed' (default: all rights with the owner)
//   returns { files: [{ path, content }], slugSuggestion }
//
// Every text of a person is escaped; nothing of the app (ids of workflows, e-mail addresses, costs unless given as a fact) reaches the page.

const WORDS = {
  de: {
    skip: 'Zum Inhalt', aiShort: 'KI-generiert', about: 'Über', work: 'Arbeiten', looks: 'Looks', agents: 'Für Agenten', play: 'Abspielen', close: 'Schliessen',
    empty: 'Hier erscheinen bald die ersten Arbeiten.', ai: 'Diese Figur und alle Inhalte auf dieser Seite sind KI-generiert. Sie zeigt keine reale Person.',
    made: 'Erstellt mit dem Creative Director', canon: 'So beschreibst du die Figur, damit sie sich gleich bleibt:', copy: 'Text kopieren', copied: 'Kopiert',
    canonFile: 'Alles als JSON', never: 'Nie', looksText: 'Garderobe', face: 'Ausdruck', voice: 'Stimme', style: 'Bildstil',
    open: 'Offene Figur: Du darfst sie für alles verwenden, was legal ist. Nenn dabei bitte den Credit.', closed: 'Alle Rechte an dieser Figur liegen bei ihren Urheber:innen. Bitte frag, bevor du sie verwendest.',
    pieces: (n) => (n === 1 ? '1 Arbeit' : `${n} Arbeiten`), looksCount: (n) => (n === 1 ? '1 Look' : `${n} Looks`)
  },
  en: {
    skip: 'Skip to content', aiShort: 'AI-generated', about: 'About', work: 'Work', looks: 'Looks', agents: 'For agents', play: 'Play', close: 'Close',
    empty: 'The first pieces will appear here soon.', ai: 'This character and everything on this page is AI-generated. It shows no real person.',
    made: 'Made with the Creative Director', canon: 'Describe the character like this to keep it consistent:', copy: 'Copy text', copied: 'Copied',
    canonFile: 'Everything as JSON', never: 'Never', looksText: 'Wardrobe', face: 'Expression', voice: 'Voice', style: 'Image style',
    open: 'An open character: you may use it for anything that is legal. Please give the credit.', closed: 'All rights to this character stay with its makers. Please ask before you use it.',
    pieces: (n) => (n === 1 ? '1 piece' : `${n} pieces`), looksCount: (n) => (n === 1 ? '1 look' : `${n} looks`)
  },
  es: {
    skip: 'Ir al contenido', aiShort: 'Generado con IA', about: 'Sobre', work: 'Trabajos', looks: 'Looks', agents: 'Para agentes', play: 'Reproducir', close: 'Cerrar',
    empty: 'Aquí aparecerán pronto los primeros trabajos.', ai: 'Este personaje y todo el contenido de esta página están generados con IA. No muestra a ninguna persona real.',
    made: 'Hecho con el Creative Director', canon: 'Describe al personaje así para que se mantenga igual:', copy: 'Copiar texto', copied: 'Copiado',
    canonFile: 'Todo como JSON', never: 'Nunca', looksText: 'Vestuario', face: 'Expresión', voice: 'Voz', style: 'Estilo de imagen',
    open: 'Un personaje abierto: puedes usarlo para todo lo que sea legal. Indica el crédito, por favor.', closed: 'Todos los derechos de este personaje son de sus autores. Pregunta antes de usarlo.',
    pieces: (n) => (n === 1 ? '1 trabajo' : `${n} trabajos`), looksCount: (n) => (n === 1 ? '1 look' : `${n} looks`)
  }
};

const MAX_ITEMS = 60;
const SAFE_PATH = /^assets\/[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

// A source the page may show: a file of the site (assets/…, no "..") or an https URL. Anything else is dropped.
function safeSource(value) {
  const text = String(value ?? '').trim();
  if (SAFE_PATH.test(text) && !text.includes('..')) return text;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch (_) {
    return '';
  }
}

// The subdomain a name suggests: lower case, a to z, digits and hyphens, 3 to 40 characters.
function slugOf(name) {
  const slug = String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return slug.length >= 3 ? slug : '';
}

// One accent colour per figure, stable for a name: a hue from the name, always light enough on the dark page.
function accentOf(name) {
  let sum = 0;
  for (const char of String(name ?? '')) sum = (sum * 31 + char.codePointAt(0)) % 360;
  return `hsl(${sum} 78% 66%)`;
}
// The second colour of the page: the neighbour of the accent, for glows and gradients.
function secondOf(name) {
  const hue = Number(/hsl\((\d+)/.exec(accentOf(name))[1]);
  return `hsl(${(hue + 70) % 360} 82% 64%)`;
}

// The id of a film on YouTube, from a link people copy (youtu.be/…, watch?v=…, /shorts/…, /embed/…, /live/…) or the bare id; '' for anything else.
function youtubeId(value) {
  const text = String(value ?? '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text;
  let url;
  try { url = new URL(text); } catch (_) { return ''; }
  if (url.protocol !== 'https:' || url.username || url.password) return '';
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  const id = host === 'youtu.be' ? url.pathname.slice(1).split('/')[0]
    : host === 'youtube.com' || host === 'youtube-nocookie.com'
      ? (url.pathname === '/watch' ? url.searchParams.get('v') : (/^\/(?:shorts|embed|live)\/([^/]+)/.exec(url.pathname) || [])[1])
      : '';
  return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : '';
}

function cleanItems(items) {
  const out = [];
  for (const raw of Array.isArray(items) ? items : []) {
    if (!raw || typeof raw !== 'object') continue;
    const kind = ['video', 'image', 'youtube'].includes(raw.kind) ? raw.kind : '';
    const youtube = kind === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(String(raw.youtube ?? '')) ? raw.youtube : '';
    const src = kind === 'youtube' ? '' : safeSource(raw.src);
    if (!kind || !(src || youtube)) continue;
    const facts = (Array.isArray(raw.facts) ? raw.facts : [])
      .map((fact) => ({ label: squash(fact?.label).slice(0, 40), value: squash(fact?.value).slice(0, 200) }))
      .filter((fact) => fact.label && fact.value).slice(0, 8);
    out.push({
      id: squash(raw.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || `p${out.length + 1}`,
      kind, src, youtube, poster: safeSource(raw.poster),
      title: squash(raw.title).slice(0, 120), description: String(raw.description ?? '').trim().slice(0, 1200),
      date: /^\d{4}-\d{2}-\d{2}/.test(String(raw.date ?? '')) ? String(raw.date).slice(0, 10) : '', facts
    });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

function canonOf(influencer, { usage, url }) {
  const pick = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  return {
    name: influencer.name,
    ...(url ? { url } : {}),
    identity: { full: pick(influencer.full), short: pick(influencer.short), looks: pick(influencer.looks), face: pick(influencer.face), never: pick(influencer.never) },
    style: pick(influencer.style),
    voice: pick(influencer.voice?.description),
    credit: pick(influencer.credit),
    usage: usage === 'open' ? 'open-with-credit' : 'all-rights-reserved',
    ai_generated: true
  };
}

function paragraphs(text) {
  return String(text ?? '').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean).map((part) => `<p>${esc(part).replace(/\n/g, '<br>')}</p>`).join('\n        ');
}

// The text about the figure, one span per word: the words light up as the reader scrolls through them (all lit without the script).
function litParagraphs(text) {
  return String(text ?? '').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
    .map((part) => `<p>${part.split(/\s+/).map((word) => `<span class="w">${esc(word)}</span>`).join(' ')}</p>`).join('\n        ');
}

function itemHtml(item, words, at) {
  const title = item.title ? `<h3>${esc(item.title)}</h3>` : '';
  const date = item.date ? `<time datetime="${esc(item.date)}">${esc(item.date)}</time>` : '';
  const facts = item.facts.length
    ? `<dl class="facts">${item.facts.map((fact) => `<div><dt>${esc(fact.label)}</dt><dd>${esc(fact.value)}</dd></div>`).join('')}</dl>`
    : '';
  // The player of YouTube without its cookies until someone presses play; the frame may send where it is embedded, YouTube refuses to play otherwise.
  const media = item.kind === 'youtube'
    ? `<div class="frame embed"><iframe src="https://www.youtube-nocookie.com/embed/${esc(item.youtube)}?rel=0" title="${esc(item.title || words.play)}" loading="lazy" allowfullscreen allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`
    : item.kind === 'video'
    ? `<div class="frame"><video controls preload="none" playsinline${item.poster ? ` poster="${esc(item.poster)}"` : ''} src="${esc(item.src)}" aria-label="${esc(item.title || words.play)}"></video></div>`
    : `<button class="frame zoom" type="button" data-full="${esc(item.src)}" aria-label="${esc(item.title || words.looks)}"><img loading="lazy" decoding="async" src="${esc(item.src)}" alt="${esc(item.title)}"></button>`;
  return `<article class="piece piece-${item.kind}${at === 0 ? ' piece-lead' : ''} reveal" id="${esc(item.id)}">
          ${media}
          <div class="piece-text"><span class="count" aria-hidden="true">${String(at + 1).padStart(2, '0')}</span>${date}${title}${item.description ? `\n            ${paragraphs(item.description)}` : ''}${facts}</div>
        </article>`;
}

// The name as the page shows it large: one span per character (they rise one after the other), read aloud as one word.
function nameLetters(name) {
  const chars = [...name];
  if (chars.length > 14) return `<span class="word">${esc(name)}</span>`;
  return chars.map((char) => (char === ' ' ? '<span class="gap"> </span>' : `<span class="letter">${esc(char)}</span>`)).join('');
}

function indexHtml({ influencer, images, items, words, lang, about, usage, accent, accent2 }) {
  const name = squash(influencer.name);
  const tagline = squash(influencer.tagline);
  const portrait = images[0] ? images[0].path : '';
  const aboutText = String(about ?? '').trim() || tagline;
  const canonRows = [[words.looksText, influencer.looks], [words.face, influencer.face], [words.never, influencer.never], [words.style, influencer.style], [words.voice, influencer.voice?.description]]
    .filter(([, value]) => typeof value === 'string' && value.trim());
  const description = (tagline || aboutText || name).slice(0, 200);
  // the name fills the width of the screen: the fewer characters, the larger (capped for very short names)
  const size = Math.max(7, Math.min(30, Math.round(1280 / Math.max(1, [...name].length)) / 10));
  const ticker = [name, tagline, words.aiShort].filter(Boolean).map((part) => `<span>${esc(part)}</span><i aria-hidden="true">✦</i>`).join('');
  const band = [name, words.aiShort, name, tagline ? words.looks : words.work].map((part) => `<span>${esc(part)}</span>`).join('<i>✦</i>');
  const stats = [[images.length, words.looks], [items.length, words.work], [100, words.aiShort, '%']]
    .filter(([count]) => count > 0).map(([count, label, unit]) => `<div class="stat"><b><span class="num" data-to="${count}">${count}</span>${unit || ''}</b><span>${esc(label)}</span></div>`).join('');
  const work = `
    <section id="work" class="block">
      <h2 class="reveal"><span>${esc(words.work)}</span></h2>
      ${items.length ? `<div class="pieces">
        ${items.map((item, at) => itemHtml(item, words, at)).join('\n        ')}
      </div>` : `<div class="soon reveal"><p>${esc(words.empty)}</p></div>`}
    </section>
`;
  const looks = images.length ? `
    <section id="looks" class="block block-wide">
      <h2 class="reveal"><span>${esc(words.looks)}</span></h2>
      <div class="looks" tabindex="0" role="group" aria-label="${esc(words.looks)}">
        ${images.map((image, at) => `<button class="zoom look reveal" type="button" data-full="${esc(image.path)}" aria-label="${esc(`${words.looks} ${at + 1}`)}"><img loading="lazy" decoding="async" src="${esc(image.path)}" alt="${esc(`${name}, ${words.looks} ${at + 1}`)}"><span class="look-no" aria-hidden="true">${String(at + 1).padStart(2, '0')}</span></button>`).join('\n        ')}
      </div>
    </section>
` : '';
  return `<!DOCTYPE html>
<html lang="${esc(lang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(name)}</title>
  <meta name="description" content="${esc(description)}">
  <meta name="theme-color" content="#08080a">
  <meta property="og:title" content="${esc(name)}">
  <meta property="og:description" content="${esc(description)}">${portrait ? `\n  <meta property="og:image" content="${esc(portrait)}">` : ''}
  <link rel="icon" href="favicon.svg" type="image/svg+xml">
  <link rel="alternate" type="application/json" href="canon.json" title="canon">
  <link rel="stylesheet" href="assets/styles.css">
  <style>:root { --accent: ${accent}; --accent2: ${accent2}; --name: ${size}vw; }</style>
</head>
<body>
  <a class="skip" href="#main">${esc(words.skip)}</a>
  <div class="bar" aria-hidden="true"></div>
  <header class="top">
    <a class="mark" href="#main">${esc(name)}</a>
    <nav aria-label="${esc(name)}">
      <a href="#about">${esc(words.about)}</a>
      <a href="#work">${esc(words.work)}</a>${images.length ? `\n      <a href="#looks">${esc(words.looks)}</a>` : ''}
      <a href="#agents">${esc(words.agents)}</a>
    </nav>
  </header>
  <main id="main">
    <section class="hero${portrait ? '' : ' hero-plain'}">
      ${portrait ? `<img class="hero-image on" src="${esc(portrait)}" alt="${esc(name)}" fetchpriority="high">${images.slice(1, 4).map((image) => `\n      <img class="hero-image" src="${esc(image.path)}" alt="" loading="lazy" decoding="async">`).join('')}` : ''}
      <div class="hero-light" aria-hidden="true"></div>
      <div class="hero-text">
        <p class="eyebrow"><span class="dot" aria-hidden="true"></span>${esc([items.length ? words.pieces(items.length) : '', images.length ? words.looksCount(images.length) : ''].filter(Boolean).join(' · ') || words.aiShort)}</p>
        <h1 aria-label="${esc(name)}" data-name="${esc(name)}"><span class="name" aria-hidden="true">${nameLetters(name)}</span></h1>
        ${tagline ? `<p class="tagline">${esc(tagline)}</p>` : ''}
      </div>
      <a class="down" href="#about" aria-label="${esc(words.about)}"><span aria-hidden="true"></span></a>
    </section>
    <div class="ticker" aria-hidden="true"><div class="ticker-run">${ticker.repeat(8)}</div></div>

    <section id="about" class="block">
      <h2 class="reveal"><span>${esc(words.about)} ${esc(name)}</span></h2>
      <div class="about">
        <div class="prose">
          ${litParagraphs(aboutText) || `<p>${esc(name)}</p>`}
        </div>
        <div class="stats reveal">${stats}</div>
      </div>
    </section>
${items.length ? work + looks : looks + work}
    <div class="band" aria-hidden="true"><div class="band-run">${band}<i>✦</i>${band}</div></div>
    <section id="agents" class="block">
      <h2 class="reveal"><span>${esc(words.agents)}</span></h2>
      <p class="quiet reveal">${esc(usage === 'open' ? words.open : words.closed)}</p>
      <div class="term reveal">
        <div class="term-bar" aria-hidden="true"><i></i><i></i><i></i><span>canon.txt</span></div>
        <p class="term-note">${esc(words.canon)}</p>
        <pre id="canonText" tabindex="0">${esc(influencer.full)}</pre>
        <p class="actions"><button id="copyCanon" class="button" type="button" data-done="${esc(words.copied)}">${esc(words.copy)}</button> <a class="button ghost" href="canon.json">${esc(words.canonFile)}</a></p>
      </div>
      ${canonRows.length ? `<dl class="canon reveal">${canonRows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value.trim())}</dd></div>`).join('')}</dl>` : ''}
    </section>
  </main>
  <footer class="foot">
    <p class="foot-name" aria-hidden="true">${esc(name)}</p>
    <p>${esc(words.ai)}</p>
    <p>${influencer.credit && influencer.credit.trim() ? `${esc(influencer.credit.trim())} · ` : ''}${esc(words.made)}</p>
  </footer>
  <dialog id="lightbox" aria-label="${esc(name)}"><button class="lightbox-close" type="button" aria-label="${esc(words.close)}">×</button><img alt=""></dialog>
  <script src="assets/app.js" defer></script>
</body>
</html>
`;
}

// No web fonts and no images of its own: the page is shown inside the app under a strict content policy, and it must load fast anywhere.
const STYLES = `:root { --bg: #08080a; --panel: #131318; --line: #26262e; --text: #f4f1ea; --quiet: #a09d96; --accent: #e8a05c; --accent2: #5ce8c3; --name: 20vw; color-scheme: dark; }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; overflow-x: clip; }
body::before { content: ""; position: fixed; inset: -30vmax; z-index: -1; pointer-events: none; opacity: .5; background: radial-gradient(38vmax 38vmax at 28% 30%, color-mix(in srgb, var(--accent) 26%, transparent), transparent 70%), radial-gradient(34vmax 34vmax at 74% 68%, color-mix(in srgb, var(--accent2) 22%, transparent), transparent 70%); animation: aurora 38s linear infinite; }
body { position: relative; isolation: isolate; margin: 0; background: var(--bg); color: var(--text); font: 17px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; overflow-x: clip; }
img, video { display: block; max-width: 100%; }
a { color: inherit; }
::selection { background: var(--accent); color: #0a0a0a; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.skip { position: absolute; left: -999px; top: 0; background: var(--accent); color: #111; padding: 8px 14px; z-index: 30; }
.skip:focus { left: 12px; top: 12px; }

.bar { position: fixed; inset: 0 0 auto 0; height: 3px; z-index: 25; background: linear-gradient(90deg, var(--accent), var(--accent2)); transform: scaleX(var(--s, 0)); transform-origin: left; box-shadow: 0 0 18px var(--accent); }
.top { position: fixed; inset: 0 0 auto 0; z-index: 20; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px clamp(16px, 4vw, 48px); transition: background .3s ease, border-color .3s ease; border-bottom: 1px solid transparent; }
.top.solid { background: color-mix(in srgb, var(--bg) 80%, transparent); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-bottom-color: var(--line); }
.mark { font-weight: 800; letter-spacing: .16em; text-transform: uppercase; text-decoration: none; font-size: 14px; }
.top nav { display: flex; gap: clamp(10px, 2.4vw, 28px); font-size: 12px; letter-spacing: .14em; text-transform: uppercase; overflow-x: auto; scrollbar-width: none; }
.top nav a { position: relative; text-decoration: none; white-space: nowrap; padding: 6px 0; text-shadow: 0 1px 12px rgba(0, 0, 0, .6); }
.top nav a::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--accent); transform: scaleX(0); transform-origin: left; transition: transform .25s ease; }
.top nav a:hover::after, .top nav a:focus-visible::after { transform: scaleX(1); }

.hero { position: relative; min-height: 100vh; min-height: 100svh; display: flex; align-items: flex-end; overflow: hidden; isolation: isolate; }
.hero-plain { min-height: 78vh; background: radial-gradient(90% 80% at 85% 10%, color-mix(in srgb, var(--accent) 34%, transparent), transparent 62%), radial-gradient(70% 70% at 5% 95%, color-mix(in srgb, var(--accent2) 26%, transparent), transparent 60%); }
.hero-image { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: 50% 20%; z-index: -3; opacity: 0; scale: calc(1 + var(--p, 0) * .2); transition: opacity 1.8s ease; animation: drift 26s ease-in-out infinite alternate; }
.hero-image.on { opacity: 1; }
.hero::before { content: ""; position: absolute; inset: 0; z-index: -2; background: linear-gradient(to top, var(--bg) 2%, rgba(8, 8, 10, .72) 30%, rgba(8, 8, 10, .1) 62%, rgba(8, 8, 10, .45) 100%), linear-gradient(100deg, color-mix(in srgb, var(--accent) 22%, transparent), transparent 46%, color-mix(in srgb, var(--accent2) 16%, transparent)); }
.hero::after { content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none; opacity: .5; background: repeating-linear-gradient(to bottom, rgba(255, 255, 255, .035) 0 1px, transparent 1px 4px); mix-blend-mode: overlay; }
.hero-light { position: absolute; inset: 0; z-index: -1; pointer-events: none; opacity: 0; transition: opacity .6s ease; background: radial-gradient(520px circle at var(--mx, 50%) var(--my, 40%), color-mix(in srgb, var(--accent) 30%, transparent), transparent 62%); mix-blend-mode: screen; }
.hero:hover .hero-light { opacity: 1; }
.hero-text { position: relative; width: 100%; padding: 0 clamp(16px, 4vw, 48px) clamp(64px, 10vh, 120px); translate: 0 calc(var(--p, 0) * -12vh); opacity: calc(1 - var(--p, 0) * 1.25); }
.down { position: absolute; right: clamp(16px, 4vw, 48px); bottom: clamp(70px, 11vh, 130px); width: 54px; height: 54px; display: grid; place-items: center; border: 1px solid color-mix(in srgb, var(--text) 45%, transparent); border-radius: 50%; background: rgba(8, 8, 10, .4); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); transition: border-color .3s ease, background .3s ease; }
.down span { width: 11px; height: 11px; border: solid var(--text); border-width: 0 2px 2px 0; transform: rotate(45deg) translate(-2px, -2px); animation: nod 1.8s ease-in-out infinite; }
.down:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 25%, transparent); }
.eyebrow { display: inline-flex; align-items: center; gap: 10px; margin: 0 0 clamp(8px, 2vh, 20px); padding: 7px 14px; border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); border-radius: 999px; background: rgba(8, 8, 10, .5); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); color: var(--accent); font-size: 12px; letter-spacing: .18em; text-transform: uppercase; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 0 var(--accent); animation: pulse 2.2s ease-out infinite; }
h1 { position: relative; margin: 0 0 0 -.04em; transform-origin: 0 100%; scale: calc(1 + var(--p, 0) * .14); font-size: clamp(64px, var(--name), 52vh); line-height: .82; letter-spacing: -.045em; text-transform: uppercase; font-weight: 900; font-stretch: 115%; white-space: nowrap; }
h1::after { content: attr(data-name); position: absolute; left: 0; top: 0; z-index: -1; color: transparent; -webkit-text-stroke: 1.5px var(--accent); transform: translate(.045em, .045em); opacity: .9; pointer-events: none; }
h1::before { content: attr(data-name); position: absolute; left: 0; top: 0; z-index: 1; color: var(--accent2); mix-blend-mode: screen; opacity: 0; pointer-events: none; animation: glitch 7s steps(1) 2.4s infinite; }
.name { display: inline-block; }
.letter, .word { display: inline-block; background: linear-gradient(180deg, #fff 35%, color-mix(in srgb, var(--accent) 60%, #fff) 100%); -webkit-background-clip: text; background-clip: text; color: transparent; }
.gap { display: inline-block; width: .28em; }
.tagline { margin: clamp(14px, 3vh, 28px) 0 0; max-width: 34em; font-size: clamp(18px, 2.3vw, 28px); line-height: 1.3; font-weight: 500; text-wrap: balance; }

.ticker { position: relative; z-index: 2; margin: -34px -3vw 0; padding: 14px 0; background: var(--accent); color: #0a0a0a; transform: rotate(-1.6deg); overflow: hidden; box-shadow: 0 18px 60px color-mix(in srgb, var(--accent) 35%, transparent); }
.ticker-run { display: flex; align-items: center; gap: 26px; width: max-content; font-weight: 800; font-size: clamp(15px, 1.8vw, 22px); letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; animation: run 60s linear infinite; }
.ticker-run i { font-style: normal; }

.block { position: relative; padding: clamp(64px, 10vw, 140px) clamp(16px, 4vw, 48px) 0; max-width: 1280px; margin: 0 auto; }
.block-wide { max-width: none; }
.block-wide > h2 { max-width: 1184px; margin-left: auto; margin-right: auto; }
h2 { display: flex; align-items: center; gap: 16px; margin: 0 0 clamp(22px, 4vw, 44px); font-size: 13px; letter-spacing: .22em; text-transform: uppercase; color: var(--accent); font-weight: 700; }
h2::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, var(--line), transparent); }
.about { display: grid; gap: clamp(28px, 5vw, 72px); grid-template-columns: minmax(0, 1fr); align-items: end; }
@media (min-width: 900px) { .about { grid-template-columns: minmax(0, 1fr) auto; } }
.prose { max-width: 17em; font-size: clamp(30px, 5vw, 72px); line-height: 1.04; letter-spacing: -.03em; font-weight: 800; text-wrap: balance; }
.prose p { margin: 0 0 .6em; }
.w { transition: color .5s ease, text-shadow .5s ease; }
.js .w { color: color-mix(in srgb, var(--text) 16%, transparent); }
.js .w.lit { color: var(--text); }
.js .w.lit.last { color: var(--accent); text-shadow: 0 0 34px color-mix(in srgb, var(--accent) 60%, transparent); }
.stats { display: flex; gap: clamp(18px, 3vw, 40px); flex-wrap: wrap; }
@media (min-width: 900px) { .stats { flex-direction: column; gap: 22px; padding-left: clamp(24px, 3vw, 48px); border-left: 1px solid var(--line); } }
.stat { display: grid; gap: 4px; }
.stat b { font-size: clamp(44px, 6vw, 92px); line-height: .88; font-weight: 900; letter-spacing: -.05em; font-variant-numeric: tabular-nums; background: linear-gradient(135deg, var(--accent), var(--accent2)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.stat > span { color: var(--quiet); font-size: 11px; letter-spacing: .2em; text-transform: uppercase; }
.band { margin: clamp(72px, 11vw, 160px) 0 calc(-1 * clamp(24px, 4vw, 60px)); overflow: hidden; }
.band-run { display: flex; align-items: center; gap: .22em; width: max-content; translate: calc((var(--s, 0) - 1) * 38vw) 0; font-size: clamp(72px, 15vw, 240px); line-height: .9; font-weight: 900; font-stretch: 115%; letter-spacing: -.045em; text-transform: uppercase; white-space: nowrap; color: transparent; -webkit-text-stroke: 1.5px color-mix(in srgb, var(--accent) 70%, transparent); }
.band-run span:nth-of-type(even) { color: var(--text); -webkit-text-stroke: 0; }
.band-run i { font-style: normal; font-size: .4em; color: var(--accent2); -webkit-text-stroke: 0; animation: spin 9s linear infinite; }
.quiet { color: var(--quiet); }

.pieces { display: grid; gap: clamp(28px, 4vw, 56px); grid-template-columns: minmax(0, 1fr); }
.piece { display: grid; gap: 18px; grid-template-columns: minmax(0, 1fr); align-content: start; }
@media (min-width: 900px) { .pieces { grid-template-columns: repeat(2, minmax(0, 1fr)); } .piece-lead { grid-column: 1 / -1; grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr); align-items: end; } }
.frame { position: relative; display: block; width: 100%; padding: 0; border: 1px solid var(--line); border-radius: 14px; overflow: hidden; background: #000; transition: border-color .3s ease, box-shadow .3s ease, transform .3s ease; }
.piece:hover .frame { border-color: color-mix(in srgb, var(--accent) 70%, transparent); box-shadow: 0 24px 80px -20px color-mix(in srgb, var(--accent) 45%, transparent); transform: translateY(-4px); }
.frame video, .frame img { width: 100%; height: auto; max-height: 82vh; object-fit: contain; background: #000; }
.embed { aspect-ratio: 16 / 9; }
.embed iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
.piece-text { position: relative; }
.count { display: block; font-size: clamp(44px, 6vw, 88px); line-height: .9; font-weight: 900; letter-spacing: -.04em; color: transparent; -webkit-text-stroke: 1px var(--accent); margin-bottom: 8px; }
.piece-text time { display: block; color: var(--quiet); font-size: 12px; letter-spacing: .14em; }
.piece-text h3 { margin: 4px 0 10px; font-size: clamp(26px, 3.4vw, 46px); line-height: 1; letter-spacing: -.02em; text-transform: uppercase; font-weight: 800; }
.piece-text p { margin: 0 0 .9em; color: #d9d6cf; }
.soon { position: relative; display: grid; place-items: center; min-height: 240px; padding: 32px; border-radius: 18px; text-align: center; font-size: clamp(20px, 3vw, 34px); font-weight: 700; letter-spacing: -.01em; background: linear-gradient(var(--panel), var(--panel)) padding-box, linear-gradient(120deg, var(--accent), var(--accent2), var(--accent)) border-box; border: 1px solid transparent; background-size: auto, 200% 100%; animation: sheen 8s linear infinite; }
.soon p { margin: 0; max-width: 18em; text-wrap: balance; }
.facts, .canon { margin: 18px 0 0; display: grid; gap: 0; border-top: 1px solid var(--line); }
.facts div, .canon div { display: grid; grid-template-columns: minmax(90px, 9em) minmax(0, 1fr); gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line); font-size: 14px; }
dt { color: var(--accent); letter-spacing: .1em; text-transform: uppercase; font-size: 11px; padding-top: 3px; }
dd { margin: 0; }

.looks { display: flex; gap: clamp(14px, 2vw, 26px); overflow-x: auto; scroll-snap-type: x mandatory; padding: 26px max(clamp(16px, 4vw, 48px), calc((100vw - 1184px) / 2)) 40px; margin: -26px calc(-1 * clamp(16px, 4vw, 48px)) 0; scrollbar-width: thin; scrollbar-color: var(--accent) transparent; }
.zoom { cursor: zoom-in; padding: 0; border: 1px solid var(--line); overflow: hidden; background: var(--panel); }
.look { position: relative; flex: 0 0 auto; width: min(72vw, 340px); aspect-ratio: 3 / 4; border-radius: 18px; scroll-snap-align: center; transition: transform .45s cubic-bezier(.2, .8, .2, 1), box-shadow .45s ease, border-color .3s ease; }
.look:nth-child(odd) { transform: rotate(-2.2deg); }
.look:nth-child(even) { transform: rotate(1.8deg) translateY(14px); }
.look:hover, .look:focus-visible { transform: perspective(900px) rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg)) translateY(-10px) scale(1.05); border-color: var(--accent); box-shadow: 0 30px 90px -20px color-mix(in srgb, var(--accent) 55%, transparent); z-index: 2; }
.look img { width: 100%; height: 100%; object-fit: cover; transition: scale .8s cubic-bezier(.2, .8, .2, 1); }
.look:hover img { scale: 1.08; }
.look::before, .frame::before { content: ""; position: absolute; inset: 0; z-index: 1; pointer-events: none; opacity: 0; transition: opacity .3s ease; background: radial-gradient(260px circle at var(--sx, 50%) var(--sy, 50%), rgba(255, 255, 255, .28), transparent 60%); mix-blend-mode: soft-light; }
.look:hover::before, .frame:hover::before { opacity: 1; }
.cursor { position: fixed; left: 0; top: 0; z-index: 40; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%; background: #fff; mix-blend-mode: difference; pointer-events: none; display: none; transition: width .25s ease, height .25s ease, margin .25s ease; }
.cursor.live { display: block; }
.cursor.big { width: 72px; height: 72px; margin: -36px 0 0 -36px; }
.look::after { content: ""; position: absolute; inset: 0; background: linear-gradient(to top, rgba(0, 0, 0, .65), transparent 38%); pointer-events: none; }
.look-no { position: absolute; left: 14px; bottom: 8px; z-index: 1; font-size: 44px; line-height: 1; font-weight: 900; letter-spacing: -.04em; color: transparent; -webkit-text-stroke: 1px #fff; }

.term { max-width: 62em; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); overflow: hidden; box-shadow: 0 30px 100px -40px color-mix(in srgb, var(--accent2) 50%, transparent); }
.term-bar { display: flex; align-items: center; gap: 7px; padding: 11px 14px; border-bottom: 1px solid var(--line); background: #0e0e12; }
.term-bar i { width: 11px; height: 11px; border-radius: 50%; background: var(--line); }
.term-bar i:first-child { background: var(--accent); }
.term-bar i:nth-child(2) { background: var(--accent2); }
.term-bar span { margin-left: 8px; color: var(--quiet); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.term-note { margin: 16px 18px 0; color: var(--quiet); font-size: 14px; }
pre { margin: 10px 18px 16px; padding: 0; background: none; border: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #e9fff8; }
pre::before { content: "> "; color: var(--accent2); }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 0; padding: 0 18px 18px; }
.button { display: inline-block; font: inherit; font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; padding: 11px 18px; border-radius: 999px; border: 1px solid var(--accent); background: var(--accent); color: #0a0a0a; cursor: pointer; text-decoration: none; transition: transform .2s ease, box-shadow .2s ease; }
.button:hover { transform: translateY(-2px); box-shadow: 0 10px 30px -8px var(--accent); }
.button.ghost { background: transparent; color: var(--text); border-color: var(--line); }
.button.ghost:hover { border-color: var(--text); box-shadow: none; }
.canon { max-width: 62em; margin-top: 28px; }

.foot { position: relative; margin-top: clamp(72px, 12vw, 160px); padding: 0 clamp(16px, 4vw, 48px) 48px; color: var(--quiet); font-size: 14px; overflow: hidden; }
.foot-name { margin: 0 0 18px -.04em; font-size: clamp(64px, var(--name), 40vh); line-height: .8; font-weight: 900; font-stretch: 115%; letter-spacing: -.045em; text-transform: uppercase; white-space: nowrap; color: transparent; -webkit-text-stroke: 1px color-mix(in srgb, var(--accent) 38%, var(--line)); user-select: none; }
.foot p { margin: 0 0 6px; max-width: 60em; }

dialog { border: 0; padding: 0; background: transparent; max-width: 96vw; max-height: 96vh; }
dialog::backdrop { background: rgba(0, 0, 0, .9); backdrop-filter: blur(6px); }
dialog img { max-width: 96vw; max-height: 92vh; border-radius: 10px; }
.lightbox-close { position: fixed; top: 14px; right: 18px; width: 44px; height: 44px; border-radius: 50%; border: 1px solid var(--line); background: var(--panel); color: var(--text); font-size: 24px; cursor: pointer; }

@keyframes drift { from { transform: scale(1.04); } to { transform: scale(1.14) translate(-1.5%, -1%); } }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 70%, transparent); } 100% { box-shadow: 0 0 0 14px transparent; } }
@keyframes run { to { transform: translateX(-50%); } }
@keyframes sheen { to { background-position: 0 0, 200% 0; } }
@keyframes aurora { to { transform: rotate(360deg); } }
@keyframes spin { to { rotate: 360deg; } }
@keyframes nod { 50% { transform: rotate(45deg) translate(2px, 2px); } }
@keyframes glitch { 0%, 100% { opacity: 0; } 90% { opacity: .9; transform: translate(-.03em, .012em); clip-path: inset(12% 0 58% 0); } 92% { opacity: .9; transform: translate(.035em, -.01em); clip-path: inset(56% 0 14% 0); } 94% { opacity: .8; transform: translate(-.02em, 0); clip-path: inset(34% 0 38% 0); } 96% { opacity: 0; } }
@keyframes rise { from { transform: translateY(110%) rotate(6deg); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes ghost { from { opacity: 0; transform: translate(0, 0); } to { opacity: .9; transform: translate(.045em, .045em); } }
.js .letter, .js .word { animation: rise .9s cubic-bezier(.2, .9, .2, 1) both; }
.js .letter:nth-child(2) { animation-delay: .06s; } .js .letter:nth-child(3) { animation-delay: .12s; } .js .letter:nth-child(4) { animation-delay: .18s; }
.js .letter:nth-child(5) { animation-delay: .24s; } .js .letter:nth-child(6) { animation-delay: .3s; } .js .letter:nth-child(7) { animation-delay: .36s; }
.js .letter:nth-child(8) { animation-delay: .42s; } .js .letter:nth-child(9) { animation-delay: .48s; } .js .letter:nth-child(10) { animation-delay: .54s; }
.js .letter:nth-child(n+11) { animation-delay: .6s; }
.js h1::after { animation: ghost .9s .7s ease both; }
.js .eyebrow, .js .tagline { animation: rise .8s .5s cubic-bezier(.2, .9, .2, 1) both; }
.js .reveal { opacity: 0; translate: 0 34px; transition: opacity .8s ease, translate .8s cubic-bezier(.2, .8, .2, 1); }
.js .reveal.in { opacity: 1; translate: 0 0; }
@media (max-width: 640px) { .down { display: none; } h1 { font-size: clamp(56px, calc(var(--name) * 1.02), 34vh); } .hero-text { padding-bottom: 76px; } .ticker { margin-top: -30px; } }
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  body::before, h1::before, .down span, .band-run i, .hero-image, .ticker-run, .dot, .soon, .js .letter, .js .word, .js h1::after, .js .eyebrow, .js .tagline { animation: none; }
  .js .reveal { opacity: 1; translate: 0 0; transition: none; }
  .look, .look img, .frame, .button, .w { transition: none; }
  .hero-image, h1 { scale: 1; }
  .hero-text, .band-run { translate: 0 0; }
  .hero-text { opacity: 1; }
  .cursor { display: none; }
}
`;

const SCRIPT = `'use strict';
(function () {
  var root = document.documentElement;
  root.classList.add('js');
  var box = document.getElementById('lightbox');
  var image = box && box.querySelector('img');
  document.addEventListener('click', function (event) {
    var zoom = event.target.closest && event.target.closest('.zoom');
    if (zoom && box && box.showModal) {
      image.src = zoom.getAttribute('data-full');
      image.alt = (zoom.querySelector('img') || {}).alt || '';
      box.showModal();
      return;
    }
    if (box && box.open && (event.target === box || (event.target.closest && event.target.closest('.lightbox-close')))) box.close();
  });
  // one film at a time
  document.addEventListener('play', function (event) {
    var all = document.querySelectorAll('video');
    for (var i = 0; i < all.length; i += 1) if (all[i] !== event.target) all[i].pause();
  }, true);
  var copy = document.getElementById('copyCanon');
  var text = document.getElementById('canonText');
  if (copy && text) {
    copy.addEventListener('click', function () {
      var label = copy.textContent;
      var done = function () { copy.textContent = copy.getAttribute('data-done'); setTimeout(function () { copy.textContent = label; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text.textContent).then(done, function () {});
      else { var range = document.createRange(); range.selectNodeContents(text); var sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
    });
  }
  // the bar turns solid once the page has moved
  var top = document.querySelector('.top');
  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var prose = document.querySelector('.prose');
  var wordsOf = prose ? prose.querySelectorAll('.w') : [];
  var ticking = false;
  // one pass per frame: the bar, how far the opening has left (--p), how far the page is read (--s), and the words that are lit
  var solid = function () {
    ticking = false;
    var y = window.scrollY, view = window.innerHeight;
    if (top) top.classList.toggle('solid', y > 40);
    var total = Math.max(1, document.documentElement.scrollHeight - view);
    root.style.setProperty('--s', Math.min(1, y / total).toFixed(4));
    root.style.setProperty('--p', Math.min(1, y / Math.max(1, view)).toFixed(4));
    if (wordsOf.length) {
      var rect = prose.getBoundingClientRect();
      var read = Math.max(0, Math.min(1, (view * 0.82 - rect.top) / Math.max(1, rect.height + view * 0.28)));
      var lit = calm ? wordsOf.length : Math.round(read * wordsOf.length);
      for (var w = 0; w < wordsOf.length; w += 1) {
        wordsOf[w].classList.toggle('lit', w < lit);
        wordsOf[w].classList.toggle('last', w === lit - 1 && lit < wordsOf.length);
      }
    }
  };
  var onScroll = function () { if (!ticking) { ticking = true; requestAnimationFrame(solid); } };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  solid();
  // the opening picture changes through the first looks
  var slides = document.querySelectorAll('.hero-image');
  if (slides.length > 1 && !calm) {
    var at = 0;
    setInterval(function () {
      if (document.hidden) return;
      slides[at].classList.remove('on');
      at = (at + 1) % slides.length;
      slides[at].classList.add('on');
    }, 4800);
  }
  var fine = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (fine && !calm) {
    // cards lean towards the pointer
    document.addEventListener('pointermove', function (event) {
      var card = event.target.closest && event.target.closest('.look, .frame');
      if (!card) return;
      var r = card.getBoundingClientRect();
      var x = (event.clientX - r.left) / r.width, yy = (event.clientY - r.top) / r.height;
      card.style.setProperty('--ry', ((x - 0.5) * 16).toFixed(2) + 'deg');
      card.style.setProperty('--rx', ((0.5 - yy) * 12).toFixed(2) + 'deg');
      card.style.setProperty('--sx', (x * 100).toFixed(1) + '%');
      card.style.setProperty('--sy', (yy * 100).toFixed(1) + '%');
    });
    // a dot follows the pointer and grows over everything that can be pressed
    var dot = document.createElement('div');
    dot.className = 'cursor';
    dot.setAttribute('aria-hidden', 'true');
    document.body.appendChild(dot);
    var tx = 0, ty = 0, cx = 0, cy = 0, moving = false;
    var follow = function () {
      cx += (tx - cx) * 0.22; cy += (ty - cy) * 0.22;
      dot.style.setProperty('transform', 'translate(' + cx.toFixed(1) + 'px,' + cy.toFixed(1) + 'px)');
      if (Math.abs(tx - cx) + Math.abs(ty - cy) > 0.3) requestAnimationFrame(follow); else moving = false;
    };
    window.addEventListener('pointermove', function (event) {
      tx = event.clientX; ty = event.clientY;
      if (!dot.classList.contains('live')) { cx = tx; cy = ty; dot.classList.add('live'); }
      dot.classList.toggle('big', !!(event.target.closest && event.target.closest('a, button, video')));
      if (!moving) { moving = true; requestAnimationFrame(follow); }
    }, { passive: true });
    document.addEventListener('pointerleave', function () { dot.classList.remove('live'); });
  }
  // numbers count up when they are reached
  var count = function (node) {
    var to = Number(node.getAttribute('data-to')) || 0;
    if (calm || !to) return;
    var start = null;
    var step = function (now) {
      if (start === null) start = now;
      var k = Math.min(1, (now - start) / 1400);
      node.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3))));
      if (k < 1) requestAnimationFrame(step);
    };
    node.textContent = '0';
    requestAnimationFrame(step);
  };
  // a light follows the pointer over the opening picture
  var hero = document.querySelector('.hero');
  var light = document.querySelector('.hero-light');
  if (hero && light) hero.addEventListener('pointermove', function (event) {
    var rect = hero.getBoundingClientRect();
    light.style.setProperty('--mx', (event.clientX - rect.left) + 'px');
    light.style.setProperty('--my', (event.clientY - rect.top) + 'px');
  });
  // blocks come in as they are reached; without the observer everything is simply shown
  var parts = document.querySelectorAll('.reveal');
  var show = function (part) {
    part.classList.add('in');
    var nums = part.querySelectorAll('.num');
    for (var n = 0; n < nums.length; n += 1) count(nums[n]);
  };
  if (!('IntersectionObserver' in window)) { for (var p = 0; p < parts.length; p += 1) show(parts[p]); return; }
  var seen = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) { if (entry.isIntersecting) { show(entry.target); seen.unobserve(entry.target); } });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
  for (var q = 0; q < parts.length; q += 1) seen.observe(parts[q]);
})();
`;

function faviconSvg(name, accent) {
  const letter = esc(([...squash(name)][0] || '•').toUpperCase());
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#0d0d0f"/><text x="32" y="45" text-anchor="middle" font-family="system-ui, sans-serif" font-size="40" font-weight="800" fill="${accent}">${letter}</text></svg>\n`;
}

function buildSite({ influencer, images = [], items = [], lang = 'de', about = '', usage = 'closed', url = '' } = {}) {
  if (!influencer || typeof influencer !== 'object' || !squash(influencer.name)) throw new TypeError('buildSite: an influencer with a name is needed');
  const language = WORDS[lang] ? lang : 'de';
  const words = WORDS[language];
  const shown = (Array.isArray(images) ? images : []).map((image) => ({ path: safeSource(image?.path) })).filter((image) => image.path).slice(0, 12);
  const pieces = cleanItems(items);
  const accent = accentOf(influencer.name);
  const accent2 = secondOf(influencer.name);
  const mode = usage === 'open' ? 'open' : 'closed';
  return {
    slugSuggestion: slugOf(influencer.name),
    files: [
      { path: 'index.html', content: indexHtml({ influencer, images: shown, items: pieces, words, lang: language, about, usage: mode, accent, accent2 }) },
      { path: 'assets/styles.css', content: STYLES },
      { path: 'assets/app.js', content: SCRIPT },
      { path: 'favicon.svg', content: faviconSvg(influencer.name, accent) },
      { path: 'canon.json', content: `${JSON.stringify(canonOf(influencer, { usage: mode, url: safeSource(url) }), null, 2)}\n` }
    ]
  };
}

module.exports = { buildSite, slugOf, safeSource, accentOf, youtubeId, MAX_ITEMS };
