'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const themes = require('../lib/music-video-hud/themes');
const graphicsLib = require('../lib/music-video-hud/graphics');
const composition = require('../lib/music-video-hud/composition');
const post = require('../lib/music-video-hud/postpass');
const plan = require('../lib/music-video-hud/plan');
const pageSandbox = require('./support/hud-page-sandbox');
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');

assert.deepEqual(themes.NAMES, ['hud', 'kuble', 'camcorder']);
const theme = themes.get('camcorder');
assert.equal(theme.frame, 'camcorder');
assert.equal(theme.post.glitch, 'vhs');
assert.ok(theme.post.grain > themes.get('hud').post.grain);
assert.equal(theme.fx, null);
assert.equal(theme.faces.display, 'mono');
assert.match(plan.systemPrompt({ theme: 'camcorder' }), /consumer tape footage.*red REC/);
assert.match(plan.briefSystemPrompt({ theme: 'camcorder' }), /consumer tape footage/);

// Captured on origin/main before this change. Optional theme entries must not alter the inline scripts of legacy pages.
const pinned = {
  'hud.off': '87b5c532b88e9fed459d9c1f6bfc5d14f63c4af1423dfd6115138bc0d94fad36',
  'hud.strong': 'baabdb2069db8edca86cc43236adfe8db391ebb3171754664620ec5da718e321',
  'kuble.off': '1b1744f703b4f8ae0c643a296602448243f11045c093583d7de47d4c6132703f',
  'kuble.strong': 'ad5aaecd1e69f274a97b399494ec64a4cb0955391f6ef53c6b57506d4d41accb'
};
for (const name of ['hud', 'kuble']) for (const effects of ['off', 'strong']) {
  const graphics = graphicsLib.prepareGraphics(graphicsLib.demoGraphics({ duration: 64 }), { theme: name }).graphics;
  const args = { graphics, chunk: { start: 24, duration: 12, clipSeconds: 12 }, options: { effects, karaoke: true } };
  assert.equal(hash(composition.buildChunkHtml(args)), pinned[`${name}.${effects}`]);
  assert.equal(hash(composition.buildChunkHtml({ ...args, options: { ...args.options, chorus_words: 'off' } })), pinned[`${name}.${effects}`]);
}
const graphics = graphicsLib.prepareGraphics(graphicsLib.demoGraphics({ duration: 128.4 }), { theme: 'camcorder', accent: graphicsLib.DEFAULT_ACCENT }).graphics;
assert.equal(graphics.accent, theme.accent);
for (const effects of ['off', 'subtle', 'strong', 'wild']) {
  const args = { graphics, chunk: { start: 64, duration: 12, clipSeconds: 12 }, options: { effects, chorus_words: 'on' } };
  const html = composition.buildChunkHtml(args);
  assert.equal(html, composition.buildChunkHtml(args));
  assert.ok(Buffer.byteLength(html) < composition.MAX_HTML_BYTES);
  assert.match(html, /REC/);
  assert.match(html, /tape-power/);
  assert.match(html, /SP · 16:9/);
  assert.match(html, /JetBrains Mono/);
  assert.ok(html.includes(`--tape-ink:${theme.colors.ink}`));
  const runtime = pageSandbox(html);
  runtime.draw(1.5);
  assert.equal(runtime.elements['tape-time'].textContent, '00:01:05');
  assert.equal(runtime.elements['tape-date'].textContent, '01.01.1998  12:01:05');
  const dot = runtime.elements['tape-dot'].style.opacity;
  runtime.draw(1);
  assert.notEqual(runtime.elements['tape-dot'].style.opacity, dot);
  runtime.draw(1.5);
  assert.equal(runtime.elements['tape-dot'].style.opacity, dot);
  assert.equal(runtime.elements['l-hud'].innerHTML, '');
  assert.ok(!/NaN|undefined/.test(runtime.elements['l-dev'].innerHTML));
}

const tiny = graphicsLib.prepareGraphics({ duration: 2, cuts: [{ start: 0, end: 1, subject: 'center' }, { start: 1, end: 2, subject: 'center', transition: 'glitch' }] }, { theme: 'camcorder' }).graphics;
const args = { listFile: 'l', songFile: 's', outFile: 'o', graphics: tiny, params: { grain: 0.35 } };
const rich = post.buildPostArgs(args);
assert.ok(!rich.filter.includes('rgbashift') && !rich.filter.includes('maskedmerge'));
assert.match(rich.filter, /overlay=x='.*sin\(n/);
assert.match(rich.filter, /noise=c0s=7:/);
assert.match(rich.filter, /boxblur=.*chroma_radius=2/);
assert.match(rich.filter, /drawgrid=/);
const fallback = post.buildPostArgs({ ...args, availableFilters: new Set(['crop', 'overlay', 'scale', 'noise', 'vignette']) });
assert.ok(!fallback.filter.includes('boxblur') && !fallback.filter.includes('drawgrid'));
assert.match(fallback.filter, /overlay=/);
assert.ok(!post.buildPostArgs({ ...args, params: { grain: 0, glitch: 0 } }).filter.includes('overlay='));
// An extreme close-up leaves no safe tracking band: skip the disturbance rather than distorting the face.
const covered = { ...tiny, cuts: tiny.cuts.map((c) => ({ ...c, framing: 'ECU', crop: { scale: 4, x: 0.5, y: 0.5 } })) };
assert.ok(!post.buildPostArgs({ ...args, graphics: covered }).filter.includes('overlay='));

const binaries = require('../lib/ffmpeg').binaries();
if (binaries.available) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-tape-'));
  const run = (a) => { const r = spawnSync(binaries.ffmpeg, ['-nostdin', '-v', 'error', '-y', ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  try {
    const clip = path.join(dir, 'clip.mp4'), song = path.join(dir, 'song.wav'), list = path.join(dir, 'list.txt');
    run(['-f', 'lavfi', '-i', 'testsrc2=s=480x270:r=24', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', clip]);
    run(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', song]);
    fs.writeFileSync(list, post.concatListText([clip]));
    for (const availableFilters of [undefined, new Set()]) {
      const built = post.buildPostArgs({ ...args, availableFilters, listFile: list, songFile: song, outFile: path.join(dir, 'out.mp4') });
      run(built.args.slice(4));
      const probe = spawnSync(binaries.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path.join(dir, 'out.mp4')], { encoding: 'utf8' });
      assert.equal(probe.status, 0, probe.stderr);
      assert.deepEqual(post.verifyOutput(JSON.parse(probe.stdout), { frames: 48, seconds: 2 }), []);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
} else console.log('ffmpeg unavailable: encode check skipped');
console.log('test-music-video-hud-camcorder.js: ok');
