'use strict';

// The preview image of a 3D model, drawn by the app (lib/glb-preview.js): a GLB in, a PNG with a transparent background out.
//
//   P  the PNG encoder (adaptive filters, CRC) and the PNG reader for textures
//   G  the GLB container, and everything that is refused: Draco, sparse accessors, damaged and cut-off files, wrong indices
//   S  the picture: texture and its orientation, vertex colours, node transforms, a material without texture, transparent
//      corners, the fit into the square with a margin
//   T  textures: embedded PNG, JPEG through ffmpeg (skipped without ffmpeg), no ffmpeg, an address outside the file that is
//      never read (a local server counts the requests)
//   C  the child process: file in, PNG out, one render at a time, a timeout, a missing or damaged file
//
// The GLBs are made here (no model file in the repository). Nothing touches the data folders; the only network is a local
// server on 127.0.0.1 that has to stay unvisited.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const preview = require('../lib/glb-preview');
const ffmpegLib = require('../lib/ffmpeg');

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/* ---------- helpers: GLB documents ---------- */

// A GLB under construction: JSON for the structure, binary parts for the data. view() and accessor() return their index.
function createDocument() {
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [] }], accessors: [], bufferViews: [] };
  const parts = [];
  let length = 0;
  const doc = {
    json,
    view(bytes, extra = {}) {
      const data = Buffer.from(bytes);
      const pad = (4 - (length % 4)) % 4;
      if (pad) {
        parts.push(Buffer.alloc(pad));
        length += pad;
      }
      json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: data.length, ...extra });
      parts.push(data);
      length += data.length;
      return json.bufferViews.length - 1;
    },
    accessor(array, type, extra = {}) {
      const componentType = array instanceof Float32Array ? 5126 : array instanceof Uint32Array ? 5125 : array instanceof Uint16Array ? 5123 : array instanceof Uint8Array ? 5121 : array instanceof Int16Array ? 5122 : 5120;
      const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
      const view = doc.view(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
      json.accessors.push({ bufferView: view, componentType, count: array.length / width, type, ...extra });
      return json.accessors.length - 1;
    },
    image(bytes, mimeType) {
      json.images = json.images || [];
      json.images.push({ bufferView: doc.view(bytes), mimeType });
      return json.images.length - 1;
    },
    // edit(json): a last change to the structure before it is written
    pack(edit) {
      const bin = Buffer.concat([...parts, Buffer.alloc((4 - (length % 4)) % 4)]);
      const copy = JSON.parse(JSON.stringify(json));
      copy.buffers = bin.length ? [{ byteLength: bin.length }] : [];
      if (typeof edit === 'function') edit(copy);
      const jsonBytes = Buffer.from(JSON.stringify(copy));
      const jsonPadded = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
      const chunks = [chunkOf(0x4e4f534a, jsonPadded)];
      if (bin.length) chunks.push(chunkOf(0x004e4942, bin));
      return glbOf(chunks);
    }
  };
  return doc;
}

function chunkOf(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(data.length, 0);
  head.writeUInt32LE(type, 4);
  return Buffer.concat([head, data]);
}

function glbOf(chunks) {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

// A square of 2 x 2 in the XY plane facing +Z, UVs with v pointing down like in an image (the bottom left corner is v = 1).
const QUAD = {
  positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 1, 1, 1, 1, 0, 0, 0],
  indices: [0, 1, 2, 0, 2, 3]
};

// options: positions, uvs (null: none), colors (12 or 16 numbers), indices (null: none), mode, normals (false: none)
function quadDoc({ positions = QUAD.positions, uvs = QUAD.uvs, colors = null, indices = QUAD.indices, mode, normals = true } = {}) {
  const doc = createDocument();
  const attributes = { POSITION: doc.accessor(new Float32Array(positions), 'VEC3') };
  if (normals) attributes.NORMAL = doc.accessor(new Float32Array(QUAD.normals), 'VEC3');
  if (uvs) attributes.TEXCOORD_0 = doc.accessor(new Float32Array(uvs), 'VEC2');
  if (colors) attributes.COLOR_0 = doc.accessor(new Float32Array(colors), colors.length === 12 ? 'VEC3' : 'VEC4');
  const primitive = { attributes };
  if (indices) primitive.indices = doc.accessor(new Uint16Array(indices), 'SCALAR');
  if (mode !== undefined) primitive.mode = mode;
  doc.json.meshes[0].primitives.push(primitive);
  return doc;
}

function withMaterial(doc, material) {
  doc.json.materials = [material];
  doc.json.meshes[0].primitives[0].material = 0;
  return doc;
}

// a texture from an encoded image (PNG or JPEG bytes) in the document, as the base colour of material 0
function withTexture(doc, bytes, mimeType, { sampler, factor } = {}) {
  const source = doc.image(bytes, mimeType);
  doc.json.textures = [{ source, ...(sampler ? { sampler: 0 } : {}) }];
  if (sampler) doc.json.samplers = [sampler];
  return withMaterial(doc, { pbrMetallicRoughness: { baseColorTexture: { index: 0 }, ...(factor ? { baseColorFactor: factor } : {}) } });
}

/* ---------- helpers: pictures ---------- */

// Two 8 x 8 WebP images, red on the left half and blue on the right: lossless (VP8L) and lossy (VP8), made once with Pillow
const WEBP_LOSSLESS = Buffer.from('UklGRh4AAABXRUJQVlA4TBIAAAAvB8ABAA8Q87//8x8O+hDR/wA=', 'base64');
const WEBP_LOSSY = Buffer.from(
  'UklGRloAAABXRUJQVlA4IE4AAAAwAwCdASoIAAgAAMASJagCdLoB+AFGA/ACu/9wABGB3KzAAP79nr/+cyG3/7tkSYKRP+uiftsiTBSJ//Wjn/41LKEjlc3+NSyhI5feAAA=',
  'base64'
);

// 2 x 2 texture: red and green on top, blue and yellow below
const CHECKER = preview.encodePng(2, 2, Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]));

function render(glb, size = 128) {
  const messages = [];
  const scene = preview.buildScene(preview.parseGlb(glb), { warn: (message) => messages.push(message) });
  const image = preview.renderToRgba(scene, { size });
  image.messages = messages;
  return image;
}

const pixel = (image, x, y) => {
  const o = (Math.round(y) * image.width + Math.round(x)) * 4;
  return [image.data[o], image.data[o + 1], image.data[o + 2], image.data[o + 3]];
};

// the box around everything that is drawn (alpha above `limit`), or null
function bounds(image, limit = 0) {
  let x0 = image.width;
  let y0 = image.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] > limit) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

// the colour at a fraction of the box around the drawing
function at(image, box, fx, fy) {
  return pixel(image, box.x0 + (box.width - 1) * fx, box.y0 + (box.height - 1) * fy);
}

const dominant = (rgba, channel) => rgba.every((value, index) => index === channel || index === 3 || rgba[channel] > value + 60);
const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message || ''}: ${actual} is not within ${tolerance} of ${expected}`);

function refused(glb, pattern, label) {
  assert.throws(
    () => preview.renderGlbBuffer(glb, { size: 64 }),
    (err) => err instanceof preview.PreviewError && pattern.test(err.message),
    label || String(pattern)
  );
}

/* ---------- P: the PNG encoder and reader ---------- */

function pngChunks(png) {
  const chunks = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const crc = png.readUInt32BE(offset + 8 + length);
    chunks.push({ type, data, crcOk: preview.crc32(png.subarray(offset + 4, offset + 8 + length)) === crc });
    offset += 12 + length;
  }
  return chunks;
}

// Lines that favour different filters, with a fixed pseudo random generator.
function mixedImage(width, height) {
  const data = new Uint8Array(width * height * 4);
  let seed = 12345;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed >>> 24;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const kind = y % 4;
      if (kind === 0) data.set([x * 7, y, 128, 255], o);
      else if (kind === 1) data.set(data.subarray(o - width * 4, o - width * 4 + 4), o);
      else if (kind === 2) data.set([(x * x + y * y) & 255, (x * y) & 255, (x + y) & 255, 255 - ((x * 3) & 63)], o);
      else data.set([random(), random(), random(), random()], o);
    }
  }
  return data;
}

// a PNG made by hand: filter 0 lines unless `filters` gives one per line (applied here, independent of the encoder)
function handmadePng({ width, height, colorType, depth = 8, rows, palette, transparency, interlace = 0, filters }) {
  const bpp = Math.max(1, Math.round(((colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 4 ? 2 : 1) * depth) / 8));
  const lines = rows.map((row, y) => {
    const filter = filters ? filters[y] : 0;
    const prev = y > 0 ? rows[y - 1] : Buffer.alloc(row.length);
    const out = Buffer.alloc(row.length + 1);
    out[0] = filter;
    for (let i = 0; i < row.length; i += 1) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[i + 1] = (row[i] - predicted) & 255;
    }
    return out;
  });
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(preview.crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = colorType;
  header[12] = interlace;
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk('IHDR', header),
    ...(palette ? [chunk('PLTE', Buffer.from(palette))] : []),
    ...(transparency ? [chunk('tRNS', Buffer.from(transparency))] : []),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(lines))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function testPng() {
  // CRC-32: the check value of the standard, and zlib's own where this Node has one
  assert.equal(preview.crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(preview.crc32(Buffer.alloc(0)), 0);
  if (typeof zlib.crc32 === 'function') {
    const sample = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 31 + (i >> 3)) & 255));
    assert.equal(preview.crc32(sample), zlib.crc32(sample));
  }

  // the structure of what the encoder writes
  const width = 37;
  const height = 29;
  const rgba = mixedImage(width, height);
  const png = preview.encodePng(width, height, rgba);
  assert.deepEqual([...png.subarray(0, 8)], PNG_SIGNATURE);
  const chunks = pngChunks(png);
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['IHDR', 'IDAT', 'IEND']);
  assert.ok(chunks.every((chunk) => chunk.crcOk), 'every chunk has its CRC');
  const header = chunks[0].data;
  assert.deepEqual([header.readUInt32BE(0), header.readUInt32BE(4), header[8], header[9], header[10], header[11], header[12]], [width, height, 8, 6, 0, 0, 0], 'size, 8 bit RGBA, no interlace');
  // the lines use several filters (this image is made so that none fits all of them) ...
  const raw = zlib.inflateSync(chunks[1].data);
  assert.equal(raw.length, (width * 4 + 1) * height);
  const used = new Set();
  for (let y = 0; y < height; y += 1) used.add(raw[y * (width * 4 + 1)]);
  assert.ok(used.size >= 3, `filters used: ${[...used].join(',')}`);
  // ... and every pixel comes back
  const back = preview.decodePng(png);
  assert.deepEqual([back.width, back.height], [width, height]);
  assert.ok(Buffer.from(back.data).equals(Buffer.from(rgba)), 'the reader returns what the encoder was given');

  // a transparent line and an all-zero image stay tiny
  const empty = preview.encodePng(512, 512, new Uint8Array(512 * 512 * 4));
  assert.ok(empty.length < 1500, `an empty image is ${empty.length} bytes`);
  assert.throws(() => preview.encodePng(0, 4, new Uint8Array(0)));
  assert.throws(() => preview.encodePng(4, 4, new Uint8Array(10)));

  // the reader: the filters one by one (made by hand, 3 bytes per pixel), and the colour types
  const rgb = [0, 1, 2, 3, 4].map((y) => Buffer.from(Array.from({ length: 6 * 3 }, (_, i) => (i * 13 + y * 29 + (i % 3) * 7) & 255)));
  const filtered = preview.decodePng(handmadePng({ width: 6, height: 5, colorType: 2, rows: rgb, filters: [0, 1, 2, 3, 4] }));
  assert.ok(filtered, 'filters None, Sub, Up, Average and Paeth');
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 6; x += 1) assert.deepEqual([...filtered.data.subarray((y * 6 + x) * 4, (y * 6 + x) * 4 + 4)], [...rgb[y].subarray(x * 3, x * 3 + 3), 255], `pixel ${x},${y}`);
  }
  const rgbs = preview.decodePng(handmadePng({ width: 2, height: 1, colorType: 2, rows: [Buffer.from([10, 20, 30, 40, 50, 60])] }));
  assert.deepEqual([...rgbs.data], [10, 20, 30, 255, 40, 50, 60, 255]);
  const gray = preview.decodePng(handmadePng({ width: 2, height: 1, colorType: 0, rows: [Buffer.from([100, 200])] }));
  assert.deepEqual([...gray.data], [100, 100, 100, 255, 200, 200, 200, 255]);
  const grayAlpha = preview.decodePng(handmadePng({ width: 2, height: 1, colorType: 4, rows: [Buffer.from([100, 50, 200, 255])] }));
  assert.deepEqual([...grayAlpha.data], [100, 100, 100, 50, 200, 200, 200, 255]);
  const indexed = preview.decodePng(handmadePng({ width: 2, height: 1, colorType: 3, rows: [Buffer.from([0, 1])], palette: [255, 0, 0, 0, 255, 0], transparency: [128] }));
  assert.deepEqual([...indexed.data], [255, 0, 0, 128, 0, 255, 0, 255], 'palette with tRNS');
  const deep = preview.decodePng(handmadePng({ width: 1, height: 1, colorType: 6, depth: 16, rows: [Buffer.from([0x80, 0x40, 0x12, 0x34, 0xff, 0x00, 0x7f, 0xff])] }));
  assert.deepEqual([...deep.data], [0x80, 0x12, 0xff, 0x7f], '16 bit: the high byte');
  // not for this reader: ffmpeg gets those
  assert.equal(preview.decodePng(handmadePng({ width: 2, height: 1, colorType: 2, rows: [Buffer.from([1, 2, 3, 4, 5, 6])], interlace: 1 })), null, 'interlaced');
  assert.equal(preview.decodePng(handmadePng({ width: 8, height: 1, colorType: 0, depth: 1, rows: [Buffer.from([0xaa])] })), null, '1 bit');
  assert.equal(preview.decodePng(png.subarray(0, png.length - 20)), null, 'cut off');
  assert.equal(preview.decodePng(Buffer.from('not a png at all, just some text bytes')), null);
  const corrupt = Buffer.from(png);
  corrupt.fill(0x55, 40, corrupt.length - 30);
  assert.doesNotThrow(() => preview.decodePng(corrupt), 'a damaged stream never throws');
  assert.equal(preview.decodePng(corrupt), null);

  // the type and size of an image by its header
  assert.deepEqual(preview.imageInfo(png), { type: 'png', width, height });
  const webp = (kind, body) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from(kind), Buffer.alloc(4), body, Buffer.alloc(8)]);
  const vp8x = Buffer.alloc(10);
  vp8x.writeUIntLE(639, 4, 3);
  vp8x.writeUIntLE(479, 7, 3);
  assert.deepEqual(preview.imageInfo(webp('VP8X', vp8x)), { type: 'webp', width: 640, height: 480 });
  const vp8 = Buffer.alloc(10);
  vp8.writeUInt16LE(321, 6);
  vp8.writeUInt16LE(123, 8);
  assert.deepEqual(preview.imageInfo(webp('VP8 ', vp8)), { type: 'webp', width: 321, height: 123 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x40, 0x00, 0xf0, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(preview.imageInfo(jpeg), { type: 'jpeg', width: 240, height: 320 });
  // WebP as the encoders write it
  assert.deepEqual(preview.imageInfo(WEBP_LOSSLESS), { type: 'webp', width: 8, height: 8 });
  assert.deepEqual(preview.imageInfo(WEBP_LOSSY), { type: 'webp', width: 8, height: 8 });
  assert.equal(preview.imageInfo(Buffer.from('GIF89a......................')), null);
  assert.equal(preview.imageInfo(Buffer.alloc(0)), null);
}

/* ---------- G: the container and what is refused ---------- */

function testContainer() {
  const good = quadDoc().pack();
  const parsed = preview.parseGlb(good);
  assert.equal(parsed.json.meshes.length, 1);
  assert.ok(parsed.bin && parsed.bin.length > 0);
  assert.equal(preview.parseGlb(new Uint8Array(good)).json.asset.version, '2.0', 'a plain Uint8Array is fine too');
  assert.ok(preview.renderGlbBuffer(good, { size: 64 }).subarray(0, 8).equals(Buffer.from(PNG_SIGNATURE)), 'the whole way: GLB in, PNG out');

  // the container
  refused(Buffer.from('nothing'), /zu kurz/, 'too short');
  refused(Buffer.concat([Buffer.from('FBX!'), good.subarray(4)]), /kein GLB/, 'wrong magic');
  const old = Buffer.from(good);
  old.writeUInt32LE(1, 4);
  refused(old, /Version 1/, 'glTF 1');
  refused(good.subarray(0, good.length - 7), /abgeschnitten/, 'cut off');
  const lying = Buffer.from(good);
  lying.writeUInt32LE(good.length + 1000, 8);
  refused(lying, /abgeschnitten/, 'a length beyond the file');
  const wide = Buffer.from(good);
  wide.writeUInt32LE(0x7fffff00, 12);
  refused(wide, /ragt/, 'a chunk beyond the end');
  const brokenJson = Buffer.from(good);
  brokenJson[20] = 0x78; // the opening brace of the JSON
  refused(brokenJson, /JSON/, 'damaged JSON');
  refused(glbOf([chunkOf(0x004e4942, Buffer.alloc(16))]), /JSON-Teil/, 'no JSON chunk');
  refused(glbOf([chunkOf(0x4e4f534a, Buffer.from('[1,2,3]'))]), /JSON-Teil/, 'JSON that is no object');
  // trailing zeros in the JSON chunk (some writers pad with them) are fine
  const padded = glbOf([chunkOf(0x4e4f534a, Buffer.concat([Buffer.from(JSON.stringify(quadDoc().json)), Buffer.alloc(4)]))]);
  assert.equal(preview.parseGlb(padded).json.asset.version, '2.0');

  // extensions the model requires: compression is refused, the shading ones are not needed
  for (const name of ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu', 'EXT_mesh_gpu_instancing']) {
    refused(quadDoc().pack((json) => { json.extensionsRequired = [name]; }), new RegExp(`Erweiterung ${name}`), name);
  }
  const unlit = quadDoc().pack((json) => { json.extensionsRequired = ['KHR_materials_unlit', 'KHR_mesh_quantization']; });
  assert.ok(render(unlit, 64), 'material extensions and quantization are drawn');

  // geometry that cannot be trusted
  refused(quadDoc().pack((json) => { json.accessors[0].sparse = { count: 1, indices: {}, values: {} }; }), /Sparse/, 'sparse');
  refused(quadDoc({ indices: [0, 1, 9, 0, 2, 3] }).pack(), /Index/, 'an index beyond the vertices');
  refused(quadDoc().pack((json) => { json.accessors[0].count = 1000; }), /ragt/, 'an accessor beyond the buffer');
  refused(quadDoc().pack((json) => { json.accessors[0].count = -1; }), /Anzahl/, 'a negative count');
  refused(quadDoc().pack((json) => { json.accessors[0].componentType = 1234; }), /Typ/, 'an unknown component type');
  refused(quadDoc().pack((json) => { json.accessors[0].type = 'VEC2'; }), /VEC3/, 'positions with the wrong width');
  refused(quadDoc().pack((json) => { json.meshes[0].primitives[0].attributes.POSITION = 77; }), /Accessor 77/, 'a missing accessor');
  refused(quadDoc().pack((json) => { json.bufferViews[0].buffer = 3; }), /Puffer 3/, 'a missing buffer');
  refused(quadDoc().pack((json) => { json.buffers[0].uri = 'geometry.bin'; delete json.buffers[0].byteLength; }), /ausserhalb/, 'a buffer outside the file');
  refused(quadDoc().pack((json) => { json.nodes[0].matrix = 'x'; }), /Matrix/, 'a matrix that is none');
  refused(quadDoc().pack((json) => { json.nodes[0].children = [0]; }), /kreist/, 'a node that is its own child');
  refused(quadDoc().pack((json) => { json.nodes[0].mesh = 5; }), /Mesh 5/, 'a mesh that does not exist');
  refused(quadDoc({ mode: 1 }).pack(), /keine Dreiecke/, 'lines are not drawn');
  refused(quadDoc({ positions: new Array(12).fill(0) }).pack(), /Ausdehnung/, 'all points in one place');
  refused(quadDoc({ positions: new Array(12).fill(NaN) }).pack(), /gueltigen/, 'no valid points');
  const nothing = createDocument();
  nothing.json.nodes = [];
  nothing.json.meshes = [];
  refused(nothing.pack(), /keine Dreiecke/, 'a model without a mesh');

  // what is drawn without fuss: no indices, no normals, no UVs, a strip and a fan, 8 bit indices
  assert.ok(bounds(render(quadDoc({ indices: null, uvs: null, positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0] }).pack())), 'without indices');
  assert.ok(bounds(render(quadDoc({ normals: false }).pack())), 'without normals (smooth normals are computed)');
  const strip = render(quadDoc({ mode: 5, indices: [3, 2, 0, 1] }).pack());
  const fan = render(quadDoc({ mode: 6, indices: [0, 1, 2, 3] }).pack());
  assert.deepEqual([bounds(strip).width, bounds(strip).height], [bounds(fan).width, bounds(fan).height], 'strip and fan make the same square');
  const bytes = quadDoc();
  bytes.json.meshes[0].primitives[0].indices = bytes.accessor(Uint8Array.from(QUAD.indices), 'SCALAR');
  assert.ok(bounds(render(bytes.pack())), 'unsigned byte indices');
}

/* ---------- S: the picture ---------- */

function testPicture() {
  // a textured quad: transparent corners, a margin of 5 % on each side, the colours where the texture puts them
  const size = 128;
  const image = render(withTexture(quadDoc(), CHECKER, 'image/png').pack(), size);
  assert.equal(image.messages.length, 0, image.messages.join('; '));
  assert.deepEqual([image.width, image.height], [size, size]);
  for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) assert.equal(pixel(image, x, y)[3], 0, `corner ${x},${y} is transparent`);
  assert.equal(pixel(image, size / 2, size / 2)[3], 255, 'the middle is covered');
  const box = bounds(image);
  near(box.x0, size * 0.05, 2, 'left margin');
  near(size - 1 - box.x1, size * 0.05, 2.5, 'right margin');
  assert.ok(box.height < box.width && box.height > box.width * 0.8, `seen from 15 degrees above, the square is a little wider than tall: ${box.width} x ${box.height}`);
  near((box.y0 + box.y1) / 2, size / 2, 2, 'centred up and down');
  near((box.x0 + box.x1) / 2, size / 2, 2, 'centred left and right');
  const topLeft = at(image, box, 0.25, 0.25);
  const topRight = at(image, box, 0.75, 0.25);
  const bottomLeft = at(image, box, 0.25, 0.75);
  const bottomRight = at(image, box, 0.75, 0.75);
  assert.ok(dominant(topLeft, 0), `red top left: ${topLeft}`);
  assert.ok(dominant(topRight, 1), `green top right: ${topRight}`);
  assert.ok(dominant(bottomLeft, 2), `blue bottom left: ${bottomLeft}`);
  assert.ok(bottomRight[0] > 150 && bottomRight[1] > 150 && bottomRight[2] < 60, `yellow bottom right: ${bottomRight}`);
  // shaded, never darker than the base light and never brighter than the texture
  assert.ok(topLeft[0] > 255 * 0.6 && topLeft[0] <= 255, `the shading keeps a bright base: ${topLeft[0]}`);

  // sampler: the texture repeats where the coordinates go beyond 1 (REPEAT is the default), clamps and mirrors when asked
  const twice = [0, 2, 2, 2, 2, 0, 0, 0]; // two repeats in each direction
  const repeated = render(withTexture(quadDoc({ uvs: twice }), CHECKER, 'image/png').pack(), size);
  assert.ok(dominant(at(repeated, bounds(repeated), 0.1, 0.1), 0) && dominant(at(repeated, bounds(repeated), 0.4, 0.1), 1), 'REPEAT: red, green, red, green along the top');
  const repeatedBox = bounds(repeated);
  assert.ok(dominant(at(repeated, repeatedBox, 0.6, 0.1), 0) && dominant(at(repeated, repeatedBox, 0.9, 0.1), 1), 'REPEAT: the second repeat');
  const clamped = render(withTexture(quadDoc({ uvs: twice }), CHECKER, 'image/png', { sampler: { wrapS: 33071, wrapT: 33071 } }).pack(), size);
  const clampedBox = bounds(clamped);
  assert.ok(dominant(at(clamped, clampedBox, 0.1, 0.1), 0), 'CLAMP_TO_EDGE: red where the texture starts');
  assert.ok(dominant(at(clamped, clampedBox, 0.9, 0.1), 1), 'CLAMP_TO_EDGE: the green edge pixel is held to the end of the top line');
  const heldYellow = at(clamped, clampedBox, 0.9, 0.9);
  assert.ok(heldYellow[0] > 150 && heldYellow[1] > 150 && heldYellow[2] < 60, `CLAMP_TO_EDGE: the corner pixel is held: ${heldYellow}`);
  const mirrored = render(withTexture(quadDoc({ uvs: twice }), CHECKER, 'image/png', { sampler: { wrapS: 33648, wrapT: 33648 } }).pack(), size);
  const mirroredBox = bounds(mirrored);
  assert.ok(dominant(at(mirrored, mirroredBox, 0.1, 0.1), 0) && dominant(at(mirrored, mirroredBox, 0.4, 0.1), 1) && dominant(at(mirrored, mirroredBox, 0.6, 0.1), 1) && dominant(at(mirrored, mirroredBox, 0.9, 0.1), 0), 'MIRRORED_REPEAT: red green green red');

  // the base colour factor multiplies the texture
  const tinted = render(withTexture(quadDoc(), CHECKER, 'image/png', { factor: [0, 1, 1, 1] }).pack(), size);
  assert.ok(at(tinted, bounds(tinted), 0.25, 0.25)[0] < 20, 'a factor without red takes the red out of the red square');

  // vertex colours (linear in the file): each corner has its own
  const colored = render(quadDoc({ colors: [0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0] }).pack(), size);
  const coloredBox = bounds(colored);
  assert.ok(dominant(at(colored, coloredBox, 0.06, 0.94), 2), `blue at the bottom left: ${at(colored, coloredBox, 0.06, 0.94)}`);
  assert.ok(dominant(at(colored, coloredBox, 0.94, 0.94), 1), 'green at the bottom right');
  assert.ok(dominant(at(colored, coloredBox, 0.94, 0.06), 0), 'red at the top right');
  const withAlpha = render(quadDoc({ colors: new Array(16).fill(1) }).pack(), size);
  assert.equal(pixel(withAlpha, size / 2, size / 2)[3], 255, 'a COLOR_0 with alpha does not cut an OPAQUE material');

  // a material of one colour, and none at all
  const green = render(withMaterial(quadDoc({ uvs: null }), { pbrMetallicRoughness: { baseColorFactor: [0, 1, 0, 1] } }).pack(), size);
  assert.ok(dominant(pixel(green, size / 2, size / 2), 1), 'the colour factor');
  const grey = pixel(render(quadDoc({ uvs: null }).pack(), size), size / 2, size / 2);
  assert.ok(Math.abs(grey[0] - grey[1]) <= 1 && Math.abs(grey[1] - grey[2]) <= 1, 'a model without a material is grey');
  assert.ok(grey[0] > 140 && grey[0] < 230, `light grey: ${grey[0]}`);
  // alpha: OPAQUE ignores it, MASK cuts, the texture alpha counts for MASK only
  const fade = (mode, alpha, extra = {}) => withMaterial(quadDoc({ uvs: null }), { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, alpha] }, alphaMode: mode, ...extra });
  assert.equal(pixel(render(fade('OPAQUE', 0.1).pack(), 64), 32, 32)[3], 255, 'OPAQUE');
  assert.equal(pixel(render(fade('MASK', 0.4).pack(), 64), 32, 32)[3], 0, 'MASK below the cutoff of 0.5');
  assert.equal(pixel(render(fade('MASK', 0.4, { alphaCutoff: 0.3 }).pack(), 64), 32, 32)[3], 255, 'MASK with its own cutoff');
  assert.equal(pixel(render(fade('BLEND', 0.2).pack(), 64), 32, 32)[3], 0, 'BLEND is a cut at one half');

  // two-sided and no culling: the same picture for either winding and for the normal on the other side
  const flipped = render(quadDoc({ indices: [0, 2, 1, 0, 3, 2] }).pack(), size);
  assert.deepEqual([...flipped.data], [...render(quadDoc().pack(), size).data], 'the winding makes no difference');
  const back = quadDoc();
  back.json.meshes[0].primitives[0].attributes.NORMAL = back.accessor(new Float32Array(QUAD.normals.map((value) => -value)), 'VEC3');
  assert.deepEqual([...render(back.pack(), size).data], [...render(quadDoc().pack(), size).data], 'a normal that looks away is turned towards the viewer');
  // lit from the upper left front: a face that looks up is brighter than one that looks down, left brighter than right
  const lit = (nx, ny, nz) => {
    const doc = quadDoc();
    doc.json.meshes[0].primitives[0].attributes.NORMAL = doc.accessor(new Float32Array([nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz]), 'VEC3');
    return pixel(render(doc.pack(), 64), 32, 32)[0];
  };
  assert.ok(lit(0, 0.6, 0.8) > lit(0, -0.6, 0.8), 'up is brighter than down');
  assert.ok(lit(-0.6, 0, 0.8) > lit(0.6, 0, 0.8), 'left is brighter than right');

  // node transforms: a rotation by 90 degrees about Z turns a wide plate into a tall one
  const plate = [-2, -1, 0, 2, -1, 0, 2, 1, 0, -2, 1, 0];
  const flat = bounds(render(quadDoc({ positions: plate }).pack(), size));
  assert.ok(flat.width > flat.height * 1.7, `wide: ${flat.width} x ${flat.height}`);
  const turn = (node) => quadDoc({ positions: plate }).pack((json) => { Object.assign(json.nodes[0], node); });
  const tall = bounds(render(turn({ rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }), size));
  assert.ok(tall.height > tall.width * 1.7, `tall: ${tall.width} x ${tall.height}`);
  near(tall.y0, size * 0.05, 2, 'the longer side is fitted whichever way it points');
  // translation does not matter (the fit centres the model), scale does, the matrix does the same as the parts
  assert.deepEqual([...render(turn({ translation: [40, -7, 3] }), size).data], [...render(turn({}), size).data], 'a translation moves nothing in the picture');
  const scaled = bounds(render(turn({ scale: [1, 3, 1] }), size));
  assert.ok(scaled.height > scaled.width * 1.2, `scaled in y: ${scaled.width} x ${scaled.height}`);
  const byMatrix = bounds(render(turn({ matrix: [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 5, 5, 5, 1] }), size));
  assert.deepEqual([byMatrix.width, byMatrix.height], [tall.width, tall.height], 'matrix: rotation by 90 degrees about Z, column-major');
  // a hierarchy multiplies; a mesh used twice is drawn twice
  const tree = quadDoc({ positions: plate }).pack((json) => {
    json.scenes[0].nodes = [1];
    json.nodes = [{ mesh: 0, translation: [4, 0, 0] }, { rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], children: [0] }];
  });
  const treeBox = bounds(render(tree, size));
  assert.deepEqual([treeBox.width, treeBox.height], [tall.width, tall.height], 'parent rotation, child translation');
  const twin = render(quadDoc().pack((json) => {
    json.scenes[0].nodes = [0, 1];
    json.nodes = [{ mesh: 0, translation: [-3, 0, 0] }, { mesh: 0, translation: [3, 0, 0] }];
  }), size);
  assert.equal(pixel(twin, size / 2, size / 2)[3], 0, 'a gap between the two squares');
  assert.ok(pixel(twin, size * 0.25, size / 2)[3] === 255 && pixel(twin, size * 0.75, size / 2)[3] === 255, 'one on each side');
  // the first scene is the default one; a node outside of it is not drawn
  const scenes = quadDoc().pack((json) => {
    json.nodes = [{ mesh: 0, translation: [50, 0, 0] }, { mesh: 0 }];
    json.scenes = [{ nodes: [0] }, { nodes: [1] }];
    json.scene = 1;
  });
  assert.equal(pixel(render(scenes, 64), 32, 32)[3], 255, 'scene 1 is the one that is drawn');

  // seen from the front: a model that stands upright stays upright (higher in the model is higher in the picture)
  const tower = quadDoc({ positions: [-0.2, -1, 0, 0.2, -1, 0, 0.2, 1, 0, -0.2, 1, 0], normals: true }).pack();
  const towerBox = bounds(render(tower, size));
  assert.ok(towerBox.height > towerBox.width * 3, 'a tall model is tall in the picture');
  // a slab seen at 15 degrees from above shows its top: the top face (normal +Y) is visible, the bottom face is not
  const slab = createDocument();
  const p = [-1, -0.1, -1, 1, -0.1, -1, 1, 0.1, -1, -1, 0.1, -1, -1, -0.1, 1, 1, -0.1, 1, 1, 0.1, 1, -1, 0.1, 1];
  slab.json.meshes[0].primitives.push({
    attributes: { POSITION: slab.accessor(new Float32Array(p), 'VEC3') },
    indices: slab.accessor(Uint16Array.from([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 3, 2, 6, 3, 6, 7, 0, 5, 1, 0, 4, 5, 1, 5, 6, 1, 6, 2, 0, 3, 7, 0, 7, 4]), 'SCALAR')
  });
  const slabImage = render(slab.pack(), size);
  assert.ok(bounds(slabImage).height > bounds(slabImage).width * 0.12, 'the top of the slab is seen as well as its front');
}

/* ---------- A: accessors and perspective ---------- */

// an accessor over bytes that are not made by createDocument().accessor: component type, stride, offset and normalization as given
function rawAccessor(doc, view, { componentType, type, count, normalized, byteOffset }) {
  doc.json.accessors.push({ bufferView: view, componentType, type, count, ...(normalized ? { normalized } : {}), ...(byteOffset ? { byteOffset } : {}) });
  return doc.json.accessors.length - 1;
}

function testAccessors() {
  const size = 96;
  const reference = render(withTexture(quadDoc(), CHECKER, 'image/png').pack(), size);

  // interleaved: position, normal and UV of a vertex in one view with a stride of 32 bytes, accessors at byte offsets 0, 12, 24
  const interleaved = createDocument();
  const vertices = new Float32Array(4 * 8);
  for (let v = 0; v < 4; v += 1) vertices.set([...QUAD.positions.slice(v * 3, v * 3 + 3), ...QUAD.normals.slice(v * 3, v * 3 + 3), ...QUAD.uvs.slice(v * 2, v * 2 + 2)], v * 8);
  const strided = interleaved.view(Buffer.from(vertices.buffer), { byteStride: 32 });
  interleaved.json.meshes[0].primitives.push({
    attributes: {
      POSITION: rawAccessor(interleaved, strided, { componentType: 5126, type: 'VEC3', count: 4 }),
      NORMAL: rawAccessor(interleaved, strided, { componentType: 5126, type: 'VEC3', count: 4, byteOffset: 12 }),
      TEXCOORD_0: rawAccessor(interleaved, strided, { componentType: 5126, type: 'VEC2', count: 4, byteOffset: 24 })
    },
    indices: interleaved.accessor(Uint16Array.from(QUAD.indices), 'SCALAR')
  });
  assert.deepEqual([...render(withTexture(interleaved, CHECKER, 'image/png').pack(), size).data], [...reference.data], 'byteStride and byteOffset');

  // quantized (KHR_mesh_quantization): normalized 16 bit positions and UVs, 8 bit normals and indices, with the stride padded to 4 bytes
  const quantized = createDocument();
  const positions = Int16Array.from([-32767, -32767, 0, 0, 32767, -32767, 0, 0, 32767, 32767, 0, 0, -32767, 32767, 0, 0]);
  const normals = Int8Array.from([0, 0, 127, 0, 0, 0, 127, 0, 0, 0, 127, 0, 0, 0, 127, 0]);
  const coordinates = Uint16Array.from([0, 65535, 65535, 65535, 65535, 0, 0, 0]);
  quantized.json.meshes[0].primitives.push({
    attributes: {
      POSITION: rawAccessor(quantized, quantized.view(Buffer.from(positions.buffer), { byteStride: 8 }), { componentType: 5122, type: 'VEC3', count: 4, normalized: true }),
      NORMAL: rawAccessor(quantized, quantized.view(Buffer.from(normals.buffer), { byteStride: 4 }), { componentType: 5120, type: 'VEC3', count: 4, normalized: true }),
      TEXCOORD_0: rawAccessor(quantized, quantized.view(Buffer.from(coordinates.buffer)), { componentType: 5123, type: 'VEC2', count: 4, normalized: true })
    },
    indices: quantized.accessor(Uint8Array.from(QUAD.indices), 'SCALAR')
  });
  withTexture(quantized, CHECKER, 'image/png');
  assert.deepEqual([...render(quantized.pack((json) => { json.extensionsRequired = ['KHR_mesh_quantization']; }), size).data], [...reference.data], 'normalized 16 and 8 bit data');
  // the same with integer UVs that are not normalized: the values are used as they are (a repeat of 1 in each direction)
  const plain = createDocument();
  plain.json.meshes[0].primitives.push({
    attributes: {
      POSITION: plain.accessor(new Float32Array(QUAD.positions), 'VEC3'),
      TEXCOORD_0: rawAccessor(plain, plain.view(Buffer.from(Uint16Array.from([0, 1, 1, 1, 1, 0, 0, 0]).buffer)), { componentType: 5123, type: 'VEC2', count: 4 })
    },
    indices: plain.accessor(Uint16Array.from(QUAD.indices), 'SCALAR')
  });
  withTexture(plain, CHECKER, 'image/png');
  assert.deepEqual([...render(plain.pack(), size).data], [...render(withTexture(quadDoc({ normals: false }), CHECKER, 'image/png').pack(), size).data], 'integer UVs');

  // an accessor without a buffer view is all zero, by the specification: a flat primitive has no extent to draw
  refused(quadDoc().pack((json) => { delete json.accessors[0].bufferView; }), /Ausdehnung/, 'positions without data');
}

// Perspective-correct interpolation: a square lying like a floor (its far edge at the top) with a texture of two rows, red above
// and blue below. The colours cross at v = 0.5, the middle of the square in space; in the picture that lies nearer to the far edge than
// the middle of the outline (the far half is smaller). Interpolating in the picture would put it at the middle.
function testPerspective() {
  const size = 256;
  const rows = preview.encodePng(1, 2, Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255]));
  const tilt = (-75 * Math.PI) / 180;
  const floor = withTexture(quadDoc(), rows, 'image/png', { sampler: { wrapS: 33071, wrapT: 33071 } }).pack((json) => {
    json.nodes[0].rotation = [Math.sin(tilt / 2), 0, 0, Math.cos(tilt / 2)];
  });
  const image = render(floor, size);
  const box = bounds(image);
  const column = Math.round((box.x0 + box.x1) / 2);
  let crossing = -1;
  for (let y = box.y0; y < box.y1; y += 1) {
    if (pixel(image, column, y)[0] >= pixel(image, column, y)[2] && pixel(image, column, y + 1)[0] < pixel(image, column, y + 1)[2]) crossing = y;
  }
  assert.ok(crossing > 0, 'the colours cross');
  const middle = (box.y0 + box.y1) / 2;
  assert.ok(middle - crossing >= 4, `perspective-correct: the crossing at row ${crossing}, the middle of the outline at ${middle}`);
  assert.ok(middle - crossing < box.height / 4, 'and not far off');
}

/* ---------- T: textures ---------- */

async function testTextures(workdir) {
  // an image as data: URI is read
  const dataUri = quadDoc();
  dataUri.json.images = [{ uri: `data:image/png;base64,${CHECKER.toString('base64')}` }];
  dataUri.json.textures = [{ source: 0 }];
  withMaterial(dataUri, { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } });
  const fromUri = render(dataUri.pack(), 64);
  assert.ok(dominant(at(fromUri, bounds(fromUri), 0.25, 0.25), 0), 'a data: URI image is drawn');
  // a buffer as data: URI is read
  const bufferUri = quadDoc();
  const glb = bufferUri.pack();
  const parsed = preview.parseGlb(glb);
  const embedded = glbOf([chunkOf(0x4e4f534a, Buffer.from(JSON.stringify({ ...parsed.json, buffers: [{ byteLength: parsed.bin.length, uri: `data:application/octet-stream;base64,${parsed.bin.toString('base64')}` }] })))]);
  assert.ok(bounds(render(embedded, 64)), 'a buffer as data: URI');

  // an address outside the file is never read: not a file next to the model, not a file URL, not an address on the network
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.end('x');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const magenta = preview.encodePng(2, 2, Uint8Array.from(new Array(4).fill([255, 0, 255, 255]).flat()));
  await fsp.writeFile(path.join(workdir, 'texture.png'), magenta);
  try {
    const addresses = ['texture.png', `file://${path.join(workdir, 'texture.png')}`, path.join(workdir, 'texture.png'), `http://127.0.0.1:${server.address().port}/texture.png`];
    for (const uri of addresses) {
      const outside = quadDoc();
      outside.json.images = [{ uri }];
      outside.json.textures = [{ source: 0 }];
      withMaterial(outside, { pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [0, 1, 0, 1] } });
      const image = render(outside.pack(), 64);
      assert.ok(dominant(pixel(image, 32, 32), 1), `${uri}: drawn in the colour of the material, the texture is not read`);
      assert.equal(image.messages.length, 1, uri);
      assert.match(image.messages[0], /ausserhalb/, uri);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(hits, [], 'nothing was requested from the network');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  // an image that is none, a texture without a source, a texture that does not exist: the material is drawn without it
  const notImage = quadDoc();
  const bad = notImage.image(Buffer.from('this is not an image'), 'image/png');
  notImage.json.textures = [{ source: bad }, {}];
  withMaterial(notImage, { pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [0, 0, 1, 1] } });
  const broken = render(notImage.pack(), 64);
  assert.ok(dominant(pixel(broken, 32, 32), 2), 'a damaged image: the colour factor');
  assert.equal(broken.messages.length, 1);
  for (const index of [1, 9]) {
    const hollow = quadDoc();
    hollow.json.textures = [{ source: 0 }, {}];
    hollow.json.images = [{ uri: 'data:image/png;base64,' }];
    withMaterial(hollow, { pbrMetallicRoughness: { baseColorTexture: { index }, baseColorFactor: [1, 0, 0, 1] } });
    assert.ok(dominant(pixel(render(hollow.pack(), 64), 32, 32), 0), `texture ${index}: the colour factor`);
  }
  // coordinates that are missing: the colour of the material
  const noCoordinates = render(withTexture(quadDoc({ uvs: null }), CHECKER, 'image/png', { factor: [0, 0, 1, 1] }).pack(), 64);
  assert.ok(dominant(pixel(noCoordinates, 32, 32), 2), 'a texture without UVs');

  // ffmpeg: JPEG (and WebP where this ffmpeg can make one), and a PNG too large for the built-in reader
  const ffmpegPath = ffmpegLib.resolveBinary('ffmpeg');
  // 64 x 64: red on the left, blue on the right (JPEG blurs the border, the middle of each half stays)
  const halves = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y += 1) for (let x = 0; x < 64; x += 1) halves.set(x < 32 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * 64 + x) * 4);
  const halvesPng = preview.encodePng(64, 64, halves);
  const encode = (args) => {
    const result = spawnSync(ffmpegPath, ['-v', 'error', '-nostdin', '-i', 'pipe:0', '-frames:v', '1', ...args, 'pipe:1'], { input: halvesPng, maxBuffer: 1 << 24 });
    return result.status === 0 && result.stdout.length > 0 ? result.stdout : null;
  };
  const sidesOf = (image) => [at(image, bounds(image), 0.15, 0.5), at(image, bounds(image), 0.85, 0.5)];
  if (!ffmpegPath) {
    console.log('   textures through ffmpeg: skipped (ffmpeg is not installed here)');
  } else {
    const jpeg = encode(['-pix_fmt', 'yuvj420p', '-q:v', '2', '-f', 'mjpeg']);
    assert.deepEqual(jpeg && preview.imageInfo(jpeg), { type: 'jpeg', width: 64, height: 64 }, 'the header of a real JPEG');
    const jpegImage = render(withTexture(quadDoc(), jpeg, 'image/jpeg').pack(), 96);
    assert.equal(jpegImage.messages.length, 0, jpegImage.messages.join('; '));
    const [left, right] = sidesOf(jpegImage);
    assert.ok(dominant(left, 0) && dominant(right, 2), `JPEG through ffmpeg: ${left} | ${right}`);
    for (const [label, webp] of [['lossless', WEBP_LOSSLESS], ['lossy', WEBP_LOSSY]]) {
      const webpImage = render(withTexture(quadDoc(), webp, 'image/webp').pack(), 96);
      const [webpLeft, webpRight] = sidesOf(webpImage);
      if (webpImage.messages.length) console.log(`   WebP ${label}: skipped (${webpImage.messages[0]})`);
      else assert.ok(dominant(webpLeft, 0) && dominant(webpRight, 2), `WebP ${label} through ffmpeg: ${webpLeft} | ${webpRight}`);
    }
    // EXT_texture_webp: the image sits in the extension of the texture
    const extension = quadDoc();
    const webpSource = extension.image(WEBP_LOSSLESS, 'image/webp');
    extension.json.textures = [{ extensions: { EXT_texture_webp: { source: webpSource } } }];
    withMaterial(extension, { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } });
    const viaExtension = render(extension.pack((json) => { json.extensionsRequired = ['EXT_texture_webp']; }), 96);
    if (!viaExtension.messages.length) assert.ok(dominant(sidesOf(viaExtension)[0], 0), 'EXT_texture_webp');
    // a texture larger than 2048 on a side is scaled down by ffmpeg and still sits where it belongs
    const large = encode(['-vf', 'scale=2600:600:flags=neighbor', '-pix_fmt', 'yuvj420p', '-q:v', '2', '-f', 'mjpeg']);
    assert.ok(large && preview.imageInfo(large).width === 2600, 'a JPEG of 2600 x 600');
    const decoded = preview.decodeTexture(large);
    assert.deepEqual([decoded.width, decoded.height], [2048, 473], 'longest side 2048, proportions kept');
    const [bigLeft, bigRight] = sidesOf(render(withTexture(quadDoc(), large, 'image/jpeg').pack(), 96));
    assert.ok(dominant(bigLeft, 0) && dominant(bigRight, 2), 'the large texture is drawn');
    // a PNG is read by the built-in reader at its own size (no ffmpeg, no scaling)
    const widePng = preview.encodePng(2600, 8, new Uint8Array(2600 * 8 * 4).fill(200));
    assert.deepEqual([preview.decodeTexture(widePng).width, preview.decodeTexture(widePng).height], [2600, 8]);
  }

  // without ffmpeg a JPEG texture cannot be read: the material is drawn in its colour, with a word about it; a PNG still works
  const saved = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = path.join(workdir, 'there-is-no-ffmpeg');
  try {
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x40, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
    const noFfmpeg = render(withTexture(quadDoc(), fakeJpeg, 'image/jpeg', { factor: [0, 1, 0, 1] }).pack(), 64);
    assert.ok(dominant(pixel(noFfmpeg, 32, 32), 1), 'JPEG without ffmpeg: the colour of the material');
    assert.equal(noFfmpeg.messages.length, 1);
    assert.match(noFfmpeg.messages[0], /ffmpeg/);
    const pngStill = render(withTexture(quadDoc(), CHECKER, 'image/png').pack(), 64);
    assert.equal(pngStill.messages.length, 0);
    assert.ok(dominant(at(pngStill, bounds(pngStill), 0.25, 0.25), 0), 'a PNG needs no ffmpeg');
    // a material that has nothing but the texture is light grey then
    const plain = render(withTexture(quadDoc(), fakeJpeg, 'image/jpeg').pack(), 64);
    const sample = pixel(plain, 32, 32);
    assert.ok(Math.abs(sample[0] - sample[2]) <= 1 && sample[0] > 140 && sample[0] < 230, `no factor, no texture: ${sample}`);
  } finally {
    if (saved === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = saved;
  }
}

/* ---------- C: the child process ---------- */

async function testChildProcess(workdir) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const file = path.join(workdir, 'quad.glb');
    await fsp.writeFile(file, withTexture(quadDoc(), CHECKER, 'image/png').pack());

    // file in, PNG out: the size asked for, a transparent background
    const png = await preview.renderGlbPreview(file, { size: 200 });
    assert.ok(Buffer.isBuffer(png) && png.subarray(0, 8).equals(Buffer.from(PNG_SIGNATURE)));
    const image = preview.decodePng(png);
    assert.deepEqual([image.width, image.height], [200, 200]);
    assert.equal(pixel(image, 0, 0)[3], 0);
    assert.ok(dominant(at(image, bounds(image), 0.25, 0.25), 0), 'the child draws the same picture');
    assert.deepEqual(warnings, []);
    const same = preview.renderGlbBuffer(await fsp.readFile(file), { size: 200 });
    assert.ok(same.equals(png), 'byte for byte what the function makes in this process');
    // the default size is 1024
    assert.equal(preview.decodePng(await preview.renderGlbPreview(file)).width, 1024);
    assert.equal(preview.DEFAULT_SIZE, 1024);
    // a size out of range is brought into range
    assert.equal(preview.decodePng(await preview.renderGlbPreview(file, { size: 5 })).width, 64);

    // one render at a time: a large one first, two small ones behind it finish in the order they were asked for
    const order = [];
    await Promise.all([
      preview.renderGlbPreview(file, { size: 1536 }).then((result) => order.push(['large', result && result.length > 0])),
      preview.renderGlbPreview(file, { size: 64 }).then((result) => order.push(['small 1', result && result.length > 0])),
      preview.renderGlbPreview(file, { size: 64 }).then((result) => order.push(['small 2', result && result.length > 0]))
    ]);
    assert.deepEqual(order, [['large', true], ['small 1', true], ['small 2', true]]);

    // a timeout kills the child and answers null with a reason in the log (the node needs longer than 5 ms to start)
    warnings.length = 0;
    const started = Date.now();
    assert.equal(await preview.renderGlbPreview(file, { size: 64, timeoutMs: 5 }), null);
    assert.ok(Date.now() - started < 3000, 'the answer does not wait for the child');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^\[glb-preview\] Vorschau von quad\.glb nicht erstellt: Zeitlimit/);
    // and the queue goes on afterwards
    assert.ok(await preview.renderGlbPreview(file, { size: 64 }), 'the next render is not affected');

    // a file that is not there, one that is damaged, one the renderer refuses: null with the reason, never an exception
    const cases = [
      [path.join(workdir, 'missing.glb'), /ENOENT|no such file/i],
      [path.join(workdir, 'junk.glb'), /kein GLB/],
      [path.join(workdir, 'draco.glb'), /Erweiterung KHR_draco_mesh_compression/],
      [path.join(workdir, 'cut.glb'), /abgeschnitten/]
    ];
    await fsp.writeFile(cases[1][0], Buffer.from('definitely not a model, but long enough to have a header and more'));
    await fsp.writeFile(cases[2][0], quadDoc().pack((json) => { json.extensionsRequired = ['KHR_draco_mesh_compression']; }));
    await fsp.writeFile(cases[3][0], (await fsp.readFile(file)).subarray(0, 300));
    for (const [target, pattern] of cases) {
      warnings.length = 0;
      assert.equal(await preview.renderGlbPreview(target, { size: 64 }), null, target);
      assert.equal(warnings.length, 1, `${target}: ${warnings.join(' | ')}`);
      assert.match(warnings[0], pattern, target);
      assert.ok(warnings[0].includes(`Vorschau von ${path.basename(target)} nicht erstellt`));
    }
    // something that is not a path at all
    assert.equal(await preview.renderGlbPreview(undefined, { size: 64 }), null);

    // what was left out on the way is logged, the preview is there (a texture that cannot be read)
    const unreadable = withTexture(quadDoc(), Buffer.from('not an image'), 'image/png', { factor: [0, 1, 0, 1] });
    await fsp.writeFile(path.join(workdir, 'untextured.glb'), unreadable.pack());
    warnings.length = 0;
    const untextured = await preview.renderGlbPreview(path.join(workdir, 'untextured.glb'), { size: 64 });
    assert.ok(untextured, 'the preview is made without the texture');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Textur/);
  } finally {
    console.warn = originalWarn;
  }
}

/* ---------- the module as the poller uses it ---------- */

function testSource() {
  const source = require('fs').readFileSync(path.join(__dirname, '..', 'lib', 'glb-preview.js'), 'utf8');
  assert.ok(!/require\(['"](?!\.|fs|path|zlib|child_process)/.test(source), 'no dependency beyond Node and the ffmpeg helper of the app');
  assert.match(source, /--max-old-space-size/, 'the child has a limit for its memory');
  assert.match(source, /DEFAULT_TIMEOUT_MS = 90 \* 1000/, 'the time limit is 90 seconds');
  assert.ok(!/zlib\.crc32/.test(source.replace(/\/\/.*$/gm, '')), 'a table of its own for the CRC, not zlib.crc32');
  assert.ok(!/\u00df/.test(source), 'no sharp s');
}

async function main() {
  const workdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-glb-preview-'));
  try {
    testPng();
    console.log('   ok P: PNG encoder and reader');
    testContainer();
    console.log('   ok G: container, refusals');
    testPicture();
    console.log('   ok S: the picture');
    testAccessors();
    testPerspective();
    console.log('   ok A: accessors, perspective');
    await testTextures(workdir);
    console.log('   ok T: textures');
    await testChildProcess(workdir);
    console.log('   ok C: child process');
    testSource();
  } finally {
    await fsp.rm(workdir, { recursive: true, force: true });
  }
  console.log('test-glb-preview.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
