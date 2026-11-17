'use strict';

// Optional sung-word layer. The schedule is built for the whole song, then sliced; placement and animation are pure functions of song time.
// No browser font measurements, random numbers or playback history enter the result.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HudChorusWords = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const FPS = 24;
  const MIN_SIZE = 64;
  const STOP = new Set(('a an the and or but i you he she it we they me my your our their is are am was were be been to of in on at for with from this that not as so ' +
    'der die das ein eine einer einem einen und oder aber ich du er sie es wir ihr mir mich mein dein ist sind war sein zu von im in am an auf mit für nicht als ' +
    'el la los las un una unos unas y o pero yo tu tú él ella nosotros mi mis su sus es son ser de del al en por para con que no se').split(' '));
  const clean = (text) => String(text).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const inPart = (parts, t) => parts.find((p) => p.k === 'chorus' && t * FPS >= p.f0 - 1e-6 && t * FPS < p.f1 - 1e-6);

  // A marked lyric word wins. Without a mark, the longest non-stop word wins (first on ties).
  function keyOf(line) {
    if (line.keyMarked !== false && Number.isInteger(line.key) && line.key >= 0 && line.key < line.words.length) return line.key;
    let best = -1;
    line.words.forEach((word, i) => {
      const text = clean(word.text);
      if (text.length >= 3 && !STOP.has(text) && (best < 0 || text.length > clean(line.words[best].text).length)) best = i;
    });
    return best;
  }

  // `width` measures upper-case text in em with the style's embedded display face (metrics.js).
  function schedule(graphics, parts, width) {
    const out = [];
    let index = 0;
    for (const line of graphics.lines || []) {
      const key = keyOf(line);
      const words = line.words || [];
      for (let i = 0; i < words.length; i += 1, index += 1) {
        const word = words[i];
        const part = inPart(parts, word.start);
        if (!part || !Number.isFinite(word.end) || word.end <= word.start) continue;
        const first = i;
        let text = word.text;
        let accent = i === key;
        // A syllable shorter than three frames shares the next word's card, including runs of short words.
        while (Math.min(words[i].end, words[i + 1] ? words[i + 1].start : Infinity) - words[i].start < 3 / FPS) {
          if (!words[i + 1] || inPart(parts, words[i + 1].start) !== part) { text = ''; break; }
          i += 1;
          index += 1;
          text += ` ${words[i].text}`;
          accent = accent || i === key;
        }
        if (!text) continue;
        const end = Math.min(word.start + 0.9, words[i + 1] ? words[i + 1].start : words[i].end, line.end, part.f1 / FPS);
        if (!(end > word.start)) continue;
        const upper = text.toUpperCase();
        out.push({ text: upper, start: word.start, end, accent, direction: (index - (i - first)) % 4, em: width(upper) });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  // Subtract face/device rectangles from the middle band. All motion is clipped to the chosen free rectangle, including its soft shadow.
  // Smaller rooms reduce the font; below MIN_SIZE the word is skipped instead of covering a face.
  function placeWord(em, boxes = [], maxSize = 220) {
    if (!(em > 0)) return null;
    let rooms = [{ x: 48, y: 280, w: 1824, h: 560 }];
    for (const box of boxes) {
      const b = { x: box.x0 - 24, y: box.y0 - 24, w: box.x1 - box.x0 + 48, h: box.y1 - box.y0 + 48 };
      rooms = rooms.flatMap((r) => {
        if (!intersects(r, b)) return [r];
        const x0 = Math.max(r.x, b.x), x1 = Math.min(r.x + r.w, b.x + b.w);
        const y0 = Math.max(r.y, b.y), y1 = Math.min(r.y + r.h, b.y + b.h);
        return [
          { x: r.x, y: r.y, w: x0 - r.x, h: r.h },
          { x: x1, y: r.y, w: r.x + r.w - x1, h: r.h },
          { x: x0, y: r.y, w: x1 - x0, h: y0 - r.y },
          { x: x0, y: y1, w: x1 - x0, h: r.y + r.h - y1 }
        ].filter((room) => room.w >= MIN_SIZE && room.h >= MIN_SIZE);
      });
    }
    let best = null;
    for (const r of rooms) {
      const size = Math.floor(Math.min(maxSize, (r.w - 32) / em, (r.h - 32) / 1.25));
      const distance = Math.abs(r.x + r.w / 2 - 960) + Math.abs(r.y + r.h / 2 - 540);
      if (size >= MIN_SIZE && (!best || size > best.size || (size === best.size && distance < best.distance))) best = { ...r, size, distance };
    }
    return best;
  }

  function wordAt(chorus, t, boxes = [], maxSize) {
    const event = (chorus.events || []).find((e) => t >= e.start - 1e-6 && t < e.end - 1e-6);
    if (!event) return null;
    const rect = placeWord(event.em, boxes, maxSize);
    if (!rect) return null;
    const p = Math.min(1, Math.max(0, (t - event.start) / (3 / FPS)));
    const hard = 1 - (1 - p) ** 3;
    return { ...event, rect, x: event.direction === 0 ? -24 * (1 - hard) : event.direction === 1 ? 24 * (1 - hard) : 0,
      y: event.direction === 2 ? 24 * (1 - hard) : 0, scale: event.direction === 3 ? 0.7 + 0.3 * hard : 1, opacity: p === 0 ? 0 : 1 };
  }

  // Decorate the engine's state only when the optional schedule exists. Small devices keep their original state.
  function frameState(base, chorus, boxes, maxSize) {
    const word = base.endcard ? null : wordAt(chorus, base.t, boxes, maxSize);
    const devices = inPart(chorus.parts || [], base.t) ? base.devices.filter((d) => d.type !== 'display') : base.devices;
    return { ...base, devices, karaoke: word ? null : base.karaoke, chorusWord: word };
  }

  return { FPS, MIN_SIZE, STOP, inPart, keyOf, schedule, intersects, placeWord, wordAt, frameState };
});
