'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const themes = require('../lib/music-video-hud/themes');
const graphicsLib = require('../lib/music-video-hud/graphics');
const composition = require('../lib/music-video-hud/composition');
const post = require('../lib/music-video-hud/postpass');
const plan = require('../lib/music-video-hud/plan');
const pageSandbox = require('./support/hud-page-sandbox');
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');

assert.deepEqual(themes.NAMES, ['hud', 'kuble', 'camcorder', 'zine']);
const theme = themes.get('zine');
assert.equal(theme.frame, 'zine');
assert.equal(theme.post.glitch, 'riso');
assert.deepEqual(theme.sizes, {}, 'the layout of HUD Blue: same faces, same sizes');
assert.equal(theme.faces.display, 'anton');
assert.match(plan.systemPrompt({ theme: 'zine' }), /photocopied fanzine.*riso/);
assert.match(plan.briefSystemPrompt({ theme: 'zine' }), /photocopied fanzine/);

// The pages of the older styles keep their bytes: the hashes are the ones test-music-video-hud-camcorder.js pinned before Zine existed, and the
// page of Camcorder must not carry the table of Zine.
const pinned = {
  'hud.off': '87b5c532b88e9fed459d9c1f6bfc5d14f63c4af1423dfd6115138bc0d94fad36',
  'hud.strong': 'baabdb2069db8edca86cc43236adfe8db391ebb3171754664620ec5da718e321',
  'kuble.off': '1b1744f703b4f8ae0c643a296602448243f11045c093583d7de47d4c6132703f',
  'kuble.strong': 'ad5aaecd1e69f274a97b399494ec64a4cb0955391f6ef53c6b57506d4d41accb'
};
for (const name of ['hud', 'kuble']) for (const effects of ['off', 'strong']) {
  const graphics = graphicsLib.prepareGraphics(graphicsLib.demoGraphics({ duration: 64 }), { theme: name }).graphics;
  assert.equal(hash(composition.buildChunkHtml({ graphics, chunk: { start: 24, duration: 12, clipSeconds: 12 }, options: { effects, karaoke: true } })), pinned[`${name}.${effects}`]);
}
const tapeGraphics = graphicsLib.prepareGraphics(graphicsLib.demoGraphics({ duration: 64 }), { theme: 'camcorder' }).graphics;
const tapeHtml = composition.buildChunkHtml({ graphics: tapeGraphics, chunk: { start: 24, duration: 12, clipSeconds: 12 }, options: { effects: 'strong' } });
assert.ok(!/zine/i.test(tapeHtml), 'no trace of Zine in a page of Camcorder');
// captured on origin/main before this change
assert.equal(hash(tapeHtml), 'f472a1aa62f5fb83e28757a74c48776ae6c848f1bc1c83a10a1c6873937d57c5');

const graphics = graphicsLib.prepareGraphics(graphicsLib.demoGraphics({ duration: 128.4 }), { theme: 'zine', accent: graphicsLib.DEFAULT_ACCENT }).graphics;
assert.equal(graphics.theme, 'zine');
assert.equal(graphics.accent, theme.accent);
for (const effects of ['off', 'subtle', 'strong', 'wild']) for (const chorus_words of ['off', 'on']) {
  const args = { graphics, chunk: { start: 64, duration: 12, clipSeconds: 12 }, options: { effects, chorus_words, karaoke: true } };
  const html = composition.buildChunkHtml(args);
  assert.equal(html, composition.buildChunkHtml(args));
  assert.ok(Buffer.byteLength(html) < composition.MAX_HTML_BYTES);
  assert.match(html, /data-theme="zine"/);
  assert.match(html, /id="l-zine"/);
  assert.match(html, /zine-stamp/);
  assert.ok(html.includes(`--paper:${theme.colors.paper}`) && html.includes(`--riso:${theme.colors.blue}`) && html.includes(`--acc:${theme.accent}`));
  assert.match(html, /#cam video\{filter:grayscale/);
  const runtime = pageSandbox(html);
  runtime.draw(1.5);
  assert.equal(runtime.elements['zine-time'].textContent, '1:05');
  assert.match(runtime.elements['zine-no'].textContent, /^N° \d\d+$/);
  const width = parseInt(runtime.elements['zine-fill'].style.width, 10);
  assert.equal(width, Math.round((65.5 / 128.4) * 1812 / 24) * 24);
  runtime.draw(11);
  assert.ok(parseInt(runtime.elements['zine-fill'].style.width, 10) > width, 'the row of dots fills');
  assert.equal(runtime.elements['zine-time'].textContent, '1:15');
  assert.equal(runtime.elements['l-hud'].innerHTML, '', 'the frame of HUD Blue is not drawn');
  assert.equal(runtime.elements.stage.className, '', 'the ink never turns dark');
  assert.ok(runtime.elements['l-dev'].innerHTML.length > 0);
  assert.ok(!/NaN|undefined/.test(runtime.elements['l-dev'].innerHTML + runtime.elements['l-kar'].innerHTML));
}

// the post-pass: grain and tags only, no colour glitch (the print look is in the page)
const tiny = graphicsLib.prepareGraphics({ duration: 2, cuts: [{ start: 0, end: 1, subject: 'center' }, { start: 1, end: 2, subject: 'center', transition: 'glitch' }] }, { theme: 'zine' }).graphics;
const built = post.buildPostArgs({ listFile: 'l', songFile: 's', outFile: 'o', graphics: tiny, params: { grain: 0.35 } });
assert.ok(!/rgbashift|maskedmerge|overlay=/.test(built.filter));
assert.match(built.filter, /noise=c0s=8:/);
assert.match(built.filter, /colorspace=bt709/);
console.log('test-music-video-hud-zine.js: ok');
