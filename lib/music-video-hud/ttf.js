'use strict';

// A reader for the few things the HUD needs from a TrueType file: the tables, the character map and the advance widths of the characters
// (lib/music-video-hud/metrics.js measures text with them) and the numbers of the vertical metrics. For a variable font (Montserrat) the advance
// widths are those of one weight: the axes (fvar), their mapping (avar) and the changes of the advances (HVAR) are read. No dependency. The same
// reader is used by scripts/subset-font.js.

function readTables(buffer) {
  const count = buffer.readUInt16BE(4);
  const tables = new Map();
  for (let index = 0; index < count; index += 1) {
    const at = 12 + index * 16;
    const tag = buffer.toString('latin1', at, at + 4);
    const offset = buffer.readUInt32BE(at + 8);
    const length = buffer.readUInt32BE(at + 12);
    tables.set(tag, buffer.subarray(offset, offset + length));
  }
  return tables;
}

// character code -> glyph index from the best Unicode subtable of `cmap` (format 12 or 4)
function readCmap(cmap) {
  const count = cmap.readUInt16BE(2);
  const found = [];
  for (let index = 0; index < count; index += 1) {
    const at = 4 + index * 8;
    found.push({ platform: cmap.readUInt16BE(at), encoding: cmap.readUInt16BE(at + 2), offset: cmap.readUInt32BE(at + 4) });
  }
  const rank = (entry) => (entry.platform === 3 && entry.encoding === 10 ? 0 : entry.platform === 0 && entry.encoding >= 4 ? 1 : entry.platform === 3 && entry.encoding === 1 ? 2 : entry.platform === 0 ? 3 : 9);
  found.sort((a, b) => rank(a) - rank(b));
  const map = new Map();
  for (const entry of found) {
    if (rank(entry) === 9) continue;
    const sub = cmap.subarray(entry.offset);
    const format = sub.readUInt16BE(0);
    if (format === 12) {
      const groups = sub.readUInt32BE(12);
      for (let group = 0; group < groups; group += 1) {
        const at = 16 + group * 12;
        const start = sub.readUInt32BE(at);
        const end = sub.readUInt32BE(at + 4);
        const glyph = sub.readUInt32BE(at + 8);
        for (let code = start; code <= end; code += 1) map.set(code, glyph + (code - start));
      }
      return map;
    }
    if (format === 4) {
      const segments = sub.readUInt16BE(6) / 2;
      const ends = 14;
      const starts = ends + segments * 2 + 2;
      const deltas = starts + segments * 2;
      const rangeOffsets = deltas + segments * 2;
      for (let segment = 0; segment < segments; segment += 1) {
        const end = sub.readUInt16BE(ends + segment * 2);
        const start = sub.readUInt16BE(starts + segment * 2);
        const delta = sub.readInt16BE(deltas + segment * 2);
        const rangeOffset = sub.readUInt16BE(rangeOffsets + segment * 2);
        for (let code = start; code <= end && code !== 0xffff; code += 1) {
          let glyph;
          if (rangeOffset === 0) glyph = (code + delta) & 0xffff;
          else {
            glyph = sub.readUInt16BE(rangeOffsets + segment * 2 + rangeOffset + (code - start) * 2);
            if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
          }
          if (glyph) map.set(code, glyph);
        }
      }
      return map;
    }
  }
  throw new Error('no usable cmap subtable');
}

/* ---------- variable fonts: the advance of a glyph at one position of the axes ---------- */

const f2dot14 = (buffer, at) => buffer.readInt16BE(at) / 16384;

// [{ tag, min, def, max }] from `fvar`
function readAxes(fvar) {
  const offset = fvar.readUInt16BE(4);
  const count = fvar.readUInt16BE(8);
  const size = fvar.readUInt16BE(10);
  const axes = [];
  for (let index = 0; index < count; index += 1) {
    const at = offset + index * size;
    axes.push({ tag: fvar.toString('latin1', at, at + 4), min: fvar.readInt32BE(at + 4) / 65536, def: fvar.readInt32BE(at + 8) / 65536, max: fvar.readInt32BE(at + 12) / 65536 });
  }
  return axes;
}

// the position on every axis as the font means it, -1 to 1 (0 is the default of the font): `coords` is { wght: 800 }; `avar` bends the line
function normalizeCoords(axes, avar, coords) {
  const maps = [];
  if (avar) {
    let at = 8;
    for (let axis = 0; axis < avar.readUInt16BE(6); axis += 1) {
      const pairs = avar.readUInt16BE(at);
      at += 2;
      const map = [];
      for (let pair = 0; pair < pairs; pair += 1) {
        map.push([f2dot14(avar, at), f2dot14(avar, at + 2)]);
        at += 4;
      }
      maps.push(map);
    }
  }
  return axes.map((axis, index) => {
    const asked = coords && Number.isFinite(coords[axis.tag]) ? coords[axis.tag] : axis.def;
    const value = Math.min(axis.max, Math.max(axis.min, asked));
    let n = 0;
    if (value < axis.def) n = -(axis.def - value) / (axis.def - axis.min);
    else if (value > axis.def) n = (value - axis.def) / (axis.max - axis.def);
    const map = maps[index];
    if (map && map.length) {
      for (let at = 1; at < map.length; at += 1) {
        if (n <= map[at][0] + 1e-12) {
          const span = map[at][0] - map[at - 1][0];
          n = span === 0 ? map[at][1] : map[at - 1][1] + ((n - map[at - 1][0]) / span) * (map[at][1] - map[at - 1][1]);
          break;
        }
      }
    }
    return n;
  });
}

// The change of one value from an item variation store (HVAR and others): `outer` and `inner` pick the row of delta values, every region of the
// row weighs its delta with the scalar of the position.
function storeDelta(store, outer, inner, normalized) {
  const regionListAt = store.readUInt32BE(2);
  const axisCount = store.readUInt16BE(regionListAt);
  const dataAt = store.readUInt32BE(8 + outer * 4);
  const regionIndexCount = store.readUInt16BE(dataAt + 4);
  const wordCountField = store.readUInt16BE(dataAt + 2);
  const long = (wordCountField & 0x8000) !== 0;
  const words = wordCountField & 0x7fff;
  const itemCount = store.readUInt16BE(dataAt);
  if (inner >= itemCount) return 0;
  const wide = long ? 4 : 2;
  const narrow = long ? 2 : 1;
  const rowSize = words * wide + (regionIndexCount - words) * narrow;
  let at = dataAt + 6 + regionIndexCount * 2 + inner * rowSize;
  let total = 0;
  for (let k = 0; k < regionIndexCount; k += 1) {
    const region = store.readUInt16BE(dataAt + 6 + k * 2);
    let delta;
    if (k < words) {
      delta = long ? store.readInt32BE(at) : store.readInt16BE(at);
      at += wide;
    } else {
      delta = long ? store.readInt16BE(at) : store.readInt8(at);
      at += narrow;
    }
    let scalar = 1;
    for (let axis = 0; axis < axisCount; axis += 1) {
      const from = regionListAt + 4 + (region * axisCount + axis) * 6;
      const start = f2dot14(store, from);
      const peak = f2dot14(store, from + 2);
      const end = f2dot14(store, from + 4);
      const x = normalized[axis] || 0;
      if (peak === 0 || start > peak || peak > end || (start < 0 && end > 0 && peak !== 0)) continue;
      if (x < start || x > end) {
        scalar = 0;
        break;
      }
      if (x === peak) continue;
      scalar *= x < peak ? (x - start) / (peak - start) : (end - x) / (end - peak);
    }
    total += delta * scalar;
  }
  return total;
}

// the advance (font units, not rounded: the browser does not round them either) of every glyph at the position `coords` of the axes: `hmtx` and the
// changes of `HVAR`
function advancesAt(tables, coords) {
  const hhea = tables.get('hhea');
  const hmtx = tables.get('hmtx');
  const metricCount = hhea.readUInt16BE(34);
  const glyphCount = tables.get('maxp').readUInt16BE(4);
  const normalized = tables.has('fvar') ? normalizeCoords(readAxes(tables.get('fvar')), tables.get('avar'), coords) : [];
  const hvar = tables.get('HVAR');
  const out = new Array(glyphCount);
  let map = null;
  let store = null;
  if (hvar && normalized.length) {
    store = hvar.subarray(hvar.readUInt32BE(4));
    const mapAt = hvar.readUInt32BE(8);
    if (mapAt) {
      const sub = hvar.subarray(mapAt);
      const format = sub.readUInt8(0);
      const entryFormat = sub.readUInt8(1);
      const count = format === 0 ? sub.readUInt16BE(2) : sub.readUInt32BE(2);
      map = { sub, from: format === 0 ? 4 : 6, count, size: ((entryFormat & 0x30) >> 4) + 1, bits: (entryFormat & 0x0f) + 1 };
    }
  }
  for (let glyph = 0; glyph < glyphCount; glyph += 1) {
    const base = hmtx.readUInt16BE(Math.min(glyph, metricCount - 1) * 4);
    let delta = 0;
    if (store) {
      let outer = 0;
      let inner = glyph;
      if (map) {
        const index = Math.min(glyph, map.count - 1);
        let entry = 0;
        for (let byte = 0; byte < map.size; byte += 1) entry = entry * 256 + map.sub.readUInt8(map.from + index * map.size + byte);
        outer = Math.floor(entry / 2 ** map.bits);
        inner = entry % 2 ** map.bits;
      }
      delta = storeDelta(store, outer, inner, normalized);
    }
    out[glyph] = base + delta;
  }
  return out;
}

// { unitsPerEm, capHeight, xHeight, ascent, descent, advances: Map(code -> advance in em) } of a font file; `coords` ({ wght: 900 }) says where on
// the axes of a variable font the advances are taken
function readMetrics(buffer, coords) {
  const tables = readTables(buffer);
  for (const need of ['head', 'hhea', 'hmtx', 'cmap']) if (!tables.has(need)) throw new Error(`the font has no ${need} table`);
  const unitsPerEm = tables.get('head').readUInt16BE(18);
  const hhea = tables.get('hhea');
  const advanceList = advancesAt(tables, coords);
  const advances = new Map();
  for (const [code, glyph] of readCmap(tables.get('cmap'))) advances.set(code, advanceList[Math.min(glyph, advanceList.length - 1)] / unitsPerEm);
  const os2 = tables.get('OS/2');
  const version = os2 ? os2.readUInt16BE(0) : 0;
  return {
    unitsPerEm,
    ascent: hhea.readInt16BE(4) / unitsPerEm,
    descent: -hhea.readInt16BE(6) / unitsPerEm,
    xHeight: version >= 2 ? os2.readInt16BE(86) / unitsPerEm : 0.5,
    capHeight: version >= 2 ? os2.readInt16BE(88) / unitsPerEm : 0.7,
    advances
  };
}

module.exports = { readTables, readCmap, readMetrics, readAxes, normalizeCoords, storeDelta, advancesAt };
