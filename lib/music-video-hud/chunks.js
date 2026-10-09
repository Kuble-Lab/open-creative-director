'use strict';

// The chunks of the film (WP44): the render node draws the film in pieces of at most 24 s (the target is 20 s), cut at the cuts of the film, so that
// no picture changes at a seam; the pieces are drawn by both render nodes at the same time and joined again afterwards. The last piece also holds the
// end card (the end of the song plus its seconds).

const FPS = 24;
const MAX_SECONDS = 24;
const TARGET_SECONDS = 20;

// planChunks(graphics, { endcardSeconds, maxSeconds, targetSeconds }) -> [{ index, startFrame, endFrame, start, end, frames, seconds, clipSeconds,
//   duration, last, onCut }]
//   start, end   seconds of the song of the footage of the chunk (frame exact), seconds = end - start
//   clipSeconds  the length of the footage; duration is the length of the page (the last chunk adds the end card)
// The boundaries are the cuts of the film; a cut that is longer than the limit is cut in the middle (onCut false). The pieces are as even as
// they can be (the sum of the squares of the difference to the target is the smallest).
function planChunks(graphics, { endcardSeconds = 0, maxSeconds = MAX_SECONDS, targetSeconds = TARGET_SECONDS } = {}) {
  const firstFrame = Math.round(graphics.cuts[0].start * FPS);
  const lastFrame = graphics.endFrame;
  const maxFrames = Math.floor(maxSeconds * FPS);
  const targetFrames = targetSeconds * FPS;
  const endcardFrames = Math.round(Math.max(0, endcardSeconds) * FPS);
  const cutFrames = new Set([firstFrame, lastFrame]);
  for (const cut of graphics.cuts) cutFrames.add(Math.round(cut.start * FPS));
  // where a long cut may be cut in the middle: every `maxFrames / 2` frames from its start
  const bounds = [...cutFrames].filter((frame) => frame >= firstFrame && frame <= lastFrame).sort((a, b) => a - b);
  const points = new Set(bounds);
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    for (let frame = bounds[i] + Math.floor(maxFrames / 2); frame < bounds[i + 1]; frame += Math.floor(maxFrames / 2)) points.add(frame);
  }
  const list = [...points].sort((a, b) => a - b);
  const n = list.length;
  const costOf = (from, to) => {
    const length = list[to] - list[from] + (to === n - 1 ? endcardFrames : 0);
    if (length > maxFrames) return Infinity;
    return (length - targetFrames) ** 2;
  };
  // best[i]: the least cost of chunking the film from the start up to point i
  const best = new Array(n).fill(Infinity);
  const from = new Array(n).fill(-1);
  best[0] = 0;
  for (let to = 1; to < n; to += 1) {
    for (let start = to - 1; start >= 0; start -= 1) {
      if (list[to] - list[start] > maxFrames) break;
      const cost = best[start] + costOf(start, to);
      if (cost < best[to]) {
        best[to] = cost;
        from[to] = start;
      }
    }
  }
  if (!Number.isFinite(best[n - 1])) throw new Error('the film cannot be cut into chunks of the allowed length');
  const chain = [];
  for (let at = n - 1; at > 0; at = from[at]) chain.push([from[at], at]);
  chain.reverse();
  return chain.map(([a, b], index) => {
    const startFrame = list[a];
    const endFrame = list[b];
    const last = index === chain.length - 1;
    const frames = endFrame - startFrame;
    return {
      index,
      startFrame,
      endFrame,
      start: startFrame / FPS,
      end: endFrame / FPS,
      frames,
      seconds: frames / FPS,
      clipSeconds: frames / FPS,
      duration: (frames + (last ? endcardFrames : 0)) / FPS,
      pageFrames: frames + (last ? endcardFrames : 0),
      last,
      onCut: bounds.includes(startFrame) && bounds.includes(endFrame)
    };
  });
}

module.exports = { planChunks, MAX_SECONDS, TARGET_SECONDS, FPS };
