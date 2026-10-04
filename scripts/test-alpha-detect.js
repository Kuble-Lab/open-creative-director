'use strict';

// Transparency of stored images and uploads (WP33c): lib/alpha.js and the place where the store uses it. What is covered:
//   - the header of PNG (colour type 4 and 6, a tRNS chunk before the data, none after it) and of WebP (VP8X flag, VP8L bit, VP8), made
//     by hand, and the files that are no image: empty, cut off, another format under a PNG name, a missing file
//   - the pixels: an RGBA PNG in which every pixel is opaque is NOT marked, one with a single transparent or half transparent pixel is
//     (grey + alpha, palette with tRNS and the colour key of an RGB PNG too); without ffmpeg, or without its two filters, the header decides;
//     an ffmpeg that fails, hangs or prints nothing gives no mark
//   - the store: saveAsset, completeAsset, completeAssetFile (uploads, outputs of nodes, copies); a WebM with alpha is marked, an MP4, a JPEG
//     and a GIF cost no process at all (a counting wrapper in place of ffmpeg and ffprobe); `alpha: false` and `alpha: true` of a caller
//     are taken as they are; a failing ffmpeg does not stop the saving; existing entries are not touched
//   - the node view: the chequerboard on the image of a card, a thumbnail, the asset widget, the viewer, the picker; the Safari note only
//     for videos; the rules of the CSS (the chequerboard sits behind the picture, not in the margins of its frame)
// Local and free: no network, no provider. The parts with ffmpeg print SKIP when it is missing.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const alpha = require('../lib/alpha');
const ffmpeg = require('../lib/ffmpeg');
const store = require('../lib/store');
const assets = require('../lib/nodes/assets');
const { createEditHarness } = require('./support/edit-harness');
const { loadPage, FakeNode } = require('./support/fake-dom');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

/* ---------- files made by hand ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const BYTES_PER_PIXEL = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// A PNG of 8 bits per channel. `pixel(x, y)` returns the bytes of one pixel; `before` are chunks between IHDR and IDAT, `after` come
// behind the data; `trns` is a tRNS chunk written after the palette.
function png({ colorType, width = 4, height = 4, pixel, palette, trns, before = [], after = [] }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = [0];
    for (let x = 0; x < width; x += 1) row.push(...pixel(x, y));
    rows.push(Buffer.from(row));
  }
  assert.equal(rows[0].length, 1 + width * BYTES_PER_PIXEL[colorType]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...before,
    ...(palette ? [chunk('PLTE', Buffer.from(palette.flat()))] : []),
    ...(trns ? [chunk('tRNS', Buffer.from(trns))] : []),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    ...after,
    chunk('IEND')
  ]);
}

const rgba = (alphaAt) => png({ colorType: 6, pixel: (x, y) => [200, 30, 30, alphaAt(x, y)] });
const OPAQUE_RGBA = () => rgba(() => 255);
const ONE_CLEAR_PIXEL = () => rgba((x, y) => (x === 1 && y === 2 ? 0 : 255));
const ONE_FAINT_PIXEL = () => rgba((x, y) => (x === 3 && y === 3 ? 128 : 255));
const CLEAR_RGBA = () => rgba(() => 0);
const RGB = () => png({ colorType: 2, pixel: () => [10, 200, 10] });
const GREY = () => png({ colorType: 0, pixel: () => [128] });
const GREY_ALPHA = (alphaAt) => png({ colorType: 4, pixel: (x, y) => [128, alphaAt(x, y)] });
const PALETTE = (trns, index = () => 0) => png({ colorType: 3, palette: [[255, 0, 0], [0, 0, 255]], trns, pixel: (x, y) => [index(x, y)] });

// WebP: RIFF header and one chunk; only the first bytes matter to a header check
function webp(type, payload) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), (() => { const size = Buffer.alloc(4); size.writeUInt32LE(payload.length, 0); return size; })(), payload]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'ascii');
  return Buffer.concat([head, body]);
}
const vp8x = (flags) => webp('VP8X', Buffer.from([flags, 0, 0, 0, 3, 0, 0, 3, 0, 0]));
// VP8L: signature 0x2f, then width-1 (14 bits), height-1 (14 bits), alpha_is_used (1 bit), version (3 bits) as one little-endian number
const vp8l = (withAlpha) => {
  const bits = (7 | (7 << 14) | ((withAlpha ? 1 : 0) << 28)) >>> 0;
  const size = Buffer.alloc(4);
  size.writeUInt32LE(bits, 0);
  return webp('VP8L', Buffer.concat([Buffer.from([0x2f]), size, Buffer.alloc(8)]));
};
const vp8 = () => webp('VP8 ', Buffer.concat([Buffer.from([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 8, 0, 8, 0]), Buffer.alloc(16)]));

async function writeIn(dir, name, buffer) {
  const file = path.join(dir, name);
  await fsp.writeFile(file, buffer);
  return file;
}

/* ---------- the header ---------- */

async function testHeaders(dir) {
  const header = async (name, buffer, ext) => alpha.imageHeaderAlpha(await writeIn(dir, name, buffer), ext || path.extname(name));
  // PNG: the colour type
  assert.equal(await header('t6.png', OPAQUE_RGBA()), true, 'RGBA (colour type 6)');
  assert.equal(await header('t4.png', GREY_ALPHA(() => 255)), true, 'grey + alpha (colour type 4)');
  assert.equal(await header('t2.png', RGB()), false, 'RGB');
  assert.equal(await header('t0.png', GREY()), false, 'grey');
  assert.equal(await header('t3.png', PALETTE(null)), false, 'a palette without tRNS');
  // PNG: tRNS before the data
  assert.equal(await header('t3-trns.png', PALETTE([0, 255])), true, 'a palette with tRNS');
  assert.equal(await header('t2-trns.png', png({ colorType: 2, pixel: () => [10, 200, 10], trns: [0, 10, 0, 200, 0, 10] })), true, 'RGB with a colour key (tRNS)');
  assert.equal(await header('t0-trns.png', png({ colorType: 0, pixel: () => [128], trns: [0, 128] })), true, 'grey with a colour key (tRNS)');
  // other chunks in front are walked over, also a big profile
  const gamma = chunk('gAMA', Buffer.from([0, 1, 0x86, 0xa0]));
  const profile = chunk('iCCP', Buffer.alloc(120 * 1024, 7));
  assert.equal(await header('t3-late.png', png({ colorType: 3, palette: [[1, 2, 3]], trns: [0], pixel: () => [0], before: [gamma, profile] })), true, 'tRNS behind a gamma chunk and a 120 KB profile');
  assert.equal(await header('t2-chunks.png', png({ colorType: 2, pixel: () => [1, 2, 3], before: [gamma, profile] })), false, 'the same chunks without tRNS');
  // a tRNS chunk behind the data is not read by any decoder: no mark
  assert.equal(await header('t3-after.png', png({ colorType: 3, palette: [[1, 2, 3]], pixel: () => [0], after: [chunk('tRNS', Buffer.from([0]))] })), false, 'tRNS after IDAT');
  // not images, cut off, missing
  assert.equal(await header('empty.png', Buffer.alloc(0)), false, 'an empty file');
  assert.equal(await header('cut.png', OPAQUE_RGBA().subarray(0, 20)), false, 'cut off inside IHDR');
  assert.equal(await header('cut2.png', png({ colorType: 3, palette: [[1, 2, 3]], pixel: () => [0], before: [gamma] }).subarray(0, 60)), false, 'cut off between chunks');
  assert.equal(await header('jpeg.png', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)])), false, 'a JPEG under a PNG name');
  assert.equal(await header('text.png', Buffer.from('not an image at all, just text that is long enough to read')), false, 'text under a PNG name');
  assert.equal(await header('t6.jpg', OPAQUE_RGBA()), false, 'the extension decides which header is read: JPEG never');
  assert.equal(await header('t6.gif', OPAQUE_RGBA()), false, 'GIF is not looked at');
  assert.equal(await alpha.imageHeaderAlpha(path.join(dir, 'does-not-exist.png'), '.png'), false, 'a missing file');
  assert.equal(await alpha.imageHeaderAlpha(dir, '.png'), false, 'a folder');
  // a chain of chunks that never ends in IDAT stops
  const endless = png({ colorType: 3, palette: [[1, 2, 3]], pixel: () => [0], before: Array.from({ length: 100 }, () => chunk('tEXt', Buffer.from('a\0b'))), trns: [0] });
  assert.equal(await header('endless.png', endless), false, 'more than 64 chunks before the data is not a normal file');

  // WebP
  assert.equal(await header('x-alpha.webp', vp8x(0x10)), true, 'VP8X with the alpha flag');
  assert.equal(await header('x-alpha-more.webp', vp8x(0x10 | 0x02 | 0x20)), true, 'VP8X with alpha and other flags');
  assert.equal(await header('x-plain.webp', vp8x(0x00)), false, 'VP8X without flags');
  assert.equal(await header('x-anim.webp', vp8x(0x02)), false, 'VP8X, animation flag only');
  assert.equal(await header('l-alpha.webp', vp8l(true)), true, 'VP8L with the alpha bit');
  assert.equal(await header('l-plain.webp', vp8l(false)), false, 'VP8L without it');
  assert.equal(await header('lossy.webp', vp8()), false, 'lossy VP8');
  assert.equal(await header('cut.webp', vp8x(0x10).subarray(0, 18)), false, 'cut off');
  assert.equal(await header('bad.webp', Buffer.from('RIFFxxxxWAVEfmt ' + 'x'.repeat(40))), false, 'RIFF but no WebP');
  assert.equal(await header('x-alpha.png', vp8x(0x10)), false, 'a WebP under a PNG name is no PNG');
  assert.equal(await header('x-alpha.jpg', vp8x(0x10)), false, 'not looked at by name');
  assert.ok(alpha.isCandidateExtension('.PNG') && alpha.isCandidateExtension('.webm') && alpha.isCandidateExtension('.mkv') && alpha.isCandidateExtension('.mov'));
  assert.ok(!alpha.isCandidateExtension('.mp4') && !alpha.isCandidateExtension('.jpg') && !alpha.isCandidateExtension('.jpeg') && !alpha.isCandidateExtension('.gif') && !alpha.isCandidateExtension('.wav') && !alpha.isCandidateExtension(''));
}

/* ---------- wrappers in place of ffmpeg and ffprobe ---------- */

// A shell script in place of a binary. `log` receives one line of the arguments per call. `mode`: 'count' passes every call to the real
// binary; 'fail' passes only the lists of filters / codecs (what the checks before a run read) and exits 1 otherwise; 'silent' passes the
// lists and exits 0 with no output otherwise; 'hang' passes the lists and sleeps otherwise.
async function makeWrapper(dir, name, real, { log, mode = 'count' }) {
  const file = path.join(dir, name);
  const lines = ['#!/bin/sh', `echo "$*" >> "${log}"`];
  if (mode !== 'count') {
    lines.push('case "$*" in', '  *-filters*|*-decoders*|*-encoders*) ;;');
    lines.push(mode === 'fail' ? '  *) exit 1 ;;' : mode === 'silent' ? '  *) exit 0 ;;' : '  *) exec sleep 10 ;;');
    lines.push('esac');
  }
  lines.push(`exec "${real}" "$@"`, '');
  await fsp.writeFile(file, lines.join('\n'), 'utf8');
  await fsp.chmod(file, 0o755);
  return file;
}

async function withEnv(vars, fn) {
  const before = {};
  for (const [key, value] of Object.entries(vars)) {
    before[key] = process.env[key];
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// A real animated WebP of two frames; the first is half transparent (the header has the alpha and the animation flag).
const ANIMATED_WEBP_BASE64 = 'UklGRoQAAABXRUJQVlA4WAoAAAASAAAACAAABgAAQU5JTQYAAAAAAAAAAABBTk1GKAAAAAAAAAAAAAgAAAYAAAAAAAJWUDhMDwAAAC8IgAEQBxD9jwIGIqL/AQBBTk1GKAAAAAAAAAAAAAgAAAYAAAAAAABWUDhMDwAAAC8IgAEABxDR//4HIqL/AQA=';

const callsOf = async (log) => (await fsp.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);

/* ---------- the pixels ---------- */

async function testPixels(dir) {
  const real = ffmpeg.binaries();
  const filters = real.ffmpeg && ffmpeg.hasFilter('alphaextract') && ffmpeg.hasFilter('signalstats');
  const detect = async (name, buffer) => alpha.detectAlpha(await writeIn(dir, name, buffer), '.png');

  // without ffmpeg (or without the two filters) the header alone counts
  await withEnv({ FFMPEG_PATH: path.join(dir, 'no-such-ffmpeg'), FFPROBE_PATH: path.join(dir, 'no-such-ffprobe') }, async () => {
    assert.equal(ffmpeg.binaries().ffmpeg, null, 'the wrapper hides ffmpeg');
    assert.equal(await detect('h-opaque.png', OPAQUE_RGBA()), true, 'no ffmpeg: an RGBA PNG counts by its header');
    assert.equal(await detect('h-rgb.png', RGB()), false, 'no ffmpeg: RGB has no header alpha');
    assert.equal(await alpha.detectAlpha(await writeIn(dir, 'h-alpha.webp', vp8x(0x10)), '.webp'), true, 'no ffmpeg: WebP by its header');
    assert.equal(await alpha.detectAlpha(await writeIn(dir, 'h-plain.webp', vp8l(false)), '.webp'), false);
    assert.equal(await alpha.detectAlpha(await writeIn(dir, 'h-anim.webp', vp8x(0x12)), '.webp'), true, 'no ffmpeg: an animated WebP with alpha by its header');
    assert.equal(await alpha.detectAlpha(await writeIn(dir, 'v.webm', Buffer.alloc(64)), '.webm'), false, 'no ffprobe: no mark for a video');
  });

  // an animated WebP (a real file, first frame half transparent): ffmpeg cannot decode it, so the header decides, with or without ffmpeg
  const animated = await writeIn(dir, 'real-anim.webp', Buffer.from(ANIMATED_WEBP_BASE64, 'base64'));
  assert.equal(await alpha.imageIsAnimatedWebp(animated, '.webp'), true);
  assert.equal(await alpha.detectAlpha(animated, '.webp'), true, 'an animated WebP with alpha is marked also when ffmpeg is there');
  assert.equal(await alpha.imageIsAnimatedWebp(await writeIn(dir, 'still.webp', vp8x(0x10)), '.webp'), false, 'a still WebP is not animated');
  assert.equal(await alpha.detectAlpha(await writeIn(dir, 'anim-plain.webp', vp8x(0x02)), '.webp'), false, 'an animated WebP without the alpha flag is not marked');

  if (!filters) {
    console.log('SKIP no ffmpeg with the filters alphaextract and signalstats: the pixel checks were not run');
    return;
  }
  // an RGBA PNG in which every pixel is opaque: the header says alpha, the pixels say no
  assert.equal(await alpha.imageHeaderAlpha(await writeIn(dir, 'p-opaque.png', OPAQUE_RGBA()), '.png'), true);
  assert.equal(await detect('p-opaque.png', OPAQUE_RGBA()), false, 'RGBA without a transparent pixel is not marked');
  assert.equal(await detect('p-one.png', ONE_CLEAR_PIXEL()), true, 'one transparent pixel is enough');
  assert.equal(await detect('p-faint.png', ONE_FAINT_PIXEL()), true, 'one half transparent pixel is enough');
  assert.equal(await detect('p-clear.png', CLEAR_RGBA()), true, 'fully transparent');
  assert.equal(await detect('p-rgb.png', RGB()), false, 'RGB');
  assert.equal(await detect('p-grey-opaque.png', GREY_ALPHA(() => 255)), false, 'grey + alpha, all opaque');
  assert.equal(await detect('p-grey-clear.png', GREY_ALPHA((x) => (x === 0 ? 0 : 255))), true, 'grey + alpha with a transparent column');
  assert.equal(await detect('p-pal-opaque.png', PALETTE([255, 255])), false, 'a palette with tRNS that is opaque');
  assert.equal(await detect('p-pal-unused.png', PALETTE([255, 0], () => 0)), false, 'a transparent palette entry that no pixel uses');
  assert.equal(await detect('p-pal-used.png', PALETTE([255, 0], (x) => (x === 0 ? 1 : 0))), true, 'a transparent palette entry that is used');
  assert.equal(await detect('p-key.png', png({ colorType: 2, pixel: (x) => (x === 0 ? [10, 200, 10] : [1, 2, 3]), trns: [0, 10, 0, 200, 0, 10] })), true, 'the colour key of an RGB PNG is used');
  assert.equal(await detect('p-key-unused.png', png({ colorType: 2, pixel: () => [1, 2, 3], trns: [0, 10, 0, 200, 0, 10] })), false, 'a colour key no pixel has');
  // a PNG with the wrong data after a good header is no mark (ffmpeg cannot read it) and never an error
  assert.equal(await detect('p-broken.png', Buffer.concat([OPAQUE_RGBA().subarray(0, 50), Buffer.alloc(30, 1)])), false, 'unreadable pixels');

  // an ffmpeg that fails, says nothing or hangs: no mark, the header is not trusted then
  const log = path.join(dir, 'calls.log');
  const run = async (mode, fn) => {
    await fsp.rm(log, { force: true });
    const wrapper = await makeWrapper(dir, `ffmpeg-${mode}`, real.ffmpeg, { log, mode });
    return withEnv({ FFMPEG_PATH: wrapper }, () => fn(wrapper));
  };
  await run('fail', async () => assert.equal(await detect('f-clear.png', CLEAR_RGBA()), false, 'a failing ffmpeg: no mark'));
  await run('silent', async () => assert.equal(await detect('s-clear.png', CLEAR_RGBA()), false, 'an ffmpeg that prints no number: no mark'));
  await run('hang', async (wrapper) => {
    const file = await writeIn(dir, 'h-clear.png', CLEAR_RGBA());
    const started = Date.now();
    assert.equal(await alpha.imageHasTransparentPixel(file, { ffmpegPath: wrapper, timeoutMs: 300 }), null, 'a hang ends at the time limit with "cannot tell"');
    assert.ok(Date.now() - started < 5000, 'quickly');
  });
  assert.equal(await alpha.imageHasTransparentPixel(path.join(dir, 'gone.png'), { ffmpegPath: real.ffmpeg }), null, 'a missing file: cannot tell');
  // one check is one call after the lists
  await run('count', async () => {
    assert.equal(await detect('c-clear.png', CLEAR_RGBA()), true);
    const calls = await callsOf(log);
    assert.equal(calls.filter((line) => /alphaextract/.test(line)).length, 1, `one call for the pixels: ${calls.join(' | ')}`);
    assert.ok(calls.filter((line) => !/-filters|-decoders|-encoders/.test(line)).length === 1, 'nothing else than the lists and that call');
  });
  // no header alpha: no process at all
  await run('count', async () => {
    assert.equal(await detect('n-rgb.png', RGB()), false);
    assert.equal(await alpha.detectAlpha(await writeIn(dir, 'n.jpg', Buffer.from([0xff, 0xd8, 0xff])), '.jpg'), false);
    assert.equal(await alpha.detectAlpha(await writeIn(dir, 'n.mp4', Buffer.alloc(64)), '.mp4'), false);
    assert.deepEqual(await callsOf(log), [], 'no header alpha, no process');
  });
}

/* ---------- the store ---------- */

async function testStore(dir) {
  const real = ffmpeg.binaries();
  if (!real.available) {
    console.log('SKIP ffmpeg is missing: the checks of the store were not run');
    return;
  }
  const h = await createEditHarness({ prefix: 'ocd-alpha-store-' });
  const h2 = await createEditHarness({ prefix: 'ocd-alpha-store2-' });
  try {
    const log = path.join(dir, 'store-calls.log');
    const ffmpegWrapper = await makeWrapper(dir, 'store-ffmpeg', real.ffmpeg, { log });
    const ffprobeWrapper = await makeWrapper(dir, 'store-ffprobe', real.ffprobe, { log });
    const counting = (fn) => withEnv({ FFMPEG_PATH: ffmpegWrapper, FFPROBE_PATH: ffprobeWrapper }, fn);
    const ledgerEntry = async (sessionId, id) => (await store.readLedger(sessionId)).find((entry) => entry.id === id);
    const reset = () => fsp.rm(log, { force: true });
    const filters = ffmpeg.hasFilter('alphaextract') && ffmpeg.hasFilter('signalstats');

    // saveAsset (generated images, chat tools, uploads of the chat)
    await counting(async () => {
      for (const [kind, ext, buffer, expected, what] of [
        ['image', '.png', CLEAR_RGBA(), true, 'a generated PNG with transparency'],
        ['upload', '.png', ONE_CLEAR_PIXEL(), true, 'an uploaded PNG with transparency'],
        ['image', '.png', OPAQUE_RGBA(), filters ? false : true, 'an RGBA PNG without a transparent pixel'],
        ['image', '.png', RGB(), false, 'an RGB PNG'],
        ['image', '.webp', vp8(), false, 'a lossy WebP']
      ]) {
        const saved = await store.saveAsset(h.sessionId, { kind, buffer, ext, prompt: what });
        assert.equal(saved.alpha === true, expected, `saveAsset: ${what}`);
        assert.equal((await ledgerEntry(h.sessionId, saved.id)).alpha === true, expected, `the ledger agrees: ${what}`);
        assert.equal((await assets.valueFromAsset(h.sessionId, saved.id)).alpha === true, expected, `the value agrees: ${what}`);
      }
      // a WebP of which only the header exists: ffmpeg cannot read its pixels, so with ffmpeg and the filters there is no mark; without them the header counts
      const header = await store.saveAsset(h.sessionId, { kind: 'image', buffer: vp8x(0x10), ext: '.webp', prompt: 'webp header only' });
      assert.equal(header.alpha === true, !filters, 'a WebP header that ffmpeg cannot back up with pixels');
      const animatedSaved = await store.saveAsset(h.sessionId, { kind: 'image', buffer: Buffer.from(ANIMATED_WEBP_BASE64, 'base64'), ext: '.webp', prompt: 'animated webp' });
      assert.equal(animatedSaved.alpha, true, 'an animated WebP with alpha is marked');
      // a JPEG and a GIF cost no process
      await reset();
      const jpeg = await store.saveAsset(h.sessionId, { kind: 'image', buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]), ext: '.jpg', prompt: 'jpeg' });
      const gif = await store.saveAsset(h.sessionId, { kind: 'upload', buffer: Buffer.from('GIF89a' + 'x'.repeat(50)), ext: '.gif', prompt: 'gif' });
      assert.equal(jpeg.alpha, undefined);
      assert.equal(gif.alpha, undefined);
      assert.deepEqual(await callsOf(log), [], 'JPEG and GIF: no process');
    });

    // completeAsset (a reserved asset that gets its bytes)
    const reserved = await store.reserveAsset(h.sessionId, { kind: 'image', ext: '.png', prompt: 'reserved' });
    const completed = await store.completeAsset(h.sessionId, reserved.id, CLEAR_RGBA(), 0.01);
    assert.equal(completed.alpha, true, 'completeAsset marks a transparent PNG');
    assert.equal(completed.pending, undefined);
    assert.equal(completed.cost, 0.01, 'the other fields are as they were');
    const reservedPlain = await store.reserveAsset(h.sessionId, { kind: 'image', ext: '.png', prompt: 'reserved plain' });
    assert.equal((await store.completeAsset(h.sessionId, reservedPlain.id, RGB(), 0)).alpha, undefined);

    // uploads, outputs and copies (the node view): completeAssetFile
    const scratchFile = async (sessionId, name, buffer) => {
      const scratch = await assets.createScratchDir(sessionId);
      const file = path.join(scratch, name);
      await fsp.writeFile(file, buffer);
      return { scratch, file };
    };
    const upload = async (name, ext, buffer) => {
      const { scratch, file } = await scratchFile(h.sessionId, name, buffer);
      try {
        return await assets.saveUploadFile(h.sessionId, { sourceFile: file, ext, name });
      } finally {
        await assets.removeScratchDir(scratch);
      }
    };
    const output = async (options, name, buffer) => {
      const { scratch, file } = await scratchFile(h.sessionId, name, buffer);
      try {
        return await assets.saveOutputFile(h.sessionId, { sourceFile: file, ...options });
      } finally {
        await assets.removeScratchDir(scratch);
      }
    };
    assert.equal((await upload('clear.png', '.png', CLEAR_RGBA())).alpha, true, 'an uploaded PNG with transparency is marked');
    assert.equal((await upload('plain.png', '.png', RGB())).alpha, undefined, 'an uploaded RGB PNG is not');
    assert.equal((await output({ kind: 'image', ext: '.png', prompt: 'op' }, 'op.png', ONE_CLEAR_PIXEL())).alpha, true, 'the PNG of an op is looked at too (alpha left out)');

    // the caller has looked: true and false are taken as they are, nobody looks again
    await counting(async () => {
      await reset();
      const no = await output({ kind: 'image', ext: '.png', alpha: false }, 'a.png', CLEAR_RGBA());
      assert.equal(no.alpha, undefined, 'alpha: false is final');
      assert.deepEqual(await callsOf(log), [], 'and costs no process');
      const yes = await output({ kind: 'image', ext: '.png', alpha: true }, 'b.png', RGB());
      assert.equal(yes.alpha, true, 'alpha: true is final');
      assert.deepEqual(await callsOf(log), [], 'and costs no process');
      const video = await output({ kind: 'video', ext: '.webm', alpha: false }, 'c.webm', Buffer.alloc(64));
      assert.equal(video.alpha, undefined);
      assert.deepEqual(await callsOf(log), [], 'a video that the caller probed is not probed again');
    });

    // an MP4 is never probed, whatever it holds
    await counting(async () => {
      await reset();
      const mp4 = await upload('clip.mp4', '.mp4', Buffer.alloc(2048, 3));
      assert.equal(mp4.alpha, undefined);
      assert.equal((await output({ kind: 'video', ext: '.mp4' }, 'o.mp4', Buffer.alloc(512, 1))).alpha, undefined);
      assert.deepEqual(await callsOf(log), [], 'MP4: no probe');
      // a WebM goes to ffprobe once (a file ffprobe cannot read: no mark, saved all the same)
      const broken = await upload('broken.webm', '.webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]));
      assert.equal(broken.alpha, undefined);
      assert.equal((await ledgerEntry(h.sessionId, broken.assetId)).file, `${broken.assetId}.webm`, 'saved');
      assert.ok(fs.existsSync(assets.assetFilePath(broken)), 'the file is there');
      const calls = await callsOf(log);
      assert.equal(calls.length, 1, `one ffprobe call: ${calls.join(' | ')}`);
      assert.match(calls[0], /-show_streams/);
    });

    // a WebM with alpha (needs libvpx-vp9): marked by the upload
    if (ffmpeg.hasEncoder('libvpx-vp9')) {
      await h.ff(['-f', 'lavfi', '-i', 'color=c=red@0.5:s=64x64:r=5:d=1,format=yuva420p', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', '40', '-deadline', 'good', '-cpu-used', '5', h.src('alpha.webm')]);
      await h.ff(['-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=5:d=1', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '0', '-crf', '40', '-deadline', 'good', '-cpu-used', '5', h.src('plain.webm')]);
      const withAlpha = await upload('alpha.webm', '.webm', await fsp.readFile(h.src('alpha.webm')));
      assert.equal(withAlpha.alpha, true, 'an uploaded WebM with alpha is marked');
      assert.equal((await upload('plain.webm', '.webm', await fsp.readFile(h.src('plain.webm')))).alpha, undefined, 'a WebM without alpha is not');
      // a copy keeps the mark without a second look
      await counting(async () => {
        await reset();
        const copied = await assets.copyAsset(h.sessionId, withAlpha.assetId, h2.sessionId);
        assert.equal(copied.alpha, true, 'a copy of a marked asset is marked');
        assert.deepEqual(await callsOf(log), [], 'and nobody looked again');
      });
    } else {
      console.log('SKIP the ffmpeg has no libvpx-vp9: the upload of a WebM with alpha was not run');
    }
    // a copy of an unmarked asset is looked at again (it may be an old asset)
    const oldPng = await store.saveAsset(h.sessionId, { kind: 'image', buffer: CLEAR_RGBA(), ext: '.png', prompt: 'to be unmarked' });
    await store.writeLedger(h.sessionId, (await store.readLedger(h.sessionId)).map((entry) => {
      if (entry.id !== oldPng.id) return entry;
      const { alpha: _gone, ...rest } = entry;
      return rest;
    }));
    assert.equal((await assets.valueFromAsset(h.sessionId, oldPng.id)).alpha, undefined, 'an existing asset without a mark stays without (no migration)');
    assert.equal((await assets.copyAsset(h.sessionId, oldPng.id, h2.sessionId)).alpha, true, 'its copy is looked at once');

    // a failing ffmpeg does not stop the saving
    for (const mode of ['fail', 'silent']) {
      const wrapper = await makeWrapper(dir, `store-${mode}`, real.ffmpeg, { log, mode });
      await withEnv({ FFMPEG_PATH: wrapper }, async () => {
        if (!filters) return;
        const saved = await store.saveAsset(h.sessionId, { kind: 'image', buffer: CLEAR_RGBA(), ext: '.png', prompt: mode });
        assert.equal(saved.alpha, undefined, `${mode}: no mark`);
        assert.ok(fs.existsSync(path.join(store.sessionAssetDir(h.sessionId), saved.file)), `${mode}: the file is stored`);
        assert.equal((await ledgerEntry(h.sessionId, saved.id)).prompt, mode, `${mode}: the ledger entry is there`);
      });
    }
    // without ffmpeg at all: the header counts for an image and the saving goes through
    await withEnv({ FFMPEG_PATH: path.join(dir, 'none'), FFPROBE_PATH: path.join(dir, 'none') }, async () => {
      assert.equal((await store.saveAsset(h.sessionId, { kind: 'image', buffer: OPAQUE_RGBA(), ext: '.png', prompt: 'no ffmpeg' })).alpha, true, 'no ffmpeg: the header counts');
      assert.equal((await upload('quiet.webm', '.webm', Buffer.alloc(64, 9))).alpha, undefined, 'no ffprobe: no mark for a video');
    });

    // two writes at once: the second ledger write of the mark does not lose the other entries
    const many = await Promise.all(Array.from({ length: 6 }, (_, index) => store.saveAsset(h.sessionId, { kind: 'image', buffer: index % 2 ? CLEAR_RGBA() : RGB(), ext: '.png', prompt: `race ${index}` })));
    const ledger = await store.readLedger(h.sessionId);
    for (const [index, saved] of many.entries()) {
      const entry = ledger.find((item) => item.id === saved.id);
      assert.ok(entry, `entry ${index} is in the ledger`);
      assert.equal(entry.alpha === true, index % 2 === 1, `entry ${index}: the mark is right`);
    }
    assert.equal(new Set(ledger.map((entry) => entry.id)).size, ledger.length, 'no id twice');
  } finally {
    await h.cleanup();
    await h2.cleanup();
  }
}

/* ---------- the node view ---------- */

function testPreview() {
  const css = read('public/nodes/nodes.css');
  const image = { type: 'image', assetId: 'img-1', sessionId: 'sess-1', file: 'img-1.png', url: '/assets/sess-1/img-1.png', alpha: true };
  const plain = { ...image, assetId: 'img-2', alpha: undefined };
  const video = { type: 'video', assetId: 'vid-1', sessionId: 'sess-1', file: 'vid-1.webm', url: '/assets/sess-1/vid-1.webm', alpha: true };
  const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  for (const lang of ['de', 'en', 'es']) {
    for (const [agent, inSafari] of [[chrome, false], [safari, true]]) {
      const page = loadPage(lang, { userAgent: agent });
      const { preview, ui } = page.OCD;
      // card
      assert.equal(preview.mediaNode(image).classList.contains('nv-alpha'), true, `${lang}: the card image`);
      assert.equal(preview.mediaNode(plain).classList.contains('nv-alpha'), false);
      // thumbnail (the chequerboard is on the tile, which the picture fills)
      assert.equal(preview.thumb(image).classList.contains('nv-alpha'), true, `${lang}: the thumbnail of an image`);
      assert.equal(preview.thumb(plain).classList.contains('nv-alpha'), false);
      // the asset widget of a node (upload field)
      assert.equal(ui.mediaElement(image).classList.contains('nv-alpha'), true, `${lang}: the asset widget image`);
      assert.equal(ui.mediaElement(video).classList.contains('nv-alpha'), true, `${lang}: the asset widget video`);
      assert.equal(ui.mediaElement(plain).classList.contains('nv-alpha'), false);
      assert.equal(ui.mediaElement({ ...plain, type: 'video', file: 'x.mp4', url: '/assets/sess-1/x.mp4' }).classList.contains('nv-alpha'), false);
      // the card with an image: the chequerboard, never the Safari note (Safari shows images with alpha right)
      const card = new FakeNode('div');
      preview.renderCardPreview(card, [{ port: 'image', value: image }], {});
      assert.equal(card.find((item) => item.classes.has('nv-alpha')).length, 1, `${lang}: one picture with the chequerboard`);
      assert.equal(card.find((item) => item.classes.has('nv-alpha-hint')).length, 0, `${lang}: no Safari note for an image, also in Safari`);
      assert.equal(preview.alphaHint(image), null, 'no note for an image');
      assert.equal(Boolean(preview.alphaHint(video)), inSafari, 'the note stays with videos in Safari');
      assert.equal(preview.alphaHint({ ...video, file: 'vid-2.mov', url: '/assets/sess-1/vid-2.mov' }), null, `${lang}: no WebM note for a MOV with alpha`);
      assert.equal(preview.alphaHint({ ...video, file: undefined, url: '/assets/sess-1/vid-3.mkv' }), null, 'nor for an MKV');
      // a list of results: the thumbnails
      const grid = new FakeNode('div');
      preview.renderCardPreview(grid, [{ port: 'images', value: { type: 'list', items: [image, plain] } }], {});
      assert.equal(grid.find((item) => item.classes.has('nv-alpha')).length, 1, `${lang}: only the marked image of a list`);
    }
  }
  const viewerSource = read('public/nodes/preview.js');
  assert.match(viewerSource, /class: `nv-viewer-img\$\{alphaClass\(value\)\}`/, 'the large view marks the image');
  assert.match(read('public/nodes/asset-picker.js'), /alpha: entry\.alpha === true/, 'chat assets of the picker carry the mark');
  assert.match(read('public/nodes/asset-picker.js'), /alpha: value\.alpha === true/, 'the assets of the workflow carry the mark');
  assert.match(read('public/nodes/asset-picker.js'), /item\.alpha === true \? 'nv-alpha' : null/, 'the tile of the picker puts the class on the picture');

  // the rules of the CSS
  // the declarations of every rule that names the selector, put together
  const rule = (selector) => {
    const found = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((block) => block.split('{')).filter(([head, body]) => body !== undefined && head.split(',').map((part) => part.trim()).includes(selector));
    assert.ok(found.length, `a rule for ${selector}`);
    return found.map(([, body]) => body).join(';');
  };
  const checker = css.match(/((?:[^{}]*\.nv-alpha[^{}]*,\s*)*[^{}]*\.nv-alpha[^{}]*)\{[^}]*linear-gradient/)[1];
  for (const selector of ['.nv-thumb.nv-alpha', '.nv-viewer-img.nv-alpha', '.nv-viewer-video.nv-alpha', '.nv-ap-thumb .nv-alpha', '.nv-appleaf-frame .nv-media.nv-alpha']) {
    assert.ok(checker.includes(selector), `the chequerboard rule names ${selector}`);
  }
  // not in the margins of the frame: a media element with alpha has the shape of its picture (auto size, a maximum, centred) ...
  for (const selector of ['.nv-media.nv-alpha', '.nv-appleaf-frame .nv-media.nv-alpha']) {
    const body = rule(selector);
    assert.match(body, /width:\s*auto/, `${selector}: automatic width`);
    assert.match(body, /height:\s*auto/, `${selector}: automatic height`);
    assert.match(body, /max-width:\s*100%/, `${selector}: no wider than the frame`);
    assert.match(body, /margin-inline:\s*auto/, `${selector}: centred`);
  }
  // ... also in the grid of the app view and in the square tile of the picker; a filled grid cell (cover) keeps the cell
  assert.match(rule('.nv-appout-body.is-grid .nv-appleaf-frame .nv-media.nv-alpha'), /aspect-ratio:\s*auto/);
  assert.match(rule('.nv-ap-thumb .nv-alpha'), /width:\s*auto[^}]*height:\s*auto[^}]*max-width:\s*100%[^}]*max-height:\s*100%/);
  // the tile of the picker is a grid with one cell of its own size, so that a tall picture (a 9:16 cutout) is cut to the tile and not as high as it is
  assert.match(rule('.nv-ap-thumb'), /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
  assert.match(rule('.nv-ap-thumb'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(rule('.nv-asset-preview.is-grid .nv-media.nv-alpha'), /width:\s*100%/);
  // weight: `.nv-appleaf-frame .nv-media.nv-alpha` (three classes) beats `.nv-appleaf-frame .nv-media` (two) whatever the order in the file
}

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-alpha-detect-'));
  try {
    await testHeaders(dir);
    await testPixels(dir);
    await testStore(dir);
    testPreview();
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
  console.log('test-alpha-detect.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
