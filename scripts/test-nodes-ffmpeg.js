'use strict';

// Tests for the editing nodes (lib/nodes/ffmpeg-ops.js, lib/nodes/nodes-edit.js) and the abortable
// ffmpeg.runProcess. Pure builders are always asserted; the real ffmpeg part runs on generated inputs
// (lavfi sources) and is skipped when ffmpeg/ffprobe are missing. No network, no provider.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const store = require('../lib/store');
const ffmpeg = require('../lib/ffmpeg');
const ops = require('../lib/nodes/ffmpeg-ops');
const edit = require('../lib/nodes/nodes-edit');
const assets = require('../lib/nodes/assets');
const nodesBasic = require('../lib/nodes/nodes-basic');
const { createRegistry } = require('../lib/nodes/registry');
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
const { createEngine } = require('../lib/nodes/engine');

const execFileAsync = promisify(execFile);

const restorers = [];
function withEnv(name, value) {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restorers.push(() => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  });
}
function restoreAll() {
  while (restorers.length) restorers.pop()();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- registry helpers ---------- */

const registry = createRegistry();
nodesBasic.registerAll(registry);
edit.registerAll(registry);

function def(type) {
  const found = registry.get(type);
  assert.ok(found, `${type} is registered`);
  return found;
}

function params(type, raw = {}) {
  return registry.normalizeParams(def(type), raw);
}

function issuesOf(type, raw, ports = {}) {
  const definition = def(type);
  return (definition.validate ? definition.validate(registry.normalizeParams(definition, raw), ports) || [] : []).map((issue) =>
    typeof issue === 'string' ? { level: 'error', message: issue } : { level: issue.level || 'error', message: issue.message }
  );
}

const probeOf = (width, height, extra = {}) => ({
  video: { codec: 'h264', width, height, fps: 25 },
  audio: null,
  duration: null,
  ...extra
});

/* ---------- pure builder tests ---------- */

function testPureBuilders() {
  // helpers
  assert.equal(ops.num(0.1 + 0.2), '0.3');
  assert.equal(ops.ffColor('#FF8800'), '0xff8800');
  assert.equal(ops.ffColor('#ff880080'), '0xff8800@0.502');
  assert.equal(ops.ffColor('', '#00ff00'), '0x00ff00');
  assert.throws(() => ops.ffColor('red'), /Invalid colour/);
  assert.equal(ops.even(181), 182);
  assert.equal(ops.even(1), 2);
  assert.equal(ops.parseAspect('16:9'), 16 / 9);
  assert.throws(() => ops.parseAspect('x'), /Invalid aspect/);
  assert.equal(ops.atempoChain(2), 'atempo=2');
  assert.equal(ops.atempoChain(4), 'atempo=2,atempo=2');
  assert.equal(ops.atempoChain(0.25), 'atempo=0.5,atempo=0.5');
  assert.equal(ops.atempoChain(3), 'atempo=2,atempo=1.5');
  assert.deepEqual(ops.parseVolumes('1, 0.5', 3), [1, 0.5, 1]);
  assert.deepEqual(ops.parseVolumes('', 2), [1, 1]);
  assert.throws(() => ops.parseVolumes('a', 2), /volumes/);
  assert.throws(() => ops.parseVolumes('11', 2), /volumes/);

  // crop
  const image = probeOf(320, 180);
  assert.equal(ops.buildCrop(params('image.crop', { mode: 'pixels', x: 10, y: 20, width: 100, height: 50 }), [image]).chain, 'crop=100:50:10:20');
  assert.equal(ops.buildCrop(params('image.crop', { mode: 'pixels', x: 300, y: 0 }), [image]).chain, 'crop=20:180:300:0', 'zero size runs to the edge');
  assert.equal(ops.buildCrop(params('image.crop', { mode: 'pixels', x: 10, y: 10, width: 999, height: 999 }), [image]).chain, 'crop=310:170:10:10', 'size is clamped');
  assert.equal(ops.buildCrop(params('image.crop', { mode: 'aspect', aspect: '1:1' }), [image]).chain, 'crop=180:180:70:0');
  assert.equal(ops.buildCrop(params('image.crop', { mode: 'aspect', aspect: '9:16', anchor: 'left' }), [image]).chain, 'crop=101:180:0:0');
  assert.equal(ops.buildCrop(params('image.crop', { mode: 'aspect', aspect: '2:1', anchor: 'bottom' }), [image]).chain, 'crop=320:160:0:20');
  assert.throws(() => ops.buildCrop(params('image.crop'), [{ video: null }]), /no image/);

  // resize
  assert.equal(ops.buildImageResize(params('image.resize', { width: 160, height: 0 })).chain, 'scale=160:-1:flags=lanczos');
  assert.equal(ops.buildImageResize(params('image.resize', { width: 0, height: 90 })).chain, 'scale=-1:90:flags=lanczos');
  assert.equal(ops.buildImageResize(params('image.resize', { width: 200, height: 100, fit: 'stretch' })).chain, 'scale=200:100:flags=lanczos');
  assert.equal(
    ops.buildImageResize(params('image.resize', { width: 200, height: 100, fit: 'cover' })).chain,
    'scale=200:100:force_original_aspect_ratio=increase:flags=lanczos,crop=200:100'
  );
  assert.equal(
    ops.buildImageResize(params('image.resize', { width: 200, height: 200, fit: 'contain', background: '#ff0000' })).chain,
    'scale=200:200:force_original_aspect_ratio=decrease:flags=lanczos,pad=200:200:(ow-iw)/2:(oh-ih)/2:color=0xff0000'
  );
  assert.equal(
    ops.buildImageResize(params('image.resize', { width: 200, height: 200, fit: 'contain', transparent: true })).chain,
    'format=rgba,scale=200:200:force_original_aspect_ratio=decrease:flags=lanczos,pad=200:200:(ow-iw)/2:(oh-ih)/2:color=black@0'
  );
  assert.throws(() => ops.buildImageResize(params('image.resize', { width: 0, height: 0 })), /width or a height/);
  assert.equal(
    ops.buildVideoResize(params('video.resize', { width: 201, height: 0 }), [probeOf(320, 180)]).chain,
    'scale=202:-2:flags=lanczos,setsar=1'
  );
  assert.equal(
    ops.buildVideoResize(params('video.resize', { width: 1080, height: 1920, fit: 'contain' }), [probeOf(320, 180)]).chain,
    'scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x000000,setsar=1'
  );

  // colour and tone
  assert.equal(ops.buildImageAdjust(params('image.adjust')).chain, 'null', 'neutral values do nothing');
  assert.equal(
    ops.buildImageAdjust(params('image.adjust', { brightness: 0.1, contrast: 1.2, saturation: 0.5, gamma: 1.1, hue: 30 })).chain,
    'eq=brightness=0.1:contrast=1.2:saturation=0.5:gamma=1.1,hue=h=30'
  );
  assert.equal(ops.buildImageAdjust(params('image.adjust', { hue: -45 })).chain, 'hue=h=-45');
  assert.equal(
    ops.buildLevels(params('image.levels', { in_black: 0.1, in_white: 0.9, out_black: 0.05, out_white: 0.95 })).chain,
    'colorlevels=rimin=0.1:gimin=0.1:bimin=0.1:rimax=0.9:gimax=0.9:bimax=0.9:romin=0.05:gomin=0.05:bomin=0.05:romax=0.95:gomax=0.95:bomax=0.95'
  );
  assert.throws(() => ops.buildLevels(params('image.levels', { in_black: 0.9, in_white: 0.5 })), /in_black/);
  assert.equal(ops.buildBlur(params('image.blur', { radius: 8 })).chain, 'gblur=sigma=8');
  assert.equal(ops.buildBlur(params('image.blur', { radius: 0 })).chain, 'null');
  assert.equal(ops.buildSharpen(params('image.sharpen', { amount: 1.5 })).chain, 'unsharp=5:5:1.5');
  assert.equal(ops.buildInvert(params('image.invert')).chain, 'negate');
  assert.equal(ops.buildInvert(params('image.invert', { alpha: true })).chain, 'negate=negate_alpha=1');
  assert.equal(ops.buildTransform(params('image.transform', { flip: 'h', rotate: '90' })).chain, 'hflip,transpose=1');
  assert.equal(ops.buildTransform(params('image.transform', { flip: 'both' })).chain, 'hflip,vflip');
  assert.equal(ops.buildTransform(params('image.transform', { rotate: '180' })).chain, 'hflip,vflip');
  assert.equal(ops.buildTransform(params('image.transform', { rotate: '270' })).chain, 'transpose=2');
  assert.equal(ops.buildTransform(params('image.transform')).chain, 'null');

  // pad
  assert.equal(ops.buildPad(params('image.pad', { mode: 'aspect', aspect: '1:1' }), [image]).chain, 'pad=320:320:0:70:color=0x000000');
  assert.equal(ops.buildPad(params('image.pad', { mode: 'aspect', aspect: '1:1', position: 'top' }), [image]).chain, 'pad=320:320:0:0:color=0x000000');
  assert.equal(ops.buildPad(params('image.pad', { mode: 'aspect', aspect: '21:9' }), [image]).chain, 'pad=420:180:50:0:color=0x000000');
  assert.equal(
    ops.buildPad(params('image.pad', { mode: 'size', width: 400, height: 300, transparent: true, position: 'bottom-right' }), [image]).chain,
    'format=rgba,pad=400:300:80:120:color=black@0'
  );
  assert.equal(ops.buildPad(params('image.pad', { mode: 'size', width: 100, height: 0 }), [image]).chain, 'pad=320:180:0:0:color=0x000000', 'pad never shrinks');

  // composite
  const compositeParams = params('image.composite', { x: 10, y: 20, scale: 50, opacity: 0.5 });
  const composite = ops.buildComposite(compositeParams, [probeOf(320, 180), probeOf(100, 100)]);
  assert.equal(
    composite.graph,
    '[1:v]format=rgba,scale=50:50:flags=lanczos,colorchannelmixer=aa=0.5[l];[0:v]format=rgba[bg];[bg][l]overlay=x=10:y=20:format=auto,format=rgba[out]'
  );
  const masked = ops.buildComposite(params('image.composite', { x: 50, y: 50, unit: 'percent', anchor: 'center' }), [probeOf(320, 180), probeOf(100, 100), probeOf(64, 64)]);
  assert.match(masked.graph, /^\[1:v\]format=rgba\[l0\];\[2:v\]scale=100:100:flags=bicubic,format=gray\[m\];\[l0\]\[m\]alphamerge\[l\];/);
  assert.match(masked.graph, /overlay=x=W\*0\.5-w\/2:y=H\*0\.5-h\/2:format=auto/);
  const blended = ops.buildComposite(params('image.composite', { blend: 'multiply' }), [probeOf(320, 180), probeOf(100, 100)]);
  assert.match(blended.graph, /color=c=black@0:s=320x180:d=1,format=rgba\[cv0\]/);
  assert.match(blended.graph, /\[b0\]\[cv1\]blend=all_mode=multiply\[bl\]/);
  assert.match(blended.graph, /\[bl\]\[al\]alphamerge\[bla\]/);
  assert.throws(() => ops.buildComposite({ ...compositeParams, blend: 'dissolve' }, [probeOf(10, 10), probeOf(5, 5)]), /blend mode/);
  assert.equal(
    ops.buildMaskApply(params('image.mask_apply', { invert: true, feather: 4 }), [probeOf(320, 180), probeOf(64, 64)]).graph,
    '[0:v]format=rgba[i];[1:v]scale=320:180:flags=bicubic,format=gray,negate,gblur=sigma=4[m];[i][m]alphamerge,format=rgba[out]'
  );
  const key = ops.buildChromaKey(params('image.chroma_key', { color: '#00ff00', similarity: 0.3, blend: 0.1 }));
  assert.equal(key.chain, 'colorkey=0x00ff00:0.3:0.1');
  assert.equal(key.graph, '[0:v]format=rgba,colorkey=0x00ff00:0.3:0.1,split[keyed][k2];[k2]alphaextract[matte]');
  assert.deepEqual(key.outputs.map((output) => output.label), ['keyed', 'matte']);

  // video
  const clip = probeOf(320, 180, { duration: 3, audio: { codec: 'aac' } });
  const still = ops.buildImageToVideo(params('image.to_video', { duration: 5, fps: 30, zoom: 'none' }), [probeOf(321, 181)]);
  assert.equal(still.chain, 'scale=322:182:flags=lanczos,fps=30,setsar=1,scale=out_range=tv,format=yuv420p');
  assert.deepEqual(still.inputOpts, [['-loop', '1', '-framerate', '30']]);
  assert.deepEqual(still.outputs[0].args, ['-t', '5']);
  const zoomed = ops.buildImageToVideo(params('image.to_video', { duration: 2, fps: 25, zoom: 'in' }), [probeOf(320, 180)]);
  assert.equal(
    zoomed.chain,
    "scale=640:360:flags=lanczos,zoompan=z='1+0.2*on/50':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=320x180:fps=25,setsar=1,scale=out_range=tv,format=yuv420p"
  );
  assert.match(ops.buildImageToVideo(params('image.to_video', { duration: 2, fps: 25, zoom: 'out' }), [probeOf(4000, 2000)]).chain, /z='1\.2-0\.2\*on\/50'/);
  const withAudio = ops.buildImageToVideo(params('image.to_video', { duration: 5, match_audio: true }), [probeOf(320, 180), { audio: { codec: 'aac' }, duration: 7.5 }]);
  assert.deepEqual(withAudio.outputs[0].maps, ['[out]', '1:a:0']);
  assert.deepEqual(withAudio.outputs[0].args, ['-t', '7.5'], 'match_audio uses the audio length');
  assert.deepEqual(ops.buildImageToVideo(params('image.to_video', { duration: 5 }), [probeOf(320, 180)], { duration: 3 }).outputs[0].args, ['-t', '3'], 'a connected duration wins');

  assert.deepEqual(ops.buildExtractFrame(params('video.extract_frame', { position: 'first' }), [clip]).inputOpts, [['-ss', '0']]);
  assert.deepEqual(ops.buildExtractFrame(params('video.extract_frame', { position: 'middle' }), [clip]).inputOpts, [['-ss', '1.5']]);
  assert.deepEqual(ops.buildExtractFrame(params('video.extract_frame', { position: 'last' }), [clip]).inputOpts, [['-ss', '2.92']]);
  assert.deepEqual(ops.buildExtractFrame(params('video.extract_frame', { position: 'time', time: 2 }), [clip]).inputOpts, [['-ss', '2']]);
  assert.throws(() => ops.buildExtractFrame(params('video.extract_frame', { position: 'time', time: 9 }), [clip]), /beyond the end/);

  const trimmed = ops.buildTrim(params('video.trim', { start: 1, end: 2 }), [clip]);
  assert.deepEqual(trimmed.inputOpts, [['-ss', '1', '-t', '1']]);
  assert.deepEqual(trimmed.outputs[0], { kind: 'video', maps: ['0:v:0', '0:a?'] });
  const copyTrim = ops.buildTrim(params('video.trim', { start: 1, end: 0, accurate: false }), [clip]);
  assert.deepEqual(copyTrim.inputOpts, [['-ss', '1', '-t', '2']]);
  assert.equal(copyTrim.outputs[0].copyAll, true);
  assert.throws(() => ops.buildTrim(params('video.trim', { start: 5 }), [clip]), /beyond the end/);
  assert.throws(() => ops.buildTrim(params('video.trim', { start: 2, end: 1 }), [clip]), /end must be greater/);

  assert.equal(ops.buildVideoAdjust(params('video.adjust', { saturation: 0 }), [clip]).chain, 'eq=saturation=0');
  const speedUp = ops.buildSpeed(params('video.speed', { factor: 4 }), [clip]);
  assert.equal(speedUp.graph, '[0:v]setpts=PTS/4[v];[0:a]atempo=2,atempo=2[a]');
  assert.deepEqual(speedUp.outputs[0].maps, ['[v]', '[a]']);
  const silentSlow = ops.buildSpeed(params('video.speed', { factor: 0.5 }), [probeOf(320, 180, { duration: 3 })]);
  assert.equal(silentSlow.graph, '[0:v]setpts=PTS/0.5[v]');
  assert.equal(silentSlow.outputs[0].noAudio, true);

  const overlay = ops.buildOverlayImage(params('video.overlay_image', { x: 10, y: 20, scale: 50, opacity: 1, start: 1, end: 3 }), [clip, probeOf(100, 100)]);
  assert.equal(
    overlay.graph,
    "[1:v]format=rgba,scale=50:50:flags=lanczos[ov];[0:v][ov]overlay=x=10:y=20:enable='between(t,1,3)':format=auto[out]"
  );
  assert.match(ops.buildOverlayImage(params('video.overlay_image', { start: 2 }), [clip, probeOf(10, 10)]).graph, /enable='gte\(t,2\)'/);
  assert.doesNotMatch(ops.buildOverlayImage(params('video.overlay_image'), [clip, probeOf(10, 10)]).graph, /enable/);

  const audioTrack = { video: null, audio: { codec: 'aac' }, duration: 4 };
  const replace = ops.buildMergeAudio(params('video.merge_audio', { mode: 'replace', audio_volume: 0.8, length: 'video' }), [clip, audioTrack]);
  assert.equal(replace.graph, '[1:a]volume=0.8,apad[aout]');
  assert.deepEqual(replace.outputs[0].maps, ['0:v:0', '[aout]']);
  assert.equal(replace.outputs[0].videoCopy, true, 'h264 is copied');
  assert.deepEqual(replace.outputs[0].args, ['-shortest']);
  const mixed = ops.buildMergeAudio(params('video.merge_audio', { mode: 'mix', video_volume: 0.5, length: 'shortest' }), [clip, audioTrack]);
  assert.equal(mixed.graph, '[0:a]volume=0.5[a0];[1:a]volume=1[a1];[a0][a1]amix=inputs=2:duration=shortest:dropout_transition=0[aout]');
  const silentMix = ops.buildMergeAudio(params('video.merge_audio', { mode: 'mix' }), [probeOf(320, 180, { duration: 3 }), audioTrack]);
  assert.equal(silentMix.graph, '[1:a]volume=1,apad[aout]', 'a video without audio degrades mix to replace');
  assert.equal(ops.buildMergeAudio(params('video.merge_audio'), [probeOf(320, 180, { video: { codec: 'vp9', width: 320, height: 180 } }), audioTrack]).outputs[0].videoCopy, false);
  assert.throws(() => ops.buildMergeAudio(params('video.merge_audio'), [clip, probeOf(10, 10)]), /no audio stream/);

  // audio
  assert.deepEqual(ops.buildExtractAudio({}, [clip]).outputs, [{ kind: 'audio', maps: ['0:a:0'] }]);
  assert.throws(() => ops.buildExtractAudio({}, [probeOf(320, 180)]), /no audio track/);
  const audioTrim = ops.buildAudioTrim(params('audio.trim', { start: 1, end: 3, fade_in: 0.5, fade_out: 1 }), [audioTrack]);
  assert.equal(audioTrim.chain, 'atrim=start=1:end=3,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.5,afade=t=out:st=1:d=1');
  assert.equal(audioTrim.graph, `[0:a]${audioTrim.chain}[out]`);
  assert.equal(ops.buildAudioTrim(params('audio.trim', { start: 1 }), [audioTrack]).chain, 'atrim=start=1,asetpts=PTS-STARTPTS');
  assert.throws(() => ops.buildAudioTrim(params('audio.trim', { start: 9 }), [audioTrack]), /beyond the end/);
  const mix = ops.buildAudioMix(params('audio.mix', { volumes: '1, 0.5', length: 'shortest' }), [audioTrack, audioTrack, audioTrack]);
  assert.equal(
    mix.graph,
    '[0:a]volume=1[a0];[1:a]volume=0.5[a1];[2:a]volume=1[a2];[a0][a1][a2]amix=inputs=3:duration=shortest:dropout_transition=0[out]'
  );
  assert.throws(() => ops.buildAudioMix(params('audio.mix'), [audioTrack]), /2 to 8/);
  assert.throws(() => ops.buildAudioMix(params('audio.mix'), [audioTrack, probeOf(10, 10)]), /no audio stream/);

  // argv assembly
  const args = ops.assembleArgs(trimmed, ['/in.mp4'], ['/out.mp4']);
  assert.deepEqual(args.slice(0, 4), ['-nostdin', '-v', 'error', '-y']);
  assert.deepEqual(args.slice(4, 9), ['-ss', '1', '-t', '1', '-i']);
  assert.ok(args.includes('libx264') && args.includes('aac') && args.at(-1) === '/out.mp4');
  const imageArgs = ops.assembleArgs(ops.buildBlur(params('image.blur')), ['/in.png'], ['/out.png']);
  assert.deepEqual(imageArgs.slice(4), ['-i', '/in.png', '-filter_complex', '[0:v]gblur=sigma=8[out]', '-map', '[out]', '-frames:v', '1', '-update', '1', '-c:v', 'png', '/out.png']);
  const keyArgs = ops.assembleArgs(key, ['/in.png'], ['/a.png', '/b.png']);
  assert.equal(keyArgs.filter((arg) => arg === '-map').length, 2);
  assert.throws(() => ops.assembleArgs(key, ['/in.png'], ['/a.png']), /Output file count/);
  const copyArgs = ops.assembleArgs(copyTrim, ['/in.mp4'], ['/out.mp4']);
  assert.ok(copyArgs.includes('copy') && !copyArgs.includes('libx264'));

  // probe normalisation
  assert.deepEqual(
    ops.normaliseMediaProbe({ streams: [{ codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', channels: 2, channel_layout: 'stereo' }], format: { duration: '4.5' } }),
    { video: null, audio: { codec: 'aac', sampleRate: 44100, channels: 2, channelLayout: 'stereo' }, duration: 4.5 }
  );
  assert.throws(() => ops.normaliseMediaProbe({ streams: [] }), /no video or audio/);
  const rotated = ops.normaliseMediaProbe({
    streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1', side_data_list: [{ rotation: -90 }] }],
    format: { duration: '2' }
  });
  assert.equal(rotated.video.width, 1080, 'a 90 degree display matrix swaps the size');
  assert.equal(rotated.video.height, 1920);

  // colours for text
  assert.deepEqual(ops.svgColor('#FFAA00'), { rgb: '#ffaa00', alpha: 1 });
  assert.deepEqual(ops.svgColor('#ffaa0080'), { rgb: '#ffaa00', alpha: 0.502 });
}

function testTextAndSvgHelpers() {
  assert.equal(edit.escapeXml(`a<b>&"'`), 'a&lt;b&gt;&amp;&quot;&apos;');
  assert.deepEqual(edit.wrapText('one two three four', 9), ['one two', 'three', 'four']);
  assert.deepEqual(edit.wrapText('a\n\nb', 20), ['a', '', 'b']);
  const built = edit.buildTextSvg(params('image.text_render', { text: 'Hello <World>', width: 400, font_size: 40, color: '#ff0000', align: 'left' }));
  assert.equal(built.width, 400);
  assert.ok(built.height >= 40);
  assert.match(built.svg, /<text x="12" y="[\d.]+">Hello &lt;World&gt;<\/text>/);
  assert.match(built.svg, /fill="#ff0000"/);
  assert.match(built.svg, /text-anchor="start"/);
  assert.equal(edit.buildTextSvg(params('image.text_render', { text: 'x', width: 300, height: 200 })).height, 200, 'a fixed height is kept');
  assert.throws(() => edit.buildTextSvg(params('image.text_render', { text: 'x\n'.repeat(190), font_size: 1000, width: 8192 })), /too large/);
  const injected = edit.buildTextSvg(params('image.text_render', { text: 'x', font_family: 'A"><script>' }));
  assert.doesNotMatch(injected.svg, /<script>/);

  assert.doesNotThrow(() => edit.checkSvgSafe('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(#g)"/><use href="#a"/></svg>'));
  assert.doesNotThrow(() => edit.checkSvgSafe('<svg><image href="data:image/png;base64,AAAA"/></svg>'));
  assert.throws(() => edit.checkSvgSafe('just text'), /not an SVG/);
  assert.throws(() => edit.checkSvgSafe('<svg><image href="/etc/passwd.png"/></svg>'), /external references/);
  assert.throws(() => edit.checkSvgSafe('<svg><image xlink:href="file:///tmp/a.png"/></svg>'), /external references/);
  assert.throws(() => edit.checkSvgSafe('<svg><rect style="fill:url(/tmp/x.svg)"/></svg>'), /external references/);
  assert.throws(() => edit.checkSvgSafe('<svg><style>@import "x.css";</style></svg>'), /imports/);
  assert.throws(() => edit.checkSvgSafe('<svg><image href="../assets/other/img-001.png"/></svg>'), /external references/);
  assert.throws(() => edit.checkSvgSafe('<svg><image href="//server/share/a.png"/></svg>'), /external references/);
  assert.throws(() => edit.checkSvgSafe('<!DOCTYPE svg [<!ENTITY x "y">]><svg></svg>'), /entities/);
  // resvg never fetches remote resources: web fonts and links in exported logos stay allowed (no preview loss).
  assert.doesNotThrow(() => edit.checkSvgSafe('<svg><style>@import url("https://fonts.googleapis.com/css2?family=Inter");</style><a href="https://kuble.com"><rect/></a></svg>'));
  assert.doesNotThrow(() => edit.checkSvgSafe('<svg><style>@import "https://fonts.example.com/a.css";</style></svg>'));
  assert.equal(edit.stripCodeFence('```svg\n<svg></svg>\n```'), '<svg></svg>');
}

function testRegistry() {
  const expected = {
    'image.crop': 'edit-image',
    'image.resize': 'edit-image',
    'image.adjust': 'edit-image',
    'image.levels': 'edit-image',
    'image.blur': 'edit-image',
    'image.sharpen': 'edit-image',
    'image.invert': 'edit-image',
    'image.transform': 'edit-image',
    'image.pad': 'edit-image',
    'image.composite': 'edit-image',
    'image.mask_apply': 'edit-image',
    'image.chroma_key': 'edit-image',
    'image.to_video': 'edit-video',
    'video.extract_frame': 'edit-video',
    'video.trim': 'edit-video',
    'video.resize': 'edit-video',
    'video.adjust': 'edit-video',
    'video.speed': 'edit-video',
    'video.overlay_image': 'edit-video',
    'video.merge_audio': 'edit-video',
    'video.extract_audio': 'edit-audio',
    'audio.trim': 'edit-audio',
    'audio.mix': 'edit-audio',
    'media.info': 'utility',
    'image.svg_rasterize': 'image',
    'image.text_render': 'image'
  };
  for (const [type, category] of Object.entries(expected)) {
    const definition = def(type);
    assert.equal(definition.category, category, type);
    assert.equal(definition.paid, false, `${type} is free`);
    assert.equal(definition.cost.unit, 'local', `${type} is local`);
    assert.deepEqual(registry.checkParams(definition, registry.paramDefaults(definition)), [], `${type} defaults are valid options`);
    const descriptor = registry.publicDescriptor(definition);
    assert.equal(typeof descriptor.available, descriptor.available === true ? 'boolean' : 'string');
  }
  assert.equal(registry.list().filter((entry) => entry.type in expected).length, Object.keys(expected).length);
  assert.deepEqual(def('image.chroma_key').outputs.map((port) => port.id), ['image', 'mask']);
  assert.equal(def('image.composite').inputs.find((port) => port.id === 'mask').required, undefined);
  assert.equal(def('audio.mix').inputs[0].multiple, true);
  // the default registry loads the module as well
  const defaultRegistry = require('../lib/nodes/registry');
  assert.ok(defaultRegistry.get('image.crop') && defaultRegistry.get('image.text_render') && defaultRegistry.get('media.info'));

  // validation messages
  assert.match(issuesOf('image.resize', { width: 0, height: 0 })[0].message, /width or a height/);
  assert.match(issuesOf('image.resize', { background: 'red' })[0].message, /hex colour/);
  assert.match(issuesOf('video.trim', { start: 3, end: 2 })[0].message, /end must be greater/);
  assert.match(issuesOf('audio.mix', {}, { tracks: { connected: true, count: 1 } })[0].message, /2 to 8/);
  assert.deepEqual(issuesOf('audio.mix', { volumes: '1,0.5' }, { tracks: { connected: true, count: 2 } }), []);
  assert.match(issuesOf('audio.mix', { volumes: 'x' }, { tracks: { connected: true, count: 2 } })[0].message, /volumes/);
  assert.equal(issuesOf('image.to_video', { match_audio: true }, { audio: { connected: false, count: 0 } })[0].level, 'warning');
  assert.match(issuesOf('image.levels', { in_black: 0.8, in_white: 0.5 })[0].message, /in_black/);
  assert.match(issuesOf('image.text_render', { color: 'nope' })[0].message, /hex colour/);
}

function testAvailability() {
  const original = { ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH };
  withEnv('FFMPEG_PATH', '/definitely/not/here/ffmpeg');
  withEnv('FFPROBE_PATH', '/definitely/not/here/ffprobe');
  try {
    for (const definition of registry.list()) {
      if (definition.category === 'edit-image' || definition.category === 'edit-video' || definition.category === 'edit-audio' || definition.type === 'media.info') {
        const availability = registry.availability(definition);
        assert.equal(typeof availability, 'string', `${definition.type} is unavailable without ffmpeg`);
        assert.match(availability, /ffmpeg/);
      }
    }
    assert.equal(registry.availability(def('image.svg_rasterize')), true, 'resvg nodes do not need ffmpeg');
    assert.equal(registry.availability(def('image.text_render')), true);
  } finally {
    restoreAll();
  }
  assert.equal(process.env.FFMPEG_PATH, original.ffmpeg);
}

/* ---------- abortable runProcess ---------- */

async function testRunProcessAbort() {
  const node = process.execPath;
  // pre-aborted: nothing is spawned
  const already = new AbortController();
  already.abort();
  await assert.rejects(ffmpeg.runProcess(node, ['-e', 'setTimeout(()=>{}, 60000)'], { signal: already.signal }), (err) => err.name === 'AbortError');

  // abort while running: the child is killed quickly
  const controller = new AbortController();
  const startedAt = Date.now();
  const running = ffmpeg.runProcess(node, ['-e', 'setTimeout(()=>{}, 60000)'], { signal: controller.signal, timeoutMs: 120000 });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(running, (err) => err.name === 'AbortError' && err.code === 'ABORT_ERR');
  assert.ok(Date.now() - startedAt < 5000, 'the process was killed, not waited for');

  // without a signal the behaviour is unchanged
  const ok = await ffmpeg.runProcess(node, ['-e', 'process.stdout.write("hi")']);
  assert.equal(ok.stdout, 'hi');
  await assert.rejects(ffmpeg.runProcess(node, ['-e', 'process.exit(3)']), /Exit 3/);
}

/* ---------- real ffmpeg ---------- */

async function ff(args) {
  const binaries = ffmpeg.binaries();
  await execFileAsync(binaries.ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args]);
}

async function probeRaw(file) {
  const binaries = ffmpeg.binaries();
  const { stdout } = await execFileAsync(binaries.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  const data = JSON.parse(stdout);
  const video = data.streams.find((stream) => stream.codec_type === 'video');
  const audio = data.streams.find((stream) => stream.codec_type === 'audio');
  return {
    width: video?.width,
    height: video?.height,
    pixFmt: video?.pix_fmt,
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    hasAudio: Boolean(audio),
    duration: Number(data.format.duration),
    formatName: data.format.format_name
  };
}

const hasAlpha = (probe) => /(rgba|bgra|argb|abgr|yuva|gbrap|ya8|ya16)/.test(String(probe.pixFmt));

// RGBA of one pixel (after the given seek time for videos).
async function pixelAt(file, x, y, { time = 0 } = {}) {
  const binaries = ffmpeg.binaries();
  const { stdout } = await execFileAsync(
    binaries.ffmpeg,
    ['-nostdin', '-v', 'error', '-ss', String(time), '-i', file, '-vf', `crop=1:1:${x}:${y},format=rgba`, '-frames:v', '1', '-f', 'rawvideo', '-'],
    { encoding: 'buffer' }
  );
  return [...stdout];
}

function near(actual, expected, tolerance = 12) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) <= tolerance, `pixel ${JSON.stringify(actual)} is not near ${JSON.stringify(expected)}`);
  });
}

async function fileOf(value) {
  return assets.assetFilePath(value);
}

async function testWithFfmpeg() {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-nodes-ffmpeg-'));
  const bus = createEventBus();
  const wfStore = createWorkflowsStore({ dir: tmpDir, registry, events: bus });
  const created = [];
  const { workflow } = await wfStore.createWorkflow({ name: 'ffmpeg test', graph: { nodes: [], edges: [] } });
  created.push(workflow.id);
  const sessionId = workflow.sessionId;
  try {
    /* ----- inputs ----- */
    const src = (name) => path.join(tmpDir, name);
    // RGB sources so the PNGs hold exact colours (a YUV round trip would shift 255 to 253)
    await ff(['-f', 'lavfi', '-i', 'color=c=0x0000ff:s=320x180,format=rgb24', '-frames:v', '1', src('blue.png')]);
    await ff(['-f', 'lavfi', '-i', 'testsrc=size=320x181:rate=1,format=rgb24', '-frames:v', '1', src('odd.png')]);
    await ff(['-f', 'lavfi', '-i', 'color=c=0xff0000:s=40x40,format=rgb24', '-frames:v', '1', src('red.png')]);
    await ff([
      '-f', 'lavfi', '-i', 'color=c=white:s=40x40,format=rgb24,drawbox=x=0:y=0:w=20:h=40:color=black:t=fill',
      '-frames:v', '1', src('half-mask.png')
    ]);
    await ff([
      '-f', 'lavfi', '-i', 'color=c=white:s=320x180,format=rgb24,drawbox=x=0:y=0:w=160:h=180:color=black:t=fill',
      '-frames:v', '1', src('big-mask.png')
    ]);
    await ff([
      '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=160x90,format=rgb24,drawbox=x=40:y=20:w=80:h=50:color=0xff0000:t=fill',
      '-frames:v', '1', src('greenscreen.png')
    ]);
    await ff(['-f', 'lavfi', '-i', 'color=c=0xff0000:s=100x100,format=rgba,colorchannelmixer=aa=0.5', '-frames:v', '1', src('alpha.png')]);
    await ff(['-f', 'lavfi', '-i', 'testsrc=size=300x200:rate=1', '-frames:v', '1', src('photo.jpg')]);
    await ff([
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src('clip.mp4')
    ]);
    await ff(['-f', 'lavfi', '-i', 'color=c=0x0000ff:s=320x180:rate=25', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src('blue.mp4')]);
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '4', src('music.wav')]);
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100', '-t', '2', src('voice.wav')]);

    const upload = async (file, ext) => {
      const saved = await store.saveAsset(sessionId, { kind: 'upload', buffer: await fsp.readFile(src(file)), ext, prompt: file, cost: null });
      return assets.valueFromAsset(sessionId, saved.id);
    };
    const photo = await upload('photo.jpg', '.jpg');
    const blue = await upload('blue.png', '.png');
    const odd = await upload('odd.png', '.png');
    const red = await upload('red.png', '.png');
    const halfMask = await upload('half-mask.png', '.png');
    const bigMask = await upload('big-mask.png', '.png');
    const greenscreen = await upload('greenscreen.png', '.png');
    const alphaImage = await upload('alpha.png', '.png');
    const clip = await upload('clip.mp4', '.mp4');
    const blueVideo = await upload('blue.mp4', '.mp4');
    const music = await upload('music.wav', '.wav');
    const voice = await upload('voice.wav', '.wav');
    assert.equal(clip.type, 'video');
    assert.equal(music.type, 'audio');

    const controller = new AbortController();
    const makeCtx = (signal = controller.signal) => ({
      workflowId: 'wf-test',
      runId: 'r-test',
      nodeId: 'n1',
      sessionId,
      user: 'tester',
      config: {},
      signal,
      log: () => {},
      saveOutputFile: (options) => assets.saveOutputFile(sessionId, options),
      withLocalSlot: (fn) => fn()
    });
    const run = async (type, inputs, raw = {}, signal) => {
      const definition = def(type);
      const result = await definition.execute(makeCtx(signal), inputs, registry.normalizeParams(definition, raw));
      assert.equal(result.variants.length, 1);
      return result.variants[0];
    };
    const ledgerKind = async (value) => (await store.readLedger(sessionId)).find((entry) => entry.id === value.assetId);

    /* ----- image ops ----- */
    {
      let out = (await run('image.crop', { image: blue }, { mode: 'aspect', aspect: '1:1' })).image;
      assert.equal(out.type, 'image');
      assert.equal((await ledgerKind(out)).kind, 'image');
      assert.equal(out.file.endsWith('.png'), true);
      let probe = await probeRaw(await fileOf(out));
      assert.deepEqual([probe.width, probe.height], [180, 180]);
      out = (await run('image.crop', { image: blue }, { mode: 'pixels', x: 10, y: 20, width: 100, height: 50 })).image;
      probe = await probeRaw(await fileOf(out));
      assert.deepEqual([probe.width, probe.height], [100, 50]);

      out = (await run('image.resize', { image: blue }, { width: 160, height: 0 })).image;
      probe = await probeRaw(await fileOf(out));
      assert.deepEqual([probe.width, probe.height], [160, 90]);
      out = (await run('image.resize', { image: blue }, { width: 200, height: 200, fit: 'contain', background: '#ff0000' })).image;
      const contain = await fileOf(out);
      probe = await probeRaw(contain);
      assert.deepEqual([probe.width, probe.height], [200, 200]);
      near(await pixelAt(contain, 100, 5), [255, 0, 0, 255], 2);
      near(await pixelAt(contain, 100, 100), [0, 0, 255, 255], 3);
      out = (await run('image.resize', { image: blue }, { width: 100, height: 100, fit: 'cover' })).image;
      probe = await probeRaw(await fileOf(out));
      assert.deepEqual([probe.width, probe.height], [100, 100]);
      out = (await run('image.resize', { image: blue }, { width: 200, height: 200, fit: 'contain', transparent: true })).image;
      const transparent = await fileOf(out);
      assert.equal(hasAlpha(await probeRaw(transparent)), true);
      assert.equal((await pixelAt(transparent, 100, 5))[3], 0);
      out = (await run('image.resize', { image: blue }, { width: 200, height: 50, fit: 'stretch' })).image;
      probe = await probeRaw(await fileOf(out));
      assert.deepEqual([probe.width, probe.height], [200, 50]);

      // alpha survives colour ops
      for (const [type, raw] of [
        ['image.adjust', { brightness: 0.1, saturation: 1.5, hue: 20 }],
        ['image.levels', { in_black: 0.1, in_white: 0.9 }],
        ['image.blur', { radius: 3 }],
        ['image.sharpen', { amount: 1 }],
        ['image.invert', {}],
        ['image.transform', { flip: 'h' }]
      ]) {
        out = (await run(type, { image: alphaImage }, raw)).image;
        const file = await fileOf(out);
        probe = await probeRaw(file);
        assert.deepEqual([probe.width, probe.height], [100, 100], type);
        assert.equal(hasAlpha(probe), true, `${type} keeps the alpha channel`);
        const pixel = await pixelAt(file, 50, 50);
        assert.ok(Math.abs(pixel[3] - 128) <= 3, `${type} keeps alpha 0.5, got ${pixel[3]}`);
      }
      out = (await run('image.adjust', { image: blue }, { brightness: 0.5 })).image;
      const bright = await pixelAt(await fileOf(out), 10, 10);
      assert.ok(bright[0] > 60 && bright[1] > 60, `brightness lifts the black channels: ${bright}`);
      out = (await run('image.invert', { image: blue })).image;
      near(await pixelAt(await fileOf(out), 10, 10), [255, 255, 0, 255], 3);
      out = (await run('image.transform', { image: blue }, { rotate: '90' })).image;
      probe = await probeRaw(await fileOf(out));
      assert.deepEqual([probe.width, probe.height], [180, 320]);
      out = (await run('image.transform', { image: blue }, { rotate: '180', flip: 'v' })).image;
      probe = await probeRaw(await fileOf(out));
      assert.deepEqual([probe.width, probe.height], [320, 180]);
      out = (await run('image.levels', { image: blue }, { out_black: 0.5, out_white: 1 })).image;
      const lifted = await pixelAt(await fileOf(out), 10, 10);
      assert.ok(lifted[0] >= 120, `levels raise the black output level: ${lifted}`);

      out = (await run('image.pad', { image: blue }, { mode: 'aspect', aspect: '1:1', color: '#ff0000' })).image;
      const padded = await fileOf(out);
      probe = await probeRaw(padded);
      assert.deepEqual([probe.width, probe.height], [320, 320]);
      near(await pixelAt(padded, 10, 10), [255, 0, 0, 255], 2);
      near(await pixelAt(padded, 160, 160), [0, 0, 255, 255], 3);
      out = (await run('image.pad', { image: blue }, { mode: 'size', width: 400, height: 300, transparent: true, position: 'top-left' })).image;
      const transparentPad = await fileOf(out);
      probe = await probeRaw(transparentPad);
      assert.deepEqual([probe.width, probe.height], [400, 300]);
      assert.equal((await pixelAt(transparentPad, 380, 280))[3], 0);
      assert.equal((await pixelAt(transparentPad, 10, 10))[3], 255);
    }

    /* ----- composite, mask, chroma key ----- */
    {
      let out = (await run('image.composite', { background: blue, layer: red }, { x: 10, y: 20 })).image;
      let file = await fileOf(out);
      let probe = await probeRaw(file);
      assert.deepEqual([probe.width, probe.height], [320, 180]);
      near(await pixelAt(file, 15, 25), [255, 0, 0, 255], 3);
      near(await pixelAt(file, 100, 100), [0, 0, 255, 255], 3);

      out = (await run('image.composite', { background: blue, layer: red }, { x: 10, y: 20, scale: 200 })).image;
      file = await fileOf(out);
      near(await pixelAt(file, 80, 90), [255, 0, 0, 255], 3);
      near(await pixelAt(file, 95, 90), [0, 0, 255, 255], 3);

      out = (await run('image.composite', { background: blue, layer: red }, { x: 50, y: 50, unit: 'percent', anchor: 'center' })).image;
      file = await fileOf(out);
      near(await pixelAt(file, 160, 90), [255, 0, 0, 255], 3);
      near(await pixelAt(file, 130, 90), [0, 0, 255, 255], 3);

      out = (await run('image.composite', { background: blue, layer: red }, { x: 10, y: 20, opacity: 0.5 })).image;
      file = await fileOf(out);
      near(await pixelAt(file, 15, 25), [128, 0, 128, 255], 6);

      out = (await run('image.composite', { background: blue, layer: red }, { x: 10, y: 20, blend: 'multiply' })).image;
      file = await fileOf(out);
      near(await pixelAt(file, 15, 25), [0, 0, 0, 255], 4);
      near(await pixelAt(file, 100, 100), [0, 0, 255, 255], 3);
      out = (await run('image.composite', { background: blue, layer: red }, { x: 10, y: 20, blend: 'screen' })).image;
      file = await fileOf(out);
      near(await pixelAt(file, 15, 25), [255, 0, 255, 255], 4);
      near(await pixelAt(file, 100, 100), [0, 0, 255, 255], 3);

      out = (await run('image.composite', { background: blue, layer: red, mask: halfMask }, { x: 10, y: 20 })).image;
      file = await fileOf(out);
      near(await pixelAt(file, 15, 25), [0, 0, 255, 255], 3); // left half of the layer is masked out
      near(await pixelAt(file, 40, 25), [255, 0, 0, 255], 3); // right half stays

      out = (await run('image.mask_apply', { image: blue, mask: bigMask })).image;
      file = await fileOf(out);
      probe = await probeRaw(file);
      assert.equal(hasAlpha(probe), true);
      assert.equal((await pixelAt(file, 10, 10))[3], 0);
      assert.equal((await pixelAt(file, 300, 10))[3], 255);
      out = (await run('image.mask_apply', { image: blue, mask: bigMask }, { invert: true })).image;
      file = await fileOf(out);
      assert.equal((await pixelAt(file, 10, 10))[3], 255);
      assert.equal((await pixelAt(file, 300, 10))[3], 0);
      out = (await run('image.mask_apply', { image: blue, mask: halfMask }, { feather: 6 })).image;
      file = await fileOf(out);
      probe = await probeRaw(file);
      assert.deepEqual([probe.width, probe.height], [320, 180], 'a small mask is scaled to the image');

      const keyed = await run('image.chroma_key', { image: greenscreen }, { color: '#00ff00', similarity: 0.3, blend: 0.05 });
      const keyedFile = await fileOf(keyed.image);
      const matteFile = await fileOf(keyed.mask);
      assert.equal(hasAlpha(await probeRaw(keyedFile)), true);
      assert.equal((await pixelAt(keyedFile, 5, 5))[3], 0, 'green becomes transparent');
      near(await pixelAt(keyedFile, 80, 45), [255, 0, 0, 255], 3);
      near((await pixelAt(matteFile, 5, 5)).slice(0, 3), [0, 0, 0], 3);
      near((await pixelAt(matteFile, 80, 45)).slice(0, 3), [255, 255, 255], 3);
      assert.notEqual(keyed.image.assetId, keyed.mask.assetId);
    }

    /* ----- image to video and frames ----- */
    {
      let out = (await run('image.to_video', { image: odd }, { duration: 2, fps: 25 })).video;
      assert.equal(out.type, 'video');
      assert.equal((await ledgerKind(out)).kind, 'video');
      let probe = await probeRaw(await fileOf(out));
      assert.equal(probe.width % 2, 0);
      assert.equal(probe.height % 2, 0);
      assert.deepEqual([probe.width, probe.height], [320, 182]);
      assert.ok(Math.abs(probe.duration - 2) < 0.15, `duration ${probe.duration}`);
      assert.equal(probe.videoCodec, 'h264');
      assert.equal(probe.hasAudio, false);
      assert.ok(out.duration > 1.8, 'the ledger stores the duration');

      out = (await run('image.to_video', { image: blue, audio: voice }, { duration: 9, match_audio: true, fps: 25 })).video;
      probe = await probeRaw(await fileOf(out));
      assert.ok(Math.abs(probe.duration - 2) < 0.2, `matched audio length ${probe.duration}`);
      assert.equal(probe.hasAudio, true);
      out = (await run('image.to_video', { image: blue, audio: music }, { duration: 1.5, fps: 25 })).video;
      probe = await probeRaw(await fileOf(out));
      assert.ok(Math.abs(probe.duration - 1.5) < 0.2, `audio is cut to the duration ${probe.duration}`);
      out = (await run('image.to_video', { image: blue, duration: { type: 'number', value: 1 } }, { duration: 4, fps: 25 })).video;
      probe = await probeRaw(await fileOf(out));
      assert.ok(Math.abs(probe.duration - 1) < 0.15, 'the connected duration wins');

      // JPEG is full range: the video must still come out as limited range yuv420p
      out = (await run('image.to_video', { image: photo }, { duration: 1, fps: 25, zoom: 'in' })).video;
      probe = await probeRaw(await fileOf(out));
      assert.equal(probe.pixFmt, 'yuv420p');
      assert.deepEqual([probe.width, probe.height], [300, 200]);
      out = (await run('image.adjust', { image: photo }, { brightness: 0.1 })).image;
      probe = await probeRaw(await fileOf(out));
      assert.deepEqual([probe.width, probe.height], [300, 200]);
      out = (await run('image.composite', { background: photo, layer: red }, { x: 5, y: 5, blend: 'overlay' })).image;
      probe = await probeRaw(await fileOf(out));
      assert.deepEqual([probe.width, probe.height], [300, 200]);

      for (const zoom of ['in', 'out']) {
        out = (await run('image.to_video', { image: blue }, { duration: 1, fps: 25, zoom })).video;
        probe = await probeRaw(await fileOf(out));
        assert.deepEqual([probe.width, probe.height], [320, 180], `zoom ${zoom}`);
        assert.ok(Math.abs(probe.duration - 1) < 0.15);
      }

      const first = (await run('video.extract_frame', { video: clip }, { position: 'first' })).image;
      const middle = (await run('video.extract_frame', { video: clip }, { position: 'middle' })).image;
      const last = (await run('video.extract_frame', { video: clip }, { position: 'last' })).image;
      const timed = (await run('video.extract_frame', { video: clip }, { position: 'time', time: 1 })).image;
      for (const frame of [first, middle, last, timed]) {
        assert.equal(frame.type, 'image');
        probe = await probeRaw(await fileOf(frame));
        assert.deepEqual([probe.width, probe.height], [320, 180]);
      }
      const bytes = async (value) => (await fsp.readFile(await fileOf(value))).toString('base64');
      assert.notEqual(await bytes(first), await bytes(last), 'first and last frame differ');
      assert.notEqual(await bytes(first), await bytes(middle));
      await assert.rejects(run('video.extract_frame', { video: clip }, { position: 'time', time: 30 }), /beyond the end/);
    }

    /* ----- video ops ----- */
    {
      let out = (await run('video.trim', { video: clip }, { start: 1, end: 2 })).video;
      let probe = await probeRaw(await fileOf(out));
      assert.ok(Math.abs(probe.duration - 1) < 0.15, `accurate trim ${probe.duration}`);
      assert.equal(probe.hasAudio, true);
      out = (await run('video.trim', { video: clip }, { start: 1, end: 0 })).video;
      probe = await probeRaw(await fileOf(out));
      assert.ok(Math.abs(probe.duration - 2) < 0.2, `open end ${probe.duration}`);
      out = (await run('video.trim', { video: clip }, { start: 0, end: 2, accurate: false })).video;
      probe = await probeRaw(await fileOf(out));
      assert.ok(probe.duration > 1.5 && probe.duration < 2.6, `copy trim ${probe.duration}`);
      assert.equal(probe.videoCodec, 'h264');
      await assert.rejects(run('video.trim', { video: clip }, { start: 10 }), /beyond the end/);

      out = (await run('video.resize', { video: clip }, { width: 160, height: 0 })).video;
      probe = await probeRaw(await fileOf(out));
      assert.deepEqual([probe.width, probe.height], [160, 90]);
      assert.equal(probe.hasAudio, true);
      out = (await run('video.resize', { video: clip }, { width: 200, height: 200, fit: 'contain', background: '#ff0000' })).video;
      const contain = await fileOf(out);
      probe = await probeRaw(contain);
      assert.deepEqual([probe.width, probe.height], [200, 200]);
      near(await pixelAt(contain, 100, 5), [255, 0, 0, 255], 12);
      out = (await run('video.resize', { video: clip }, { width: 101, height: 101, fit: 'cover' })).video;
      probe = await probeRaw(await fileOf(out));
      assert.deepEqual([probe.width, probe.height], [102, 102], 'sizes are rounded to even');
      out = (await run('video.resize', { video: clip }, { width: 90, height: 160, fit: 'stretch' })).video;
      probe = await probeRaw(await fileOf(out));
      assert.deepEqual([probe.width, probe.height], [90, 160]);

      out = (await run('video.adjust', { video: blueVideo }, { brightness: 0.4, saturation: 0 })).video;
      const adjusted = await pixelAt(await fileOf(out), 10, 10);
      assert.ok(Math.abs(adjusted[0] - adjusted[2]) < 30, `saturation 0 makes the frame grey: ${adjusted}`);
      out = (await run('video.adjust', { video: clip })).video;
      probe = await probeRaw(await fileOf(out));
      assert.equal(probe.hasAudio, true);

      out = (await run('video.speed', { video: clip }, { factor: 2 })).video;
      probe = await probeRaw(await fileOf(out));
      assert.ok(Math.abs(probe.duration - 1.5) < 0.2, `2x speed ${probe.duration}`);
      assert.equal(probe.hasAudio, true);
      out = (await run('video.speed', { video: clip }, { factor: 0.5 })).video;
      probe = await probeRaw(await fileOf(out));
      assert.ok(Math.abs(probe.duration - 6) < 0.3, `0.5x speed ${probe.duration}`);
      out = (await run('video.speed', { video: blueVideo }, { factor: 4 })).video;
      probe = await probeRaw(await fileOf(out));
      assert.ok(Math.abs(probe.duration - 0.75) < 0.2, `silent 4x speed ${probe.duration}`);
      assert.equal(probe.hasAudio, false);

      out = (await run('video.overlay_image', { video: blueVideo, image: red }, { x: 10, y: 20, start: 1, end: 2 })).video;
      const overlaid = await fileOf(out);
      probe = await probeRaw(overlaid);
      assert.deepEqual([probe.width, probe.height], [320, 180]);
      assert.ok(Math.abs(probe.duration - 3) < 0.15);
      near(await pixelAt(overlaid, 15, 25, { time: 0.3 }), [0, 0, 255, 255], 20);
      near(await pixelAt(overlaid, 15, 25, { time: 1.5 }), [255, 0, 0, 255], 20);
      near(await pixelAt(overlaid, 15, 25, { time: 2.6 }), [0, 0, 255, 255], 20);
      out = (await run('video.overlay_image', { video: blueVideo, image: red }, { x: 0, y: 0, opacity: 0.5, scale: 100 })).video;
      near(await pixelAt(await fileOf(out), 5, 5, { time: 1 }), [128, 0, 128, 255], 25);
    }

    /* ----- audio ----- */
    {
      let out = (await run('video.merge_audio', { video: blueVideo, audio: music }, { mode: 'replace', length: 'video' })).video;
      let probe = await probeRaw(await fileOf(out));
      assert.equal(probe.hasAudio, true);
      assert.ok(Math.abs(probe.duration - 3) < 0.3, `video length kept ${probe.duration}`);
      out = (await run('video.merge_audio', { video: blueVideo, audio: voice }, { mode: 'replace', length: 'shortest' })).video;
      probe = await probeRaw(await fileOf(out));
      assert.ok(Math.abs(probe.duration - 2) < 0.3, `shortest ${probe.duration}`);
      out = (await run('video.merge_audio', { video: clip, audio: music }, { mode: 'mix', audio_volume: 0.5, video_volume: 1, length: 'video' })).video;
      probe = await probeRaw(await fileOf(out));
      assert.equal(probe.hasAudio, true);
      assert.ok(Math.abs(probe.duration - 3) < 0.3, `mix length ${probe.duration}`);
      out = (await run('video.merge_audio', { video: clip, audio: music }, { mode: 'replace', length: 'video' })).video;
      probe = await probeRaw(await fileOf(out));
      assert.equal(probe.videoCodec, 'h264');

      out = (await run('video.extract_audio', { video: clip })).audio;
      assert.equal(out.type, 'audio');
      assert.equal((await ledgerKind(out)).kind, 'audio');
      assert.equal(out.file.endsWith('.m4a'), true);
      probe = await probeRaw(await fileOf(out));
      assert.equal(probe.hasAudio, true);
      assert.equal(probe.width, undefined);
      assert.ok(Math.abs(probe.duration - 3) < 0.2);
      await assert.rejects(run('video.extract_audio', { video: blueVideo }), /no audio track/);

      out = (await run('audio.trim', { audio: music }, { start: 1, end: 3, fade_in: 0.2, fade_out: 0.5 })).audio;
      probe = await probeRaw(await fileOf(out));
      assert.ok(Math.abs(probe.duration - 2) < 0.15, `trimmed audio ${probe.duration}`);
      out = (await run('audio.trim', { audio: music }, { start: 3 })).audio;
      probe = await probeRaw(await fileOf(out));
      assert.ok(Math.abs(probe.duration - 1) < 0.15, `open end audio ${probe.duration}`);
      await assert.rejects(run('audio.trim', { audio: music }, { start: 9 }), /beyond the end/);

      const tracks = { type: 'list', of: 'audio', items: [music, voice] };
      out = (await run('audio.mix', { tracks }, { length: 'longest' })).audio;
      probe = await probeRaw(await fileOf(out));
      assert.ok(Math.abs(probe.duration - 4) < 0.2, `longest ${probe.duration}`);
      out = (await run('audio.mix', { tracks }, { length: 'shortest', volumes: '1, 0.5' })).audio;
      probe = await probeRaw(await fileOf(out));
      assert.ok(Math.abs(probe.duration - 2) < 0.2, `shortest ${probe.duration}`);
      out = (await run('audio.mix', { tracks }, { length: 'first' })).audio;
      probe = await probeRaw(await fileOf(out));
      assert.ok(Math.abs(probe.duration - 4) < 0.2, `first ${probe.duration}`);
      await assert.rejects(run('audio.mix', { tracks: { type: 'list', of: 'audio', items: [music] } }), /2 to 8/);
    }

    /* ----- media.info ----- */
    {
      let info = await run('media.info', { media: blue });
      assert.deepEqual([info.width.value, info.height.value, info.duration.value], [320, 180, 0]);
      info = await run('media.info', { media: clip });
      assert.deepEqual([info.width.value, info.height.value], [320, 180]);
      assert.ok(Math.abs(info.duration.value - 3) < 0.1);
      info = await run('media.info', { media: music });
      assert.deepEqual([info.width.value, info.height.value], [0, 0]);
      assert.ok(Math.abs(info.duration.value - 4) < 0.1);
      await assert.rejects(run('media.info', { media: { type: 'text', value: 'x' } }), /connect an image/);
    }

    /* ----- resvg nodes ----- */
    {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50"><rect width="100" height="50" fill="#ff0000"/></svg>';
      let out = (await run('image.svg_rasterize', { svg: { type: 'text', value: svg } }, { width: 400 })).image;
      let file = await fileOf(out);
      let probe = await probeRaw(file);
      assert.deepEqual([probe.width, probe.height], [400, 200]);
      near(await pixelAt(file, 200, 100), [255, 0, 0, 255], 2);
      assert.equal((await ledgerKind(out)).kind, 'image');
      out = (await run('image.svg_rasterize', { svg: { type: 'text', value: `\`\`\`svg\n${svg}\n\`\`\`` } }, { width: 50 })).image;
      probe = await probeRaw(await fileOf(out));
      assert.deepEqual([probe.width, probe.height], [50, 25]);
      await assert.rejects(run('image.svg_rasterize', { svg: { type: 'text', value: 'not svg' } }), /not an SVG/);
      await assert.rejects(
        run('image.svg_rasterize', { svg: { type: 'text', value: '<svg xmlns="http://www.w3.org/2000/svg"><image href="/etc/hosts.png"/></svg>' } }),
        /external references/
      );
      await assert.rejects(run('image.svg_rasterize', { svg: { type: 'text', value: '<svg><broken' } }), /svg:/);
      const tall = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="1000" viewBox="0 0 10 1000"><rect width="10" height="1000"/></svg>';
      await assert.rejects(run('image.svg_rasterize', { svg: { type: 'text', value: tall } }, { width: 1024 }), /too large/);

      out = (await run('image.text_render', { text: { type: 'text', value: 'Hello' } }, { width: 600, font_size: 80, color: '#ffffff' })).image;
      file = await fileOf(out);
      probe = await probeRaw(file);
      assert.equal(probe.width, 600);
      assert.ok(probe.height >= 80);
      assert.equal(hasAlpha(probe), true, 'text renders on a transparent background');
      assert.equal((await pixelAt(file, 2, 2))[3], 0);
      out = (await run('image.text_render', { text: { type: 'text', value: 'Boxed' } }, { width: 300, height: 200, align: 'left' })).image;
      probe = await probeRaw(await fileOf(out));
      assert.deepEqual([probe.width, probe.height], [300, 200]);
      await assert.rejects(run('image.text_render', { text: { type: 'text', value: '   ' } }), /nothing to render/);
      // an emoji would turn the whole text into boxes: it is left out, and a text of emoji only is refused with the reason
      const withEmoji = (await run('image.text_render', { text: { type: 'text', value: 'Müller 😀 ok' } }, { width: 600, font_size: 80 })).image;
      const withoutEmoji = (await run('image.text_render', { text: { type: 'text', value: 'Müller ok' } }, { width: 600, font_size: 80 })).image;
      assert.ok((await fsp.readFile(await fileOf(withEmoji))).equals(await fsp.readFile(await fileOf(withoutEmoji))), 'the text is drawn as without the emoji');
      await assert.rejects(run('image.text_render', { text: { type: 'text', value: '😀🚀' } }), /emoji cannot be drawn/);
    }

    /* ----- ledger: outputs are ordinary assets, scratch dirs are gone ----- */
    {
      const ledger = await store.readLedger(sessionId);
      assert.ok(ledger.every((entry) => !entry.pending), 'no pending reservations are left behind');
      const generated = ledger.filter((entry) => entry.kind !== 'upload');
      assert.ok(generated.length > 60);
      assert.ok(generated.every((entry) => entry.cost === 0 && typeof entry.file === 'string'));
      const names = await fsp.readdir(store.sessionAssetDir(sessionId));
      assert.deepEqual(names.filter((name) => name.startsWith('.')), [], 'scratch directories are removed');
    }

    /* ----- failures clean up ----- */
    {
      const corrupt = await store.saveAsset(sessionId, { kind: 'upload', buffer: Buffer.from('not an image'), ext: '.png', prompt: 'corrupt', cost: null });
      const corruptValue = await assets.valueFromAsset(sessionId, corrupt.id);
      const count = (await store.readLedger(sessionId)).length;
      await assert.rejects(run('image.blur', { image: corruptValue }), /ffprobe|ffmpeg|Invalid/i);
      assert.equal((await store.readLedger(sessionId)).length, count, 'a failed op adds no ledger entry');
      const names = await fsp.readdir(store.sessionAssetDir(sessionId));
      assert.deepEqual(names.filter((name) => name.startsWith('.')), [], 'scratch directory removed after an error');
    }

    /* ----- abort kills a long ffmpeg process ----- */
    {
      const longController = new AbortController();
      const startedAt = Date.now();
      // 10 minutes of zooming video: far longer than the test, so only an abort can end it in time
      const running = run('image.to_video', { image: blue }, { duration: 600, fps: 60, zoom: 'in' }, longController.signal);
      await sleep(800);
      longController.abort();
      await assert.rejects(running, (err) => err.name === 'AbortError');
      assert.ok(Date.now() - startedAt < 10000, 'the abort ended the op early');
      await sleep(100);
      const names = await fsp.readdir(store.sessionAssetDir(sessionId));
      assert.deepEqual(names.filter((name) => name.startsWith('.')), [], 'scratch directory removed after an abort');
      const stillRunning = await execFileAsync('pgrep', ['-f', 'zoompan=z=.1\\+0\\.2\\*on/36000']).then(() => true, () => false);
      assert.equal(stillRunning, false, 'no orphaned ffmpeg process');
    }

    /* ----- engine integration ----- */
    {
      const engine = createEngine({
        store: wfStore,
        registry,
        events: bus,
        getConfig: () => ({}),
        limits: { jobPollMs: 20 }
      });
      const node = (id, type, nodeParams = {}, x = 0) => ({ id, type, typeVersion: 1, x, y: 0, params: nodeParams });
      const edge = (id, from, fromPort, to, toPort) => ({ id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
      // input nodes only accept assets of their own workflow: give the chain its own copy
      const { workflow: wf } = await wfStore.createWorkflow({ name: 'Edit chain', graph: { nodes: [], edges: [] } });
      created.push(wf.id);
      const ownBlue = await assets.copyAsset(sessionId, blue.assetId, wf.sessionId);
      await wfStore.saveGraph(wf.id, {
        baseRev: wf.rev,
        graph: {
          nodes: [
            node('n1', 'input.image', { asset: ownBlue }),
            node('n2', 'image.resize', { width: 160, height: 160, fit: 'cover' }, 300),
            node('n3', 'image.transform', { rotate: '90' }, 600),
            node('n4', 'media.info', {}, 900),
            node('n5', 'output.result', { label: 'Result' }, 1200)
          ],
          edges: [
            edge('e1', 'n1', 'image', 'n2', 'image'),
            edge('e2', 'n2', 'image', 'n3', 'image'),
            edge('e3', 'n3', 'image', 'n4', 'media'),
            edge('e4', 'n3', 'image', 'n5', 'inputs')
          ]
        }
      });
      const plan = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(plan.valid, true, JSON.stringify(plan.issues));
      assert.equal(plan.totals.paidNodes, 0);
      const record = await engine.whenFinished(wf.id, await engine.start(wf.id, { mode: 'all', user: 'tester' }));
      assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
      const results = await wfStore.readResults(wf.id);
      const resized = results.nodes.n2.history[0].variants[0].image;
      assert.equal(resized.sessionId, wf.sessionId);
      const dimsOf = await probeRaw(await fileOf(resized));
      assert.deepEqual([dimsOf.width, dimsOf.height], [160, 160]);
      assert.equal(results.nodes.n4.history[0].variants[0].width.value, 160);
      assert.equal(results.nodes.n2.history[0].cost.usd, null, 'local ops report no cost');
      const cached = await engine.whenFinished(wf.id, await engine.start(wf.id, { mode: 'all' }));
      assert.equal(cached.nodes.n3.status, 'cached');

      // an unavailable ffmpeg fails the node with a clear reason and skips descendants
      withEnv('FFMPEG_PATH', '/definitely/not/here/ffmpeg');
      const forced = await engine.plan(wf.id, { mode: 'node', nodeIds: ['n2'], force: true });
      assert.equal(forced.nodes.n2.status, 'unavailable');
      assert.match(forced.nodes.n2.reason, /ffmpeg/);
      restoreAll();
    }
  } finally {
    restoreAll();
    for (const id of created) await wfStore.deleteWorkflow(id).catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  testPureBuilders();
  testTextAndSvgHelpers();
  testRegistry();
  testAvailability();
  await testRunProcessAbort();
  if (!ffmpeg.binaries().available) {
    console.log('SKIP ffmpeg fehlt (nur reine Builder-Tests gelaufen)');
    console.log('test-nodes-ffmpeg.js: ok');
    return;
  }
  await testWithFfmpeg();
  console.log('test-nodes-ffmpeg.js: ok');
}

main().catch((err) => {
  restoreAll();
  console.error(err);
  process.exit(1);
});
