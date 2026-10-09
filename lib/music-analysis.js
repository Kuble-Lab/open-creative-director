'use strict';

// Song analysis (WP34, node "Analyze song"): tempo, beats, sections and the loudness of a song, computed here, offline and
// free. No library: ffmpeg turns the file into mono PCM, the rest is plain JavaScript.
//
//   1. decode        ffmpeg -> mono 22.05 kHz PCM
//   2. onset         log-compressed band spectra (FFT 512, hop 256 = 11.6 ms), the rise of each band summed up: the onset envelope
//   3. tempo         autocorrelation of the envelope, 60-180 BPM, with a prior (round 100 BPM, or a hint such as the "82 BPM" of a
//                    song plan) and the multiples of the lag added in, which settles most octave doubts
//   4. beats         dynamic programming after Ellis (2007), "Beat Tracking by Dynamic Programming": the best chain of onsets that
//                    keeps the tempo; the chain is extended to both ends of the song
//   5. bpm           the slope of the beats in time, which is far finer than the lag grid of step 3
//   6. sections      from a song plan (the lengths of its sections, the boundaries moved to the nearest change in the sound),
//                    else from the jumps in loudness and timbre: 3 to 10 parts named "Teil 1" ...
//   7. downbeats     the first beat of every bar (WP44): the bar is four beats, its phase is the one whose beats carry the most accent (the
//                    onset strength, the low bands of the kick drum counted twice) and the starts of the sections, which vote for it
//   8. hits          the strong onsets of the envelope (WP44): the highest peaks, at most three in any second
//
// Everything is async with short pauses for the event loop: the server must not stand still while a ten-minute song is analysed.

const { spawn } = require('child_process');

const ffmpegLib = require('./ffmpeg');
const musicPlan = require('../public/nodes/music-plan');

const SAMPLE_RATE = 22050;
const FFT_SIZE = 512;
const HOP = 256;
const FPS = SAMPLE_RATE / HOP;
const BANDS = 24;
const BAND_MIN_HZ = 40;
const BAND_MAX_HZ = 9000;
// the tempo range and the prior: log-normal round PRIOR_BPM, wide (one octave); with a hint narrow (a fifth of an octave)
const MIN_BPM = 60;
const MAX_BPM = 180;
const PRIOR_BPM = 100;
const PRIOR_OCTAVES = 1;
const HINT_OCTAVES = 0.2;
const TIGHTNESS = 400;
// where the envelope peak of an onset lies in relation to the onset itself (seconds, added to the time of the peak frame): found
// with clicks and kick drums of known time, which the peak showed 16 ms too early (the window of a frame is centred
// FFT_SIZE / 2 after its start, and the rise of the band is seen before the middle of the sound); see scripts/test-music-analysis.js
const ONSET_OFFSET_SEC = 0.0128;
// the longest audio that is looked at (a file is cut here), and the shortest that has a tempo
const MAX_SECONDS = 20 * 60;
const MIN_TEMPO_SECONDS = 4;
// sections found by listening: the target count follows the length, never fewer than 3 or more than 10 parts
const SECTION_SECONDS = 25;
const MIN_PARTS = 3;
const MAX_PARTS = 10;
const FEATURE_HOP_SEC = 0.5;
const NOVELTY_SPAN_SEC = 6;
const MIN_PART_SEC = 6;
// plan sections: how far a boundary may be moved to the change in the sound, and how far the plan may be off the audio
const PLAN_REFINE_SEC = 1.5;
const PLAN_MISMATCH = 0.25;
const YIELD_EVERY = 4000;
// downbeats: a bar is four beats; the accent of a beat is its onset strength in the whole spectrum and in the lowest bands (the kick drum and the
// bass: seven bands, up to about 300 Hz, with the 43 Hz bins of the FFT); the start of a section votes for the phase of the beat it falls on when
// that beat is at most ANCHOR_SNAP_SEC away (as for the sections themselves) - it votes and does not decide, because a boundary found by listening
// is only as exact as the features (half a second); another phase than the first beat's must beat the first one's score by PHASE_MARGIN
const BEATS_PER_BAR = 4;
const LOW_BANDS = 7;
const ANCHOR_SNAP_SEC = 0.35;
const ANCHOR_WEIGHT = 0.5;
const PHASE_MARGIN = 0.05;
// hits: a peak of the envelope that is the highest within HIT_RADIUS frames (35 ms), at least HIT_FLOOR times the RMS of the envelope and
// HIT_MIN_SHARE of the strongest peak of the song; the strongest first, HIT_GAP_SEC apart, and never more than HIT_MAX_PER_SECOND in a second
const HIT_RADIUS = 3;
const HIT_FLOOR = 1.5;
const HIT_MIN_SHARE = 0.1;
const HIT_GAP_SEC = 0.1;
const HIT_MAX_PER_SECOND = 3;
// The envelope is scaled to a standard deviation of 1, so numerical noise would look like onsets: a steady tone (0.0005 before the scaling) and
// silence have no hits; a quiet song (a click train at -40 dB: 0.006) and hiss (0.04) have, as the real songs (0.5 and more) do
const ONSET_ACTIVITY_FLOOR = 0.002;

function abortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function breathe(signal) {
  await tick();
  if (signal?.aborted) throw abortError();
}

/* ---------- decoding ---------- */

// The audio file as mono PCM (Float32Array, -1..1) at 22.05 kHz. ffmpeg's output is binary, so it is read here and not through
// ffmpeg.runProcess (which collects text).
function decodeMono(file, { ffmpegPath, signal, timeoutMs = 5 * 60 * 1000, maxSeconds = MAX_SECONDS } = {}) {
  const command = ffmpegPath || ffmpegLib.binaries().ffmpeg;
  if (!command) return Promise.reject(new Error('ffmpeg not found'));
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const args = ['-nostdin', '-v', 'error', '-i', file, '-t', String(maxSeconds), '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'];
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    child.on('close', (code) => {
      cleanup();
      if (aborted) return reject(abortError());
      if (timedOut) return reject(new Error('ffmpeg took too long to read the audio'));
      if (code !== 0) return reject(new Error(`ffmpeg could not read the audio: ${stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ')}`));
      const bytes = Buffer.concat(chunks);
      const samples = new Float32Array(Math.floor(bytes.length / 2));
      for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readInt16LE(index * 2) / 32768;
      resolve(samples);
    });
  });
}

/* ---------- spectra ---------- */

function makeFft(size) {
  const levels = Math.round(Math.log2(size));
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let index = 0; index < size / 2; index += 1) {
    cos[index] = Math.cos((2 * Math.PI * index) / size);
    sin[index] = Math.sin((2 * Math.PI * index) / size);
  }
  const reverse = new Uint32Array(size);
  for (let index = 0; index < size; index += 1) {
    let value = 0;
    for (let bit = 0; bit < levels; bit += 1) value |= ((index >>> bit) & 1) << (levels - 1 - bit);
    reverse[index] = value;
  }
  // in place; re and im are Float64Array(size)
  return function fft(re, im) {
    for (let index = 0; index < size; index += 1) {
      const other = reverse[index];
      if (other > index) {
        const tr = re[index];
        re[index] = re[other];
        re[other] = tr;
        const ti = im[index];
        im[index] = im[other];
        im[other] = ti;
      }
    }
    for (let span = 2; span <= size; span *= 2) {
      const half = span / 2;
      const step = size / span;
      for (let start = 0; start < size; start += span) {
        for (let k = 0, table = 0; k < half; k += 1, table += step) {
          const a = start + k;
          const b = a + half;
          const tr = re[b] * cos[table] + im[b] * sin[table];
          const ti = im[b] * cos[table] - re[b] * sin[table];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  };
}

// The FFT bins that make up each band: log-spaced edges from BAND_MIN_HZ to BAND_MAX_HZ, at least one bin per band.
function bandEdges() {
  const bins = FFT_SIZE / 2 + 1;
  const edges = [];
  let previous = Math.max(1, Math.round((BAND_MIN_HZ * FFT_SIZE) / SAMPLE_RATE));
  edges.push(previous);
  for (let band = 1; band <= BANDS; band += 1) {
    const hz = BAND_MIN_HZ * (BAND_MAX_HZ / BAND_MIN_HZ) ** (band / BANDS);
    const bin = Math.min(bins, Math.max(previous + 1, Math.round((hz * FFT_SIZE) / SAMPLE_RATE)));
    edges.push(bin);
    previous = bin;
  }
  return edges;
}

// Band spectra of every frame: `bands` = Float32Array(frames * BANDS), log-compressed amplitude (about 1 for a loud tone).
async function bandSpectra(samples, signal) {
  const frames = samples.length >= FFT_SIZE ? Math.floor((samples.length - FFT_SIZE) / HOP) + 1 : 0;
  const bands = new Float32Array(frames * BANDS);
  const fft = makeFft(FFT_SIZE);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const window = new Float64Array(FFT_SIZE);
  for (let index = 0; index < FFT_SIZE; index += 1) window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (FFT_SIZE - 1));
  const edges = bandEdges();
  const scale = 2 / FFT_SIZE;
  for (let frame = 0; frame < frames; frame += 1) {
    const offset = frame * HOP;
    for (let index = 0; index < FFT_SIZE; index += 1) {
      re[index] = samples[offset + index] * window[index];
      im[index] = 0;
    }
    fft(re, im);
    for (let band = 0; band < BANDS; band += 1) {
      let sum = 0;
      for (let bin = edges[band]; bin < edges[band + 1]; bin += 1) sum += Math.hypot(re[bin], im[bin]);
      const mean = (sum / (edges[band + 1] - edges[band])) * scale;
      bands[frame * BANDS + band] = Math.log1p(mean * 20);
    }
    if (frame % YIELD_EVERY === YIELD_EVERY - 1) await breathe(signal);
  }
  return { bands, frames };
}

/* ---------- onsets and tempo ---------- */

// The onset envelope: the rise of the bands from frame to frame, summed; the local mean (one second) taken away, scaled to a
// standard deviation of 1. `bandTo` stops the sum at a band (the lowest ones are the kick drum); all bands by default.
function onsetEnvelope({ bands, frames }, { bandTo = BANDS } = {}) {
  const flux = new Float64Array(frames);
  for (let frame = 1; frame < frames; frame += 1) {
    let sum = 0;
    for (let band = 0; band < bandTo; band += 1) {
      const rise = bands[frame * BANDS + band] - bands[(frame - 1) * BANDS + band];
      if (rise > 0) sum += rise;
    }
    flux[frame] = sum;
  }
  const radius = Math.round(FPS / 2);
  const prefix = new Float64Array(frames + 1);
  for (let frame = 0; frame < frames; frame += 1) prefix[frame + 1] = prefix[frame] + flux[frame];
  const envelope = new Float64Array(frames);
  let sumSquares = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    const from = Math.max(0, frame - radius);
    const to = Math.min(frames, frame + radius + 1);
    const local = (prefix[to] - prefix[from]) / (to - from);
    const value = Math.max(0, flux[frame] - local);
    envelope[frame] = value;
    sumSquares += value * value;
  }
  const deviation = Math.sqrt(sumSquares / Math.max(1, frames));
  if (deviation > 1e-9) for (let frame = 0; frame < frames; frame += 1) envelope[frame] /= deviation;
  return { envelope, deviation };
}

// Normalised autocorrelation of the envelope (mean taken away) for the lags 0..maxLag.
function autocorrelation(envelope, maxLag) {
  const count = envelope.length;
  let mean = 0;
  for (let index = 0; index < count; index += 1) mean += envelope[index];
  mean /= Math.max(1, count);
  const centred = new Float64Array(count);
  for (let index = 0; index < count; index += 1) centred[index] = envelope[index] - mean;
  const result = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag && lag < count; lag += 1) {
    let sum = 0;
    for (let index = 0; index + lag < count; index += 1) sum += centred[index] * centred[index + lag];
    result[lag] = sum / (count - lag);
  }
  const zero = result[0];
  if (zero > 1e-12) for (let lag = 0; lag <= maxLag; lag += 1) result[lag] /= zero;
  return result;
}

function valueAt(table, position) {
  if (position <= 0) return table[0];
  const index = Math.floor(position);
  if (index >= table.length - 1) return 0;
  const fraction = position - index;
  return table[index] * (1 - fraction) + table[index + 1] * fraction;
}

// A first estimate of the tempo: { bpm, strength } or null where the envelope has no pulse. `hint` (BPM, optional) narrows the prior.
function estimateTempo(envelope, hint = null) {
  const maxLag = Math.ceil((4 * 60 * FPS) / MIN_BPM) + 2;
  if (envelope.length < MIN_TEMPO_SECONDS * FPS) return null;
  const table = autocorrelation(envelope, Math.min(maxLag, envelope.length - 2));
  const centre = hint && hint >= 30 && hint <= 300 ? hint : PRIOR_BPM;
  const octaves = hint && hint >= 30 && hint <= 300 ? HINT_OCTAVES : PRIOR_OCTAVES;
  let best = null;
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.25) {
    const lag = (60 * FPS) / bpm;
    const raw = valueAt(table, lag) + 0.5 * valueAt(table, 2 * lag) + 0.25 * valueAt(table, 4 * lag);
    const prior = Math.exp(-0.5 * (Math.log2(bpm / centre) / octaves) ** 2);
    const score = raw * prior;
    if (!best || score > best.score) best = { bpm, score, raw };
  }
  if (!best || best.raw <= 0.02) return null;
  return { bpm: best.bpm, strength: Math.min(1, best.raw) };
}

/* ---------- beats ---------- */

// Dynamic programming (Ellis 2007): the chain of frames with the most onset strength in which every step is about one beat
// long (a step of half to double the period is allowed, a deviation is punished by the square of its log ratio). Frames of
// the chain are returned.
async function trackBeats(envelope, bpm, signal) {
  const count = envelope.length;
  const period = (60 * FPS) / bpm;
  const low = Math.max(1, Math.round(period / 2));
  const high = Math.max(low + 1, Math.round(period * 2));
  const score = new Float64Array(count);
  const link = new Int32Array(count).fill(-1);
  const penalty = new Float64Array(high + 1);
  for (let step = low; step <= high; step += 1) penalty[step] = TIGHTNESS * Math.log(step / period) ** 2;
  for (let frame = 0; frame < count; frame += 1) {
    let best = -Infinity;
    let bestFrom = -1;
    for (let step = low; step <= high && step <= frame; step += 1) {
      const value = score[frame - step] - penalty[step];
      if (value > best) {
        best = value;
        bestFrom = frame - step;
      }
    }
    if (bestFrom >= 0) {
      score[frame] = envelope[frame] + best;
      link[frame] = bestFrom;
    } else {
      score[frame] = envelope[frame];
    }
    if (frame % (YIELD_EVERY * 4) === YIELD_EVERY * 4 - 1) await breathe(signal);
  }
  // the last beat: the best end of a chain in the last period and a half
  let last = count - 1;
  for (let frame = Math.max(0, count - Math.round(period * 1.5)); frame < count; frame += 1) if (score[frame] > score[last]) last = frame;
  const frames = [];
  for (let frame = last; frame >= 0; frame = link[frame]) {
    frames.push(frame);
    if (link[frame] < 0) break;
  }
  frames.reverse();
  // the chain starts in the first period and ends wherever it scored best: beats without any onset at the two ends are
  // not beats, they only keep the spacing (extendBeats continues the grid where the song has more)
  const strength = (frame) => Math.max(envelope[frame - 1] ?? 0, envelope[frame], envelope[frame + 1] ?? 0);
  const floor = 0.1 * median(frames.map(strength));
  let from = 0;
  let to = frames.length;
  while (from < to - 1 && strength(frames[from]) < floor) from += 1;
  while (to > from + 1 && strength(frames[to - 1]) < floor) to -= 1;
  return frames.slice(from, to);
}

// The position of the peak near `frame`, to a fraction of a frame (parabola through the three points), in seconds.
function refinePeak(envelope, frame) {
  const before = envelope[frame - 1] ?? 0;
  const here = envelope[frame] ?? 0;
  const after = envelope[frame + 1] ?? 0;
  const denominator = before - 2 * here + after;
  const shift = denominator < -1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (before - after)) / denominator)) : 0;
  return ((frame + shift) * HOP) / SAMPLE_RATE + ONSET_OFFSET_SEC;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// The tempo from the beats themselves: the median of the time that eight beats take (robust against a slip, and finer than a
// grid of frames because the quantisation of single beats averages out).
function tempoOfBeats(times) {
  const span = Math.min(8, times.length - 1);
  if (span < 1) return null;
  const slopes = [];
  for (let index = 0; index + span < times.length; index += 1) slopes.push((times[index + span] - times[index]) / span);
  const period = median(slopes);
  return period > 0 ? 60 / period : null;
}

// The beats continued with the period of the nearest beats to the start and the end of the song.
function extendBeats(times, duration) {
  if (times.length < 2) return times;
  const steps = times.slice(1).map((time, index) => time - times[index]);
  const lead = median(steps.slice(0, 8));
  const tail = median(steps.slice(-8));
  const before = [];
  for (let time = times[0] - lead; lead > 0.05 && time >= 0; time -= lead) before.push(time);
  const after = [];
  for (let time = times[times.length - 1] + tail; tail > 0.05 && time <= duration; time += tail) after.push(time);
  return [...before.reverse(), ...times, ...after];
}

// A regular grid when there is no pulse to follow.
function regularBeats(bpm, duration) {
  const period = 60 / bpm;
  const out = [];
  for (let time = 0; time <= duration + 1e-9; time += period) out.push(time);
  return out;
}

/* ---------- downbeats and hits ---------- */

// How strong the onset is at each beat: the highest value of the envelope within two frames of it.
function strengthAtBeats(envelope, beats) {
  const last = envelope.length - 1;
  return beats.map((time) => {
    const frame = Math.round(((time - ONSET_OFFSET_SEC) * SAMPLE_RATE) / HOP);
    let top = 0;
    for (let at = Math.max(0, frame - 2); at <= Math.min(last, frame + 2); at += 1) if (envelope[at] > top) top = envelope[at];
    return top;
  });
}

// The accent of each beat: how much stronger it is than the other beats, in the whole spectrum and in the lowest bands, compressed (log) so that
// one crash cymbal does not decide. 0 for a song without any onset.
function beatAccents(envelope, lowEnvelope, beats) {
  const channels = [strengthAtBeats(envelope, beats), strengthAtBeats(lowEnvelope, beats)].map((values) => values.map((value) => Math.log1p(value)));
  const means = channels.map((values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length));
  return beats.map((_time, index) => channels.reduce((sum, values, channel) => sum + (means[channel] > 1e-9 ? values[index] / means[channel] : 0), 0) / channels.length);
}

function nearestIndex(list, value) {
  let best = -1;
  for (let index = 0; index < list.length; index += 1) if (best < 0 || Math.abs(list[index] - value) < Math.abs(list[best] - value)) best = index;
  return best;
}

// The first beat of every bar: every fourth beat, from the phase that scores best. The score of a phase is the mean accent of its beats (1 = an
// average beat) plus ANCHOR_WEIGHT times the share of the section starts that fall on one of its beats. Without any evidence the first beat of the
// song starts a bar. Returns a subset of `beats`.
//   accents   one value per beat (beatAccents), 0 where there is no onset
//   starts    the starts of the sections
function estimateDownbeats(beats, accents, starts = []) {
  if (!beats.length) return [];
  const mean = accents.reduce((sum, value) => sum + value, 0) / accents.length;
  const score = Array.from({ length: BEATS_PER_BAR }, (_unused, phase) => {
    let sum = 0;
    let count = 0;
    for (let index = phase; index < beats.length; index += BEATS_PER_BAR) {
      sum += accents[index];
      count += 1;
    }
    return count && mean > 1e-9 ? sum / count / mean : 0;
  });
  const votes = new Array(BEATS_PER_BAR).fill(0);
  let anchors = 0;
  for (const start of starts) {
    const index = nearestIndex(beats, start);
    if (index >= 0 && Math.abs(beats[index] - start) <= ANCHOR_SNAP_SEC) {
      votes[index % BEATS_PER_BAR] += 1;
      anchors += 1;
    }
  }
  const total = score.map((value, phase) => value + (anchors ? (ANCHOR_WEIGHT * votes[phase]) / anchors : 0));
  let phase = 0;
  for (let other = 1; other < BEATS_PER_BAR; other += 1) if (total[other] > total[phase]) phase = other;
  if (phase !== 0 && total[phase] < total[0] + PHASE_MARGIN) phase = 0;
  return beats.filter((_time, index) => index % BEATS_PER_BAR === phase);
}

// The strong onsets of the song: [{ t, strength }] in order of time, `strength` 0..1 relative to the strongest peak of the song (so 1 is the
// hardest hit of the song, and the share that is above 0.8 is small). The peaks of the envelope, strongest first, are taken as long as they keep
// HIT_GAP_SEC from the ones taken and no second holds more than HIT_MAX_PER_SECOND; the time is that of the peak, as for the beats.
function findHits(envelope, duration = Infinity) {
  const peaks = [];
  for (let frame = 0; frame < envelope.length; frame += 1) {
    const value = envelope[frame];
    if (!(value >= HIT_FLOOR)) continue;
    let highest = true;
    for (let step = 1; step <= HIT_RADIUS && highest; step += 1) {
      // the first of equal values wins
      if (frame - step >= 0 && envelope[frame - step] > value) highest = false;
      if (frame + step < envelope.length && envelope[frame + step] >= value) highest = false;
    }
    if (highest) peaks.push({ frame, value });
  }
  const top = peaks.reduce((best, peak) => Math.max(best, peak.value), 0);
  if (!(top > 0)) return [];
  const taken = [];
  const crowded = (at, time) => {
    const before = taken[at - 1];
    const after = taken[at];
    if ((before && time - before.t < HIT_GAP_SEC) || (after && after.t - time < HIT_GAP_SEC)) return true;
    // any window of HIT_MAX_PER_SECOND + 1 hits in a row that fits into a second is one too many
    const list = [...taken.slice(Math.max(0, at - HIT_MAX_PER_SECOND), at), { t: time }, ...taken.slice(at, at + HIT_MAX_PER_SECOND)];
    for (let first = 0; first + HIT_MAX_PER_SECOND < list.length; first += 1) if (list[first + HIT_MAX_PER_SECOND].t - list[first].t < 1) return true;
    return false;
  };
  const strongestFirst = peaks.filter((peak) => peak.value >= HIT_MIN_SHARE * top).sort((a, b) => b.value - a.value || a.frame - b.frame);
  for (const peak of strongestFirst) {
    const time = refinePeak(envelope, peak.frame);
    if (time < 0 || time > duration) continue;
    let at = 0;
    while (at < taken.length && taken[at].t < time) at += 1;
    if (crowded(at, time)) continue;
    taken.splice(at, 0, { t: time, value: peak.value });
  }
  return taken.map((hit) => ({ t: Math.round(hit.t * 1000) / 1000, strength: Math.round((hit.value / top) * 1000) / 1000 }));
}

/* ---------- loudness ---------- */

// The loudness of every second (RMS), 0..1 relative to the loudest second.
function energyPerSecond(samples) {
  const seconds = Math.max(1, Math.ceil(samples.length / SAMPLE_RATE));
  const rms = new Float64Array(seconds);
  for (let second = 0; second < seconds; second += 1) {
    const from = second * SAMPLE_RATE;
    const to = Math.min(samples.length, from + SAMPLE_RATE);
    let sum = 0;
    for (let index = from; index < to; index += 1) sum += samples[index] * samples[index];
    rms[second] = to > from ? Math.sqrt(sum / (to - from)) : 0;
  }
  const top = Math.max(...rms, 1e-9);
  return Array.from(rms, (value) => Math.round((value / top) * 1000) / 1000);
}

/* ---------- sections ---------- */

// Features for the change in the sound: every FEATURE_HOP_SEC the mean band spectrum and the loudness, each dimension scaled to
// a standard deviation of 1 over the song.
function soundFeatures(spectra, samples) {
  const framesPer = Math.max(1, Math.round((FEATURE_HOP_SEC * SAMPLE_RATE) / HOP));
  const count = Math.max(1, Math.floor(spectra.frames / framesPer));
  const dims = BANDS + 1;
  const features = new Float64Array(count * dims);
  for (let index = 0; index < count; index += 1) {
    const from = index * framesPer;
    for (let band = 0; band < BANDS; band += 1) {
      let sum = 0;
      for (let frame = from; frame < from + framesPer; frame += 1) sum += spectra.bands[frame * BANDS + band];
      features[index * dims + band] = sum / framesPer;
    }
    let energy = 0;
    const sampleFrom = index * framesPer * HOP;
    const sampleTo = Math.min(samples.length, sampleFrom + framesPer * HOP);
    for (let sample = sampleFrom; sample < sampleTo; sample += 1) energy += samples[sample] * samples[sample];
    features[index * dims + BANDS] = Math.log10(1e-6 + energy / Math.max(1, sampleTo - sampleFrom)) * 2;
  }
  for (let dim = 0; dim < dims; dim += 1) {
    let mean = 0;
    for (let index = 0; index < count; index += 1) mean += features[index * dims + dim];
    mean /= count;
    let variance = 0;
    for (let index = 0; index < count; index += 1) variance += (features[index * dims + dim] - mean) ** 2;
    const deviation = Math.sqrt(variance / count) || 1;
    for (let index = 0; index < count; index += 1) features[index * dims + dim] = (features[index * dims + dim] - mean) / deviation;
  }
  return { features, count, dims };
}

// How much the sound changes at each feature frame: the distance between the mean of the `span` frames before and after it.
function noveltyCurve({ features, count, dims }, spanFrames) {
  const prefix = new Float64Array((count + 1) * dims);
  for (let index = 0; index < count; index += 1) {
    for (let dim = 0; dim < dims; dim += 1) prefix[(index + 1) * dims + dim] = prefix[index * dims + dim] + features[index * dims + dim];
  }
  const novelty = new Float64Array(count);
  const minimum = Math.min(3, spanFrames);
  for (let index = 0; index < count; index += 1) {
    const before = Math.min(spanFrames, index);
    const after = Math.min(spanFrames, count - index);
    if (before < minimum || after < minimum) continue;
    let sum = 0;
    for (let dim = 0; dim < dims; dim += 1) {
      const left = (prefix[index * dims + dim] - prefix[(index - before) * dims + dim]) / before;
      const right = (prefix[(index + after) * dims + dim] - prefix[index * dims + dim]) / after;
      sum += (right - left) ** 2;
    }
    novelty[index] = Math.sqrt(sum / dims);
  }
  return novelty;
}

// Boundaries by listening: the strongest changes in the sound, at least `minGap` seconds apart, as many as the length of the song
// suggests; the hardly audible ones are left out as long as the song keeps its three parts.
function detectBoundaries(spectra, samples, duration) {
  const wanted = Math.max(1, Math.min(MAX_PARTS, Math.max(MIN_PARTS, Math.round(duration / SECTION_SECONDS)), Math.floor(duration / 3)));
  if (wanted <= 1) return [];
  const data = soundFeatures(spectra, samples);
  const span = Math.max(3, Math.min(Math.round(NOVELTY_SPAN_SEC / FEATURE_HOP_SEC), Math.floor(data.count / 6)));
  const novelty = noveltyCurve(data, span);
  const minGap = Math.max(1, Math.min(MIN_PART_SEC, duration / (wanted * 2)));
  const gapFrames = Math.max(1, Math.round(minGap / FEATURE_HOP_SEC));
  const peaks = [];
  for (let index = 1; index < data.count - 1; index += 1) {
    if (novelty[index] <= 0) continue;
    let isPeak = true;
    for (let other = Math.max(0, index - gapFrames); other <= Math.min(data.count - 1, index + gapFrames) && isPeak; other += 1) {
      if (other !== index && (novelty[other] > novelty[index] || (novelty[other] === novelty[index] && other < index))) isPeak = false;
    }
    if (isPeak) peaks.push({ time: index * FEATURE_HOP_SEC, height: novelty[index] });
  }
  peaks.sort((a, b) => b.height - a.height);
  const top = peaks.length ? peaks[0].height : 0;
  const chosen = [];
  for (const peak of peaks) {
    if (chosen.length >= wanted - 1) break;
    if (peak.time < minGap || peak.time > duration - minGap) continue;
    // weak changes only count while the song would otherwise have fewer than MIN_PARTS parts
    if (chosen.length >= MIN_PARTS - 1 && peak.height < 0.35 * top) break;
    if (chosen.some((other) => Math.abs(other.time - peak.time) < minGap)) continue;
    chosen.push(peak);
  }
  // a song without clear changes still gets its three parts: evenly spaced boundaries fill up
  const need = Math.min(MIN_PARTS - 1, wanted - 1);
  for (let fill = 1; chosen.length < need && fill < need + 1; fill += 1) {
    const time = (duration * fill) / (need + 1);
    if (!chosen.some((other) => Math.abs(other.time - time) < minGap)) chosen.push({ time, height: 0 });
  }
  return chosen.map((peak) => peak.time).sort((a, b) => a - b);
}

function nearest(list, value) {
  let best = null;
  for (const item of list) if (best === null || Math.abs(item - value) < Math.abs(best - value)) best = item;
  return best;
}

// Section boundaries snap to a beat when one is close.
function snapToBeats(times, beats, maxDistance) {
  if (!beats.length) return times;
  return times.map((time) => {
    const beat = nearest(beats, time);
    return beat !== null && Math.abs(beat - time) <= maxDistance ? beat : time;
  });
}

function sectionEnergy(energy, start, end) {
  let sum = 0;
  let weight = 0;
  for (let second = Math.floor(start); second < Math.ceil(end) && second < energy.length; second += 1) {
    const overlap = Math.min(end, second + 1) - Math.max(start, second);
    if (overlap > 0) {
      sum += energy[second] * overlap;
      weight += overlap;
    }
  }
  return weight > 0 ? Math.round((sum / weight) * 1000) / 1000 : 0;
}

function makeSections(names, boundaries, duration, energy) {
  const edges = [0, ...boundaries, duration];
  return names.map((name, index) => ({
    name,
    start: Math.round(edges[index] * 1000) / 1000,
    end: Math.round(edges[index + 1] * 1000) / 1000,
    energy: sectionEnergy(energy, edges[index], edges[index + 1])
  }));
}

// A song plan's sections: names and cumulative lengths. null where the plan has none or cannot be read.
function planSections(planText) {
  if (!String(planText || '').trim()) return null;
  const { plan } = musicPlan.parse(String(planText));
  const sections = (plan?.sections || []).filter((section) => Number.isFinite(section.durationMs) && section.durationMs > 0);
  if (!sections.length || sections.length !== (plan.sections || []).length) return null;
  let at = 0;
  return sections.map((section, index) => {
    const start = at;
    at += section.durationMs / 1000;
    return { name: section.name || `Teil ${index + 1}`, start, end: at };
  });
}

// The BPM a plan names in its styles ("82 BPM"): the middle one of those found, or null.
function bpmHint(text) {
  const found = [];
  for (const match of String(text || '').matchAll(/(\d{2,3}(?:[.,]\d+)?)\s*bpm/gi)) {
    const value = Number(match[1].replace(',', '.'));
    if (value >= 40 && value <= 240) found.push(value);
  }
  return found.length ? median(found) : null;
}

// The boundaries of a plan are accurate to about a second. Each one moves to the strongest change in the sound within
// PLAN_REFINE_SEC, if there is a clear one.
function refinePlanBoundaries(boundaries, spectra, samples, duration) {
  if (!boundaries.length || spectra.frames < 8) return boundaries;
  const data = soundFeatures(spectra, samples);
  const novelty = noveltyCurve(data, Math.max(2, Math.min(Math.round(3 / FEATURE_HOP_SEC), Math.floor(data.count / 6))));
  const typical = median(Array.from(novelty).filter((value) => value > 0));
  return boundaries.map((nominal) => {
    const from = Math.max(0, Math.round((nominal - PLAN_REFINE_SEC) / FEATURE_HOP_SEC));
    const to = Math.min(data.count - 1, Math.round((nominal + PLAN_REFINE_SEC) / FEATURE_HOP_SEC));
    let best = -1;
    for (let index = from; index <= to; index += 1) if (best < 0 || novelty[index] > novelty[best]) best = index;
    if (best < 0 || !(novelty[best] > 1.5 * typical)) return nominal;
    return Math.min(duration, best * FEATURE_HOP_SEC);
  });
}

/* ---------- the whole analysis ---------- */

// Analyses decoded samples. Options: sampleRate (22050 unless the samples come from elsewhere: they are not resampled, so this
// stays 22050), planText (a song plan: its sections and its "82 BPM" are used), signal (abort).
// Returns { version, duration, bpm, tempoConfidence, beats, sections, energy, sectionSource, warnings, downbeats, hits }: the last two
// came with WP44 (the version stays 1: the readers of the other fields do not look at them, and a reader that needs them looks for them).
async function analyse(samples, { planText = '', signal } = {}) {
  const duration = Math.round((samples.length / SAMPLE_RATE) * 1000) / 1000;
  const warnings = [];
  const energy = energyPerSecond(samples);
  const spectra = await bandSpectra(samples, signal);
  const hint = bpmHint(planText);

  // tempo and beats
  let bpm = null;
  let beats = [];
  let confidence = 0;
  const { envelope, deviation } = onsetEnvelope(spectra);
  const tempo = estimateTempo(envelope, hint);
  if (tempo) {
    const frames = await trackBeats(envelope, tempo.bpm, signal);
    const times = frames.map((frame) => refinePeak(envelope, frame)).filter((time) => time >= 0 && time <= duration);
    const refined = tempoOfBeats(times);
    bpm = refined && refined >= MIN_BPM * 0.9 && refined <= MAX_BPM * 1.1 ? refined : tempo.bpm;
    beats = extendBeats(times, duration);
    confidence = Math.round(tempo.strength * 1000) / 1000;
  } else {
    bpm = hint || 120;
    beats = regularBeats(bpm, duration);
    warnings.push('NO_PULSE');
  }
  bpm = Math.round(bpm * 100) / 100;
  beats = beats.map((time) => Math.round(time * 1000) / 1000);

  // sections
  let sections = null;
  let sectionSource = 'detected';
  const planned = duration >= 1 ? planSections(planText) : null;
  if (planned) {
    const total = planned[planned.length - 1].end;
    if (Math.abs(total - duration) / duration > PLAN_MISMATCH) {
      warnings.push('PLAN_LENGTH_MISMATCH');
    } else {
      const kept = planned.filter((section) => section.start < duration - 0.05);
      const refined = refinePlanBoundaries(
        kept.slice(1).map((section) => section.start),
        spectra,
        samples,
        duration
      );
      const starts = snapToBeats(refined, beats, 0.35);
      // a boundary that fell onto the one before (or onto the end) takes its section with it
      const names = [kept[0].name];
      const boundaries = [];
      starts.forEach((start, index) => {
        const previous = boundaries.length ? boundaries[boundaries.length - 1] : 0;
        if (start > previous + 0.1 && start < duration - 0.1) {
          boundaries.push(start);
          names.push(kept[index + 1].name);
        }
      });
      sections = makeSections(names, boundaries, duration, energy);
      sectionSource = 'plan';
    }
  }
  if (!sections) {
    const boundaries = snapToBeats(detectBoundaries(spectra, samples, duration), beats, 0.35).filter((time, index, all) => time > (index ? all[index - 1] : 0) + 0.5 && time < duration - 0.5);
    sections = makeSections(
      Array.from({ length: boundaries.length + 1 }, (_unused, index) => `Teil ${index + 1}`),
      boundaries,
      duration,
      energy
    );
  }

  // WP44: the first beat of every bar and the strong onsets; they come after the fields above, which are as they were
  const low = onsetEnvelope(spectra, { bandTo: LOW_BANDS }).envelope;
  const downbeats = estimateDownbeats(beats, beatAccents(envelope, low, beats), sections.map((section) => section.start));
  const hits = deviation >= ONSET_ACTIVITY_FLOOR ? findHits(envelope, duration) : [];

  return { version: 1, duration, bpm, tempoConfidence: confidence, beats, sections, energy, sectionSource, warnings, downbeats, hits };
}

// Decodes a file and analyses it.
async function analyseFile(file, { planText = '', signal, ffmpegPath } = {}) {
  const samples = await decodeMono(file, { ffmpegPath, signal });
  if (samples.length < SAMPLE_RATE / 2) throw Object.assign(new Error('The audio is too short to analyse'), { code: 'BEATS_AUDIO_TOO_SHORT' });
  return analyse(samples, { planText, signal });
}

module.exports = {
  SAMPLE_RATE,
  FPS,
  MAX_SECONDS,
  MIN_BPM,
  MAX_BPM,
  decodeMono,
  analyse,
  analyseFile,
  bpmHint,
  planSections,
  energyPerSecond,
  tempoOfBeats,
  beatAccents,
  estimateDownbeats,
  findHits,
  BEATS_PER_BAR,
  HIT_MAX_PER_SECOND
};
