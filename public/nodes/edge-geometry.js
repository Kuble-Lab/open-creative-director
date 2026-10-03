'use strict';

// Geometry of the edges of the node view: the bezier curve between two ports, points on it by arc length, and the
// placement of the number badges of a multi-input so that they never cover each other. Pure maths, no DOM, so Node tests
// can run it. UMD: module.exports in Node, window.OCDNodes.edgeGeometry in the browser.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.OCDNodes = root.OCDNodes || {};
    root.OCDNodes.edgeGeometry = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // Horizontal reach of the control points: at least this, else half the horizontal distance of the ports.
  const MIN_REACH = 60;
  const SAMPLES = 48;
  // Badges: radius of the circle, extra air between two circles, the preferred distance from the input along the curve and
  // the step in which a badge moves back until it is free.
  const BADGE_RADIUS = 8;
  const BADGE_AIR = 4;
  const BADGE_OFFSET = 48;
  const BADGE_STEP = 6;
  // A badge never moves further back than this part of the curve (it would leave the neighbourhood of the input).
  const MAX_FRACTION = 0.85;

  // The four points of the cubic curve from a (output) to b (input).
  function controls(a, b) {
    const reach = Math.max(MIN_REACH, Math.abs(b.x - a.x) * 0.5);
    return [{ x: a.x, y: a.y }, { x: a.x + reach, y: a.y }, { x: b.x - reach, y: b.y }, { x: b.x, y: b.y }];
  }

  // SVG path data of the curve.
  function path(a, b) {
    const [p0, p1, p2, p3] = controls(a, b);
    return `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`;
  }

  // Point at parameter t (0 = output, 1 = input).
  function pointAt(a, b, t) {
    const [p0, p1, p2, p3] = controls(a, b);
    const u = 1 - t;
    const w0 = u * u * u;
    const w1 = 3 * u * u * t;
    const w2 = 3 * u * t * t;
    const w3 = t * t * t;
    return { x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x, y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y };
  }

  // Unit vector of the curve at t (the direction of travel); falls back to "to the right" for a curve of no length.
  function tangentAt(a, b, t) {
    const [p0, p1, p2, p3] = controls(a, b);
    const u = 1 - t;
    const x = 3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x);
    const y = 3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y);
    const length = Math.hypot(x, y);
    return length > 1e-9 ? { x: x / length, y: y / length } : { x: 1, y: 0 };
  }

  // Table of the curve: points at equal steps of t with the arc length up to each. { total, fromEnd(distance) }.
  // fromEnd(distance) is the point `distance` back from the input along the curve (clamped to the curve): { x, y, t, distance }.
  function table(a, b, samples = SAMPLES) {
    const points = [];
    let length = 0;
    let last = null;
    for (let i = 0; i <= samples; i += 1) {
      const t = i / samples;
      const point = pointAt(a, b, t);
      if (last) length += Math.hypot(point.x - last.x, point.y - last.y);
      points.push({ t, x: point.x, y: point.y, length });
      last = point;
    }
    const total = length;
    function fromEnd(distance) {
      const wanted = total - Math.max(0, Math.min(total, Number.isFinite(distance) ? distance : 0));
      let index = 1;
      while (index < points.length - 1 && points[index].length < wanted) index += 1;
      const before = points[index - 1];
      const after = points[index];
      const span = after.length - before.length;
      const share = span > 1e-9 ? (wanted - before.length) / span : 0;
      return {
        x: before.x + (after.x - before.x) * share,
        y: before.y + (after.y - before.y) * share,
        t: before.t + (after.t - before.t) * share,
        distance: total - wanted
      };
    }
    return { total, fromEnd };
  }

  // Length of the curve.
  function curveLength(a, b) {
    return table(a, b).total;
  }

  // Point `distance` back from the input along the curve.
  function pointFromEnd(a, b, distance) {
    return table(a, b).fromEnd(distance);
  }

  // Places one badge on each curve of an input. curves = [{ a, b }] in the order of the connections (b is the same point
  // for all of them, a is the output of each). A badge sits `offset` px back from the input along its own curve, where
  // the curves of different sources have parted; when that spot is taken by a badge placed before, it moves back along its
  // own curve in small steps until it is free. Edge cases:
  //   - a curve that is too short for the offset: the badge sits in its middle,
  //   - an edge that runs backwards (output right of the input) has a loop; the distance is along the curve, so it works
  //     the same way,
  //   - curves that never part (same output): the best spot is nudged sideways, alternating, so the circles do not overlap.
  // Returns [{ x, y, t, distance, free }]; `free` is false only when no spot without an overlap was found at all.
  function placeBadges(curves, options = {}) {
    const radius = Number.isFinite(options.radius) ? options.radius : BADGE_RADIUS;
    const gap = radius * 2 + (Number.isFinite(options.air) ? options.air : BADGE_AIR);
    const offset = Number.isFinite(options.offset) ? options.offset : BADGE_OFFSET;
    const step = Math.max(1, Number.isFinite(options.step) ? options.step : BADGE_STEP);
    const maxFraction = Number.isFinite(options.maxFraction) ? options.maxFraction : MAX_FRACTION;
    const placed = [];
    const clearance = (point) => placed.reduce((least, other) => Math.min(least, Math.hypot(other.x - point.x, other.y - point.y)), Infinity);

    for (const curve of curves) {
      const spots = table(curve.a, curve.b);
      const limit = spots.total * maxFraction;
      // The first candidate is the preferred offset; a curve shorter than that takes its middle.
      const candidates = [];
      if (offset > limit) candidates.push(spots.total / 2);
      else for (let distance = offset; distance <= limit + 1e-9; distance += step) candidates.push(distance);

      let chosen = null;
      let best = null;
      for (const distance of candidates) {
        const point = spots.fromEnd(distance);
        const room = clearance(point);
        if (room >= gap) {
          chosen = point;
          break;
        }
        if (!best || room > best.room) best = { point, room };
      }
      if (chosen) {
        placed.push({ ...chosen, free: true });
        continue;
      }
      // No free spot on this curve: the one with the most room, pushed sideways until it clears the others.
      const base = best.point;
      const tangent = tangentAt(curve.a, curve.b, base.t);
      const normal = { x: -tangent.y, y: tangent.x };
      let point = { ...base };
      let free = false;
      for (let k = 1; k <= curves.length * 2; k += 1) {
        const side = k % 2 ? 1 : -1;
        const shift = Math.ceil(k / 2) * gap;
        const tried = { x: base.x + normal.x * shift * side, y: base.y + normal.y * shift * side };
        if (clearance(tried) >= gap) {
          point = { ...base, x: tried.x, y: tried.y };
          free = true;
          break;
        }
      }
      placed.push({ ...point, free });
    }
    return placed;
  }

  // The label of a badge or chip: the position as a number, or the ellipsis behind the first list ("order" is null there).
  function orderText(order) {
    return Number.isInteger(order) ? String(order) : '…';
  }

  return {
    MIN_REACH,
    BADGE_RADIUS,
    BADGE_OFFSET,
    controls,
    path,
    pointAt,
    tangentAt,
    table,
    curveLength,
    pointFromEnd,
    placeBadges,
    orderText
  };
});
