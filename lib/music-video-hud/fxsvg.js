'use strict';

// The SVG filters of the beat effects (WP45) for the page of a chunk: the markup of five filters that the effects put on the wrapper of the footage
// (#fx, effects.js view()) and the displacement maps they read, as small PNG images in data URLs. A displacement map moves every pixel by the colour
// of the map at its place (red: sideways, green: up and down, 128 is no move); the maps are smooth, so a small image scaled to the picture is enough.
//   fx-bulge    the lens bulge on the kick: the middle is pulled out, nothing moves at the middle and at the edges (fx-bulge-d: scale in px)
//   fx-wave     a wave across the rows (fx-wave-i: y of the map, which moves; fx-wave-d: scale)
//   fx-zoom     a zoom blur: the mean of the picture and three copies pulled to the middle by a third, two thirds and all of the scale (fx-zoom-1..3)
//   fx-blur     a blur sideways (fx-blur-g: stdDeviation "x 0"); Chrome darkens the edges (edgeMode is not drawn), the zoom of effects.js pushes them out
//   fx-chroma   chromatic edges: the red and the blue channel pulled to the middle by different amounts, more at the corners, nothing at the middle
//               (fx-chroma-r, fx-chroma-b: scale)
// The values are set for every frame by the runtime (runtime.fx.browser.js). Checked in HyperFrames 0.8.139: a filter on an element round the footage
// changes exactly the frame it is set for (the frame of the footage is put into the page after the timeline is moved and before the frame is taken),
// also the first frame a filter is used in (its map is there in time).
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

// A PNG (8 bit RGB) of width x height whose pixel (x, y) is pixel(x, y) -> [r, g, b]
function png(width, height, pixel) {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw.set([r, g, b], y * row + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

const dataUrl = (buffer) => `data:image/png;base64,${buffer.toString('base64')}`;
// -1..1 -> the byte of the map (128 is no move)
const byte = (value) => Math.max(0, Math.min(255, Math.round(128 + 127 * Math.max(-1, Math.min(1, value)))));
// the place of a pixel of a map of w x h as -1..1 from the middle
const unit = (x, size) => ((x + 0.5) / size) * 2 - 1;

const MAP = { width: 96, height: 54 };

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
  made = { bulge: dataUrl(bulge), radial: dataUrl(radial), edge: dataUrl(edge), wave: dataUrl(wave) };
  return made;
}

// The <svg> with the filters, for the page (inside #main-composition, before the stage).
function svgDefs() {
  const m = maps();
  const image = (href, extra = '') => `<feImage href="${href}" x="0" y="0" width="1920" height="1080" preserveAspectRatio="none" result="m"${extra}/>`;
  const box = 'x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"';
  const disp = (id, input, result) => `<feDisplacementMap id="${id}" in="${input}" in2="m" scale="0" xChannelSelector="R" yChannelSelector="G"${result ? ` result="${result}"` : ''}/>`;
  const only = (input, channel, result) => {
    const rows = ['0 0 0 0 0', '0 0 0 0 0', '0 0 0 0 0', '0 0 0 1 0'];
    rows[channel] = ['1 0 0 0 0', '0 1 0 0 0', '0 0 1 0 0'][channel];
    return `<feColorMatrix in="${input}" type="matrix" values="${rows.join(' ')}" result="${result}"/>`;
  };
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
    '</defs></svg>'
  );
}

module.exports = { svgDefs, maps, png, MAP };
