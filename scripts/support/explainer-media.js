'use strict';

// Test helpers of the explainer video tests (WP37b): made-up voices, pictures and measurements, with the real ffmpeg.
//   toneWav(seconds, frequency)        a WAV file as a Buffer: one tone (a "voice" that can be told from every other by its pitch)
//   wavSamples(buffer)                 the samples of a WAV file
//   createMedia({ ffmpeg, ffprobe, dir })
//     .colourClip(hex, seconds, opts)  a silent clip of one colour, or of two colours (hex, then secondHex from `switchAt`)
//     .probe(file)                     { duration, frames, width, height, hasAudio, audioDuration }
//     .colourAt(file, seconds)         the nearest colour of PALETTE of the picture at a moment, and `rgbAt` for the raw values
//     .pcm(file)                       the sound of a file as mono samples at 48 kHz { samples, rate }
//   amplitudeAt(samples, rate, frequency, from, to)   the strength of one frequency in a window (Goertzel)
//   dominantFrequency(samples, rate, from, to, candidates)  which of the candidate frequencies is the strongest in a window

const { execFile } = require('child_process');
const fsp = require('fs/promises');
const path = require('path');
const { promisify } = require('util');
const assert = require('assert/strict');

const execFileAsync = promisify(execFile);

const RATE = 44100;
const PALETTE = ['ff0000', '00ff00', '0000ff', 'ffff00', 'ff00ff', '00ffff', 'ff8000', '8000ff', '80ff00', '0080ff', 'ff0080', '808080', 'c0c0c0', '804000', '008040', '000000', 'ffffff'];
const rgbOf = (hex) => [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));

function nearestColour(rgb) {
  let best = null;
  for (const hex of PALETTE) {
    const [r, g, b] = rgbOf(hex);
    const distance = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
    if (!best || distance < best.distance) best = { hex, distance };
  }
  return best.hex;
}

function wavOf(samples, rate = RATE) {
  const data = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[index] * 32767))), index * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// One tone of `seconds` (a short fade at both ends so that nothing clicks).
function toneWav(seconds, frequency, { amplitude = 0.5, rate = RATE } = {}) {
  const count = Math.round(seconds * rate);
  const samples = new Float32Array(count);
  const fade = Math.min(Math.round(0.005 * rate), Math.floor(count / 2));
  for (let index = 0; index < count; index += 1) {
    let gain = amplitude;
    if (index < fade) gain *= index / fade;
    if (count - index < fade) gain *= (count - index) / fade;
    samples[index] = gain * Math.sin((2 * Math.PI * frequency * index) / rate);
  }
  return wavOf(samples, rate);
}

function wavSamples(buffer) {
  let at = 12;
  while (at + 8 <= buffer.length) {
    const id = buffer.toString('latin1', at, at + 4);
    const size = buffer.readUInt32LE(at + 4);
    if (id === 'data') {
      const count = Math.floor(Math.min(size, buffer.length - at - 8) / 2);
      return Float32Array.from({ length: count }, (_unused, index) => buffer.readInt16LE(at + 8 + index * 2) / 32767);
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

// The strength of one frequency in samples[from..to) (seconds): the amplitude of the sine wave of that frequency (Goertzel).
function amplitudeAt(samples, rate, frequency, from, to) {
  const start = Math.max(0, Math.round(from * rate));
  const end = Math.min(samples.length, Math.round(to * rate));
  const count = end - start;
  if (count <= 0) return 0;
  const omega = (2 * Math.PI * frequency) / rate;
  const coefficient = 2 * Math.cos(omega);
  let s1 = 0;
  let s2 = 0;
  for (let index = start; index < end; index += 1) {
    const s0 = samples[index] + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coefficient * s1 * s2;
  return (2 * Math.sqrt(Math.max(0, power))) / count;
}

function dominantFrequency(samples, rate, from, to, candidates) {
  let best = null;
  for (const frequency of candidates) {
    const amplitude = amplitudeAt(samples, rate, frequency, from, to);
    if (!best || amplitude > best.amplitude) best = { frequency, amplitude };
  }
  return best && best.amplitude > 0.02 ? best.frequency : null;
}

// The first moment (seconds) from which `frequency` is clearly there, found in windows of 10 ms.
function onsetOf(samples, rate, frequency, { from = 0, threshold = 0.08, window = 0.01 } = {}) {
  for (let time = from; time < samples.length / rate - window; time += window / 2) {
    if (amplitudeAt(samples, rate, frequency, time, time + window) >= threshold) return time;
  }
  return null;
}

// The last moment up to which `frequency` is there.
function endOf(samples, rate, frequency, { threshold = 0.08, window = 0.01 } = {}) {
  for (let time = samples.length / rate - window; time > 0; time -= window / 2) {
    if (amplitudeAt(samples, rate, frequency, time, time + window) >= threshold) return time + window;
  }
  return null;
}

function createMedia({ ffmpeg, ffprobe, dir }) {
  let counter = 0;
  const cache = new Map();
  const ff = (args) => execFileAsync(ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 });
  const next = (ext) => {
    counter += 1;
    return path.join(dir, `media-${counter}${ext}`);
  };
  return {
    ff,
    next,
    // A clip of one colour; with `second` and `switchAt` the colour changes at that moment. `audio`: a tone file to put in as the sound.
    async colourClip(hex, seconds, { size = '160x90', fps = 30, second = null, switchAt = null, audioFile = null } = {}) {
      const key = JSON.stringify([hex, seconds, size, fps, second, switchAt, audioFile]);
      if (cache.has(key)) return cache.get(key);
      const file = next('.mp4');
      const [width, height] = size.split('x');
      const args = [];
      if (second) {
        args.push('-f', 'lavfi', '-i', `color=c=0x${hex}:s=${size}:r=${fps}:d=${seconds}`, '-f', 'lavfi', '-i', `color=c=0x${second}:s=${size}:r=${fps}:d=${seconds}`);
        if (audioFile) args.push('-i', audioFile);
        args.push('-filter_complex', `[0:v][1:v]overlay=enable='gte(t,${switchAt})':format=auto,format=yuv420p[v]`, '-map', '[v]');
        if (audioFile) args.push('-map', '2:a');
      } else {
        args.push('-f', 'lavfi', '-i', `color=c=0x${hex}:s=${width}x${height}:r=${fps}:d=${seconds}`);
        if (audioFile) args.push('-i', audioFile);
      }
      args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-g', '15');
      if (audioFile) args.push('-c:a', 'aac', '-shortest');
      else args.push('-an');
      args.push('-t', String(seconds), file);
      await ff(args);
      cache.set(key, file);
      return file;
    },
    async probe(file) {
      const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file], { maxBuffer: 16 * 1024 * 1024 });
      const data = JSON.parse(stdout);
      const video = data.streams.find((stream) => stream.codec_type === 'video');
      const audio = data.streams.find((stream) => stream.codec_type === 'audio');
      return {
        duration: Number(data.format.duration),
        frames: video ? Number(video.nb_read_frames) : 0,
        width: video ? video.width : 0,
        height: video ? video.height : 0,
        fps: video ? Number(video.r_frame_rate.split('/')[0]) / Number(video.r_frame_rate.split('/')[1] || 1) : 0,
        hasAudio: Boolean(audio),
        audioDuration: audio ? Number(audio.duration) : 0
      };
    },
    async rgbAt(file, seconds) {
      const { stdout } = await execFileAsync(
        ffmpeg,
        ['-nostdin', '-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'scale=1:1:flags=area,format=rgb24', '-f', 'rawvideo', '-'],
        { encoding: 'buffer', maxBuffer: 1024 * 1024 }
      );
      assert.equal(stdout.length, 3, `a picture at ${seconds} s of ${path.basename(file)}`);
      return [stdout[0], stdout[1], stdout[2]];
    },
    async colourAt(file, seconds) {
      return nearestColour(await this.rgbAt(file, seconds));
    },
    // The sound of a file as mono float samples at 48 kHz.
    async pcm(file) {
      const out = next('.wav');
      await ff(['-i', file, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', out]);
      const samples = wavSamples(await fsp.readFile(out));
      await fsp.rm(out, { force: true });
      return { samples, rate: 48000 };
    }
  };
}

module.exports = { RATE, PALETTE, rgbOf, nearestColour, wavOf, toneWav, wavSamples, amplitudeAt, dominantFrequency, onsetOf, endOf, createMedia };
