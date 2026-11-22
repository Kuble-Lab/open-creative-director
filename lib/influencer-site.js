'use strict';

// The page of an influencer (stage 2): a static site made from the saved influencer and the pieces the owner put on it. Pure: no file
// access, no network. The caller hands over the texts and the names of the media files; this module returns the text files of the site
// (index.html, assets/styles.css, assets/app.js, favicon.svg, canon.json) and says where each media file belongs.
//
//   buildSite({ influencer, images, items, lang, about, usage })
//     influencer  the saved influencer (lib/influencers.js)
//     images      the reference images as they are on the site: [{ path: 'assets/looks/1.jpg' }] (the first one is the portrait)
//     items       the pieces on the page, newest first: [{ id, kind: 'video' | 'image', title, description, src, poster, date, facts }]
//                 `src` and `poster` are paths on the site (assets/work/…) or https URLs; `facts` is [{ label, value }]
//     lang        'de' | 'en' | 'es' (the language of the fixed words; the texts of the influencer are shown as written)
//     about       a few sentences about the figure for people (optional; the tagline stands in)
//     usage       'open' (others may use the figure with the credit) or 'closed' (default: all rights with the owner)
//   returns { files: [{ path, content }], slugSuggestion }
//
// Every text of a person is escaped; nothing of the app (ids of workflows, e-mail addresses, costs unless given as a fact) reaches the page.

const WORDS = {
  de: {
    skip: 'Zum Inhalt', about: 'Über', work: 'Arbeiten', looks: 'Looks', agents: 'Für Agenten', play: 'Abspielen', close: 'Schliessen',
    empty: 'Hier erscheinen bald die ersten Arbeiten.', ai: 'Diese Figur und alle Inhalte auf dieser Seite sind KI-generiert. Sie zeigt keine reale Person.',
    made: 'Erstellt mit dem Creative Director', canon: 'So beschreibst du die Figur, damit sie sich gleich bleibt:', copy: 'Text kopieren', copied: 'Kopiert',
    canonFile: 'Alles als JSON', never: 'Nie', looksText: 'Garderobe', face: 'Ausdruck', voice: 'Stimme', style: 'Bildstil',
    open: 'Offene Figur: Du darfst sie in eigenen Arbeiten verwenden, wenn du den Credit nennst.', closed: 'Alle Rechte an dieser Figur liegen bei ihren Urheber:innen. Bitte frag, bevor du sie verwendest.',
    pieces: (n) => (n === 1 ? '1 Arbeit' : `${n} Arbeiten`), looksCount: (n) => (n === 1 ? '1 Look' : `${n} Looks`)
  },
  en: {
    skip: 'Skip to content', about: 'About', work: 'Work', looks: 'Looks', agents: 'For agents', play: 'Play', close: 'Close',
    empty: 'The first pieces will appear here soon.', ai: 'This character and everything on this page is AI-generated. It shows no real person.',
    made: 'Made with the Creative Director', canon: 'Describe the character like this to keep it consistent:', copy: 'Copy text', copied: 'Copied',
    canonFile: 'Everything as JSON', never: 'Never', looksText: 'Wardrobe', face: 'Expression', voice: 'Voice', style: 'Image style',
    open: 'An open character: you may use it in your own work if you give the credit.', closed: 'All rights to this character stay with its makers. Please ask before you use it.',
    pieces: (n) => (n === 1 ? '1 piece' : `${n} pieces`), looksCount: (n) => (n === 1 ? '1 look' : `${n} looks`)
  },
  es: {
    skip: 'Ir al contenido', about: 'Sobre', work: 'Trabajos', looks: 'Looks', agents: 'Para agentes', play: 'Reproducir', close: 'Cerrar',
    empty: 'Aquí aparecerán pronto los primeros trabajos.', ai: 'Este personaje y todo el contenido de esta página están generados con IA. No muestra a ninguna persona real.',
    made: 'Hecho con el Creative Director', canon: 'Describe al personaje así para que se mantenga igual:', copy: 'Copiar texto', copied: 'Copiado',
    canonFile: 'Todo como JSON', never: 'Nunca', looksText: 'Vestuario', face: 'Expresión', voice: 'Voz', style: 'Estilo de imagen',
    open: 'Un personaje abierto: puedes usarlo en tus trabajos si indicas el crédito.', closed: 'Todos los derechos de este personaje son de sus autores. Pregunta antes de usarlo.',
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

function cleanItems(items) {
  const out = [];
  for (const raw of Array.isArray(items) ? items : []) {
    if (!raw || typeof raw !== 'object') continue;
    const kind = raw.kind === 'video' ? 'video' : raw.kind === 'image' ? 'image' : '';
    const src = safeSource(raw.src);
    if (!kind || !src) continue;
    const facts = (Array.isArray(raw.facts) ? raw.facts : [])
      .map((fact) => ({ label: squash(fact?.label).slice(0, 40), value: squash(fact?.value).slice(0, 200) }))
      .filter((fact) => fact.label && fact.value).slice(0, 8);
    out.push({
      id: squash(raw.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || `p${out.length + 1}`,
      kind, src, poster: safeSource(raw.poster),
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

function itemHtml(item, words) {
  const title = item.title ? `<h3>${esc(item.title)}</h3>` : '';
  const date = item.date ? `<time datetime="${esc(item.date)}">${esc(item.date)}</time>` : '';
  const facts = item.facts.length
    ? `<dl class="facts">${item.facts.map((fact) => `<div><dt>${esc(fact.label)}</dt><dd>${esc(fact.value)}</dd></div>`).join('')}</dl>`
    : '';
  const media = item.kind === 'video'
    ? `<div class="frame"><video controls preload="none" playsinline${item.poster ? ` poster="${esc(item.poster)}"` : ''} src="${esc(item.src)}" aria-label="${esc(item.title || words.play)}"></video></div>`
    : `<button class="frame zoom" type="button" data-full="${esc(item.src)}" aria-label="${esc(item.title || words.looks)}"><img loading="lazy" decoding="async" src="${esc(item.src)}" alt="${esc(item.title)}"></button>`;
  return `<article class="piece piece-${item.kind}" id="${esc(item.id)}">
          ${media}
          <div class="piece-text">${date}${title}${item.description ? `\n            ${paragraphs(item.description)}` : ''}${facts}</div>
        </article>`;
}

function indexHtml({ influencer, images, items, words, lang, about, usage, accent }) {
  const name = influencer.name;
  const tagline = squash(influencer.tagline);
  const portrait = images[0] ? images[0].path : '';
  const aboutText = String(about ?? '').trim() || tagline;
  const canonRows = [[words.looksText, influencer.looks], [words.face, influencer.face], [words.never, influencer.never], [words.style, influencer.style], [words.voice, influencer.voice?.description]]
    .filter(([, value]) => typeof value === 'string' && value.trim());
  const description = (tagline || aboutText || name).slice(0, 200);
  return `<!DOCTYPE html>
<html lang="${esc(lang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(name)}</title>
  <meta name="description" content="${esc(description)}">
  <meta property="og:title" content="${esc(name)}">
  <meta property="og:description" content="${esc(description)}">${portrait ? `\n  <meta property="og:image" content="${esc(portrait)}">` : ''}
  <link rel="icon" href="favicon.svg" type="image/svg+xml">
  <link rel="alternate" type="application/json" href="canon.json" title="canon">
  <link rel="stylesheet" href="assets/styles.css">
  <style>:root { --accent: ${accent}; }</style>
</head>
<body>
  <a class="skip" href="#main">${esc(words.skip)}</a>
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
      ${portrait ? `<img class="hero-image" src="${esc(portrait)}" alt="${esc(name)}" fetchpriority="high">` : ''}
      <div class="hero-text">
        <p class="eyebrow">${esc(words.pieces(items.length))}${images.length ? ` · ${esc(words.looksCount(images.length))}` : ''}</p>
        <h1>${esc(name)}</h1>
        ${tagline ? `<p class="tagline">${esc(tagline)}</p>` : ''}
      </div>
    </section>

    <section id="about" class="block">
      <h2>${esc(words.about)} ${esc(name)}</h2>
      <div class="prose">
        ${paragraphs(aboutText) || `<p>${esc(name)}</p>`}
      </div>
    </section>

    <section id="work" class="block">
      <h2>${esc(words.work)}</h2>
      ${items.length ? `<div class="pieces">
        ${items.map((item) => itemHtml(item, words)).join('\n        ')}
      </div>` : `<p class="quiet">${esc(words.empty)}</p>`}
    </section>
${images.length ? `
    <section id="looks" class="block">
      <h2>${esc(words.looks)}</h2>
      <div class="looks">
        ${images.map((image, at) => `<button class="zoom" type="button" data-full="${esc(image.path)}" aria-label="${esc(`${words.looks} ${at + 1}`)}"><img loading="lazy" decoding="async" src="${esc(image.path)}" alt="${esc(`${name}, ${words.looks} ${at + 1}`)}"></button>`).join('\n        ')}
      </div>
    </section>
` : ''}
    <section id="agents" class="block">
      <h2>${esc(words.agents)}</h2>
      <p class="quiet">${esc(usage === 'open' ? words.open : words.closed)}</p>
      <p>${esc(words.canon)}</p>
      <pre id="canonText" tabindex="0">${esc(influencer.full)}</pre>
      <p class="actions"><button id="copyCanon" class="button" type="button" data-done="${esc(words.copied)}">${esc(words.copy)}</button> <a class="button ghost" href="canon.json">${esc(words.canonFile)}</a></p>
      ${canonRows.length ? `<dl class="canon">${canonRows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value.trim())}</dd></div>`).join('')}</dl>` : ''}
    </section>
  </main>
  <footer class="foot">
    <p>${esc(words.ai)}</p>
    <p>${influencer.credit && influencer.credit.trim() ? `${esc(influencer.credit.trim())} · ` : ''}${esc(words.made)}</p>
  </footer>
  <dialog id="lightbox" aria-label="${esc(name)}"><button class="lightbox-close" type="button" aria-label="${esc(words.close)}">×</button><img alt=""></dialog>
  <script src="assets/app.js" defer></script>
</body>
</html>
`;
}

const STYLES = `:root { --bg: #0d0d0f; --panel: #17171b; --line: #2a2a31; --text: #f2efe9; --quiet: #a5a29b; --accent: #e8a05c; color-scheme: dark; }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; background: var(--bg); color: var(--text); font: 17px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; }
img, video { display: block; max-width: 100%; }
a { color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.skip { position: absolute; left: -999px; top: 0; background: var(--accent); color: #111; padding: 8px 14px; z-index: 20; }
.skip:focus { left: 12px; top: 12px; }
.top { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px clamp(16px, 4vw, 48px); background: color-mix(in srgb, var(--bg) 82%, transparent); backdrop-filter: blur(10px); border-bottom: 1px solid var(--line); }
.mark { font-weight: 700; letter-spacing: .14em; text-transform: uppercase; text-decoration: none; font-size: 14px; }
.top nav { display: flex; gap: clamp(10px, 2.4vw, 26px); font-size: 13px; letter-spacing: .1em; text-transform: uppercase; overflow-x: auto; }
.top nav a { text-decoration: none; color: var(--quiet); white-space: nowrap; padding: 6px 0; }
.top nav a:hover { color: var(--text); }
.hero { position: relative; min-height: min(86vh, 900px); display: flex; align-items: flex-end; overflow: hidden; }
.hero-plain { min-height: 46vh; background: radial-gradient(120% 90% at 80% 0%, color-mix(in srgb, var(--accent) 26%, transparent), transparent 60%); }
.hero-image { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: 50% 22%; }
.hero::after { content: ""; position: absolute; inset: 0; background: linear-gradient(to top, var(--bg) 4%, rgba(13, 13, 15, .55) 42%, rgba(13, 13, 15, .08) 78%); }
.hero-plain::after { display: none; }
.hero-text { position: relative; z-index: 1; padding: clamp(20px, 5vw, 64px); max-width: 1100px; }
.eyebrow { margin: 0 0 10px; color: var(--accent); font-size: 13px; letter-spacing: .16em; text-transform: uppercase; }
h1 { margin: 0; font-size: clamp(52px, 13vw, 168px); line-height: .9; letter-spacing: -.035em; text-transform: uppercase; font-weight: 800; overflow-wrap: anywhere; }
.tagline { margin: 18px 0 0; max-width: 38em; font-size: clamp(17px, 2vw, 22px); color: var(--text); }
.block { padding: clamp(40px, 7vw, 96px) clamp(16px, 4vw, 48px); max-width: 1240px; margin: 0 auto; border-top: 1px solid var(--line); }
h2 { margin: 0 0 24px; font-size: 13px; letter-spacing: .18em; text-transform: uppercase; color: var(--accent); font-weight: 600; }
.prose { max-width: 42em; font-size: clamp(18px, 2.1vw, 24px); line-height: 1.5; }
.prose p { margin: 0 0 1em; }
.quiet { color: var(--quiet); }
.pieces { display: grid; gap: clamp(28px, 5vw, 64px); }
.piece { display: grid; gap: 18px; grid-template-columns: minmax(0, 1fr); }
@media (min-width: 900px) { .piece { grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr); align-items: start; } }
.frame { display: block; width: 100%; padding: 0; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; background: #000; }
.frame video, .frame img { width: 100%; height: auto; max-height: 82vh; object-fit: contain; background: #000; }
.piece-text time { display: block; color: var(--quiet); font-size: 13px; letter-spacing: .1em; }
.piece-text h3 { margin: 4px 0 10px; font-size: clamp(24px, 3vw, 38px); line-height: 1.1; letter-spacing: -.01em; text-transform: uppercase; }
.piece-text p { margin: 0 0 .9em; color: #d9d6cf; }
.facts, .canon { margin: 18px 0 0; display: grid; gap: 0; border-top: 1px solid var(--line); }
.facts div, .canon div { display: grid; grid-template-columns: minmax(90px, 9em) minmax(0, 1fr); gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--line); font-size: 14px; }
dt { color: var(--quiet); letter-spacing: .08em; text-transform: uppercase; font-size: 12px; padding-top: 2px; }
dd { margin: 0; }
.looks { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr)); gap: 12px; }
.looks .zoom { aspect-ratio: 3 / 4; }
.zoom { cursor: zoom-in; padding: 0; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; background: var(--panel); }
.looks .zoom img { width: 100%; height: 100%; object-fit: cover; transition: transform .4s ease; }
.looks .zoom:hover img { transform: scale(1.03); }
pre { margin: 0 0 14px; padding: 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; max-width: 60em; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 8px; }
.button { display: inline-block; font: inherit; font-size: 13px; letter-spacing: .1em; text-transform: uppercase; padding: 10px 16px; border-radius: 4px; border: 1px solid var(--accent); background: var(--accent); color: #111; cursor: pointer; text-decoration: none; }
.button.ghost { background: transparent; color: var(--text); border-color: var(--line); }
.canon { max-width: 60em; }
.foot { padding: 32px clamp(16px, 4vw, 48px) 56px; border-top: 1px solid var(--line); color: var(--quiet); font-size: 14px; max-width: 1240px; margin: 0 auto; }
.foot p { margin: 0 0 6px; }
dialog { border: 0; padding: 0; background: transparent; max-width: 96vw; max-height: 96vh; }
dialog::backdrop { background: rgba(0, 0, 0, .88); }
dialog img { max-width: 96vw; max-height: 92vh; border-radius: 4px; }
.lightbox-close { position: fixed; top: 14px; right: 18px; width: 44px; height: 44px; border-radius: 50%; border: 1px solid var(--line); background: var(--panel); color: var(--text); font-size: 24px; cursor: pointer; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } .looks .zoom img { transition: none; } }
`;

const SCRIPT = `'use strict';
(function () {
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
  const mode = usage === 'open' ? 'open' : 'closed';
  return {
    slugSuggestion: slugOf(influencer.name),
    files: [
      { path: 'index.html', content: indexHtml({ influencer, images: shown, items: pieces, words, lang: language, about, usage: mode, accent }) },
      { path: 'assets/styles.css', content: STYLES },
      { path: 'assets/app.js', content: SCRIPT },
      { path: 'favicon.svg', content: faviconSvg(influencer.name, accent) },
      { path: 'canon.json', content: `${JSON.stringify(canonOf(influencer, { usage: mode, url: safeSource(url) }), null, 2)}\n` }
    ]
  };
}

module.exports = { buildSite, slugOf, safeSource, accentOf, MAX_ITEMS };
