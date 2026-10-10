'use strict';

// The SVG filters of the beat effects (WP45, WP49) for the page of a chunk: the markup of the filters that the effects put on the wrapper of the footage
// (#fx) and on the wrapper of the whole picture (#fxall, the HUD included; effects.js view()), the maps they read and the noise texture, as small PNG
// images in data URLs. A displacement map moves every pixel by the colour of the map at its place (red: sideways, green: up and down, 128 is no move).
// On the footage:
//   fx-bulge    the lens bulge on the kick: the middle is pulled out, nothing moves at the middle and at the edges (fx-bulge-d: scale in px)
//   fx-wave     a wave across the rows (fx-wave-i: y of the map, which moves; fx-wave-d: scale)
//   fx-zoom     a zoom blur: the mean of the picture and three copies pulled to the middle by a third, two thirds and all of the scale (fx-zoom-1..3)
//   fx-blur     a blur sideways (fx-blur-g: stdDeviation "x 0"); Chrome darkens the edges (edgeMode is not drawn), the zoom of effects.js pushes them out
//   fx-chroma   chromatic edges: the red and the blue channel pulled to the middle by different amounts, more at the corners, nothing at the middle
//               (fx-chroma-r, fx-chroma-b: scale)
//   fx-smear    the smear: a smooth field of moves that grows (fx-smear-i: x of the field, fx-smear-d: scale); with a held frame it melts like a datamosh
//   fx-split    the RGB split: the red channel moved one way, the blue one the other (fx-split-r, fx-split-b: dx, dy)
//   fx-jitter   the line offset of the scanlines: rows of 4 px moved sideways by a random amount (fx-jitter-i: y of the rows, fx-jitter-d: scale)
//   fx-pixel    pixels: one pixel of every cell, grown to the cell (fx-pixel-dot: x, y; fx-pixel-cell: width, height; fx-pixel-grow: radius)
// On the whole picture:
//   fa-rgb      the RGB split (fa-rgb-r, fa-rgb-b: dx, dy)
//   fa-slices   four horizontal slices moved sideways and a bright seam (fa-sl0..3: y, height, dx; fa-seam: y)
//   fa-blocks0..2  blocks of the picture moved (three layouts of blocks: wide, square, tall), some of them a grey negative (fa-blocks<i>-d: scale)
//   fa-vhs      a VHS tracking band: a band of rows moved sideways and lit, a bright line on top (fa-vhs-i: y of the rows; fa-vhs-d: y, height, scale;
//               fa-vhs-l: y)
//   fa-roll     the picture rolls down: two copies one picture apart and the black bar between them (fa-roll-a, fa-roll-b: dy; fa-roll-bar: y)
// In a style whose glitch is a prism (Kuble) the two RGB splits move an amber and a blue part of the picture instead of the red and the blue channel,
// and the seam, the line of the VHS band and the negative blocks are in its blue (the options of svgDefs); the ids are the same.
// The values are set for every frame by the runtime (runtime.fx.browser.js). Checked in HyperFrames 0.8.139: a filter on an element round the footage or
// round the stage changes exactly the frame it is set for (the frame of the footage is put into the page after the timeline is moved and before the frame
// is taken), also the first frame a filter is used in (its map is there in time); two renders of the same page are the same, byte for byte.
// Runs in Node only (zlib); the page carries the result.

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// A PNG of width x height, 8 bit: RGB, pixel(x, y) -> [r, g, b]; or grey ({ gray: true }), pixel(x, y) -> value
function png(width, height, pixel, { gray = false } = {}) {
  const channels = gray ? 1 : 3;
  const row = width * channels + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = pixel(x, y);
      if (gray) raw[y * row + 1 + x] = value;
      else raw.set(value, y * row + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = gray ? 0 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

const dataUrl = (buffer) => `data:image/png;base64,${buffer.toString('base64')}`;
// -1..1 -> the byte of the map (128 is no move)
const byte = (value) => Math.max(0, Math.min(255, Math.round(128 + 127 * Math.max(-1, Math.min(1, value)))));
// the place of a pixel of a map of w x h as -1..1 from the middle
const unit = (x, size) => ((x + 0.5) / size) * 2 - 1;

// the hash of effects.js and state.js (integers into [0, 1))
function hash(a, b = 0, c = 0) {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}

const MAP = { width: 96, height: 54 };
// the noise texture: a tile of grey noise that the layers repeat and move with every frame
const NOISE = { size: 128 };
// the layouts of the blocks on a map of 480 x 270 (a quarter of the picture): [cell width, cell height] in px of the map
const BLOCK_CELLS = Object.freeze([[32, 9], [20, 18], [12, 27]]);

// the maps, made once
let made = null;
function maps() {
  if (made) return made;
  const { width, height } = MAP;
  // bulge: the place a pixel is taken from is pulled to the middle by (1 - r^2) * r (strongest at r = 0.58, normalised to 1); nothing outside r = 1
  const bulgeNorm = 2 / (3 * Math.sqrt(3));
  const bulge = png(width, height, (x, y) => {
    const u = unit(x, width);
    const v = unit(y, height);
    const r2 = u * u + v * v;
    const k = r2 < 1 ? (1 - r2) / bulgeNorm : 0;
    return [byte(-u * k), byte(-v * k), 128];
  });
  // the pull to the middle, as far as the distance from it (the zoom blur)
  const radial = png(width, height, (x, y) => [byte(-unit(x, width)), byte(-unit(y, height)), 128]);
  // the pull to the middle growing with the square of the distance (the chromatic edges: nothing in the middle where the face mostly is)
  const edge = png(width, height, (x, y) => {
    const u = unit(x, width);
    const v = unit(y, height);
    const r2 = Math.min(2, u * u + v * v) / 2;
    return [byte(-u * r2 * 1.4), byte(-v * r2 * 1.4), 128];
  });
  // the wave: 7 periods of a sine over the height of the map (it is drawn 1260 px high, one period is 180 px, and moved by up to one period)
  const wave = png(4, 126, (_x, y) => [byte(Math.sin(((y + 0.5) / 18) * 2 * Math.PI)), 128, 128]);
  // grey noise, every pixel its own value
  const noise = png(NOISE.size, NOISE.size, (x, y) => Math.floor(hash(x, y, 11) * 256), { gray: true });
  // rows: every row a random move sideways (drawn 2160 px high: rows of 4 px, moved up by up to one picture)
  const rows = png(2, 540, (_x, y) => [byte(2 * hash(y, 5, 3) - 1), 128, 128]);
  // blocks: a fifth of the cells moved sideways (and a little up or down), a twelfth of them marked in blue (they turn into a grey negative)
  const blocks = BLOCK_CELLS.map(([cw, ch], index) =>
    png(480, 270, (x, y) => {
      const cx = Math.floor(x / cw);
      const cy = Math.floor(y / ch);
      const salt = 21 + index * 10;
      const moved = hash(cx, cy, salt) < 0.2;
      const dx = moved ? (hash(cx, cy, salt + 1) < 0.5 ? -1 : 1) * (0.4 + 0.6 * hash(cx, cy, salt + 2)) : 0;
      const dy = moved ? (hash(cx, cy, salt + 3) - 0.5) * 0.3 : 0;
      return [byte(dx), byte(dy), hash(cx, cy, salt + 4) < 0.08 ? 255 : 0];
    })
  );
  // the smear: a smooth field of moves (drawn 2880 px wide, so it can travel a third of the picture)
  const smear = png(48, 18, (x, y) => [byte(2 * hash(x, y, 77) - 1), byte((2 * hash(x, y, 78) - 1) * 0.6), 128]);
  made = {
    bulge: dataUrl(bulge),
    radial: dataUrl(radial),
    edge: dataUrl(edge),
    wave: dataUrl(wave),
    noise: dataUrl(noise),
    rows: dataUrl(rows),
    blocks: blocks.map(dataUrl),
    smear: dataUrl(smear)
  };
  return made;
}

// The <svg> with the filters, for the page (inside #main-composition, before the stage). What the style changes (composition.js; Kuble, as its glitch
// in the post-pass of WP45 did): `light` the colour of the seam of the slices and of the line of the VHS band (white), `prism` the RGB split as a prism
// of amber and blue, `negative` the colour of the negative blocks (white: a grey negative; a colour: dark where the picture is bright).
function svgDefs({ light = '#FFFFFF', prism = false, negative = '#FFFFFF' } = {}) {
  const m = maps();
  const image = (href, extra = '') => `<feImage href="${href}" x="0" y="0" width="1920" height="1080" preserveAspectRatio="none" result="m"${extra}/>`;
  const box = 'x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"';
  const disp = (id, input, result) => `<feDisplacementMap id="${id}" in="${input}" in2="m" scale="0" xChannelSelector="R" yChannelSelector="G"${result ? ` result="${result}"` : ''}/>`;
  const only = (input, channel, result) => {
    const rows = ['0 0 0 0 0', '0 0 0 0 0', '0 0 0 0 0', '0 0 0 1 0'];
    rows[channel] = ['1 0 0 0 0', '0 1 0 0 0', '0 0 1 0 0'][channel];
    return `<feColorMatrix in="${input}" type="matrix" values="${rows.join(' ')}" result="${result}"/>`;
  };
  const add = (a, b, result) => `<feComposite in="${a}" in2="${b}" operator="arithmetic" k2="1" k3="1"${result ? ` result="${result}"` : ''}/>`;
  // the red channel moved by <prefix>-r, the blue one by <prefix>-b, the green one stays. As a prism an amber part of the picture (the red, 0.55 of
  // the green, 0.1 of the blue) moves instead of the red and a blue part (0.3 of the green, 0.9 of the blue) instead of the blue, 0.15 of the green
  // stays: fringes of amber on one side and of blue on the other. The parts add up to the picture, so a split of 0 leaves it as it is.
  const mix = (rows, result) => `<feColorMatrix in="SourceGraphic" type="matrix" values="${rows} 0 0 0 1 0" result="${result}"/>`;
  const parts = prism
    ? [mix('1 0 0 0 0 0 0.55 0 0 0 0 0 0.1 0 0', 'sr'), mix('0 0 0 0 0 0 0.15 0 0 0 0 0 0 0 0', 'sg'), mix('0 0 0 0 0 0 0.3 0 0 0 0 0 0.9 0 0', 'sb')]
    : [only('SourceGraphic', 0, 'sr'), only('SourceGraphic', 1, 'sg'), only('SourceGraphic', 2, 'sb')];
  const split = (prefix) =>
    `<filter id="${prefix}" ${box}>${parts[0]}<feOffset id="${prefix}-r" in="sr" dx="0" dy="0" result="or"/>${parts[1]}` +
    `${parts[2]}<feOffset id="${prefix}-b" in="sb" dx="0" dy="0" result="ob"/>${add('or', 'sg', 'og')}${add('og', 'ob')}</filter>`;
  // the blocks: moved by the map; the cells marked in blue a negative: grey, or dark to `negative` (the brighter the picture, the darker)
  const tint = [1, 3, 5].map((at) => parseInt(negative.slice(at, at + 2), 16) / 255);
  const round = (value) => Math.round(value * 10000) / 10000;
  const neg = tint.map((c) => `${round(-0.3 * c)} ${round(-0.59 * c)} ${round(-0.11 * c)} 0 ${round(c)}`).join(' ');
  const blocks = (index) =>
    `<filter id="fa-blocks${index}" ${box}>${image(m.blocks[index])}${disp(`fa-blocks${index}-d`, 'SourceGraphic', 'd')}` +
    `<feColorMatrix in="d" type="matrix" values="${neg} 0 0 0 1 0" result="neg"/>` +
    '<feColorMatrix in="m" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0" result="mask"/><feComposite in="neg" in2="mask" operator="in" result="bad"/>' +
    '<feMerge><feMergeNode in="d"/><feMergeNode in="bad"/></feMerge></filter>';
  return (
    '<svg id="fx-defs" width="0" height="0" aria-hidden="true"><defs>' +
    `<filter id="fx-bulge" ${box}>${image(m.bulge)}${disp('fx-bulge-d', 'SourceGraphic')}</filter>` +
    `<filter id="fx-wave" ${box}><feImage id="fx-wave-i" href="${m.wave}" x="0" y="0" width="1920" height="1260" preserveAspectRatio="none" result="m"/>${disp('fx-wave-d', 'SourceGraphic')}</filter>` +
    `<filter id="fx-zoom" ${box}>${image(m.radial)}${disp('fx-zoom-1', 'SourceGraphic', 'z1')}${disp('fx-zoom-2', 'SourceGraphic', 'z2')}${disp('fx-zoom-3', 'SourceGraphic', 'z3')}` +
    '<feComposite in="SourceGraphic" in2="z1" operator="arithmetic" k2="0.5" k3="0.5" result="za"/><feComposite in="z2" in2="z3" operator="arithmetic" k2="0.5" k3="0.5" result="zb"/>' +
    '<feComposite in="za" in2="zb" operator="arithmetic" k2="0.5" k3="0.5"/></filter>' +
    `<filter id="fx-blur" ${box}><feGaussianBlur id="fx-blur-g" stdDeviation="0 0"/></filter>` +
    `<filter id="fx-chroma" ${box}>${image(m.edge)}${disp('fx-chroma-r', 'SourceGraphic', 'dr')}${only('dr', 0, 'cr')}${disp('fx-chroma-b', 'SourceGraphic', 'db')}${only('db', 2, 'cb')}` +
    `${only('SourceGraphic', 1, 'cg')}<feComposite in="cr" in2="cg" operator="arithmetic" k2="1" k3="1" result="crg"/><feComposite in="crg" in2="cb" operator="arithmetic" k2="1" k3="1"/></filter>` +
    `<filter id="fx-smear" ${box}><feImage id="fx-smear-i" href="${m.smear}" x="0" y="0" width="2880" height="1080" preserveAspectRatio="none" result="m"/>${disp('fx-smear-d', 'SourceGraphic')}</filter>` +
    split('fx-split') +
    `<filter id="fx-jitter" ${box}><feImage id="fx-jitter-i" href="${m.rows}" x="0" y="0" width="1920" height="2160" preserveAspectRatio="none" result="m"/>${disp('fx-jitter-d', 'SourceGraphic')}</filter>` +
    `<filter id="fx-pixel" ${box}><feFlood id="fx-pixel-dot" x="11" y="11" width="2" height="2" flood-color="#000"/><feComposite id="fx-pixel-cell" width="24" height="24"/>` +
    '<feTile result="a"/><feComposite in="SourceGraphic" in2="a" operator="in"/><feMorphology id="fx-pixel-grow" operator="dilate" radius="12"/></filter>' +
    split('fa-rgb') +
    `<filter id="fa-slices" ${box}>${[0, 1, 2, 3].map((i) => `<feOffset id="fa-sl${i}" in="SourceGraphic" dx="0" dy="0" x="0" y="0" width="1920" height="10" result="s${i}"/>`).join('')}` +
    `<feFlood id="fa-seam" flood-color="${light}" flood-opacity="0.85" x="0" y="0" width="1920" height="3" result="seam"/>` +
    '<feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="s0"/><feMergeNode in="s1"/><feMergeNode in="s2"/><feMergeNode in="s3"/><feMergeNode in="seam"/></feMerge></filter>' +
    blocks(0) +
    blocks(1) +
    blocks(2) +
    `<filter id="fa-vhs" ${box}><feImage id="fa-vhs-i" href="${m.rows}" x="0" y="0" width="1920" height="2160" preserveAspectRatio="none" result="m"/>` +
    '<feDisplacementMap id="fa-vhs-d" in="SourceGraphic" in2="m" scale="0" xChannelSelector="R" yChannelSelector="G" x="0" y="0" width="1920" height="100" result="band"/>' +
    '<feComponentTransfer in="band" result="lit"><feFuncR type="linear" slope="1.15" intercept="0.08"/><feFuncG type="linear" slope="1.15" intercept="0.08"/><feFuncB type="linear" slope="1.2" intercept="0.1"/></feComponentTransfer>' +
    `<feFlood id="fa-vhs-l" flood-color="${light}" flood-opacity="0.55" x="0" y="0" width="1920" height="3" result="line"/>` +
    '<feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="lit"/><feMergeNode in="line"/></feMerge></filter>' +
    `<filter id="fa-roll" ${box}><feOffset id="fa-roll-a" in="SourceGraphic" dx="0" dy="0" result="a"/><feOffset id="fa-roll-b" in="SourceGraphic" dx="0" dy="-1080" result="b"/>` +
    '<feFlood id="fa-roll-bar" flood-color="#000000" x="0" y="0" width="1920" height="28" result="bar"/><feMerge><feMergeNode in="a"/><feMergeNode in="b"/><feMergeNode in="bar"/></feMerge></filter>' +
    '</defs></svg>'
  );
}

module.exports = { svgDefs, maps, png, hash, MAP, NOISE, BLOCK_CELLS };
