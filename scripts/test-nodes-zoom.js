'use strict';

// Tests for the motions of the node "Still image zoom (local)" (image.to_video): the pan motions, `alternate` and `varied` (by the
// position of the item in a list) and the parallax with a depth map. The builders are checked as text; a run on a real ffmpeg
// (lavfi sources) checks length, size, and with a pixel comparison the DIRECTION of every motion and that the near part of a
// synthetic depth map moves further than the far one. Local and free: no network, no provider.

const assert = require('assert/strict');
const ffmpeg = require('../lib/ffmpeg');
const ops = require('../lib/nodes/ffmpeg-ops');
const { createEditHarness } = require('./support/edit-harness');

const probeOf = (width, height, extra = {}) => ({ video: { codec: 'h264', width, height, fps: 25 }, audio: null, duration: null, ...extra });

/* ---------- the builders ---------- */

function testBuilders(h) {
  const definition = h.def('image.to_video');
  assert.deepEqual(
    definition.params.find((param) => param.id === 'zoom').options,
    ['none', 'in', 'out', 'pan_left', 'pan_right', 'pan_up', 'pan_down', 'alternate', 'varied', 'parallax_left', 'parallax_right', 'parallax_in']
  );
  assert.deepEqual(ops.ZOOM_MODES, definition.params.find((param) => param.id === 'zoom').options);
  const strength = definition.params.find((param) => param.id === 'parallax_strength');
  assert.deepEqual([strength.kind, strength.min, strength.max, strength.default], ['slider', 0, 100, 30]);
  assert.deepEqual(definition.inputs.map((port) => [port.id, port.type, Boolean(port.required)]), [
    ['image', 'image', true],
    ['audio', 'audio', false],
    ['depth', 'image', false],
    ['duration', 'number', false]
  ]);
  assert.deepEqual(h.registry.checkParams(definition, h.params('image.to_video', { zoom: 'parallax_in', parallax_strength: 100 })), []);
  assert.ok(h.registry.checkParams(definition, { ...h.params('image.to_video'), zoom: 'spin' }).length > 0, 'an unknown motion is refused');
  assert.equal(h.params('image.to_video', { parallax_strength: 101 }).parallax_strength, 100, 'the strength is kept inside 0 to 100');

  // the position of the item counts in the key where the result depends on it
  assert.equal(definition.itemIndexInKey({ zoom: 'alternate' }), true);
  assert.equal(definition.itemIndexInKey({ zoom: 'varied' }), true);
  for (const zoom of ['none', 'in', 'out', 'pan_left', 'pan_right', 'pan_up', 'pan_down', 'parallax_left', 'parallax_right', 'parallax_in']) {
    assert.equal(definition.itemIndexInKey({ zoom }), false, zoom);
  }

  // alternate: in, out, in, ...; varied: in, pan_right, out, pan_left, in, ...; outside a list (undefined) the index is 0
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => ops.resolveMotion('alternate', i)), ['in', 'out', 'in', 'out', 'in']);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => ops.resolveMotion('varied', i)), ['in', 'pan_right', 'out', 'pan_left', 'in', 'pan_right', 'out', 'pan_left']);
  assert.equal(ops.resolveMotion('alternate', undefined), 'in');
  assert.equal(ops.resolveMotion('varied', undefined), 'in');
  assert.equal(ops.resolveMotion('pan_up', 3), 'pan_up', 'a fixed motion ignores the position');

  // the filter chains: the old ones are unchanged, the pans are zoompan at a constant zoom 1.15
  const build = (zoom, opts = {}, raw = {}) => ops.buildImageToVideo(h.params('image.to_video', { duration: 2, fps: 25, zoom, ...raw }), [probeOf(320, 180)], opts);
  assert.equal(
    build('in').chain,
    "scale=640:360:flags=lanczos,zoompan=z='1+0.2*on/50':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=320x180:fps=25,setsar=1,scale=out_range=tv,format=yuv420p"
  );
  const panChain = (x, y) => `scale=640:360:flags=lanczos,zoompan=z='1.15':x='${x}':y='${y}':d=1:s=320x180:fps=25,setsar=1,scale=out_range=tv,format=yuv420p`;
  assert.equal(build('pan_right').chain, panChain('(iw-iw/zoom)*on/49', 'ih/2-(ih/zoom/2)'));
  assert.equal(build('pan_left').chain, panChain('(iw-iw/zoom)*(1-on/49)', 'ih/2-(ih/zoom/2)'));
  assert.equal(build('pan_down').chain, panChain('iw/2-(iw/zoom/2)', '(ih-ih/zoom)*on/49'));
  assert.equal(build('pan_up').chain, panChain('iw/2-(iw/zoom/2)', '(ih-ih/zoom)*(1-on/49)'));
  assert.equal(build('alternate', { itemIndex: 0 }).chain, build('in').chain);
  assert.equal(build('alternate', { itemIndex: 3 }).chain, build('out').chain);
  assert.equal(build('varied', { itemIndex: 1 }).chain, build('pan_right').chain);
  assert.equal(build('varied', { itemIndex: 3 }).chain, build('pan_left').chain);
  assert.equal(build('alternate').chain, build('in').chain, 'no index: 0');
  for (const zoom of ['pan_left', 'pan_right', 'pan_up', 'pan_down']) assert.deepEqual(build(zoom).outputs[0].args, ['-t', '2']);
  assert.equal(build('pan_right').notes.length, 0);

  // parallax: a graph with displace and a geq map that depends on T; the depth map is the next input after the image
  const withDepth = (zoom, raw = {}, infos = [probeOf(320, 180), probeOf(100, 60)]) =>
    ops.buildImageToVideo(h.params('image.to_video', { duration: 2, fps: 25, zoom, ...raw }), infos, { depth: true });
  for (const zoom of ['parallax_left', 'parallax_right', 'parallax_in']) {
    const spec = withDepth(zoom);
    assert.match(spec.graph, /\[1:v\]scale=160:90:flags=bilinear,format=gbrp,gblur=sigma=2,split=2\[dx\]\[dy\]/, zoom);
    assert.match(spec.graph, /\[src\]\[xmap\]\[ymap\]displace=edge=smear,zoompan=/, zoom);
    assert.match(spec.graph, /geq=r='clip\(.*T\/2.*,0,255\)'/, `${zoom}: the map changes with the time`);
    assert.deepEqual(spec.inputOpts, [['-loop', '1', '-framerate', '25'], ['-loop', '1', '-framerate', '25']], 'the depth map is a looped image as well');
    assert.deepEqual(spec.outputs[0].maps, ['[out]']);
    assert.deepEqual(spec.notes, []);
  }
  // strength: 30 % of 5 % of the width in the working size (640): 10 px; 100 % gives 32 px
  assert.match(withDepth('parallax_right').graph, /128\+10\*r\(X,Y\)\/255\*min\(1,T\/2\)/);
  assert.match(withDepth('parallax_left').graph, /128\+-10\*r\(X,Y\)\/255/);
  assert.match(withDepth('parallax_right', { parallax_strength: 100 }).graph, /128\+32\*r\(X,Y\)/);
  assert.match(withDepth('parallax_in').graph, /128-\(2\*X\/W-1\)\*10\*r\(X,Y\)\/255\*min\(1,T\/2\)/);
  assert.match(withDepth('parallax_in').graph, /128-\(2\*Y\/H-1\)\*10\*r\(X,Y\)\/255\*min\(1,T\/2\)/);
  // the displacement stays inside what displace can take (+-127 pixels) for a huge picture at full strength
  const huge = ops.buildImageToVideo(h.params('image.to_video', { duration: 2, fps: 25, zoom: 'parallax_right', parallax_strength: 100 }), [probeOf(7680, 4320), probeOf(100, 100)], { depth: true });
  assert.match(huge.graph, /128\+120\*r\(X,Y\)/);
  // with audio: the audio is the second input, the depth map the third
  const audioSpec = ops.buildImageToVideo(h.params('image.to_video', { duration: 2, fps: 25, zoom: 'parallax_right' }), [probeOf(320, 180), { audio: { codec: 'aac' }, duration: 2 }, probeOf(100, 60)], { depth: true });
  assert.match(audioSpec.graph, /\[2:v\]scale=/);
  assert.deepEqual(audioSpec.outputs[0].maps, ['[out]', '1:a:0']);
  assert.deepEqual(audioSpec.inputOpts, [['-loop', '1', '-framerate', '25'], [], ['-loop', '1', '-framerate', '25']]);

  // without a depth map: the matching travel or the zoom, with a line for the log
  for (const [zoom, fallback] of [['parallax_left', 'pan_left'], ['parallax_right', 'pan_right'], ['parallax_in', 'in']]) {
    const spec = build(zoom);
    assert.equal(spec.chain, build(fallback).chain, `${zoom} without depth is ${fallback}`);
    assert.deepEqual(spec.notes, [`No depth map is connected: ${zoom} becomes ${fallback}`]);
  }
  // strength 0 does not need the map either
  {
    const flat = h.params('image.to_video', { duration: 2, fps: 25, zoom: 'parallax_right', parallax_strength: 0 });
    const spec = ops.buildImageToVideo(flat, [probeOf(320, 180)], { depth: ops.usesDepth(flat, { depth: {} }) });
    assert.equal(spec.chain, build('pan_right').chain, 'strength 0 needs no map');
    assert.deepEqual(spec.notes, ['Parallax strength is 0: parallax_right becomes pan_right']);
  }
  assert.equal(ops.usesDepth(h.params('image.to_video', { zoom: 'parallax_right' }), { depth: {} }), true);
  assert.equal(ops.usesDepth(h.params('image.to_video', { zoom: 'parallax_right', parallax_strength: 0 }), { depth: {} }), false);
  assert.equal(ops.usesDepth(h.params('image.to_video', { zoom: 'in' }), { depth: {} }), false, 'a map is only read by a parallax motion');
  assert.equal(ops.usesDepth(h.params('image.to_video', { zoom: 'parallax_in' }), {}), false);

  // validate: a warning for a parallax motion without a map, none with one or for the other motions
  const issues = (raw, connected) => definition.validate(h.params('image.to_video', raw), { depth: { connected, count: connected ? 1 : 0 } });
  assert.equal(issues({ zoom: 'parallax_left' }, false)[0].level, 'warning');
  assert.equal(issues({ zoom: 'parallax_left' }, false)[0].code, 'PARALLAX_NO_DEPTH');
  assert.deepEqual(issues({ zoom: 'parallax_left' }, true), []);
  assert.deepEqual(issues({ zoom: 'pan_left' }, false), []);
}

/* ---------- a real ffmpeg ---------- */

// Mean difference per byte of two frames (the encoder is lossy: the same picture can differ a little between two files).
function difference(a, b) {
  assert.equal(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

// Where does the content of `area` of frame a sit in frame b? Returns { dx, dy }: b(x + dx, y + dy) is a(x, y) (a negative dx: moved left).
function shiftOf(a, b, width, height, area, range = 70) {
  const gray = (frame, x, y) => {
    const at = (y * width + x) * 3;
    return (frame[at] + frame[at + 1] + frame[at + 2]) / 3;
  };
  let best = { dx: 0, dy: 0, error: Infinity };
  for (let dy = -range; dy <= range; dy += 1) {
    for (let dx = -range; dx <= range; dx += 1) {
      let sum = 0;
      let count = 0;
      for (let y = area.y0; y < area.y1; y += 2) {
        const ys = y + dy;
        if (ys < 0 || ys >= height) continue;
        for (let x = area.x0; x < area.x1; x += 2) {
          const xs = x + dx;
          if (xs < 0 || xs >= width) continue;
          const d = gray(a, x, y) - gray(b, xs, ys);
          sum += d * d;
          count += 1;
        }
      }
      if (count > 200 && sum / count < best.error) best = { dx, dy, error: sum / count };
    }
  }
  return best;
}

async function testRun(h) {
  const W = 320;
  const H = 180;
  // a picture without symmetry or repetition, so a shift has one answer
  await h.ff(['-f', 'lavfi', '-i', `color=c=gray:s=${W}x${H},format=rgb24,geq=lum='128+60*sin(X/7)*cos(Y/5)+50*sin((X+Y)/13)+25*sin(X*Y/900)':cb='128+40*sin(X/11)':cr='128+40*cos(Y/9)',format=rgb24`, '-frames:v', '1', h.src('texture.png')]);
  // the depth map: the left half near (white), the right half far (black)
  await h.ff(['-f', 'lavfi', '-i', `color=c=white:s=${W / 2}x${H},format=rgb24`, '-f', 'lavfi', '-i', `color=c=black:s=${W / 2}x${H},format=rgb24`, '-filter_complex', 'hstack', '-frames:v', '1', h.src('depth.png')]);
  await h.ff(['-f', 'lavfi', '-i', 'color=c=white:s=64x36,format=rgb24', '-frames:v', '1', h.src('depth-small.png')]);
  // for the border test: every column differs from its neighbour (a repeated column shows as a run of equal ones), everything near
  await h.ff(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H},format=rgb24,geq=r='mod(X*37,256)':g='mod(X*11+Y,256)':b='mod(X*91,256)'`, '-frames:v', '1', h.src('stripes.png')]);
  await h.ff(['-f', 'lavfi', '-i', `color=c=white:s=${W}x${H},format=rgb24`, '-frames:v', '1', h.src('depth-near.png')]);
  // two bright squares on a dark picture, one in the left and one in the right half: their positions follow a zoom, which a
  // search for a shifted block cannot (a zoom changes the size of what it looks for)
  await h.ff([
    '-f', 'lavfi', '-i', `color=c=0x202020:s=${W}x${H},format=rgb24,drawbox=x=50:y=78:w=24:h=24:color=white:t=fill,drawbox=x=246:y=78:w=24:h=24:color=white:t=fill`,
    '-frames:v', '1', h.src('marker.png')
  ]);
  await h.ff(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100', '-t', '2', h.src('voice.wav')]);
  const texture = await h.upload('texture.png', '.png');
  const marker = await h.upload('marker.png', '.png');
  const depth = await h.upload('depth.png', '.png');
  const smallDepth = await h.upload('depth-small.png', '.png');
  const stripes = await h.upload('stripes.png', '.png');
  const allNear = await h.upload('depth-near.png', '.png');
  const voice = await h.upload('voice.wav', '.wav');
  const definition = h.def('image.to_video');

  const seconds = 1.2;
  const logs = [];
  const execute = async (inputs, raw, itemIndex) => {
    const ctx = { ...h.makeCtx(), log: (line) => logs.push(line) };
    if (itemIndex !== undefined) ctx.itemIndex = itemIndex;
    const result = await definition.execute(ctx, inputs, h.registry.normalizeParams(definition, { duration: seconds, fps: 25, ...raw }));
    return result.variants[0].video;
  };
  // first and last frame of a run
  const frames = async (video) => {
    const file = await h.fileOf(video);
    const probe = await h.probe(file);
    assert.deepEqual([probe.width, probe.height], [W, H]);
    assert.ok(Math.abs(probe.duration - seconds) < 0.15, `length ${probe.duration}`);
    assert.equal(probe.videoCodec, 'h264');
    return { first: await h.frame(file, 0, W, H), last: await h.frame(file, seconds - 0.05, W, H), file };
  };
  const centre = { x0: 110, y0: 60, x1: 210, y1: 120 };
  const leftArea = { x0: 30, y0: 60, x1: 110, y1: 120 };
  const rightArea = { x0: 210, y0: 60, x1: 290, y1: 120 };
  const moved = async (video, area = centre) => {
    const { first, last } = await frames(video);
    return shiftOf(first, last, W, H, area);
  };

  // a still image does not move (the control of the measurements below)
  {
    const still = await moved(await execute({ image: texture }, { zoom: 'none' }));
    assert.ok(Math.abs(still.dx) <= 1 && Math.abs(still.dy) <= 1, `none: ${JSON.stringify(still)}`);
  }

  // the direction of every pan: the view travels the named way, so the content moves the other way
  const pans = {
    pan_right: (s) => s.dx <= -20 && Math.abs(s.dy) <= 2,
    pan_left: (s) => s.dx >= 20 && Math.abs(s.dy) <= 2,
    pan_down: (s) => s.dy <= -10 && Math.abs(s.dx) <= 2,
    pan_up: (s) => s.dy >= 10 && Math.abs(s.dx) <= 2
  };
  for (const [zoom, ok] of Object.entries(pans)) {
    const shift = await moved(await execute({ image: texture }, { zoom }));
    assert.ok(ok(shift), `${zoom}: ${JSON.stringify(shift)}`);
  }
  // a pan is a constant zoom 1.15: the picture is bigger from the first frame on (the first frame is the left edge of the zoomed picture)
  {
    const { first } = await frames(await execute({ image: texture }, { zoom: 'pan_right' }));
    const plain = await frames(await execute({ image: texture }, { zoom: 'none' }));
    const scale = shiftOf(plain.first, first, W, H, { x0: 20, y0: 40, x1: 120, y1: 100 }, 30);
    assert.ok(scale.dx <= -1 || scale.error > 1, 'the first frame of a pan is already zoomed');
  }
  // where the two squares sit in the first and in the last frame: the centre (x) of the bright pixels of each half
  const squares = async (video) => {
    const { first, last } = await frames(video);
    const centre = (frame, from, to) => {
      let sum = 0;
      let count = 0;
      for (let y = 0; y < H; y += 1) {
        for (let x = from; x < to; x += 1) {
          if (frame[(y * W + x) * 3] > 200) {
            sum += x;
            count += 1;
          }
        }
      }
      assert.ok(count > 100, 'the square is in the picture');
      return sum / count;
    };
    const t = { left: [centre(first, 0, W / 2), centre(last, 0, W / 2)], right: [centre(first, W / 2, W), centre(last, W / 2, W)] };
    const leftMove = t.left[1] - t.left[0];
    const rightMove = t.right[1] - t.right[0];
    // spread > 0: the squares move apart (zoom in), < 0: towards each other (zoom out); pan: both go the same way
    return { leftMove, rightMove, spread: rightMove - leftMove, pan: (leftMove + rightMove) / 2 };
  };

  // in and out: the content spreads from the centre or runs together
  {
    const zoomIn = await squares(await execute({ image: marker }, { zoom: 'in' }));
    assert.ok(zoomIn.leftMove <= -4 && zoomIn.rightMove >= 4, `in: ${JSON.stringify(zoomIn)}`);
    const zoomOut = await squares(await execute({ image: marker }, { zoom: 'out' }));
    assert.ok(zoomOut.leftMove >= 4 && zoomOut.rightMove <= -4, `out: ${JSON.stringify(zoomOut)}`);
  }

  // alternate and varied follow the position of the item (ctx.itemIndex); without one (outside a list) it is 0
  {
    const spread = async (zoom, index) => {
      const t = await squares(await execute({ image: marker }, { zoom }, index));
      if (t.spread >= 8 && Math.abs(t.pan) < 4) return 'in';
      if (t.spread <= -8 && Math.abs(t.pan) < 4) return 'out';
      if (Math.abs(t.spread) < 4 && t.pan <= -20) return 'pan_right';
      if (Math.abs(t.spread) < 4 && t.pan >= 20) return 'pan_left';
      return `unknown ${JSON.stringify(t)}`;
    };
    assert.deepEqual(await Promise.all([0, 1, 2, 3].map((index) => spread('alternate', index))), ['in', 'out', 'in', 'out']);
    assert.equal(await spread('alternate', undefined), 'in', 'outside a list the index is 0');
    assert.deepEqual(await Promise.all([0, 1, 2, 3, 4].map((index) => spread('varied', index))), ['in', 'pan_right', 'out', 'pan_left', 'in']);
    assert.equal(await spread('varied'), 'in');
  }

  // parallax with the depth map: the near half (left) moves further than the far half (right)
  {
    const near = (video) => moved(video, leftArea);
    const far = (video) => moved(video, rightArea);
    const right = await execute({ image: texture, depth }, { zoom: 'parallax_right', parallax_strength: 100 });
    const rightNear = await near(right);
    const rightFar = await far(right);
    assert.ok(rightNear.dx < 0 && rightFar.dx < 0, `parallax_right moves the content left: ${JSON.stringify([rightNear, rightFar])}`);
    assert.ok(Math.abs(rightNear.dx) >= Math.abs(rightFar.dx) + 4, `the near part moves further: ${JSON.stringify([rightNear, rightFar])}`);
    const left = await execute({ image: texture, depth }, { zoom: 'parallax_left', parallax_strength: 100 });
    const leftNear = await near(left);
    const leftFar = await far(left);
    assert.ok(leftNear.dx > 0 && leftFar.dx > 0, `parallax_left moves the content right: ${JSON.stringify([leftNear, leftFar])}`);
    assert.ok(Math.abs(leftNear.dx) >= Math.abs(leftFar.dx) + 4, `the near part moves further: ${JSON.stringify([leftNear, leftFar])}`);
    // parallax_in: the content spreads from the centre; the near square (left) moves further out than the far one (right)
    const dolly = await squares(await execute({ image: marker, depth }, { zoom: 'parallax_in', parallax_strength: 100 }));
    assert.ok(dolly.leftMove < 0 && dolly.rightMove > 0, `parallax_in spreads from the centre: ${JSON.stringify(dolly)}`);
    assert.ok(Math.abs(dolly.leftMove) >= Math.abs(dolly.rightMove) + 3, `the near part spreads more: ${JSON.stringify(dolly)}`);
    const flatDolly = await squares(await execute({ image: marker }, { zoom: 'in' }));
    assert.ok(Math.abs(flatDolly.leftMove + flatDolly.rightMove) < 2, 'the plain zoom spreads both squares evenly');
    // the strength counts: 0 % is the plain travel (no depth read), a small value moves the near part less than a large one
    const weak = await near(await execute({ image: texture, depth }, { zoom: 'parallax_right', parallax_strength: 20 }));
    assert.ok(Math.abs(weak.dx) < Math.abs(rightNear.dx), `20 % moves less than 100 %: ${JSON.stringify([weak, rightNear])}`);
    // the first frame is the picture before any displacement: the same for every strength
    const a = await frames(right);
    const b = await frames(await execute({ image: texture, depth }, { zoom: 'parallax_right', parallax_strength: 20 }));
    assert.ok(difference(a.first, b.first) < 1.5, `both start from the same frame (${difference(a.first, b.first)})`);
    // the displacement must not smear the border into the picture: in the last frame, with everything near (the worst case),
    // no run of equal columns at the border (a repeated column is what displace does with `edge=smear` past the picture)
    for (const zoom of ['parallax_right', 'parallax_left', 'parallax_in']) {
      for (const strength of [30, 100]) {
        const { last } = await frames(await execute({ image: stripes, depth: allNear }, { zoom, parallax_strength: strength }));
        const column = (x) => {
          let sum = 0;
          for (let y = 0; y < H; y += 1) sum += last[(y * W + x) * 3 + 1];
          return sum;
        };
        const run = (from, step) => {
          let n = 0;
          for (let x = from; x + step >= 0 && x + step < W; x += step) {
            if (Math.abs(column(x) - column(x + step)) < H) n += 1;
            else break;
          }
          return n;
        };
        assert.ok(run(0, 1) <= 2 && run(W - 1, -1) <= 2, `${zoom} at ${strength} %: columns repeated at the border (left ${run(0, 1)}, right ${run(W - 1, -1)})`);
      }
    }
    // a map of another size is scaled to the picture; with sound the audio stays the second input and the length follows it
    logs.length = 0;
    const small = await execute({ image: texture, depth: smallDepth }, { zoom: 'parallax_right' });
    await frames(small);
    const withSound = await execute({ image: texture, audio: voice, depth }, { zoom: 'parallax_left', match_audio: true });
    const soundProbe = await h.probe(await h.fileOf(withSound));
    assert.ok(Math.abs(soundProbe.duration - 2) < 0.2, `length of the audio: ${soundProbe.duration}`);
    assert.equal(soundProbe.hasAudio, true);
    assert.equal(logs.length, 0, 'a map is connected: no fallback line');
  }

  // without a depth map the motion falls back to the matching travel (the same picture) and says so in the log
  {
    for (const [zoom, fallback] of [['parallax_right', 'pan_right'], ['parallax_left', 'pan_left'], ['parallax_in', 'in']]) {
      logs.length = 0;
      const video = await frames(await execute({ image: texture }, { zoom }));
      assert.deepEqual(logs, [`No depth map is connected: ${zoom} becomes ${fallback}`]);
      const plain = await frames(await execute({ image: texture }, { zoom: fallback }));
      assert.ok(difference(video.first, plain.first) < 0.5, `${zoom} starts like ${fallback}`);
      assert.ok(difference(video.last, plain.last) < 0.5, `${zoom} ends like ${fallback}`);
    }
    // a map that is connected but not read: strength 0, or a motion that is no parallax
    logs.length = 0;
    await execute({ image: texture, depth }, { zoom: 'parallax_right', parallax_strength: 0 });
    assert.deepEqual(logs, ['Parallax strength is 0: parallax_right becomes pan_right']);
    logs.length = 0;
    await execute({ image: texture, depth }, { zoom: 'in' });
    assert.deepEqual(logs, []);
    // no logs at all for the plain motions
    await execute({ image: texture }, { zoom: 'pan_up' });
    assert.deepEqual(logs, []);
  }
}

async function main() {
  const h = await createEditHarness({ prefix: 'ocd-zoom-', extraRegister: undefined });
  try {
    testBuilders(h);
    if (!ffmpeg.binaries().available) {
      console.log('SKIP ffmpeg fehlt (nur reine Builder-Tests gelaufen)');
    } else {
      await testRun(h);
    }
  } finally {
    await h.cleanup();
  }
  console.log('test-nodes-zoom.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
