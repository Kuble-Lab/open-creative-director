'use strict';

// Test support (not a test): a small real GLB (glTF 2.0 binary), made here so no test needs a model file in the
// repository. A cube of 24 vertices with normals and one material of a plain colour, readable by any glTF viewer.
//
//   const { cubeGlb, readGlb } = require('./support/glb');
//   const bytes = cubeGlb({ color: [0.9, 0.3, 0.2], size: 1 });   // Buffer
//   cubeGlb({ edit: (json) => { json.images = [{ uri: 'https://x.test/a.png' }]; } })   // change the glTF JSON before it is packed
//   readGlb(bytes)                                                 // { version, length, json, bin } or throws

const MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function padded(buffer, fill) {
  const rest = buffer.length % 4;
  return rest === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(4 - rest, fill)]);
}

// The six faces of a cube: [normal, four corners counter-clockwise seen from outside].
function faces(h) {
  return [
    [[0, 0, 1], [[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]]],
    [[0, 0, -1], [[h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]]],
    [[1, 0, 0], [[h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h]]],
    [[-1, 0, 0], [[-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]]],
    [[0, 1, 0], [[-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h]]],
    [[0, -1, 0], [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]]]
  ];
}

function cubeGlb({ color = [0.85, 0.35, 0.25], size = 1, edit = null } = {}) {
  const half = size / 2;
  const positions = [];
  const normals = [];
  const indices = [];
  faces(half).forEach(([normal, corners], face) => {
    for (const corner of corners) {
      positions.push(...corner);
      normals.push(...normal);
    }
    const base = face * 4;
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  const positionBytes = Buffer.from(new Float32Array(positions).buffer);
  const normalBytes = Buffer.from(new Float32Array(normals).buffer);
  const indexBytes = padded(Buffer.from(new Uint16Array(indices).buffer), 0);
  const bin = Buffer.concat([positionBytes, normalBytes, indexBytes]);
  const json = {
    asset: { version: '2.0', generator: 'ocd-test' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [color[0], color[1], color[2], 1], metallicFactor: 0, roughnessFactor: 0.6 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-half, -half, -half], max: [half, half, half] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.length, target: 34962 },
      { buffer: 0, byteOffset: positionBytes.length, byteLength: normalBytes.length, target: 34962 },
      { buffer: 0, byteOffset: positionBytes.length + normalBytes.length, byteLength: 72, target: 34963 }
    ],
    buffers: [{ byteLength: bin.length }]
  };
  if (typeof edit === 'function') edit(json);
  const jsonBytes = padded(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const chunkHead = (length, type) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(length, 0);
    head.writeUInt32LE(type, 4);
    return head;
  };
  return Buffer.concat([header, chunkHead(jsonBytes.length, JSON_CHUNK), jsonBytes, chunkHead(bin.length, BIN_CHUNK), bin]);
}

// Reads a GLB back: { version, length, json, bin }. Throws for anything that is not a well-formed GLB 2.0.
function readGlb(buffer) {
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== MAGIC) throw new Error('not a GLB (magic)');
  const version = buffer.readUInt32LE(4);
  const length = buffer.readUInt32LE(8);
  if (version !== 2) throw new Error(`GLB version ${version}`);
  if (length !== buffer.length) throw new Error(`GLB length ${length} differs from the file (${buffer.length})`);
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const data = buffer.subarray(offset + 8, offset + 8 + size);
    if (type === JSON_CHUNK) json = JSON.parse(data.toString('utf8'));
    else if (type === BIN_CHUNK) bin = data;
    offset += 8 + size;
  }
  if (!json) throw new Error('GLB without a JSON chunk');
  return { version, length, json, bin };
}

module.exports = { cubeGlb, readGlb };
