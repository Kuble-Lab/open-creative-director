'use strict';

// The state of one frame of the HUD (WP44): frameState(graphics, t) says everything that is on the screen at the song time t, as plain numbers
// and strings. A pure function of the data and of t: no clock, no random numbers (what looks like noise comes from a hash of the frame number),
// no memory between frames. So a chunk of the film that is rendered on another machine, or again, shows exactly the same frames, and the HUD,
// the ticker and the counters join without a seam where one chunk ends and the next one begins.
// UMD: runs in Node (the tests, the layout) and in the browser (the render node), where it is inlined in the page; the drawing is in view.js.
// The style of the graphics (`graphics.theme`, lib/music-video-hud/themes.js) adds to the state of a frame: the first style (HUD Blue) adds nothing,
// the second one (Kuble) adds the layers over the picture (a pulse on the hits, a sweep of light, sparks), the one amber element of the picture, the
// data of its frame (the chapter, the counter, the typed status line, the beat bar) and a different entrance of the big words. All of it is a
// function of the song time alone, like the rest.
//
// `graphics` is the resolved data (lib/music-video-hud/graphics.js resolveGraphics(), or a part of it from sliceGraphics()): the cuts, the lines,
// the music, the HUD values and the devices with their places. All times are seconds of the song.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./themes'));
  else root.HudState = factory(root.HudThemes);
})(typeof self !== 'undefined' ? self : this, function (themes) {
  const FPS = 24;
  const FRAME_S = 1 / FPS;
  const WIDTH = 1920;
  const HEIGHT = 1080;

  // the motion of the HUD, in seconds (see the Stilblatt: an entrance takes 4 to 8 frames, a roll 6 frames, a wipe 8 frames)
  const ENTER_S = 6 * FRAME_S;
  const EXIT_S = 3 * FRAME_S;
  const ROLL_S = 6 * FRAME_S;
  const WIPE_S = 8 * FRAME_S;
  const FLASH_FRAMES = 2;
  const KARAOKE_LEAD_S = 0.2;
  const KARAOKE_TAIL_S = 0.3;
  const DROP_WINDOW_S = 8;
  const TICKER_PX_PER_S = 96;
  const TICKER_PITCH = 13 * 0.6 + 13 * 0.1;
  const TYPE_CPS = 30;

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const lerp = (from, to, amount) => from + (to - from) * amount;
  const ease = {
    out: (x) => 1 - (1 - clamp(x, 0, 1)) ** 3,
    outStrong: (x) => 1 - (1 - clamp(x, 0, 1)) ** 5,
    inOut: (x) => {
      const y = clamp(x, 0, 1);
      return y < 0.5 ? 4 * y * y * y : 1 - (-2 * y + 2) ** 3 / 2;
    },
    // a short overshoot, for the things that land
    back: (x) => {
      const y = clamp(x, 0, 1) - 1;
      return 1 + 2.2 * y * y * y + 1.2 * y * y;
    },
    // a strong overshoot (20 %) that settles: the big words of Kuble spring into the picture
    spring: (x) => {
      const y = clamp(x, 0, 1) - 1;
      return 1 + 3.6 * y * y * y + 2.6 * y * y;
    }
  };

  // A hash of integers into [0, 1): the same on every machine (integer arithmetic only).
  function hash(a, b = 0, c = 0) {
    let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    return h / 4294967296;
  }

  // The first index whose value is above x (the number of entries that are at or before x).
  function after(list, x) {
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (list[mid] <= x) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  const pad2 = (n) => String(Math.max(0, Math.floor(n))).padStart(2, '0');

  function groupThousands(n) {
    const sign = n < 0 ? '-' : '';
    return sign + String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  const ROMAN = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  function roman(n) {
    let rest = Math.max(1, Math.min(3999, Math.floor(n)));
    let out = '';
    for (const [value, letters] of ROMAN) {
      while (rest >= value) {
        out += letters;
        rest -= value;
      }
    }
    return out;
  }

  // 83.5 -> "01:23:12" (minutes, seconds, frames of the song time)
  function timecode(seconds) {
    const frames = Math.max(0, Math.floor(seconds * FPS + 1e-6));
    return `${pad2(Math.floor(frames / (FPS * 60)))}:${pad2(Math.floor(frames / FPS) % 60)}:${pad2(frames % FPS)}`;
  }

  // A time in frames as "HH:MM:SS:FF", "HH:MM:SS" or "MM:SS" (`parts` says which).
  function clockText(frames, parts) {
    const whole = Math.max(0, Math.round(frames));
    const f = whole % FPS;
    const s = Math.floor(whole / FPS) % 60;
    const m = Math.floor(whole / (FPS * 60)) % 60;
    const h = Math.floor(whole / (FPS * 3600));
    if (parts >= 4) return `${pad2(h)}:${pad2(m)}:${pad2(s)}:${pad2(f)}`;
    if (parts === 3) return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
    return `${pad2(h * 60 + m)}:${pad2(s)}`;
  }

  /* ---------- the music ---------- */

  // The value of the loudness (one value per second, each at the middle of its second) at t.
  function energyAt(music, t) {
    const list = music.energy || [];
    if (!list.length) return 0.5;
    const base = music.energyFrom || 0;
    const x = t - 0.5 - base;
    const index = Math.floor(x);
    const at = (i) => list[clamp(i, 0, list.length - 1)];
    return clamp(lerp(at(index), at(index + 1), x - index), 0, 1);
  }

  // Where t stands against the beats: the beat before it, the length of the beat, the sixteenth (counted from the start of the song) and the bar.
  function beatState(music, t) {
    const beats = music.beats || [];
    const period = clamp(60 / (music.bpm || 120), 0.2, 1.5);
    const base = music.beatsBefore || 0;
    let index = after(beats, t + 1e-9) - 1;
    let prev;
    let length = period;
    if (beats.length && index >= 0) {
      prev = beats[index];
      if (index + 1 < beats.length) length = clamp(beats[index + 1] - prev, 0.2, 1.5);
    } else if (beats.length) {
      prev = beats[0] - period;
      index = -1;
    } else {
      index = Math.floor(t / period);
      prev = index * period;
    }
    const since = t - prev;
    const quarter = clamp(Math.floor((4 * since) / length), 0, 3);
    const absolute = base + index;
    const downbeats = music.downbeats || [];
    const downCount = after(downbeats, t + 1e-9);
    let beat;
    if (downCount > 0 && beats.length) {
      const last = downbeats[downCount - 1];
      const lastIndex = after(beats, last + 1e-6) - 1;
      beat = ((((index - lastIndex) % 4) + 4) % 4) + 1;
    } else {
      beat = ((((absolute % 4) + 4) % 4) + 1);
    }
    return {
      beatIndex: absolute,
      since,
      length,
      phase: clamp(since / length, 0, 1),
      sixteenth: absolute * 4 + quarter,
      sixteenthS: length / 4,
      bar: (music.downbeatsBefore || 0) + downCount,
      beat
    };
  }

  // The zoom of the picture on the drums: a small push on every beat while the music is loud (nothing where it breathes), a bigger one on a hit.
  // `thuds` are extra impacts (a stamp that lands): [{ t }]. Returns 0 to 0.05 (the whole picture, the HUD included, is pushed, so that its edge
  // stays on the screen).
  function kickAt(music, t, beat, thuds) {
    let kick = 0;
    const energy = energyAt(music, t);
    if (energy >= 0.45 && beat.since >= 0) kick = (0.01 + 0.02 * energy) * Math.exp(-beat.since / 0.07);
    const hits = music.hits || [];
    const times = music.hitTimes || [];
    for (let i = after(times, t - 0.5); i < hits.length && hits[i].t <= t; i += 1) {
      const strength = clamp(hits[i].strength, 0, 1);
      if (strength < 0.6) continue;
      kick = Math.max(kick, (0.03 + 0.03 * strength) * Math.exp(-(t - hits[i].t) / 0.1));
    }
    for (const thud of thuds || []) {
      if (thud.t <= t && t - thud.t < 0.6) kick = Math.max(kick, 0.04 * Math.exp(-(t - thud.t) / 0.1));
    }
    return clamp(kick, 0, 0.05);
  }

  /* ---------- the cuts ---------- */

  function cutAt(cuts, t) {
    if (!cuts.length) return null;
    let low = 0;
    let high = cuts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (cuts[mid].start <= t + 1e-6) low = mid;
      else high = mid - 1;
    }
    return { cut: cuts[low], index: low };
  }

  // The transform of the picture for a cut: the crop window (scale, centre) into a CSS transform with the origin in the top left corner.
  function camera(crop, kick) {
    const scale = clamp(Number(crop?.scale) || 1, 1, 1.6);
    const half = 1 / (2 * scale);
    const x = clamp(Number(crop?.x) || 0.5, half, 1 - half);
    const y = clamp(Number(crop?.y) || 0.5, half, 1 - half);
    return { scale, x, y, tx: WIDTH / 2 - scale * x * WIDTH, ty: HEIGHT / 2 - scale * y * HEIGHT, kick };
  }

  /* ---------- the values of the HUD ---------- */

  // The value of a counter with steps [{ at, value }] at t: the value of the last step, rolled up from the one before over 6 frames.
  function stepValue(steps, t) {
    if (!steps || !steps.length) return { value: 0, rolling: 0, step: -1 };
    let index = -1;
    for (let i = 0; i < steps.length; i += 1) if (steps[i].at <= t + 1e-9) index = i;
    if (index < 0) return { value: steps[0].value, rolling: 0, step: -1 };
    const current = steps[index];
    const before = index > 0 ? steps[index - 1].value : current.value;
    const progress = clamp((t - current.at) / ROLL_S, 0, 1);
    return { value: Math.round(lerp(before, current.value, ease.out(progress))), rolling: progress < 1 ? 1 - progress : 0, step: index };
  }

  function chapterAt(chapters, t) {
    let found = -1;
    for (let i = 0; i < (chapters || []).length; i += 1) if (chapters[i].start <= t + 1e-6) found = i;
    return found;
  }

  const SCRAMBLE = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&<>/';

  function hudState(g, t, music, beat) {
    const hud = g.hud || {};
    const frame = Math.round(t * FPS);
    const progress = clamp(t / Math.max(1, g.duration), 0, 1);
    const energy = energyAt(music, t);
    // loudness as the HUD shows it: the slow value, a little push on every beat
    const level = clamp(0.2 + 0.7 * energy * (0.82 + 0.18 * Math.exp(-beat.since / 0.12)), 0, 1);

    // the title in the tiles: "TITLE · LABEL 01", the number rolls up; in the first second the letters are found like in a departure board
    const counter = hud.counter ? stepValue(hud.counter.steps, t) : null;
    let counterText = '';
    if (hud.counter) {
      const shown = counter.value;
      const text = groupThousands(shown);
      counterText = text.length < (hud.counter.pad || 0) ? text.padStart(hud.counter.pad, '0') : text;
    }
    const titleText = [hud.title, hud.counter ? `${hud.counter.label ? `· ${hud.counter.label} ` : ''}${counterText}` : ''].filter(Boolean).join(' ').replace(/\s+/g, ' ');
    const chars = Array.from(titleText);
    const numFrom = chars.length - Array.from(counterText).length;
    const tiles = chars.map((char, index) => {
      const settle = 0.2 + index * 0.02;
      if (t < 1.2 && t < settle && char !== ' ') return { ch: SCRAMBLE[Math.floor(hash(frame, index, 7) * SCRAMBLE.length)], scrambled: true, num: false };
      return { ch: char, scrambled: false, num: Boolean(counterText) && index >= numFrom };
    });

    const chapter = chapterAt(hud.chapters, t);
    const chapterText = chapter >= 0 ? `CH ${roman(chapter + 1)} · ${hud.chapters[chapter].name}` : '';
    const consoleText = [hud.console, chapterText].filter(Boolean).join('  ·  ');

    // the number of instances on the right
    let instances = null;
    if (hud.instances && hud.instances.steps && hud.instances.steps.length) {
      const read = stepValue(hud.instances.steps, t);
      const first = hud.instances.steps[0].value;
      instances = {
        label: hud.instances.label || 'INSTANCES',
        value: read.value,
        text: `×${groupThousands(read.value)}`,
        raised: read.value > first,
        rolling: read.rolling
      };
    }
    const peers = instances ? instances.value : 1;
    // the readings: slow noise around a value that follows the loudness
    const slow = Math.floor(t * 3);
    const stats = {
      cpu: Math.round(clamp(52 + 38 * energy + 6 * (hash(slow, 1) - 0.5), 20, 99)),
      gpu: Math.round(clamp(58 + 30 * energy + 8 * (hash(slow, 2) - 0.5), 20, 99)),
      temp: (58 + 8 * energy + 2.4 * hash(slow, 3)).toFixed(1),
      peers: groupThousands(peers),
      lat: Math.round(clamp(14 - 6 * energy + 6 * hash(slow, 4), 3, 30))
    };

    // the meter: 36 bars, the lit ones follow the loudness, the top ones are the accent
    const bars = [];
    for (let i = 0; i < 36; i += 1) bars.push({ h: 5 + Math.round(hash(i, 11) * 6), on: (i + 1) / 36 <= level, top: (i + 1) / 36 <= level && (i + 1) / 36 > level - 4 / 36 });

    // the ruler on the left: a marker that follows the loudness
    const ruler = { marker: clamp(1 - level, 0, 1) };

    // the drops: in the 8 seconds before each one the countdown on the right
    let drop = null;
    for (const at of hud.drops || []) {
      if (t >= at - DROP_WINDOW_S && t < at) {
        const left = at - t;
        drop = { left, text: `DROP IN ${left.toFixed(2)} S`, accent: left <= 1 };
      }
    }

    const cycle = (hud.ticker || []).length ? `${hud.ticker.join('  ·  ')}  ·  ` : '';
    const ticker = { text: cycle, width: Array.from(cycle).length * TICKER_PITCH, offset: 0 };
    if (ticker.width > 0) ticker.offset = (t * TICKER_PX_PER_S) % ticker.width;

    return {
      title: { tiles, pulse: counter ? counter.rolling : 0, text: titleText, counterText, counterValue: counter ? counter.value : 0 },
      console: consoleText,
      chapter,
      progress,
      instances,
      stats,
      meter: { level, bars },
      ruler,
      barBeat: `BAR ${String(Math.max(0, beat.bar)).padStart(3, '0')} · BEAT ${beat.beat}`,
      ticker,
      rec: { text: hud.rec || '', on: Math.floor(t * 2) % 2 === 0 },
      timecode: timecode(t),
      drop,
      figure: hud.figure || ''
    };
  }

  /* ---------- the karaoke line ---------- */

  function karaokeState(g, t) {
    const lines = g.lines || [];
    let found = -1;
    for (let i = 0; i < lines.length; i += 1) if (lines[i].start - KARAOKE_LEAD_S <= t + 1e-6 && t < lines[i].end + KARAOKE_TAIL_S) found = i;
    if (found < 0) return null;
    const line = lines[found];
    let current = -1;
    const words = (line.words || []).map((word, index) => {
      let state = 'next';
      if (t >= word.end) state = 'sung';
      else if (t >= word.start) {
        state = 'current';
        current = index;
      }
      return { text: word.text, state };
    });
    const entry = clamp((t - (line.start - KARAOKE_LEAD_S)) / (3 * FRAME_S), 0, 1);
    const leave = clamp(1 - (t - line.end) / KARAOKE_TAIL_S, 0, 1);
    return { line: (g.linesBefore || 0) + found, words, current, alpha: Math.min(ease.out(entry), 1) * (t > line.end ? ease.out(leave) : 1), key: line.key };
  }

  /* ---------- the devices ---------- */

  const TYPED_ROWS_CPS = TYPE_CPS;

  // the typing of a list of texts one after the other at `cps` characters a second from `local`: how many characters of each are shown
  function typedCounts(texts, local, cps, delay = 0) {
    let budget = Math.max(0, Math.floor((local - delay) * cps));
    return texts.map((text) => {
      const length = Array.from(text).length;
      const shown = Math.min(length, budget);
      budget -= shown;
      return shown;
    });
  }

  // A running time: the frames of a timecode text such as "03:52:17:04"
  function parseClock(text) {
    const parts = String(text || '').split(':').map((part) => Number(part));
    if (!parts.length || parts.some((part) => !Number.isFinite(part))) return { frames: 0, parts: 4 };
    const [a = 0, b = 0, c = 0, d = 0] = parts;
    if (parts.length >= 4) return { frames: ((a * 60 + b) * 60 + c) * FPS + d, parts: 4 };
    if (parts.length === 3) return { frames: ((a * 60 + b) * 60 + c) * FPS, parts: 3 };
    return { frames: (a * 60 + b) * FPS, parts: 2 };
  }

  // the substate of every kind of device: what is shown of it `local` seconds after it appeared
  const SUB = {
    display(d, c) {
      return {
        rows: d.rows.map((row, rowIndex) => ({
          boxP: row.box ? ease.out((c.t - ((d.wordTimes[rowIndex] || [c.appear])[0] || c.appear)) / 0.16) : 1,
          tokens: row.tokens.map((token, tokenIndex) => {
            const at = (d.wordTimes[rowIndex] || [])[tokenIndex];
            const start = Number.isFinite(at) ? at : c.appear;
            return { text: token, p: ease.out((c.t - start - (row.box ? 0.06 : 0)) / ENTER_S), shown: c.t >= start };
          })
        }))
      };
    },
    counter(d, c) {
      const format = d.format;
      const span = Math.max(0.2, c.end - c.appear);
      let text;
      let total = '';
      let progress;
      if (format === 'clock') {
        const from = parseClock(d.from);
        const to = parseClock(d.to);
        progress = clamp(c.local / span, 0, 1);
        text = clockText(lerp(from.frames, to.frames, progress), from.parts);
      } else {
        const rollS = Math.min(1.4, 0.7 * span);
        const steps = Math.floor(c.local / c.sixteenthS);
        progress = clamp((steps * c.sixteenthS) / rollS, 0, 1);
        const value = Math.round(lerp(d.from, d.to, ease.out(progress)));
        if (format === 'percent') text = `${value}%`;
        else if (format === 'money') text = `$${groupThousands(value)}`;
        else if (format === 'multiplier') text = `×${groupThousands(value)}`;
        else if (format === 'fraction') {
          text = groupThousands(value);
          total = `/ ${groupThousands(d.total)}`;
        } else text = groupThousands(value);
      }
      return { text, total, progress, pulse: Math.exp(-c.beat.since / 0.11) };
    },
    tag() {
      return {};
    },
    stamp(d, c) {
      const stamps = [];
      for (let i = 0; i < d.count; i += 1) {
        const at = c.landings[i];
        stamps.push({ at, p: c.t >= at ? clamp((c.t - at) / (5 * FRAME_S), 0, 1) : -1, shake: c.t >= at ? Math.exp(-(c.t - at) / 0.12) : 0 });
      }
      return { stamps };
    },
    strike(d, c) {
      const at = c.landings[0];
      return { at, p: c.t >= at ? ease.out((c.t - at) / (4 * FRAME_S)) : 0 };
    },
    spec(d, c) {
      const rows = d.rows.map((row) => row.label);
      const values = d.rows.map((row) => row.value);
      const texts = [d.title, ...rows.flatMap((label, i) => [label, values[i]])];
      const counts = typedCounts(texts, c.local, 40, 0.1);
      return { title: counts[0], rows: rows.map((_label, i) => ({ label: counts[1 + i * 2], value: counts[2 + i * 2] })) };
    },
    blueprint(d, c) {
      return { p: ease.inOut(c.local / 1.1), labels: ease.out((c.local - 0.8) / 0.25) };
    },
    chart(d, c) {
      return { p: ease.inOut(c.local / 1.3), marker: ease.back((c.local - 1.15) / 0.25) };
    },
    terminal(d, c) {
      const texts = d.lines.map((line) => line);
      const counts = typedCounts(texts, c.local, 26, 0.15);
      const last = counts.findIndex((count, i) => count < Array.from(texts[i]).length);
      const cursorRow = last < 0 ? texts.length - 1 : last;
      return { lines: texts.map((text, i) => Array.from(text).slice(0, counts[i]).join('')), cursorRow, cursorOn: c.beat.phase < 0.55 };
    },
    chat(d, c) {
      return { bubbles: d.messages.map((_message, i) => ({ p: ease.back((c.t - (d.bubbleTimes[i] || c.appear)) / ENTER_S), shown: c.t >= (d.bubbleTimes[i] || c.appear) })) };
    },
    notification(d, c) {
      const intro = ease.outStrong(c.local / (8 * FRAME_S));
      const outro = c.t > c.end - 0.25 ? ease.out((c.t - (c.end - 0.25)) / 0.25) : 0;
      return { p: intro * (1 - outro) };
    },
    voice(d, c) {
      // the line of the last 1.2 s: flat on the left, the swing of the voice grows towards the right end, which is the moment that is heard now
      const points = [];
      const count = 120;
      const span = 1.2;
      for (let i = 0; i < count; i += 1) {
        const at = c.t - (count - 1 - i) * (span / count);
        const frame = Math.floor(at * FPS * 3);
        const amp = clamp(energyAt(c.music, at), 0, 1);
        const swing = hash(frame, i, 21) * 2 - 1;
        const recent = (i / (count - 1)) ** 2.6;
        points.push(swing * (0.04 + 0.96 * amp) * recent);
      }
      return { points };
    },
    clock(d, c) {
      const time = String(d.time || '00:00');
      const [h = 0, m = 0] = time.split(':').map((part) => Number(part) || 0);
      return { hour: ((h % 12) + m / 60) * 30, minute: m * 6, arc: clamp(d.arc, 0, 1) * ease.inOut(c.local / 0.9), text: time };
    },
    stopwatch(d, c) {
      const from = parseClock(d.from);
      return { text: clockText(from.frames + c.local * FPS, from.parts) };
    },
    list(d, c) {
      return { shown: clamp(Math.floor(c.local / c.sixteenthS) + 1, 0, d.rows.length) };
    },
    toggle(d, c) {
      const flips = (d.flips || []).filter((time) => time <= c.t);
      const on = flips.length % 2 === 0;
      const last = flips.length ? flips[flips.length - 1] : null;
      const motion = last === null ? 1 : ease.out((c.t - last) / 0.22);
      return { on, knob: on ? motion : 1 - motion, label: d.states[on ? 0 : 1] || (on ? 'ON' : 'OFF'), settled: motion >= 1 };
    },
    progress(d, c) {
      const motion = ease.inOut(c.local / Math.max(0.5, Math.min(2.2, (c.end - c.appear) * 0.8)));
      return { value: Math.round(lerp(d.from, d.to, motion)), p: lerp(d.from, d.to, motion) / 100 };
    },
    pin(d, c) {
      return { drop: ease.back(c.local / 0.3), pulse: ((c.local % 1.2) / 1.2) };
    }
  };

  // The ink of the writing that stands on the picture: dark on a light picture. `luma` is [left, right] (0 to 1) of the cut; `threshold` is the
  // brightness from which the picture is light (0.58 in the first style; the heavy letters of Kuble turn dark a little earlier, 0.5).
  function inkFor(cut, rect, threshold = 0.58) {
    const luma = cut && cut.luma;
    if (!luma) return 'light';
    const value = rect.x + rect.w / 2 < WIDTH / 2 ? luma[0] : luma[1];
    return value > threshold ? 'dark' : 'light';
  }

  // The ink of the frame of the HUD (the numbers, the ruler, the ticker): dark when the picture is bright, white otherwise.
  function hudInk(cut) {
    const luma = cut && cut.luma;
    if (!luma) return 'light';
    return (luma[0] + luma[1]) / 2 > 0.6 ? 'dark' : 'light';
  }

  function deviceStates(g, t, music, beat, cut, style) {
    const out = [];
    const hard = (end) => (g.cuts || []).some((item) => Math.abs(item.start - end) <= 0.05);
    for (const d of g.devices || []) {
      const appear = d.appear;
      // a big display exists from `appear`, but nothing of it is drawn before its first word (`first`): it is not on the screen yet
      if (t < appear - 1e-6 || t < (d.first === undefined ? appear : d.first) - 1e-6) continue;
      const exit = hard(d.end) ? 0 : EXIT_S;
      if (t >= d.end + exit) continue;
      const local = t - appear;
      const context = {
        t, local, appear, end: d.end, music, beat, sixteenthS: beat.sixteenthS,
        landings: d.landings || []
      };
      // a style may draw a device in its own way (Kuble: the words of a big display spring in on the sixteenths)
      const own = style && style.id === 'kuble' ? SUB_KUBLE[d.type] : null;
      if (own) {
        context.fx = style.fx;
        context.first = d.first === undefined ? appear : d.first;
      }
      const make = own || SUB[d.type];
      const sub = make ? make(d, context) : {};
      out.push({
        id: d.id,
        type: d.type,
        d,
        rect: d.rect,
        accent: d.accent,
        enter: ease.out(local / ENTER_S),
        leave: t >= d.end && exit > 0 ? clamp((t - d.end) / exit, 0, 1) : 0,
        local,
        ink: inkFor(cut, d.rect, style && style.inkThreshold),
        sub
      });
    }
    return out;
  }

  // the impacts of the devices that land with a bang (stamps, the strike)
  function thudsOf(g) {
    const found = [];
    for (const d of g.devices || []) if (d.type === 'stamp') for (const at of d.landings || []) found.push({ t: at });
    return found;
  }


  /* ---------- Kuble: the big words on the sixteenths, the layers over the picture, the amber, the frame ---------- */

  const KUBLE_ENTER_S = 7 * FRAME_S;
  const STATUS_SLOT_S = 3.6;
  const STATUS_CPS = 34;
  const SPARK_CHAPTER = /CHORUS|REFRAIN|HOOK|DROP/;

  // The start of a word on the grid of the sixteenths: the sixteenth nearest to `at` (on the grid of the beat that `at` is in; before the first beat
  // the grid goes on backwards), never before `floor`.
  function sixteenthGrid(music, at, floor) {
    const beats = music.beats || [];
    const period = clamp(60 / (music.bpm || 120), 0.2, 1.5);
    let prev = Math.floor(at / period) * period;
    let length = period;
    if (beats.length) {
      const index = after(beats, at + 1e-9) - 1;
      if (index >= 0) {
        prev = beats[index];
        if (index + 1 < beats.length) length = clamp(beats[index + 1] - prev, 0.2, 1.5);
      } else prev = beats[0] - period;
    }
    const step = length / 4;
    return Math.max(floor, prev + Math.round((at - prev) / step) * step);
  }

  // The devices that Kuble draws with another substate. A big display: every word springs in (a strong overshoot) with a blue glow that fades, on
  // the nearest sixteenth to the time the word is sung.
  const SUB_KUBLE = {
    display(d, c) {
      const glowS = c.fx.kinetic.glowSeconds;
      return {
        rows: d.rows.map((row, rowIndex) => {
          const times = d.wordTimes[rowIndex] || [];
          const startOf = (tokenIndex) => sixteenthGrid(c.music, Number.isFinite(times[tokenIndex]) ? times[tokenIndex] : c.appear, c.first);
          return {
            boxP: row.box ? ease.out((c.t - startOf(0)) / 0.16) : 1,
            tokens: row.tokens.map((token, tokenIndex) => {
              const start = startOf(tokenIndex);
              const shown = c.t >= start;
              return {
                text: token,
                p: ease.spring((c.t - start - (row.box ? 0.06 : 0)) / KUBLE_ENTER_S),
                shown,
                glow: shown ? clamp(1 - (c.t - start) / glowS, 0, 1) : 0
              };
            })
          };
        })
      };
    }
  };

  // The pulse on a hit: a flash of the accent colour over the picture for `frames` frames, as strong as the hit (0.15 to 0.35), and a small push of the
  // picture. Null when no hit of the strength `from` or more is that young.
  function pulseAt(fx, music, t) {
    const frames = fx.pulse.frames;
    const seconds = frames * FRAME_S;
    const hits = music.hits || [];
    const times = music.hitTimes || hits.map((hit) => hit.t);
    let found = null;
    let age = 0;
    // `age` counts the frames since the hit: the first frame that shows it (0) has the whole strength, the next ones fade (2/3, 1/3 for three frames)
    for (let i = after(times, t - seconds); i < hits.length && hits[i].t <= t + 1e-9; i += 1) {
      if (clamp(hits[i].strength, 0, 1) < fx.pulse.from) continue;
      const frame = Math.floor((t - hits[i].t) * FPS + 1e-6);
      if (frame >= 0 && frame < frames) {
        found = hits[i];
        age = frame;
      }
    }
    if (!found) return null;
    const strength = clamp((clamp(found.strength, 0, 1) - fx.pulse.from) / (1 - fx.pulse.from), 0, 1);
    const decay = (frames - age) / frames;
    return { alpha: (fx.pulse.min + (fx.pulse.max - fx.pulse.min) * strength) * decay, zoom: 0.02 * decay };
  }

  // The band of light that crosses the picture: at the start of a chapter (not the first) and during a wipe. { p: 0..1, kind } or null.
  function sweepAt(fx, g, t, transition) {
    if (transition && transition.kind === 'wipe') return { p: clamp(transition.local / WIPE_S, 0, 1), kind: 'wipe' };
    const seconds = fx.sweep.frames * FRAME_S;
    for (const chapter of (g.hud && g.hud.chapters) || []) {
      if (chapter.start > (g.start || 0) + 0.05 && t >= chapter.start - 1e-6 && t < chapter.start + seconds) return { p: clamp((t - chapter.start) / seconds, 0, 1), kind: 'chapter' };
    }
    return null;
  }

  // The moment of the sparks that are in the air at t (the latest one): a hit of the strength `from` or more, a drop, the start of a chorus.
  function sparkTrigger(fx, g, music, t) {
    const seconds = fx.sparks.seconds;
    let best = null;
    const consider = (at, strength) => {
      if (at <= t + 1e-9 && t - at < seconds && (!best || at > best.t)) best = { t: at, strength };
    };
    const hits = music.hits || [];
    const times = music.hitTimes || hits.map((hit) => hit.t);
    for (let i = after(times, t - seconds); i < hits.length && hits[i].t <= t + 1e-9; i += 1) if (clamp(hits[i].strength, 0, 1) >= fx.sparks.from) consider(hits[i].t, clamp(hits[i].strength, 0, 1));
    for (const at of (g.hud && g.hud.drops) || []) consider(at, 1);
    for (const chapter of (g.hud && g.hud.chapters) || []) if (SPARK_CHAPTER.test(chapter.name) && chapter.start > (g.start || 0) + 0.05) consider(chapter.start, 1);
    return best;
  }

  // Where the sparks start: the side (1: they come from the right and fly left, -1 the other way round) and the x of the point they start at. Never on the
  // side of the figure (a figure on the left: from the right, on the right: from the left; with the figure in the middle or none, either side, at the
  // edge, far from the zone of the face). Of the places that are allowed, the one that the devices of the layout cover least while the sparks are in the
  // air (a card on the place that the sparks fly through is the worse place); the first one when it is a tie, the side by a hash when there is no
  // figure on one of them. It depends on the layout and on the moment of the trigger only, so the sparks of one trigger keep their place for their whole
  // flight and a chunk draws the same sparks as the film.
  const SPARK_PLACES = {
    left: [{ side: 1, xs: [1560, 1400, 1250] }],
    right: [{ side: -1, xs: [360, 520, 670] }],
    middle: [{ side: -1, xs: [300, 400] }, { side: 1, xs: [1620, 1520] }]
  };
  function sparkOrigin(subject, seed, g, at, seconds) {
    const places = subject === 'left' ? SPARK_PLACES.left : subject === 'right' ? SPARK_PLACES.right : SPARK_PLACES.middle.slice();
    if (places.length > 1 && hash(seed, 99, 5) < 0.5) places.reverse();
    const covered = (side, x) => {
      // what the dots cross: the lower part of the picture, 320 px inward from the start
      const a = { x: side > 0 ? x - 320 : x - 50, y: 520, w: 370, h: 440 };
      let sum = 0;
      for (const d of g.devices || []) {
        if (!d.rect || !(d.appear < at + seconds && d.end > at)) continue;
        for (const r of d.occupies || [d.rect]) {
          const w = Math.min(a.x + a.w, r.x + r.w) - Math.max(a.x, r.x);
          const h = Math.min(a.y + a.h, r.y + r.h) - Math.max(a.y, r.y);
          if (w > 0 && h > 0) sum += w * h;
        }
      }
      return sum;
    };
    let best = null;
    for (const place of places) {
      for (const x of place.xs) {
        const cost = covered(place.side, x);
        if (!best || cost < best.cost - 1e-6) best = { side: place.side, x, cost };
      }
    }
    return best;
  }

  // The sparks of a trigger at t: 24 to 40 dots from a point low on the screen at the side away from the figure, thrown up and inward, falling. Every
  // number comes from a hash of the time of the trigger and the index of the dot. [{ x, y, r, a }]
  function sparkDots(fx, trigger, t, subject, g) {
    const S = fx.sparks;
    const local = t - trigger.t;
    const count = Math.round(S.min + (S.max - S.min) * clamp((trigger.strength - S.from) / (1 - S.from), 0, 1));
    const seed = Math.round(trigger.t * 1000);
    const origin = sparkOrigin(subject, seed, g, trigger.t, S.seconds);
    const side = origin.side;
    const dots = [];
    for (let i = 0; i < count; i += 1) {
      const ox = origin.x + (hash(seed, i, 6) - 0.5) * 90;
      const oy = 900 + (hash(seed, i, 7) - 0.5) * 50;
      const vx = side > 0 ? lerp(-600, 70, hash(seed, i, 1)) : lerp(-70, 600, hash(seed, i, 1));
      const vy = lerp(-1120, -420, hash(seed, i, 2));
      const life = S.seconds * (0.6 + 0.4 * hash(seed, i, 4));
      const age = local / life;
      if (age >= 1) continue;
      const fade = 1 - age;
      dots.push({
        x: Math.round((ox + vx * local) * 10) / 10,
        y: Math.round((oy + vy * local + 0.5 * 1500 * local * local) * 10) / 10,
        r: Math.round((2.4 + 4 * hash(seed, i, 5)) * (1 - 0.4 * age) * 10) / 10,
        a: Math.round(fade ** 1.3 * 100) / 100
      });
    }
    return dots;
  }

  // The one amber element of the picture (Kuble: amber is the single warm counterpoint, never two at once). The order: the end card, then the devices
  // that are amber for as long as they are on the screen (the stamp, the strike, the marker of a chart; the first one in the list), then the sparks,
  // then the downbeat square of the beat bar. -> { kind, id } or null.
  function amberOf({ end, devices, sparksOn, downbeat }) {
    if (end) return { kind: 'end', id: '' };
    for (const item of devices) {
      if (item.type === 'stamp' && item.sub.stamps.some((stamp) => stamp.p >= 0)) return { kind: 'stamp', id: item.id };
      if (item.type === 'strike' && item.sub.p > 0) return { kind: 'strike', id: item.id };
      if (item.type === 'chart' && item.sub.marker > 0) return { kind: 'marker', id: item.id };
    }
    if (sparksOn) return { kind: 'sparks', id: '' };
    if (downbeat) return { kind: 'beat', id: '' };
    return null;
  }

  // The status line at the bottom left: the entries of the ticker, one after the other, each typed (the cursor blinks once it is typed).
  function statusAt(entries, t) {
    if (!entries.length) return { text: '', cursor: false };
    const slot = Math.floor(t / STATUS_SLOT_S);
    const local = t - slot * STATUS_SLOT_S;
    const chars = Array.from(entries[slot % entries.length]);
    const typed = Math.min(chars.length, Math.floor(local * STATUS_CPS));
    return { text: chars.slice(0, typed).join(''), cursor: typed < chars.length || Math.floor(local * 2) % 2 === 0 };
  }

  // What the frame of Kuble shows besides the values that the first style shows too (`hud`, the result of hudState).
  function kubleHud(g, t, beat, hud, pulse, style) {
    const h = g.hud || {};
    const chapter = hud.chapter;
    const quarter = ((beat.sixteenth % 4) + 4) % 4;
    const instances = hud.instances;
    return {
      title: h.title || '',
      chapter: chapter >= 0 ? `CH ${pad2(chapter + 1)} · ${h.chapters[chapter].name}` : '',
      meta: [hud.figure, instances ? `${instances.label} ${instances.text}` : ''].filter(Boolean).join(' · '),
      raised: Boolean(instances && instances.raised),
      counter: h.counter ? { label: h.counter.label || '', text: hud.title.counterText, rolling: hud.title.pulse } : null,
      status: statusAt((h.ticker || []).length ? h.ticker : h.console ? [h.console] : [], t),
      // the square of the beat bar that is lit: the sixteenth of the bar (0 is the downbeat)
      beats: { lit: (beat.beat - 1) * 4 + quarter, amber: false },
      // the glow of the title, the counter and the head of the progress line on a hit: as strong as the pulse over the picture (0 to 1)
      hit: pulse ? Math.round(clamp(pulse.alpha / style.fx.pulse.max, 0, 1) * 100) / 100 : 0
    };
  }

  /* ---------- the end card ---------- */

  function endcardState(g, t, style) {
    const card = g.endcard;
    if (!card || !(card.seconds > 0)) return null;
    const start = g.endFrame / FPS;
    if (t < start - 1e-6) return null;
    const local = t - start;
    const lines = card.lines || [];
    // typed one line after the other, fast enough that the last line is complete when 60 % of the card are over (the credit must be readable)
    const chars = [card.title || '', ...lines].reduce((sum, text) => sum + Array.from(text).length, 0);
    const cps = clamp(chars / Math.max(0.5, card.seconds * 0.6 - 0.25), 34, 90);
    const typed = typedCounts([card.title || '', ...lines], local, cps, 0.25);
    const out = {
      local,
      fade: ease.out(local / (4 * FRAME_S)),
      line: ease.out((local - 0.1) / 0.5),
      title: Array.from(card.title || '').slice(0, typed[0]).join(''),
      lines: lines.map((line, i) => Array.from(line).slice(0, typed[1 + i]).join('')),
      cursor: Math.floor(local * 2) % 2 === 0
    };
    if (style && style.id === 'kuble') {
      // the title is set in Montserrat Black on one line: its size follows the length of the whole title (a capital is about 0.78 em wide)
      const length = Math.max(8, Array.from(card.title || '').length);
      out.size = Math.round(clamp(1640 / (length * 0.78), 40, 104));
      // the amber dot comes when the title is typed
      out.dot = ease.spring((local - (0.25 + Array.from(card.title || '').length / cps)) / 0.3);
    }
    return out;
  }

  /* ---------- one frame ---------- */

  // t: seconds of the song. options: { karaoke: true, endcard: true }.
  function frameState(graphics, t, options = {}) {
    const g = graphics;
    const time = Math.max(0, Number(t) || 0);
    const music = g.music || {};
    const style = themes.get(g.theme);
    const kuble = style.id === 'kuble';
    const beat = beatState(music, time);
    const found = cutAt(g.cuts || [], time);
    const cut = found ? found.cut : null;
    const end = options.endcard === false ? null : endcardState(g, time, style);
    const pulse = kuble && !end ? pulseAt(style.fx, music, time) : null;
    const kick = end ? 0 : kuble ? clamp(kickAt(music, time, beat, thudsOf(g)) + (pulse ? pulse.zoom : 0), 0, 0.05) : kickAt(music, time, beat, thudsOf(g));

    // the number of the cut in the whole film (a chunk holds only some of the cuts: `cutsBefore` counts the ones before it)
    const cutIndex = found ? (g.cutsBefore || 0) + found.index : 0;
    let transition = null;
    if (cut && cutIndex > 0 && !end) {
      const local = time - cut.start;
      if (cut.transition === 'wipe' && local < WIPE_S) transition = { kind: 'wipe', p: clamp(local / WIPE_S, 0, 1), local };
      else if (cut.transition === 'flash' && local < FLASH_FRAMES * FRAME_S - 1e-6) transition = { kind: 'flash', p: local / (FLASH_FRAMES * FRAME_S), alpha: local < FRAME_S - 1e-6 ? 1 : 0.55, local };
      else if (cut.transition === 'glitch' && local < 5 * FRAME_S) transition = { kind: 'glitch', p: clamp(local / (5 * FRAME_S), 0, 1), local };
    }

    const hud = end ? null : hudState(g, time, music, beat);
    const devices = end ? [] : deviceStates(g, time, music, beat, cut, style);
    const result = {
      t: time,
      frame: Math.round(time * FPS),
      cut: cut ? { index: cutIndex, start: cut.start, end: cut.end, local: time - cut.start, kind: cut.kind, unit: cut.unit, subject: cut.subject || 'center', transition: cut.transition || 'cut', crop: cut.crop } : null,
      camera: camera(cut && cut.crop, kick),
      kick,
      transition,
      music: {
        beat: beat.beat,
        bar: beat.bar,
        beatIndex: beat.beatIndex,
        sixteenth: beat.sixteenth,
        since: beat.since,
        phase: beat.phase,
        energy: energyAt(music, time)
      },
      ink: hudInk(cut),
      hud,
      karaoke: options.karaoke === false || end ? null : karaokeState(g, time),
      devices,
      endcard: end,
      accent: g.accent || '#3B82F6'
    };
    if (kuble) {
      // the layers over the picture, the one amber element and the frame of the style
      const subject = cut ? cut.subject || 'center' : 'center';
      const sweep = end ? null : sweepAt(style.fx, g, time, transition);
      const trigger = end ? null : sparkTrigger(style.fx, g, music, time);
      if (hud) hud.k = kubleHud(g, time, beat, hud, pulse, style);
      const persistent = amberOf({ end, devices, sparksOn: false, downbeat: false });
      const sparksOn = Boolean(trigger) && !persistent;
      const amber = amberOf({ end, devices, sparksOn, downbeat: Boolean(hud && hud.k.beats.lit === 0) });
      if (hud && amber && amber.kind === 'beat') hud.k.beats.amber = true;
      result.theme = 'kuble';
      // how strong the dark gradients at the top and bottom of the picture are (the writing of the frame and the karaoke line lie on them): full on a
      // bright picture, light on a dark one (the brightness of the cut that the node measured; 0.5 when it is not known)
      const luma = cut && cut.luma;
      const bright = luma ? (luma[0] + luma[1]) / 2 : 0.5;
      const scrim = Math.round(clamp((bright - 0.15) / 0.45, 0.25, 1) * 100) / 100;
      result.fx = { pulse, sweep, sparks: sparksOn ? sparkDots(style.fx, trigger, time, subject, g) : null, scrim };
      result.amber = amber;
    }
    return result;
  }

  return {
    FPS,
    WIDTH,
    HEIGHT,
    ENTER_S,
    EXIT_S,
    ROLL_S,
    WIPE_S,
    TICKER_PITCH,
    TICKER_PX_PER_S,
    DROP_WINDOW_S,
    KARAOKE_LEAD_S,
    KARAOKE_TAIL_S,
    TYPED_ROWS_CPS,
    frameState,
    sixteenthGrid,
    statusAt,
    beatState,
    energyAt,
    kickAt,
    cutAt,
    camera,
    stepValue,
    groupThousands,
    roman,
    timecode,
    clockText,
    parseClock,
    typedCounts,
    inkFor,
    hudInk,
    hash,
    ease,
    clamp,
    lerp,
    after
  };
});
