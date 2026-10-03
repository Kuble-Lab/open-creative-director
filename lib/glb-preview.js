'use strict';

// The preview image of a 3D model, rendered by the app itself.
//
// fal.ai renders a preview for Tripo, Hunyuan and Meshy but not for SAM 3D, and a render of the provider can fail to download.
// This module draws one from the stored GLB (glTF binary): a PNG with a transparent background, seen from the front the way
// <model-viewer> shows a model first. It is plain JavaScript without a dependency: a small glTF reader, a z-buffer rasterizer
// with texturing and a PNG encoder. Textures are read by the PNG reader of this module and by ffmpeg (JPEG, WebP, large PNG);
// without ffmpeg a textured material is drawn in its base colour.
//
// renderGlbPreview(file) renders in a child process (a large model keeps a rasterizer busy for seconds, the event loop of the
// server must not wait for it), one model at a time, and answers null with a warning for anything it cannot draw: the preview
// is a convenience, the model is the result. The pure parts are exported for the tests.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');

const ffmpeg = require('./ffmpeg');

const DEFAULT_SIZE = 1024;
const MIN_SIZE = 64;
const MAX_SIZE = 2048;
const SUPERSAMPLE = 2;
const DEFAULT_TIMEOUT_MS = 90 * 1000;
const WORKER_HEAP_MB = 2048;
const MAX_WORKER_OUTPUT = 64 * 1024 * 1024;
const STDERR_TAIL = 2000;

// The view: from the front (+Z towards -Z, Y up), 15 degrees above the horizon, aimed at the middle of the bounding box, like
// the first view of <model-viewer>. The distance only sets how strong the perspective is: the silhouette is fitted into the
// square afterwards, with a margin on each side (fraction of the side).
const VIEW = Object.freeze({ fovDeg: 30, elevationDeg: 15, azimuthDeg: 0, margin: 0.05 });
// Shading: a base light and one directional light from the upper left front (in camera space), two-sided. The textures of
// generated models carry their shadows already, so the base is high and the model is never dark.
const AMBIENT = 0.6;
const DIFFUSE = 0.45;
const LIGHT_CAMERA = Object.freeze([-0.45, 0.65, 0.75]);
const LIGHT_GREY = 0.8; // a material without a colour of its own

const GLB_MAGIC = 0x46546c67; // "glTF"
const GLB_CHUNK_JSON = 0x4e4f534a;
const GLB_CHUNK_BIN = 0x004e4942;
const GLB_JSON_MAX_BYTES = 32 * 1024 * 1024;
const MAX_ACCESSOR_ELEMENTS = 64 * 1024 * 1024;
const MAX_TRIANGLES = 16 * 1000 * 1000;
const MAX_INSTANCES = 4096;
const MAX_NODE_VISITS = 20000;
const MAX_NODE_DEPTH = 256;

const MAX_TEXTURE_SIDE = 2048; // larger textures are scaled down by ffmpeg
const MAX_TEXTURE_PIXELS = 100 * 1000 * 1000; // what the header of an image may claim
const NATIVE_PNG_PIXELS = 4096 * 4096; // the PNG reader of this module takes up to this many pixels itself
const TEXTURE_TIMEOUT_MS = 60 * 1000;

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const WRAP_REPEAT = 10497;
const WRAP_CLAMP = 33071;
const WRAP_MIRROR = 33648;

// Extensions a model may require and this renderer can do without: the material ones only change what it does not draw
// (it shades on its own), the others are read through the plain accessors.
const HANDLED_EXTENSION = /^(KHR_materials_[a-z_]+|KHR_lights_punctual|KHR_mesh_quantization|EXT_texture_webp)$/;

// A reason a model cannot be drawn (the messages end up in the log of the server). Anything else that is thrown is a bug.
class PreviewError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PreviewError';
  }
}

function fail(message) {
  throw new PreviewError(message);
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;
const isNumbers = (value, length) => Array.isArray(value) && value.length === length && value.every((item) => typeof item === 'number' && Number.isFinite(item));

/* ---------- PNG: encoder and reader ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'latin1');
  chunk.set(data, 8);
  chunk.writeUInt32BE(crc32(chunk, 4, 8 + data.length), 8 + data.length);
  return chunk;
}

function paeth(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  return pb <= pc ? up : upLeft;
}

// One scanline of 4-byte pixels filtered with filter `type` (0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth) into `out`.
function filterRow(type, row, prev, out) {
  const length = row.length;
  for (let i = 0; i < length; i += 1) {
    const left = i >= 4 ? row[i - 4] : 0;
    const up = prev[i];
    let predicted = 0;
    if (type === 1) predicted = left;
    else if (type === 2) predicted = up;
    else if (type === 3) predicted = (left + up) >> 1;
    else if (type === 4) predicted = paeth(left, up, i >= 4 ? prev[i - 4] : 0);
    out[i] = (row[i] - predicted) & 255;
  }
}

// RGBA (8 bits, straight alpha, width * height * 4 bytes) as a PNG. Per line the filter with the smallest sum of absolute
// values is used (the usual heuristic), so smooth renders stay small.
function encodePng(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('Ungueltige Bildgroesse');
  const stride = width * 4;
  if (rgba.length < stride * height) throw new Error('Zu wenige Bilddaten');
  const raw = Buffer.alloc((stride + 1) * height);
  const none = new Uint8Array(stride);
  const trial = new Uint8Array(stride);
  const best = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : none;
    let bestType = 0;
    let bestScore = Infinity;
    for (let type = 0; type < 5; type += 1) {
      filterRow(type, row, prev, trial);
      let score = 0;
      for (let i = 0; i < stride; i += 1) score += trial[i] < 128 ? trial[i] : 256 - trial[i];
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
        best.set(trial);
        if (score === 0) break;
      }
    }
    raw[y * (stride + 1)] = bestType;
    raw.set(best, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })), pngChunk('IEND', Buffer.alloc(0))]);
}

// The unfiltered bytes of a non-interlaced PNG, or null for a filter byte that does not exist.
function unfilterPng(raw, height, stride, bpp) {
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    if (filter === 0) {
      out.set(raw.subarray(src, src + stride), dst);
    } else if (filter === 1) {
      for (let i = 0; i < stride; i += 1) out[dst + i] = raw[src + i] + (i >= bpp ? out[dst + i - bpp] : 0);
    } else if (filter === 2) {
      for (let i = 0; i < stride; i += 1) out[dst + i] = raw[src + i] + (y > 0 ? out[up + i] : 0);
    } else if (filter === 3) {
      for (let i = 0; i < stride; i += 1) out[dst + i] = raw[src + i] + (((i >= bpp ? out[dst + i - bpp] : 0) + (y > 0 ? out[up + i] : 0)) >> 1);
    } else if (filter === 4) {
      for (let i = 0; i < stride; i += 1) {
        const left = i >= bpp ? out[dst + i - bpp] : 0;
        out[dst + i] = raw[src + i] + (y > 0 ? paeth(left, out[up + i], i >= bpp ? out[up + i - bpp] : 0) : left);
      }
    } else {
      return null;
    }
  }
  return out;
}

const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// A PNG as { width, height, data } (RGBA, 8 bits, row by row from the top), or null when it is not a PNG this reader takes:
// interlaced images, 1 to 4 bit samples, damaged data. Callers fall back to ffmpeg then.
function decodePng(bytes) {
  if (bytes.length < 33 || !Buffer.from(bytes.buffer, bytes.byteOffset, 8).equals(PNG_SIGNATURE)) return null;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  let header = null;
  let palette = null;
  let transparency = null;
  const data = [];
  for (let offset = 8; offset + 12 <= buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    if (start + length + 4 > buffer.length) return null;
    if (type === 'IHDR' && length >= 13) {
      header = { width: buffer.readUInt32BE(start), height: buffer.readUInt32BE(start + 4), depth: buffer[start + 8], colorType: buffer[start + 9], interlace: buffer[start + 12] };
    } else if (type === 'PLTE') {
      palette = buffer.subarray(start, start + length);
    } else if (type === 'tRNS') {
      transparency = buffer.subarray(start, start + length);
    } else if (type === 'IDAT') {
      data.push(buffer.subarray(start, start + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = start + length + 4;
  }
  if (!header || !data.length || header.interlace !== 0) return null;
  const { width, height, depth, colorType } = header;
  const channels = PNG_CHANNELS[colorType];
  if (!channels || width < 1 || height < 1 || width * height > NATIVE_PNG_PIXELS) return null;
  if (depth !== 8 && !(depth === 16 && colorType !== 3)) return null;
  if (colorType === 3 && !palette) return null;
  const bpp = (channels * depth) / 8;
  const stride = width * bpp;
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(data), { maxOutputLength: (stride + 1) * height + 64 });
  } catch (_) {
    return null;
  }
  if (raw.length < (stride + 1) * height) return null;
  const pixels = unfilterPng(raw, height, stride, bpp);
  if (!pixels) return null;
  if (colorType === 6 && depth === 8) return { width, height, data: pixels };

  const out = new Uint8Array(width * height * 4);
  const step = depth === 16 ? 2 : 1; // of a 16-bit sample the high byte is kept
  for (let i = 0, count = width * height; i < count; i += 1) {
    const o = i * 4;
    if (colorType === 2 || colorType === 6) {
      out[o] = pixels[i * channels * step];
      out[o + 1] = pixels[(i * channels + 1) * step];
      out[o + 2] = pixels[(i * channels + 2) * step];
      out[o + 3] = colorType === 6 ? pixels[(i * channels + 3) * step] : 255;
    } else if (colorType === 0 || colorType === 4) {
      const gray = pixels[i * channels * step];
      out[o] = gray;
      out[o + 1] = gray;
      out[o + 2] = gray;
      out[o + 3] = colorType === 4 ? pixels[(i * channels + 1) * step] : 255;
    } else {
      const entry = pixels[i];
      out[o] = palette[entry * 3] || 0;
      out[o + 1] = palette[entry * 3 + 1] || 0;
      out[o + 2] = palette[entry * 3 + 2] || 0;
      out[o + 3] = transparency && entry < transparency.length ? transparency[entry] : 255;
    }
  }
  return { width, height, data: out };
}

/* ---------- textures: size of an image, ffmpeg ---------- */

// Type and size of a PNG, JPEG or WebP from its header, or null.
function imageInfo(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { type: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    for (let o = 2; o + 4 <= buffer.length; ) {
      if (buffer[o] !== 0xff) {
        o += 1;
        continue;
      }
      const marker = buffer[o + 1];
      if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        o += marker === 0xff ? 1 : 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (o + 9 > buffer.length) break;
        return { type: 'jpeg', width: buffer.readUInt16BE(o + 7), height: buffer.readUInt16BE(o + 5) };
      }
      o += 2 + buffer.readUInt16BE(o + 2);
    }
    return null;
  }
  if (buffer.length >= 30 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    const kind = buffer.toString('latin1', 12, 16);
    if (kind === 'VP8 ') return { type: 'webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      return {
        type: 'webp',
        width: 1 + (buffer[21] | ((buffer[22] & 0x3f) << 8)),
        height: 1 + ((buffer[22] >> 6) | (buffer[23] << 2) | ((buffer[24] & 0x0f) << 10))
      };
    }
    if (kind === 'VP8X') return { type: 'webp', width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  }
  return null;
}

// Decodes an image with ffmpeg to raw RGBA, scaled down so that no side is longer than MAX_TEXTURE_SIDE. A texture is
// sampled by its UV coordinates, so what matters is that it is a grid of colours, not its size.
function decodeWithFfmpeg(bytes, info) {
  const binary = ffmpeg.resolveBinary('ffmpeg');
  if (!binary) throw new Error('ffmpeg wurde nicht gefunden');
  let { width, height } = info;
  const filter = [];
  const longest = Math.max(width, height);
  if (longest > MAX_TEXTURE_SIDE) {
    width = Math.max(1, Math.round((width * MAX_TEXTURE_SIDE) / longest));
    height = Math.max(1, Math.round((height * MAX_TEXTURE_SIDE) / longest));
    filter.push('-vf', `scale=${width}:${height}:flags=area`);
  }
  const result = spawnSync(
    binary,
    ['-v', 'error', '-nostdin', '-noautorotate', '-i', 'pipe:0', '-frames:v', '1', ...filter, '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'],
    { input: bytes, maxBuffer: width * height * 4 + 1024 * 1024, timeout: TEXTURE_TIMEOUT_MS, windowsHide: true }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || '').split(/\r?\n/).filter(Boolean).slice(-2).join(' | ');
    throw new Error(`ffmpeg ist fehlgeschlagen (Exit ${result.status}): ${detail}`);
  }
  if (result.stdout.length !== width * height * 4) throw new Error('ffmpeg lieferte eine unerwartete Bildgroesse');
  return { width, height, data: new Uint8Array(result.stdout.buffer, result.stdout.byteOffset, result.stdout.length) };
}

// An embedded image as { width, height, data } (RGBA, row by row from the top). Throws when it cannot be read.
function decodeTexture(bytes) {
  const info = imageInfo(bytes);
  if (!info) throw new Error('kein PNG-, JPEG- oder WebP-Bild');
  const pixels = info.width * info.height;
  if (!(pixels > 0) || pixels > MAX_TEXTURE_PIXELS) throw new Error(`Bildgroesse ${info.width} x ${info.height} wird nicht gelesen`);
  if (info.type === 'png' && pixels <= NATIVE_PNG_PIXELS) {
    const image = decodePng(bytes);
    if (image) return image;
  }
  return decodeWithFfmpeg(bytes, info);
}

/* ---------- glTF: container, buffers, accessors ---------- */

// The two parts of a GLB: { json, bin } (bin is null without a BIN chunk). Throws PreviewError for anything that is not a
// complete GLB 2.0.
function parseGlb(input) {
  const buffer = Buffer.isBuffer(input) ? input : input instanceof Uint8Array ? Buffer.from(input.buffer, input.byteOffset, input.byteLength) : null;
  if (!buffer || buffer.length < 20) fail('Die Datei ist zu kurz fuer ein GLB');
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) fail('Die Datei ist kein GLB (glTF-Binaerformat)');
  const version = buffer.readUInt32LE(4);
  if (version !== 2) fail(`glTF-Version ${version} wird nicht unterstuetzt`);
  const length = buffer.readUInt32LE(8);
  if (length > buffer.length) fail('Die GLB-Datei ist abgeschnitten');
  let json = null;
  let bin = null;
  let offset = 12;
  while (offset + 8 <= length) {
    const size = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > length) fail('Ein Teil der GLB-Datei ragt ueber ihr Ende');
    if (type === GLB_CHUNK_JSON && json === null) {
      if (size > GLB_JSON_MAX_BYTES) fail('Der JSON-Teil der GLB-Datei ist zu gross');
      try {
        json = JSON.parse(buffer.toString('utf8', start, end).replace(/[\0\s]+$/, ''));
      } catch (_) {
        fail('Der JSON-Teil der GLB-Datei ist defekt');
      }
    } else if (type === GLB_CHUNK_BIN && bin === null) {
      bin = buffer.subarray(start, end);
    }
    offset = end;
  }
  if (!isObject(json)) fail('Der GLB-Datei fehlt der JSON-Teil');
  return { json, bin };
}

// The bytes of a data: URI (base64), or null: any other address is never read.
function decodeDataUri(uri) {
  const match = typeof uri === 'string' ? /^data:([^,]*),/i.exec(uri) : null;
  if (!match || !/;base64$/i.test(match[1])) return null;
  return Buffer.from(uri.slice(match[0].length), 'base64');
}

function bufferData(doc, index) {
  if (doc.buffers.has(index)) return doc.buffers.get(index);
  const entry = Array.isArray(doc.json.buffers) ? doc.json.buffers[index] : undefined;
  if (!isObject(entry)) fail(`Puffer ${index} fehlt`);
  let bytes;
  if (entry.uri === undefined) {
    if (index !== 0 || !doc.bin) fail(`Puffer ${index} hat keine Daten`);
    bytes = doc.bin;
  } else {
    bytes = decodeDataUri(entry.uri);
    if (!bytes) fail(`Puffer ${index} liegt ausserhalb der Datei und wird nicht gelesen`);
  }
  doc.buffers.set(index, bytes);
  return bytes;
}

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function readComponent(view, offset, componentType) {
  switch (componentType) {
    case 5120:
      return view.getInt8(offset);
    case 5121:
      return view.getUint8(offset);
    case 5122:
      return view.getInt16(offset, true);
    case 5123:
      return view.getUint16(offset, true);
    case 5125:
      return view.getUint32(offset, true);
    default:
      return view.getFloat32(offset, true);
  }
}

function normalizeComponent(componentType, value) {
  switch (componentType) {
    case 5120:
      return Math.max(value / 127, -1);
    case 5121:
      return value / 255;
    case 5122:
      return Math.max(value / 32767, -1);
    case 5123:
      return value / 65535;
    default:
      return value;
  }
}

// The values of one accessor as { data, count, width }: a Float32Array (normalized integers become 0..1 or -1..1), or a
// Uint32Array for indices. byteOffset, byteStride and every component type are honoured; sparse accessors are not drawn.
// Plain float or 32-bit index data is returned as a view into the file, without a copy.
function readAccessor(doc, index, { indices = false } = {}) {
  const accessor = Array.isArray(doc.json.accessors) ? doc.json.accessors[index] : undefined;
  if (!isObject(accessor)) fail(`Accessor ${index} fehlt`);
  if (accessor.sparse !== undefined) fail('Sparse-Accessoren werden nicht gezeichnet');
  const { componentType, count } = accessor;
  const componentBytes = COMPONENT_BYTES[componentType];
  const width = TYPE_WIDTH[accessor.type];
  if (!componentBytes || !width) fail(`Accessor ${index} hat einen unbekannten Typ`);
  if (!isCount(count) || count > MAX_ACCESSOR_ELEMENTS) fail(`Accessor ${index} hat eine ungueltige Anzahl`);
  if (indices && (width !== 1 || componentType === 5120 || componentType === 5122 || componentType === 5126)) fail('Indizes haben einen ungueltigen Typ');
  const total = count * width;
  const normalized = accessor.normalized === true && componentType !== 5126;
  const Out = indices ? Uint32Array : Float32Array;
  if (accessor.bufferView === undefined) return { data: new Out(total), count, width }; // all zero, by the specification

  const view = Array.isArray(doc.json.bufferViews) ? doc.json.bufferViews[accessor.bufferView] : undefined;
  if (!isObject(view)) fail(`BufferView ${accessor.bufferView} fehlt`);
  const bytes = bufferData(doc, view.buffer);
  const elementBytes = componentBytes * width;
  const stride = view.byteStride === undefined ? elementBytes : view.byteStride;
  const viewOffset = view.byteOffset === undefined ? 0 : view.byteOffset;
  const accessorOffset = accessor.byteOffset === undefined ? 0 : accessor.byteOffset;
  if (!isCount(viewOffset) || !isCount(accessorOffset) || !Number.isInteger(stride) || stride < elementBytes) fail(`Accessor ${index} hat ungueltige Offsets`);
  const start = viewOffset + accessorOffset;
  if (count > 0 && start + (count - 1) * stride + elementBytes > bytes.length) fail(`Accessor ${index} ragt ueber den Puffer`);

  const base = bytes.byteOffset + start;
  const packed = stride === elementBytes && LITTLE_ENDIAN;
  if (packed && componentType === (indices ? 5125 : 5126) && base % 4 === 0) return { data: new Out(bytes.buffer, base, total), count, width };
  if (packed && indices && componentType === 5123 && base % 2 === 0) {
    const data = new Uint32Array(total);
    data.set(new Uint16Array(bytes.buffer, base, total));
    return { data, count, width };
  }
  if (packed && indices && componentType === 5121) {
    const data = new Uint32Array(total);
    data.set(new Uint8Array(bytes.buffer, base, total));
    return { data, count, width };
  }
  const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const data = new Out(total);
  for (let i = 0; i < count; i += 1) {
    for (let c = 0; c < width; c += 1) {
      const value = readComponent(dataView, start + i * stride + c * componentBytes, componentType);
      data[i * width + c] = normalized ? normalizeComponent(componentType, value) : value;
    }
  }
  return { data, count, width };
}

/* ---------- glTF: scene, materials, meshes ---------- */

function mat4Multiply(a, b) {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

const IDENTITY = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// The local matrix of a node: `matrix`, or translation * rotation (quaternion x y z w) * scale. Column-major like glTF.
function nodeMatrix(node) {
  if (node.matrix !== undefined) {
    if (!isNumbers(node.matrix, 16)) fail('Die Matrix eines Nodes ist ungueltig');
    return Float64Array.from(node.matrix);
  }
  const translation = node.translation === undefined ? [0, 0, 0] : node.translation;
  const rotation = node.rotation === undefined ? [0, 0, 0, 1] : node.rotation;
  const scale = node.scale === undefined ? [1, 1, 1] : node.scale;
  if (!isNumbers(translation, 3) || !isNumbers(rotation, 4) || !isNumbers(scale, 3)) fail('Die Transformation eines Nodes ist ungueltig');
  let [x, y, z, w] = rotation;
  const length = Math.hypot(x, y, z, w);
  if (length > 0) {
    x /= length;
    y /= length;
    z /= length;
    w /= length;
  } else {
    w = 1;
  }
  const m = new Float64Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * scale[0];
  m[1] = 2 * (x * y + z * w) * scale[0];
  m[2] = 2 * (x * z - y * w) * scale[0];
  m[4] = 2 * (x * y - z * w) * scale[1];
  m[5] = (1 - 2 * (x * x + z * z)) * scale[1];
  m[6] = 2 * (y * z + x * w) * scale[1];
  m[8] = 2 * (x * z + y * w) * scale[2];
  m[9] = 2 * (y * z - x * w) * scale[2];
  m[10] = (1 - 2 * (x * x + y * y)) * scale[2];
  m[12] = translation[0];
  m[13] = translation[1];
  m[14] = translation[2];
  m[15] = 1;
  return m;
}

// Every mesh instance of the default scene with its world matrix: [{ mesh, matrix }].
function collectInstances(json) {
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const meshes = Array.isArray(json.meshes) ? json.meshes : [];
  if (!nodes.length) return meshes.map((_, mesh) => ({ mesh, matrix: IDENTITY }));
  let roots;
  if (Array.isArray(json.scenes) && json.scenes.length) {
    const scene = json.scenes[isCount(json.scene) ? json.scene : 0] || json.scenes[0];
    roots = isObject(scene) && Array.isArray(scene.nodes) ? scene.nodes : [];
  } else {
    const children = new Set();
    for (const node of nodes) if (isObject(node) && Array.isArray(node.children)) node.children.forEach((child) => children.add(child));
    roots = nodes.map((_, index) => index).filter((index) => !children.has(index));
  }
  const instances = [];
  const stack = roots.map((index) => ({ index, parent: IDENTITY, depth: 0 }));
  let visits = 0;
  while (stack.length) {
    const { index, parent, depth } = stack.pop();
    const node = nodes[index];
    visits += 1;
    if (!isObject(node)) fail(`Node ${index} fehlt`);
    if (depth > MAX_NODE_DEPTH || visits > MAX_NODE_VISITS) fail('Die Node-Hierarchie ist zu gross oder kreist');
    const world = mat4Multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined) instances.push({ mesh: node.mesh, matrix: world });
    if (instances.length > MAX_INSTANCES) fail('Das Modell hat zu viele Instanzen');
    if (Array.isArray(node.children)) for (const child of node.children) stack.push({ index: child, parent: world, depth: depth + 1 });
  }
  return instances;
}

// Linear (glTF colour factors, vertex colours) to the encoding of the display; textures are encoded already.
function linearToSrgb(value) {
  const c = value <= 0 ? 0 : value >= 1 ? 1 : value;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function imageBytes(doc, index) {
  const image = Array.isArray(doc.json.images) ? doc.json.images[index] : undefined;
  if (!isObject(image)) fail(`Bild ${index} fehlt`);
  if (image.bufferView !== undefined) {
    const view = Array.isArray(doc.json.bufferViews) ? doc.json.bufferViews[image.bufferView] : undefined;
    if (!isObject(view)) fail(`BufferView ${image.bufferView} fehlt`);
    const bytes = bufferData(doc, view.buffer);
    const start = view.byteOffset === undefined ? 0 : view.byteOffset;
    if (!isCount(start) || !isCount(view.byteLength) || start + view.byteLength > bytes.length) fail(`Bild ${index} ragt ueber den Puffer`);
    return bytes.subarray(start, start + view.byteLength);
  }
  // an address outside the file is never read (nothing is fetched, no file opened): the material is drawn without it
  const decoded = decodeDataUri(image.uri);
  if (!decoded) throw new Error('das Bild liegt ausserhalb der Datei und wird nicht gelesen');
  return decoded;
}

// The base colour texture of a material as { width, height, data, wrapS, wrapT }, or null (reason through `warn`).
function loadTexture(doc, reference, state) {
  const texture = Array.isArray(doc.json.textures) ? doc.json.textures[reference.index] : undefined;
  if (!isObject(texture)) return null;
  const webp = isObject(texture.extensions) && isObject(texture.extensions.EXT_texture_webp) ? texture.extensions.EXT_texture_webp.source : undefined;
  const source = texture.source !== undefined ? texture.source : webp;
  if (source === undefined) return null;
  if (!state.images.has(source)) {
    let image = null;
    try {
      image = state.decodeImage(imageBytes(doc, source));
    } catch (err) {
      state.warn(`Textur (Bild ${source}) nicht gelesen: ${err.message}`);
    }
    state.images.set(source, image);
  }
  const image = state.images.get(source);
  if (!image) return null;
  const sampler = isObject(doc.json.samplers && doc.json.samplers[texture.sampler]) ? doc.json.samplers[texture.sampler] : {};
  const wrap = (value) => (value === WRAP_CLAMP || value === WRAP_MIRROR ? value : WRAP_REPEAT);
  return { width: image.width, height: image.height, data: image.data, wrapS: wrap(sampler.wrapS), wrapT: wrap(sampler.wrapT) };
}

// What the rasterizer needs of a material: the colour in display encoding, the base colour texture and how alpha is used.
// OPAQUE ignores alpha; MASK cuts at alphaCutoff; BLEND is drawn as a cut at one half (no sorting of transparent surfaces).
function loadMaterial(doc, index, state) {
  if (state.materials.has(index)) return state.materials.get(index);
  const source = index !== undefined && Array.isArray(doc.json.materials) ? doc.json.materials[index] : undefined;
  const pbr = isObject(source) && isObject(source.pbrMetallicRoughness) ? source.pbrMetallicRoughness : {};
  const factor = isNumbers(pbr.baseColorFactor, 4) ? pbr.baseColorFactor : null;
  const reference = isObject(pbr.baseColorTexture) && isCount(pbr.baseColorTexture.index) ? pbr.baseColorTexture : null;
  const texture = reference ? loadTexture(doc, reference, state) : null;
  const mode = isObject(source) ? source.alphaMode : undefined;
  const material = {
    // a material without a colour of its own is light grey (a factor of 1 is the neutral multiplier of a texture)
    r: factor ? linearToSrgb(factor[0]) : texture ? 1 : LIGHT_GREY,
    g: factor ? linearToSrgb(factor[1]) : texture ? 1 : LIGHT_GREY,
    b: factor ? linearToSrgb(factor[2]) : texture ? 1 : LIGHT_GREY,
    a: factor ? Math.min(1, Math.max(0, factor[3])) : 1,
    texture,
    texCoord: texture && isCount(reference.texCoord) ? reference.texCoord : 0,
    cut: mode === 'MASK' || mode === 'BLEND',
    cutoff: mode === 'MASK' && typeof source.alphaCutoff === 'number' ? source.alphaCutoff : 0.5
  };
  state.materials.set(index, material);
  return material;
}

// Which vertices sit at exactly the same place: rep[i] is the first vertex with the position of vertex i. An open-addressing
// table over the bits of the three coordinates, so equal means equal and nothing is merged by accident.
function weldByPosition(positions, count) {
  const bits = new Int32Array(positions.buffer, positions.byteOffset, count * 3);
  let size = 1;
  while (size < count * 2) size *= 2;
  const table = new Int32Array(size).fill(-1);
  const rep = new Int32Array(count);
  const key = (v, axis) => (bits[v * 3 + axis] === -2147483648 ? 0 : bits[v * 3 + axis]); // -0 is 0
  for (let v = 0; v < count; v += 1) {
    const x = key(v, 0);
    const y = key(v, 1);
    const z = key(v, 2);
    let hash = Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(z, 0xc2b2ae3d);
    hash ^= hash >>> 15;
    hash = Math.imul(hash, 0x2c1b3c6d);
    hash ^= hash >>> 12;
    let slot = hash & (size - 1);
    for (;;) {
      const other = table[slot];
      if (other === -1) {
        table[slot] = v;
        rep[v] = v;
        break;
      }
      if (key(other, 0) === x && key(other, 1) === y && key(other, 2) === z) {
        rep[v] = other;
        break;
      }
      slot = (slot + 1) & (size - 1);
    }
  }
  return rep;
}

// Smooth vertex normals from the faces (area weighted), for a model without NORMAL. Vertices at the same place share one
// normal, so the seams of the UV islands do not show in the shading.
function smoothNormals(positions, triangles, count) {
  const rep = weldByPosition(positions, count);
  const sum = new Float64Array(count * 3);
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const a = triangles[t] * 3;
    const b = triangles[t + 1] * 3;
    const c = triangles[t + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (let k = 0; k < 3; k += 1) {
      const r = rep[triangles[t + k]] * 3;
      sum[r] += nx;
      sum[r + 1] += ny;
      sum[r + 2] += nz;
    }
  }
  const normals = new Float32Array(count * 3);
  for (let v = 0; v < count; v += 1) {
    const r = rep[v] * 3;
    const length = Math.hypot(sum[r], sum[r + 1], sum[r + 2]);
    if (length > 0) {
      normals[v * 3] = sum[r] / length;
      normals[v * 3 + 1] = sum[r + 1] / length;
      normals[v * 3 + 2] = sum[r + 2] / length;
    }
  }
  return normals;
}

// The triangle list (3 indices each) of a primitive in drawing mode 4 (triangles), 5 (strip) or 6 (fan), checked against the
// number of vertices.
function triangleList(mode, source, vertexCount) {
  let list;
  if (mode === 4) {
    list = source.length % 3 === 0 ? source : source.subarray(0, source.length - (source.length % 3));
  } else {
    const count = Math.max(0, source.length - 2);
    list = new Uint32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      if (mode === 5) {
        list[i * 3] = source[i + (i % 2)];
        list[i * 3 + 1] = source[i + 1 - (i % 2)];
        list[i * 3 + 2] = source[i + 2];
      } else {
        list[i * 3] = source[0];
        list[i * 3 + 1] = source[i + 1];
        list[i * 3 + 2] = source[i + 2];
      }
    }
  }
  for (let i = 0; i < list.length; i += 1) if (list[i] >= vertexCount) fail('Ein Index zeigt auf einen Punkt, den es nicht gibt');
  return list;
}

// An attribute as floats when it has the right shape (width, and at least as many entries as the positions), else null.
function optionalAttribute(doc, index, widths, vertexCount) {
  if (index === undefined) return null;
  const found = readAccessor(doc, index);
  return widths.includes(found.width) && found.count >= vertexCount ? found : null;
}

// The data of one primitive in the space of its mesh (cached per primitive): { count, pos, nrm, uv, col, alpha, tris, material }.
// Null for a primitive that is no triangle mesh (points, lines).
function loadPrimitive(doc, primitive, state) {
  if (!isObject(primitive) || !isObject(primitive.attributes) || primitive.attributes.POSITION === undefined) return null;
  const mode = primitive.mode === undefined ? 4 : primitive.mode;
  if (mode !== 4 && mode !== 5 && mode !== 6) return null;
  if (state.primitives.has(primitive)) return state.primitives.get(primitive);

  const position = readAccessor(doc, primitive.attributes.POSITION);
  if (position.width !== 3) fail('POSITION ist kein VEC3');
  const count = position.count;
  let source;
  if (primitive.indices !== undefined) {
    source = readAccessor(doc, primitive.indices, { indices: true }).data;
  } else {
    source = new Uint32Array(count);
    for (let i = 0; i < count; i += 1) source[i] = i;
  }
  const tris = triangleList(mode, source, count);
  if (!tris.length) {
    state.primitives.set(primitive, null);
    return null;
  }
  const material = loadMaterial(doc, primitive.material, state);
  const normal = optionalAttribute(doc, primitive.attributes.NORMAL, [3], count);
  const texCoord = material.texture ? optionalAttribute(doc, primitive.attributes[`TEXCOORD_${material.texCoord}`], [2], count) : null;
  const color = optionalAttribute(doc, primitive.attributes.COLOR_0, [3, 4], count);

  let col = null;
  let alpha = null;
  if (color) {
    col = new Float32Array(count * 3);
    for (let v = 0; v < count; v += 1) {
      for (let k = 0; k < 3; k += 1) col[v * 3 + k] = linearToSrgb(color.data[v * color.width + k]);
    }
    if (color.width === 4) {
      alpha = new Float32Array(count);
      for (let v = 0; v < count; v += 1) alpha[v] = color.data[v * 4 + 3];
    }
  }
  const data = {
    count,
    pos: position.data,
    nrm: normal ? normal.data : smoothNormals(position.data, tris, count),
    // a material with a texture whose coordinates are missing is drawn in its colour
    uv: texCoord ? texCoord.data : null,
    col,
    alpha,
    tris,
    material: material.texture && !texCoord ? { ...material, texture: null } : material
  };
  state.primitives.set(primitive, data);
  return data;
}

// A primitive at its place in the scene: the vertices in world space, normals with the normal matrix (the cofactor matrix
// of the upper 3x3; its sign does not matter, the shading is two-sided). Widens `bounds` by the vertices.
function placePrimitive(data, matrix, bounds) {
  const { count, pos, nrm } = data;
  const m = matrix;
  const a = m[0];
  const b = m[4];
  const c = m[8];
  const d = m[1];
  const e = m[5];
  const f = m[9];
  const g = m[2];
  const h = m[6];
  const i = m[10];
  const n00 = e * i - f * h;
  const n01 = f * g - d * i;
  const n02 = d * h - e * g;
  const n10 = c * h - b * i;
  const n11 = a * i - c * g;
  const n12 = b * g - a * h;
  const n20 = b * f - c * e;
  const n21 = c * d - a * f;
  const n22 = a * e - b * d;
  const worldPos = new Float32Array(count * 3);
  const worldNrm = new Float32Array(count * 3);
  let [minX, minY, minZ] = bounds.min;
  let [maxX, maxY, maxZ] = bounds.max;
  for (let v = 0; v < count; v += 1) {
    const o = v * 3;
    const x = pos[o];
    const y = pos[o + 1];
    const z = pos[o + 2];
    const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
    worldPos[o] = wx;
    worldPos[o + 1] = wy;
    worldPos[o + 2] = wz;
    if (Number.isFinite(wx) && Number.isFinite(wy) && Number.isFinite(wz)) {
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
      if (wz < minZ) minZ = wz;
      if (wz > maxZ) maxZ = wz;
    }
    const nx = nrm[o];
    const ny = nrm[o + 1];
    const nz = nrm[o + 2];
    const tx = n00 * nx + n01 * ny + n02 * nz;
    const ty = n10 * nx + n11 * ny + n12 * nz;
    const tz = n20 * nx + n21 * ny + n22 * nz;
    const length = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (length > 0) {
      worldNrm[o] = tx / length;
      worldNrm[o + 1] = ty / length;
      worldNrm[o + 2] = tz / length;
    }
  }
  bounds.min = [minX, minY, minZ];
  bounds.max = [maxX, maxY, maxZ];
  return { count, pos: worldPos, nrm: worldNrm, uv: data.uv, col: data.col, alpha: data.alpha, tris: data.tris, material: data.material };
}

// The model of a GLB ready to draw: { items, min, max, triangles }, every item a primitive in world space. Throws PreviewError
// for a model that cannot be drawn (a required extension such as Draco, sparse accessors, damaged data, nothing to draw).
// decodeImage(bytes) -> { width, height, data } reads a texture, warn(message) hears about what was left out.
function buildScene(glb, { decodeImage = decodeTexture, warn = () => {} } = {}) {
  const doc = { json: glb.json, bin: glb.bin, buffers: new Map() };
  const required = Array.isArray(doc.json.extensionsRequired) ? doc.json.extensionsRequired : [];
  for (const name of required) {
    if (typeof name !== 'string' || !HANDLED_EXTENSION.test(name)) fail(`Das Modell verlangt die Erweiterung ${name}, die nicht gezeichnet wird`);
  }
  const state = { decodeImage, warn, images: new Map(), materials: new Map(), primitives: new Map() };
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const items = [];
  let triangles = 0;
  for (const instance of collectInstances(doc.json)) {
    const mesh = Array.isArray(doc.json.meshes) ? doc.json.meshes[instance.mesh] : undefined;
    if (!isObject(mesh) || !Array.isArray(mesh.primitives)) fail(`Mesh ${instance.mesh} fehlt`);
    for (const primitive of mesh.primitives) {
      const data = loadPrimitive(doc, primitive, state);
      if (!data) continue;
      triangles += data.tris.length / 3;
      if (triangles > MAX_TRIANGLES) fail('Das Modell hat zu viele Dreiecke');
      items.push(placePrimitive(data, instance.matrix, bounds));
    }
  }
  if (!items.length) fail('Das Modell enthaelt keine Dreiecke');
  if (!bounds.min.every(Number.isFinite) || !bounds.max.every(Number.isFinite)) fail('Das Modell hat keine gueltigen Punkte');
  return { items, min: bounds.min, max: bounds.max, triangles };
}

/* ---------- rasterizer ---------- */

const clampSize = (size) => {
  const value = Math.round(Number(size));
  return Number.isFinite(value) ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, value)) : DEFAULT_SIZE;
};

const normalized = (v) => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
};

// The camera: where it stands, its axes, and the light in world space.
function makeCamera(min, max) {
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = 0.5 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  if (!(radius > 0) || !Number.isFinite(radius)) fail('Das Modell hat keine Ausdehnung');
  const rad = Math.PI / 180;
  const elevation = VIEW.elevationDeg * rad;
  const azimuth = VIEW.azimuthDeg * rad;
  const distance = (1.05 * radius) / Math.sin((VIEW.fovDeg * rad) / 2);
  const toEye = [Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation)];
  const forward = [-toEye[0], -toEye[1], -toEye[2]];
  const right = normalized([-forward[2], 0, forward[0]]); // forward x up(0,1,0)
  const up = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]];
  const light = normalized([
    right[0] * LIGHT_CAMERA[0] + up[0] * LIGHT_CAMERA[1] + toEye[0] * LIGHT_CAMERA[2],
    right[1] * LIGHT_CAMERA[0] + up[1] * LIGHT_CAMERA[1] + toEye[1] * LIGHT_CAMERA[2],
    right[2] * LIGHT_CAMERA[0] + up[2] * LIGHT_CAMERA[1] + toEye[2] * LIGHT_CAMERA[2]
  ]);
  return { eye: [center[0] + toEye[0] * distance, center[1] + toEye[1] * distance, center[2] + toEye[2] * distance], forward, right, up, light };
}

// The vertices of an item seen from the camera, in tangent units: tx = x / depth, ty = y / depth, and iw = 1 / depth.
function projectItem(item, camera) {
  const { count, pos } = item;
  const tx = new Float64Array(count);
  const ty = new Float64Array(count);
  const iw = new Float64Array(count);
  const [ex, ey, ez] = camera.eye;
  const [fx, fy, fz] = camera.forward;
  const [rx, ry, rz] = camera.right;
  const [ux, uy, uz] = camera.up;
  for (let v = 0; v < count; v += 1) {
    const dx = pos[v * 3] - ex;
    const dy = pos[v * 3 + 1] - ey;
    const dz = pos[v * 3 + 2] - ez;
    const depth = dx * fx + dy * fy + dz * fz;
    const inverse = depth > 1e-9 ? 1 / depth : 0;
    iw[v] = inverse;
    tx[v] = (dx * rx + dy * ry + dz * rz) * inverse;
    ty[v] = (dx * ux + dy * uy + dz * uz) * inverse;
  }
  return { tx, ty, iw };
}

function wrapIndex(index, size, mode) {
  if (mode === WRAP_CLAMP) return index < 0 ? 0 : index >= size ? size - 1 : index;
  if (mode === WRAP_MIRROR) {
    const period = size * 2;
    const m = ((index % period) + period) % period;
    return m < size ? m : period - 1 - m;
  }
  const m = index % size;
  return m < 0 ? m + size : m;
}

// Draws the triangles of one item into the frame (z-buffer on 1 / depth, perspective-correct attributes, no culling). The
// pixel centres decide what a triangle covers; the shading is two-sided: a normal that looks away from the viewer is turned.
function drawItem(frame, item, screen, view) {
  const { size, depth, color } = frame;
  const { sx, sy, iw } = screen;
  const { tris, uv, nrm, col, alpha, material } = item;
  const texture = material.texture;
  const texData = texture ? texture.data : null;
  const texW = texture ? texture.width : 0;
  const texH = texture ? texture.height : 0;
  const wrapS = texture ? texture.wrapS : WRAP_REPEAT;
  const wrapT = texture ? texture.wrapT : WRAP_REPEAT;
  const { cut, cutoff } = material;
  const baseR = material.r;
  const baseG = material.g;
  const baseB = material.b;
  const baseA = material.a;
  const [lx, ly, lz] = view.light;
  const [rx, ry, rz] = view.right;
  const [ux, uy, uz] = view.up;
  const [fx, fy, fz] = view.forward;
  const half = size / 2;
  const triangleCount = Math.floor(tris.length / 3);

  for (let t = 0; t < triangleCount; t += 1) {
    const i0 = tris[t * 3];
    const i1 = tris[t * 3 + 1];
    const i2 = tris[t * 3 + 2];
    const iw0 = iw[i0];
    const iw1 = iw[i1];
    const iw2 = iw[i2];
    if (!(iw0 > 0 && iw1 > 0 && iw2 > 0)) continue;
    const x0 = sx[i0];
    const y0 = sy[i0];
    const x1 = sx[i1];
    const y1 = sy[i1];
    const x2 = sx[i2];
    const y2 = sy[i2];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (!(area > 1e-12 || area < -1e-12)) continue; // also true for NaN
    const minX = Math.min(x0, x1, x2);
    const maxX = Math.max(x0, x1, x2);
    const minY = Math.min(y0, y1, y2);
    const maxY = Math.max(y0, y1, y2);
    const px0 = Math.max(0, Math.ceil(minX - 0.5));
    const px1 = Math.min(size - 1, Math.floor(maxX - 0.5));
    const py0 = Math.max(0, Math.ceil(minY - 0.5));
    const py1 = Math.min(size - 1, Math.floor(maxY - 0.5));
    if (px0 > px1 || py0 > py1) continue;

    // barycentric weights of the first pixel centre and their steps; b0 belongs to vertex 0, and so on
    const inverseArea = 1 / area;
    const cx = px0 + 0.5;
    const cy = py0 + 0.5;
    const d0x = (y1 - y2) * inverseArea;
    const d0y = (x2 - x1) * inverseArea;
    const d1x = (y2 - y0) * inverseArea;
    const d1y = (x0 - x2) * inverseArea;
    const d2x = (y0 - y1) * inverseArea;
    const d2y = (x1 - x0) * inverseArea;
    let b0Row = ((x2 - x1) * (cy - y1) - (y2 - y1) * (cx - x1)) * inverseArea;
    let b1Row = ((x0 - x2) * (cy - y2) - (y0 - y2) * (cx - x2)) * inverseArea;
    let b2Row = ((x1 - x0) * (cy - y0) - (y1 - y0) * (cx - x0)) * inverseArea;
    const w0 = iw0;
    const w1 = iw1;
    const w2 = iw2;
    const n0 = i0 * 3;
    const n1 = i1 * 3;
    const n2 = i2 * 3;

    for (let py = py0; py <= py1; py += 1) {
      let b0 = b0Row;
      let b1 = b1Row;
      let b2 = b2Row;
      const tangentY = view.centerY - (py + 0.5 - half) * view.inverseScale;
      const rowX = fx + tangentY * ux;
      const rowY = fy + tangentY * uy;
      const rowZ = fz + tangentY * uz;
      let o = py * size + px0;
      for (let px = px0; px <= px1; px += 1, o += 1) {
        if (b0 >= 0 && b1 >= 0 && b2 >= 0) {
          const z = b0 * w0 + b1 * w1 + b2 * w2;
          if (z > depth[o]) {
            const inverse = 1 / z;
            const c0 = b0 * w0 * inverse;
            const c1 = b1 * w1 * inverse;
            const c2 = 1 - c0 - c1;
            let r = baseR;
            let g = baseG;
            let b = baseB;
            let a = baseA;
            if (texData !== null) {
              const tu = c0 * uv[i0 * 2] + c1 * uv[i1 * 2] + c2 * uv[i2 * 2];
              const tv = c0 * uv[i0 * 2 + 1] + c1 * uv[i1 * 2 + 1] + c2 * uv[i2 * 2 + 1];
              const fxp = tu * texW - 0.5;
              const fyp = tv * texH - 0.5;
              const ix = Math.floor(fxp);
              const iy = Math.floor(fyp);
              if (ix === ix && iy === iy) {
                const ax = fxp - ix;
                const ay = fyp - iy;
                const xa = wrapIndex(ix, texW, wrapS);
                const xb = wrapIndex(ix + 1, texW, wrapS);
                const ya = wrapIndex(iy, texH, wrapT);
                const yb = wrapIndex(iy + 1, texH, wrapT);
                const o00 = (ya * texW + xa) * 4;
                const o10 = (ya * texW + xb) * 4;
                const o01 = (yb * texW + xa) * 4;
                const o11 = (yb * texW + xb) * 4;
                const k00 = (1 - ax) * (1 - ay) / 255;
                const k10 = ax * (1 - ay) / 255;
                const k01 = (1 - ax) * ay / 255;
                const k11 = ax * ay / 255;
                r *= texData[o00] * k00 + texData[o10] * k10 + texData[o01] * k01 + texData[o11] * k11;
                g *= texData[o00 + 1] * k00 + texData[o10 + 1] * k10 + texData[o01 + 1] * k01 + texData[o11 + 1] * k11;
                b *= texData[o00 + 2] * k00 + texData[o10 + 2] * k10 + texData[o01 + 2] * k01 + texData[o11 + 2] * k11;
                if (cut) a *= texData[o00 + 3] * k00 + texData[o10 + 3] * k10 + texData[o01 + 3] * k01 + texData[o11 + 3] * k11;
              }
            }
            if (col !== null) {
              r *= c0 * col[n0] + c1 * col[n1] + c2 * col[n2];
              g *= c0 * col[n0 + 1] + c1 * col[n1 + 1] + c2 * col[n2 + 1];
              b *= c0 * col[n0 + 2] + c1 * col[n1 + 2] + c2 * col[n2 + 2];
              if (alpha !== null && cut) a *= c0 * alpha[i0] + c1 * alpha[i1] + c2 * alpha[i2];
            }
            if (!cut || a >= cutoff) {
              let nx = c0 * nrm[n0] + c1 * nrm[n1] + c2 * nrm[n2];
              let ny = c0 * nrm[n0 + 1] + c1 * nrm[n1 + 1] + c2 * nrm[n2 + 1];
              let nz = c0 * nrm[n0 + 2] + c1 * nrm[n1 + 2] + c2 * nrm[n2 + 2];
              // the ray of this pixel; a normal along the ray looks away from the viewer
              const tangentX = view.centerX + (px + 0.5 - half) * view.inverseScale;
              if (nx * (rowX + tangentX * rx) + ny * (rowY + tangentX * ry) + nz * (rowZ + tangentX * rz) > 0) {
                nx = -nx;
                ny = -ny;
                nz = -nz;
              }
              const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
              let lit = length > 1e-12 ? (nx * lx + ny * ly + nz * lz) / length : 0.5;
              if (lit < 0) lit = 0;
              const shade = (AMBIENT + DIFFUSE * lit) * 255;
              depth[o] = z;
              color[o * 4] = r * shade;
              color[o * 4 + 1] = g * shade;
              color[o * 4 + 2] = b * shade;
              color[o * 4 + 3] = 255;
            }
          }
        }
        b0 += d0x;
        b1 += d1x;
        b2 += d2x;
      }
      b0Row += d0y;
      b1Row += d1y;
      b2Row += d2y;
    }
  }
}

// The scene as an RGBA image (straight alpha, size x size, transparent where nothing is drawn): drawn at SUPERSAMPLE times
// the size and averaged down with premultiplied alpha. The silhouette is fitted into the square with a margin.
function renderToRgba(scene, { size = DEFAULT_SIZE } = {}) {
  const outSize = clampSize(size);
  const N = outSize * SUPERSAMPLE;
  const camera = makeCamera(scene.min, scene.max);
  const screens = scene.items.map((item) => projectItem(item, camera));

  let minTx = Infinity;
  let maxTx = -Infinity;
  let minTy = Infinity;
  let maxTy = -Infinity;
  for (const { tx, ty, iw } of screens) {
    for (let v = 0; v < tx.length; v += 1) {
      if (iw[v] > 0) {
        if (tx[v] < minTx) minTx = tx[v];
        if (tx[v] > maxTx) maxTx = tx[v];
        if (ty[v] < minTy) minTy = ty[v];
        if (ty[v] > maxTy) maxTy = ty[v];
      }
    }
  }
  const span = Math.max(maxTx - minTx, maxTy - minTy);
  if (!(span > 0) || !Number.isFinite(span)) fail('Das Modell hat keine sichtbare Ausdehnung');
  const scale = (N * (1 - 2 * VIEW.margin)) / span;
  const centerX = (minTx + maxTx) / 2;
  const centerY = (minTy + maxTy) / 2;
  for (const screen of screens) {
    const { tx, ty } = screen;
    screen.sx = new Float64Array(tx.length);
    screen.sy = new Float64Array(tx.length);
    for (let v = 0; v < tx.length; v += 1) {
      screen.sx[v] = N / 2 + (tx[v] - centerX) * scale;
      screen.sy[v] = N / 2 - (ty[v] - centerY) * scale;
    }
  }

  const frame = { size: N, depth: new Float32Array(N * N), color: new Uint8ClampedArray(N * N * 4) };
  const view = { light: camera.light, right: camera.right, up: camera.up, forward: camera.forward, centerX, centerY, inverseScale: 1 / scale };
  scene.items.forEach((item, index) => drawItem(frame, item, screens[index], view));

  const out = new Uint8Array(outSize * outSize * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < outSize; y += 1) {
    for (let x = 0; x < outSize; x += 1) {
      let covered = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const at = ((y * SUPERSAMPLE + sy) * N + x * SUPERSAMPLE + sx) * 4;
          if (frame.color[at + 3] !== 0) {
            covered += 1;
            r += frame.color[at];
            g += frame.color[at + 1];
            b += frame.color[at + 2];
          }
        }
      }
      if (covered > 0) {
        const o = (y * outSize + x) * 4;
        out[o] = Math.round(r / covered);
        out[o + 1] = Math.round(g / covered);
        out[o + 2] = Math.round(b / covered);
        out[o + 3] = Math.round((255 * covered) / samples);
      }
    }
  }
  return { width: outSize, height: outSize, data: out };
}

// The whole way in this process: GLB bytes in, PNG out. Throws PreviewError for a model that cannot be drawn.
function renderGlbBuffer(buffer, { size = DEFAULT_SIZE, decodeImage, warn } = {}) {
  const scene = buildScene(parseGlb(buffer), { decodeImage, warn });
  const image = renderToRgba(scene, { size });
  return encodePng(image.width, image.height, image.data);
}

/* ---------- the child process ---------- */

// The render runs as `node glb-preview.js --render <file> <size>`: the PNG goes to stdout, a reason to stderr (exit 2 for a model
// that cannot be drawn, 1 for anything else).
function workerMain(argv) {
  const [flag, file, sizeText] = argv;
  if (flag !== '--render' || !file) {
    process.stderr.write('Aufruf: glb-preview.js --render <datei.glb> [groesse]\n');
    process.exitCode = 64;
    return;
  }
  try {
    const png = renderGlbBuffer(fs.readFileSync(file), {
      size: clampSize(sizeText),
      warn: (message) => process.stderr.write(`${message}\n`)
    });
    process.stdout.write(png);
  } catch (err) {
    process.stderr.write(`${err && err.message ? err.message : err}\n`);
    process.exitCode = err instanceof PreviewError ? 2 : 1;
  }
}

function renderInChild(glbPath, { size, timeoutMs }) {
  const name = path.basename(String(glbPath));
  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    let timer = null;
    const finish = (value, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reason) console.warn(`[glb-preview] Vorschau von ${name} nicht erstellt: ${reason}`);
      resolve(value);
    };
    try {
      child = spawn(process.execPath, [`--max-old-space-size=${WORKER_HEAP_MB}`, __filename, '--render', String(glbPath), String(size)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (err) {
      finish(null, err.message);
      return;
    }
    const chunks = [];
    let received = 0;
    let stderr = '';
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null, `Zeitlimit von ${Math.round(timeoutMs / 1000)} s erreicht`);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_WORKER_OUTPUT) {
        child.kill('SIGKILL');
        finish(null, 'die Ausgabe ist zu gross');
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code, signal) => {
      const reason = stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(' | ');
      if (code !== 0) {
        finish(null, reason || `der Prozess endete mit ${signal ? `Signal ${signal}` : `Code ${code}`}`);
        return;
      }
      const png = Buffer.concat(chunks);
      if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
        finish(null, 'der Prozess lieferte kein PNG');
        return;
      }
      // what was left out on the way (a texture that could not be read) is worth a line, the preview is there
      if (reason) console.warn(`[glb-preview] ${name}: ${reason}`);
      finish(png);
    });
  });
}

// Renders `glbPath` to a PNG (size x size, RGBA, transparent background) in a child process and resolves with its bytes, or null
// when there is no preview: unreadable or unsupported model, a render that takes longer than timeoutMs, a failed process. The reason
// goes to the log; this never rejects. Renders run one after another.
let queue = Promise.resolve();

function renderGlbPreview(glbPath, { size = DEFAULT_SIZE, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const job = queue.then(() => renderInChild(glbPath, { size: clampSize(size), timeoutMs }));
  queue = job.then(
    () => undefined,
    () => undefined
  );
  return job.catch((err) => {
    console.warn(`[glb-preview] Vorschau von ${path.basename(String(glbPath))} nicht erstellt: ${err.message}`);
    return null;
  });
}

if (require.main === module) workerMain(process.argv.slice(2));

module.exports = {
  renderGlbPreview,
  renderGlbBuffer,
  parseGlb,
  buildScene,
  renderToRgba,
  encodePng,
  decodePng,
  decodeTexture,
  imageInfo,
  crc32,
  PreviewError,
  DEFAULT_SIZE,
  DEFAULT_TIMEOUT_MS
};
