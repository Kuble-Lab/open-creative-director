'use strict';

const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const ffmpeg = require('../lib/ffmpeg');
const { preparePhoto, dateHeader } = require('../lib/event-video/photos');
const { readExif } = require('../lib/event-video/exif');
const assets = require('../lib/nodes/assets');
const routes = require('../lib/nodes/routes');

async function main() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'event-heic-test-'));
  try {
    const date = '2026-03-12T18:04:00+02:00';
    const file = path.join(scratch, 'phone.heic');
    // A TIFF item beyond the first read block, crossing a boundary, exercises bounded HEIF metadata scanning.
    const exif = dateHeader(date).subarray(10);
    await fs.writeFile(file, Buffer.concat([Buffer.alloc(256 * 1024 - 2), exif]));
    assert.equal((await readExif(file)).taken_at, date);
    const exact = path.join(scratch, 'exact.heif');
    await fs.writeFile(exact, Buffer.concat([Buffer.alloc(256 * 1024 - exif.length), exif]));
    assert.equal((await readExif(exact)).taken_at, date, 'Metadata at EOF of an exact read block is preserved');
    const calls = [];
    const mock = async (command, args, options) => {
      calls.push({ command, args, options });
      assert.equal(options.timeoutMs, 60000);
      assert.ok(Array.isArray(args));
      if (calls.length <= 2) throw new Error('Decoder unavailable');
      assert.equal(command, 'convert');
      assert.ok(args.includes('-auto-orient'));
      await fs.writeFile(args.at(-1), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    };
    const [first, second] = await Promise.all([preparePhoto(file, { runProcess: mock }), preparePhoto(file, { runProcess: mock })]);
    assert.equal(first, second);
    assert.equal(calls.length, 3, 'ffmpeg, magick and convert attempted once');
    assert.equal(await preparePhoto(file, { runProcess: mock }), first);
    assert.equal(calls.length, 3, 'Converted JPEG is reused');
    assert.equal((await readExif(first)).taken_at, date);
    assert.equal((await readExif(first)).orientation, 1, 'Converted image is upright');
    const fail = path.join(scratch, 'broken.heif');
    await fs.writeFile(fail, 'bad');
    await assert.rejects(preparePhoto(fail, { runProcess: async () => { throw new Error('missing'); } }), /broken.heif.*HEIC\/HEIF.*ffmpeg.*ImageMagick/);
    assert.ok(!(await fs.readdir(scratch)).some((name) => name.startsWith('.heic-')), 'Failed scratch files are removed');
    const abort = new AbortController();
    abort.abort();
    let attempts = 0;
    await assert.rejects(preparePhoto(fail, { signal: abort.signal, runProcess: async () => { attempts++; throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } }), /aborted/);
    assert.equal(attempts, 0, 'An already cancelled request never starts a converter');
    let release, started;
    const ready = new Promise((resolve) => { started = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    let sharedSignal;
    const sharedMock = async (_command, args, { signal }) => {
      sharedSignal = signal;
      started();
      await gate;
      signal.throwIfAborted();
      await fs.writeFile(args.at(-1), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    };
    const one = new AbortController();
    const two = new AbortController();
    const firstWait = preparePhoto(fail, { signal: one.signal, runProcess: sharedMock });
    const secondWait = preparePhoto(fail, { signal: two.signal, runProcess: sharedMock });
    await ready;
    one.abort();
    await assert.rejects(firstWait, /abort/i);
    assert.equal(sharedSignal.aborted, false, 'another caller still needs the conversion');
    two.abort();
    await assert.rejects(secondWait, /abort/i);
    assert.equal(sharedSignal.aborted, true, 'the last cancellation stops the shared converter');
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const ext of ['.heic', '.heif']) {
      assert.equal(assets.typeFromExtension(ext.toUpperCase()), 'image');
      assert.equal(routes.uploadExtension('image/' + ext.slice(1), '').ext, ext);
      assert.equal(assets.valueFromLedgerEntry('test', { id: 'photo', kind: 'upload', file: 'phone' + ext }).type, 'image');
    }
    const store = require('../lib/store');
    const original = { readLedger: store.readLedger, sessionAssetDir: store.sessionAssetDir };
    try {
      store.readLedger = async () => [{ id: 'photo', kind: 'upload', file: path.basename(file) }];
      store.sessionAssetDir = () => scratch;
      const resolved = await assets.valueFromAsset('test', 'photo');
      assert.equal(resolved.assetId, 'photo');
      assert.equal(assets.assetFilePath(resolved), first, 'All consumers receive the reusable JPEG');
      assert.ok(resolved.url.endsWith('.jpg'), 'AI providers receive a JPEG URL');
      await assert.rejects(assets.resolveAssetParam({ assetId: 'photo' }, 'test', 'image', { signal: abort.signal }), /abort/i, 'asset resolution forwards the signal through to photo preparation');
    } finally {
      Object.assign(store, original);
    }
    const { registry } = require('../lib/nodes/registry');
    const originalResolve = assets.resolveAssetParam;
    const listAbort = new AbortController();
    let resolvedCount = 0;
    try {
      assets.resolveAssetParam = async (_param, _session, _kind, options) => {
        assert.equal(options.signal, listAbort.signal, 'list forwards cancellation to asset preparation');
        resolvedCount++;
        listAbort.abort();
        return { type: 'image' };
      };
      await assert.rejects(registry.get('input.media_list').execute({ sessionId: 'test', signal: listAbort.signal }, {}, { kind: 'image', assets: [{}, {}] }), /abort/i);
      assert.equal(resolvedCount, 1, 'cancellation stops the next list item');
    } finally { assets.resolveAssetParam = originalResolve; }
    // Use an installed HEIF encoder for a real round trip; there is no downloaded fixture.
    let encoder = null;
    for (const command of ['magick', 'convert']) {
      try {
        const formats = await ffmpeg.runProcess(command, ['-list', 'format'], { timeoutMs: 10000 });
        if (/HEIC\*?\s+HEIC\s+rw/.test(formats.stdout)) { encoder = command; break; }
      } catch (_) { /* Optional local tool. */ }
    }
    const fixture = process.env.EVENT_HEIC_FIXTURE || null;
    if (!encoder && !fixture && process.platform === 'darwin') {
      try {
        const formats = await ffmpeg.runProcess('sips', ['--formats'], { timeoutMs: 10000 });
        if (/public.heic\s+heic\s+Writable/.test(formats.stdout)) encoder = 'sips';
      } catch (_) { /* Optional fixture encoder. */ }
    }
    if (encoder || fixture) {
      const real = path.join(scratch, 'real.heic');
      let fixtureReady = false;
      try {
        if (fixture) {
          await fs.copyFile(fixture, real);
        } else if (encoder === 'sips') {
          const png = path.join(scratch, 'source.png');
          await ffmpeg.runProcess(ffmpeg.binaries().ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=red:size=64x48', '-frames:v', '1', png], { timeoutMs: 60000 });
          await ffmpeg.runProcess('sips', ['-s', 'format', 'heic', png, '--out', real], { timeoutMs: 60000 });
        } else {
          await ffmpeg.runProcess(encoder, ['-size', '64x48', 'xc:red', real], { timeoutMs: 60000 });
        }
        fixtureReady = true;
      } catch (error) {
        if (fixture) throw error;
        console.log('SKIP real HEIC round trip: local fixture encoder cannot run in this environment');
      }
      if (fixtureReady) {
        const originalExif = await readExif(real);
        const converted = await preparePhoto(real);
        if (originalExif.taken_at) assert.equal((await readExif(converted)).taken_at, originalExif.taken_at);
        const probe = JSON.parse((await ffmpeg.runProcess(ffmpeg.binaries().ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', converted])).stdout);
        assert.ok(probe.streams.some((stream) => fixture ? stream.width > 0 && stream.height > 0 : stream.width === 64 && stream.height === 48));
        console.log('Real HEIC round trip passed');
      }
    } else {
      console.log('SKIP real HEIC round trip: no local HEIF encoder available');
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
  console.log('test-event-video-heic.js: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
