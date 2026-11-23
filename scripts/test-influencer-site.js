'use strict';

// The page of an influencer (lib/influencer-site.js): the files of the static site, escaping, safe sources, the slug.

const assert = require('assert');
const site = require('../lib/influencer-site');

const influencer = {
  name: 'Nova <b>Ray</b>', tagline: 'Singt über "Tokens" & Tests', full: 'a woman with a silver bob', short: '', looks: 'chrome suit',
  face: '', never: 'a second Nova', credit: 'Nova by Kuble', style: '35mm film', voice: { voiceId: 'abc', name: 'N', description: 'dry alto' }
};

function fileOf(out, path) {
  const found = out.files.find((file) => file.path === path);
  assert.ok(found, `${path} is part of the site`);
  return found.content;
}

const out = site.buildSite({
  influencer,
  images: [{ path: 'assets/looks/1.jpg' }, { path: '../secret.jpg' }, { path: 'assets/looks/2.webp' }],
  items: [
    { id: 'a 1', kind: 'video', title: 'Film <one>', description: 'Line one\n\nLine two', src: 'assets/work/a1.mp4', poster: 'assets/work/a1.jpg', date: '2026-11-22T10:00:00Z', facts: [{ label: 'Song', value: 'Suno' }, { label: '', value: 'x' }] },
    { kind: 'image', title: 'bad', src: 'javascript:alert(1)' },
    { kind: 'image', title: 'remote', src: 'https://example.com/a.jpg' },
    { kind: 'audio', title: 'no', src: 'assets/work/a.mp3' },
    { kind: 'image', title: 'creds', src: 'https://user:pw@example.com/a.jpg' }
  ],
  lang: 'en', usage: 'open', about: 'About <her>', url: 'https://nova.host.example/'
});

assert.deepEqual(out.files.map((file) => file.path), ['index.html', 'assets/styles.css', 'assets/app.js', 'favicon.svg', 'canon.json']);
assert.equal(out.slugSuggestion, 'nova-b-ray-b');
const html = fileOf(out, 'index.html');
assert.ok(html.startsWith('<!DOCTYPE html>') && html.includes('<html lang="en">'));
// share previews need absolute addresses: the first look, resolved against the published address
assert.ok(html.includes('<meta property="og:image" content="https://nova.host.example/assets/looks/1.jpg">'));
assert.ok(html.includes('<meta name="twitter:image" content="https://nova.host.example/assets/looks/1.jpg">'));
assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'));
assert.ok(html.includes('<meta property="og:url" content="https://nova.host.example/">'));
{
  // without a published address a relative image would be useless: no image tags, a small card
  const local = fileOf(site.buildSite({ influencer: { name: 'Nova', full: 'x' }, images: [{ path: 'assets/looks/1.jpg' }] }), 'index.html');
  assert.ok(!local.includes('og:image') && !local.includes('twitter:image') && !local.includes('og:url'));
  assert.ok(local.includes('<meta name="twitter:card" content="summary">'));
  const noSlash = fileOf(site.buildSite({ influencer: { name: 'Nova', full: 'x' }, images: [{ path: 'assets/looks/1.jpg' }], url: 'https://nova.host.example' }), 'index.html');
  assert.ok(noSlash.includes('<meta property="og:image" content="https://nova.host.example/assets/looks/1.jpg">'));
}
assert.ok(html.includes('<meta name="viewport"') && html.includes('href="favicon.svg"'));
assert.ok(!/<b>Ray<\/b>|<one>|<her>|javascript:|secret\.jpg|user:pw|a\.mp3/.test(html), 'texts are escaped and unsafe sources are dropped');
assert.ok(html.includes('Nova &lt;b&gt;Ray&lt;/b&gt;') && html.includes('&quot;Tokens&quot; &amp; Tests'));
assert.ok(html.includes('src="assets/work/a1.mp4"') && html.includes('poster="assets/work/a1.jpg"') && html.includes('datetime="2026-11-22"'));
assert.ok(html.includes('https://example.com/a.jpg'), 'an https source is kept');
assert.equal((html.match(/<article /g) || []).length, 2, 'two valid pieces');
assert.ok(html.includes('<p>Line one</p>') && html.includes('<p>Line two</p>'));
assert.ok(html.includes('<dt>Song</dt><dd>Suno</dd>') && !html.includes('<dd>x</dd>'));
assert.ok(html.includes('2 pieces') && html.includes('2 looks'));
assert.ok(html.includes('AI-generated'), 'the page says that it is AI-generated');
assert.ok(html.includes('An open character'));
assert.ok(!html.includes('abc'), 'the voice id stays in the app');
const canon = JSON.parse(fileOf(out, 'canon.json'));
assert.equal(canon.name, influencer.name);
assert.equal(canon.usage, 'open-with-credit');
assert.equal(canon.ai_generated, true);
assert.equal(canon.identity.full, influencer.full);
assert.equal(canon.url, 'https://nova.host.example/');
assert.ok(!('short' in JSON.parse(JSON.stringify(canon.identity))), 'empty fields are left out');
assert.ok(fileOf(out, 'favicon.svg').includes('>N</text>'));

// defaults: German, closed, no images, no pieces
const plain = site.buildSite({ influencer: { name: 'Äna', full: 'x' } });
const plainHtml = fileOf(plain, 'index.html');
assert.ok(plainHtml.includes('<html lang="de">') && plainHtml.includes('hero-plain') && !plainHtml.includes('id="looks"'));
assert.ok(plainHtml.includes('Hier erscheinen bald die ersten Arbeiten.') && plainHtml.includes('Alle Rechte'));
assert.equal(JSON.parse(fileOf(plain, 'canon.json')).usage, 'all-rights-reserved');
assert.equal(plain.slugSuggestion, 'ana');
assert.equal(site.buildSite({ influencer: { name: 'Äna', full: 'x' }, lang: 'xx' }).files[0].content.includes('lang="de"'), true);

// the slug: 3 to 40 characters of a to z, digits and hyphens, or none
assert.equal(site.slugOf('Zoë Straße 2'), 'zoe-strasse-2');
assert.equal(site.slugOf('!!'), '');
assert.equal(site.slugOf('x'.repeat(80)).length, 40);
assert.equal(site.safeSource('assets/a/../b.jpg'), '');
assert.equal(site.safeSource('http://example.com/a.jpg'), '');
assert.equal(site.accentOf('Nova'), site.accentOf('Nova'));

// more pieces than the page holds
const many = site.buildSite({ influencer: { name: 'Max', full: 'x' }, items: Array.from({ length: site.MAX_ITEMS + 5 }, (_, at) => ({ kind: 'image', src: `assets/work/${at}.jpg` })) });
assert.equal((fileOf(many, 'index.html').match(/<article /g) || []).length, site.MAX_ITEMS);
assert.throws(() => site.buildSite({ influencer: { name: ' ' } }), TypeError);

// a film on YouTube is embedded by its id; anything that is not an id is dropped
for (const link of ['https://youtu.be/9kqGUuzK5_s', 'https://www.youtube.com/watch?v=9kqGUuzK5_s&t=4', 'https://youtube.com/shorts/9kqGUuzK5_s', 'https://www.youtube.com/embed/9kqGUuzK5_s', '9kqGUuzK5_s']) assert.equal(site.youtubeId(link), '9kqGUuzK5_s', link);
for (const link of ['http://youtu.be/9kqGUuzK5_s', 'https://example.com/watch?v=9kqGUuzK5_s', 'https://youtu.be/short', 'https://youtu.be/9kqGUuzK5_s"><script>', '', null]) assert.equal(site.youtubeId(link), '', String(link));
const tube = fileOf(site.buildSite({ influencer: { name: 'Nova', full: 'x' }, lang: 'en', items: [
  { id: 't1', kind: 'youtube', youtube: '9kqGUuzK5_s', title: 'Film' }, { id: 't2', kind: 'youtube', youtube: 'x"><script>' }, { id: 't3', kind: 'youtube', src: 'assets/work/a.mp4' }] }), 'index.html');
assert.equal((tube.match(/<article /g) || []).length, 1, 'only the piece with a real id is shown');
assert.ok(tube.includes('<iframe src="https://www.youtube-nocookie.com/embed/9kqGUuzK5_s?rel=0"') && tube.includes('referrerpolicy="strict-origin-when-cross-origin"') && tube.includes('1 piece'));

console.log('test-influencer-site.js: ok');
