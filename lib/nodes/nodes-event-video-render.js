'use strict';

// The cut and the render of the event video (WP53, spec §3, §7), two nodes:
//   event_video.cut      the plan `shots` (lib/event-video/contract.js) becomes the film of the format without sound and the stem of the sound of the
//                        clips: photos are made small once (lib/event-video/cut.js stillArgs), every shot is reframed (crop around the anchor, or the
//                        whole picture over a blurred copy, lib/event-video/reframe.js), the look of the plan goes on (eq, YUV only), the scenes are cut
//                        frame-exact in batches (lib/music-video-edit.js, lib/music-video-render.js). Local and free.
//   event_video.render   draws the graphics (title, lower thirds, intertitles, subtitles of the soundbites, end card with the logo, tint, light spot, dip
//                        and flash) on the film in chunks of at most 24 s on the render nodes (lib/event-video/composition.js, lib/render-chunks.js),
//                        mixes the sound (music ducked under the soundbites and the voice, the stem of the clips, the voice; two passes to the loudness
//                        of the plan, lib/event-video/mix.js), joins and finishes the film (grain, vignette, BT.709, AAC), checks it, and makes a contact
//                        sheet and the SRT of the soundbites. Free of charge: the render nodes are ours.
// The registration (lib/nodes/registry.js), the template and the texts of the app come with the integration (WP53, package D). runCut() and
// mixSound() take plain files and a runner of ffmpeg, so the tests and the QA scripts use them without a session.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ffmpeg = require('../ffmpeg');
const rendernode = require('../rendernode');
const store = require('../store');
const contract = require('../event-video/contract');
const cutLib = require('../event-video/cut');
const reframe = require('../event-video/reframe');
const composition = require('../event-video/composition');
const mixLib = require('../event-video/mix');
const postLib = require('../music-video-hud/postpass');
const renderLib = require('../music-video-render');
const chunkRenderer = require('../render-chunks');
const assets = require('./assets');
const ops = require('./ffmpeg-ops');
const { textValue } = require('./types');

const FPS = contract.FPS;
const { ERRORS } = contract;
// the whole render may take its time: the render nodes draw the chunks, a film of 90 s is 4 or 5 of them
const RENDER_TIMEOUT_MS = 75 * 60 * 1000;
const CUT_TIMEOUT_MS = 60 * 60 * 1000;
// the codes of the render nodes for lib/render-chunks.js (a node that cannot take large files is a missing node for the event video)
const RENDER_CODES = Object.freeze({ noNode: ERRORS.EVENTRENDER_NO_NODE, noUploads: ERRORS.EVENTRENDER_NO_NODE, failed: ERRORS.EVENTRENDER_CHUNK_FAILED });
const HEADER_BYTES = 512 * 1024;

function eventError(code, message, data) {
  const err = new Error(message);
  if (code) err.code = code;
  if (data) err.data = data;
  return err;
}

const textOf = (inputs, id) => (inputs[id] ? String(inputs[id].value ?? '') : '');
const itemsOf = (inputs, id) => {
  const value = inputs[id];
  if (!value) return [];
  return value.type === 'list' ? value.items : [value];
};
const secondsText = (value) => `${Math.round(value * 10) / 10}`;

function ffmpegAvailable() {
  return ffmpeg.binaries().available ? true : 'ffmpeg/ffprobe not found';
}

// zscale (the tone mapping of HDR footage) is in the ffmpeg of the server but not in every one: without it HDR footage gets the fallback look
const hdrMode = () => (ffmpeg.hasFilter('zscale') ? 'zscale' : 'fallback');

// The plan from its text: JSON and the shape of the contract
function readShots(text) {
  let shots;
  try {
    shots = JSON.parse(text);
  } catch (_) {
    throw eventError(ERRORS.EVENTCUT_FAILED, 'shots: the text is not the plan of the cut (JSON)');
  }
  const checked = contract.checkShots(shots);
  if (!checked.ok) throw eventError(ERRORS.EVENTCUT_FAILED, `shots: ${checked.problems.slice(0, 3).join('; ')}`, { problems: checked.problems.slice(0, 10).join('; ') });
  return shots;
}

function readGraphics(text) {
  let graphics;
  try {
    graphics = JSON.parse(text);
  } catch (_) {
    throw eventError(null, 'graphics: the text is not the plan of the graphics (JSON)');
  }
  const checked = contract.checkGraphics(graphics);
  if (!checked.ok) throw eventError(null, `graphics: ${checked.problems.slice(0, 3).join('; ')}`);
  return graphics;
}

function readFormat(text, code) {
  const format = String(text || '').trim();
  if (!contract.FORMATS.includes(format)) throw eventError(code, `format: "${format.slice(0, 20)}" is not one of ${contract.FORMATS.join(', ')}`);
  return format;
}

/* ---------- the cut ---------- */

// Width, height (as shown) and EXIF orientation of a photo: the header of a JPEG, else what ffprobe says (a PNG or WebP has no orientation).
async function photoInfo(file, probe) {
  const handle = await fsp.open(file, 'r');
  let header;
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    header = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const jpeg = cutLib.jpegInfo(header);
  if (jpeg) return { width: jpeg.width, height: jpeg.height, orientation: jpeg.orientation };
  const info = await probe(file);
  if (!info.video) throw eventError(ERRORS.EVENTCUT_FAILED, `${path.basename(file)} is not a picture`);
  return { width: info.video.width, height: info.video.height, orientation: 1 };
}

// The cut with plain files. shots: the plan; format; sources: per shot { list, index, path } (cutLib.resolveSources over paths); scratch: a folder for
// the stills and the outputs; run(args, { timeoutMs }) runs ffmpeg; probe(file) is ops.probeMedia; renderPlan runs the plan of the cut. Returns
// { video, nat, natCount, fits, notes, seconds, timings, plan }.
async function runCut({ shots, format, sources, scratch, quality = 'standard', hdr = 'zscale', run, probe, renderPlan, log = () => {} }) {
  const timings = {};
  let started = Date.now();
  const probes = new Map();
  const probeOf = async (file) => {
    if (!probes.has(file)) probes.set(file, await probe(file));
    return probes.get(file);
  };
  // the fit of every shot: the one of the plan, else the choice of the cut (D17); photos are made small once per photo and fit
  const fits = [];
  const files = [];
  const stills = new Map();
  for (let index = 0; index < shots.shots.length; index += 1) {
    const shot = shots.shots[index];
    const source = sources[index];
    if (shot.kind === 'photo') {
      const info = await photoInfo(source.path, probeOf);
      const { fit } = reframe.chooseFit(shot, info.width, info.height, format);
      const key = `${source.path}\n${fit}`;
      if (!stills.has(key)) {
        const outFile = path.join(scratch, `still-${stills.size + 1}.png`);
        const built = cutLib.stillArgs({ inputFile: source.path, outFile, orientation: info.orientation, format, fit, width: info.width, height: info.height });
        await run(built.args);
        stills.set(key, { path: outFile, width: built.size.width, height: built.size.height, seconds: null, audio: false, original: info });
      }
      fits.push(fit);
      files.push(stills.get(key));
    } else {
      const info = await probeOf(source.path);
      if (!info.video) throw eventError(ERRORS.EVENTCUT_FAILED, `${shot.id}: ${source.list}[${source.index}] has no picture`);
      const { fit } = reframe.chooseFit(shot, info.video.width, info.video.height, format);
      fits.push(fit);
      files.push({ path: source.path, width: info.video.width, height: info.video.height, fps: info.video.fps || null, seconds: info.duration || null, audio: Boolean(info.audio) });
    }
  }
  timings.stills = (Date.now() - started) / 1000;
  // the plan with the fit of every shot (so that the cut does not choose again on the size of the still)
  const fixed = { ...shots, shots: shots.shots.map((shot, index) => ({ ...shot, fit: fits[index] })) };
  const cut = cutLib.cutArgs(fixed, format, files, { quality, hdr });
  for (const note of cut.notes) log(note);
  started = Date.now();
  const video = path.join(scratch, 'cut.mp4');
  await renderPlan(cut.plan, { files: cut.files, outputFile: video });
  timings.cut = (Date.now() - started) / 1000;
  // the stem of the clips; a film without a clip with sound gets a silent one (the render leaves it out of the mix)
  started = Date.now();
  const nat = path.join(scratch, 'nat.wav');
  const natBuilt = cutLib.natArgs(fixed, files, { outFile: nat });
  if (natBuilt) await run(natBuilt.args);
  else await run(['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=${mixLib.SAMPLE_RATE}:cl=stereo`, '-t', ops.num(shots.duration), '-c:a', 'pcm_s16le', nat]);
  timings.nat = (Date.now() - started) / 1000;
  return { video, nat, natCount: natBuilt ? natBuilt.count : 0, fits, notes: cut.notes, seconds: cut.plan.seconds, timings, plan: cut.plan, stills: stills.size };
}

const cutDefinition = {
  type: 'event_video.cut',
  category: 'edit-video',
  label: 'Cut event video',
  keywords: ['event', 'aftermovie', 'cut', 'edit', 'reframe', 'crop', 'photos', 'zoom', 'slow motion', 'video', 'ffmpeg'],
  description:
    'Cuts the event video from the plan of the shots: every clip from its place, at its speed, reframed to the format around the person (a crop with a ' +
    'slight drift), or shown whole over a blurred copy of itself where a crop would lose too much (an upright photo in 16:9); photos zoom or pan; ' +
    'the AI and parallax clips are cut like clips; the look of the plan (contrast, saturation, the exposure of every shot) goes on, HDR footage is ' +
    'tone-mapped. The second output is the sound of the clips at their times in the film (silent for an event of photos only). Local and free.',
  inputs: [
    { id: 'shots', type: 'text', required: true },
    { id: 'format', type: 'text', required: true },
    { id: 'videos', type: 'video', multiple: true, max: contract.LIMITS.listItems },
    { id: 'photos', type: 'image', multiple: true, max: contract.LIMITS.listItems },
    { id: 'ai_clips', type: 'video', multiple: true, max: contract.MAX_AI_PHOTOS },
    { id: 'parallax_clips', type: 'video', multiple: true, max: contract.MAX_PARALLAX }
  ],
  outputs: [
    { id: 'video', type: 'video' },
    { id: 'nat', type: 'audio' }
  ],
  params: [{ id: 'quality', kind: 'select', options: ['standard', 'high'], default: 'standard' }],
  cost: { unit: 'local' },
  timeoutMs: CUT_TIMEOUT_MS,
  available: ffmpegAvailable,
  execute: async (ctx, inputs, params) => {
    const shots = readShots(textOf(inputs, 'shots'));
    const format = readFormat(textOf(inputs, 'format'), ERRORS.EVENTCUT_FAILED);
    const lists = { videos: itemsOf(inputs, 'videos'), photos: itemsOf(inputs, 'photos'), ai_clips: itemsOf(inputs, 'ai_clips'), parallax_clips: itemsOf(inputs, 'parallax_clips') };
    const sources = cutLib.resolveSources(shots, lists).map((source) => ({ ...source, path: assets.assetFilePath(source.item) }));
    for (const source of sources) {
      if (!fs.existsSync(source.path)) throw eventError(ERRORS.EVENTCUT_SOURCE_MISSING, `${source.list}[${source.index}]: the file is missing`, { list: source.list, index: source.index });
    }
    const binaries = ffmpeg.binaries();
    const scratch = await assets.createScratchDir(ctx.sessionId);
    const started = Date.now();
    const timeoutMs = Math.max(ffmpeg.PROCESS_TIMEOUT_MS, Math.ceil(shots.duration * 30) * 1000);
    try {
      const result = await ctx.withLocalSlot(() =>
        runCut({
          shots,
          format,
          sources,
          scratch,
          quality: params.quality,
          hdr: hdrMode(),
          log: (line) => ctx.log(line),
          run: (args) => ffmpeg.runProcess(binaries.ffmpeg, args, { timeoutMs, signal: ctx.signal }),
          probe: (file) => ops.probeMedia(file, { ffprobePath: binaries.ffprobe, signal: ctx.signal }),
          renderPlan: (plan, { files, outputFile }) => renderLib.renderPlan(plan, { files, outputFile, ffmpegPath: binaries.ffmpeg, signal: ctx.signal, timeoutMs })
        })
      ).catch((err) => {
        if (err.code || ctx.signal?.aborted || err.name === 'AbortError') throw err;
        throw eventError(ERRORS.EVENTCUT_FAILED, `the cut failed: ${String(err.message || err).slice(0, 300)}`);
      });
      const blur = result.fits.filter((fit) => fit === 'blur').length;
      ctx.log(
        `${shots.shots.length} shots, ${secondsText(result.seconds)} s, ${format} (${contract.FORMAT_SIZES[format].width}x${contract.FORMAT_SIZES[format].height}), ` +
          `${blur ? `${blur} over a blurred copy, ` : ''}${result.stills} photos made small, ${result.natCount} clips with sound` +
          `${result.plan.mode === 'batched' ? `, cut in ${result.plan.batches.length} batches` : ''}; ` +
          `photos ${secondsText(result.timings.stills)} s, cut ${secondsText(result.timings.cut)} s, sound ${secondsText(result.timings.nat)} s, all ${secondsText((Date.now() - started) / 1000)} s`
      );
      const video = await ctx.saveOutputFile({ kind: 'video', ext: '.mp4', sourceFile: result.video, prompt: `Event video cut (${format})`, cost: 0, duration: result.seconds });
      const nat = await ctx.saveOutputFile({ kind: 'audio', ext: '.wav', sourceFile: result.nat, prompt: 'Sound of the clips', cost: 0, duration: shots.duration });
      return { variants: [{ video, nat }] };
    } finally {
      await assets.removeScratchDir(scratch).catch(() => {});
    }
  }
};

/* ---------- the render ---------- */

// The sound of the film with plain files: the stem measured (silent: left out), the mix, its loudness measured and brought to the plan. files:
// { music, nat (or null), voices: [{ file, seconds }] }; run(args) runs ffmpeg, runCapture(args) runs it and returns its stderr. Returns
// { file, measured, gain, natUsed, windows }.
async function mixSound({ graphics, files, scratch, run, runCapture, log = () => {} }) {
  let nat = files.nat || null;
  if (nat) {
    const measured = mixLib.readLoudness(await runCapture(mixLib.loudnessProbeArgs(nat)));
    if (mixLib.isSilent(measured)) {
      log('the sound of the clips is silent (an event of photos only): the mix is music and voice');
      nat = null;
    }
  }
  const mixed = path.join(scratch, 'mix.wav');
  const built = mixLib.mixArgs(graphics, { music: files.music, nat, voices: files.voices || [], out: mixed });
  await run(built.args);
  const measured = mixLib.readLoudness(await runCapture(mixLib.loudnessProbeArgs(mixed)));
  const gain = mixLib.gainOf(measured, mixLib.mixOf(graphics).lufs);
  if (gain === null) return { file: mixed, measured: null, gain: null, natUsed: Boolean(nat), windows: built.windows };
  const out = path.join(scratch, 'sound.wav');
  await run(mixLib.normalizeArgs({ inputFile: mixed, outputFile: out, gainDb: gain }));
  return { file: out, measured, gain, natUsed: Boolean(nat), windows: built.windows };
}

async function colourOf(file, signal) {
  try {
    const { ffprobe } = ffmpeg.binaries();
    const { stdout } = await ffmpeg.runProcess(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_space,color_range', '-of', 'json', file], { timeoutMs: 30000, signal });
    const stream = (JSON.parse(stdout).streams || [])[0] || {};
    return { color_space: stream.color_space, color_range: stream.color_range };
  } catch (_) {
    return {};
  }
}

async function probeFilm(file, signal) {
  const { ffprobe } = ffmpeg.binaries();
  const { stdout } = await ffmpeg.runProcess(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { timeoutMs: 60000, signal });
  return JSON.parse(stdout);
}

const renderDefinition = {
  type: 'event_video.render',
  category: 'edit-video',
  label: 'Draw event video',
  keywords: ['event', 'aftermovie', 'title', 'lower third', 'subtitles', 'end card', 'logo', 'music', 'ducking', 'render', 'hyperframes', 'video'],
  description:
    'Draws the graphics of the event video on the cut: the title, the lower thirds over the soundbites, the intertitles, the subtitles of the ' +
    'soundbites, the end card with the logo, the colour tint and the light of the look, dips and flashes at the cuts. The film is drawn in pieces of ' +
    'at most 24 s on the render nodes; the music is mixed under the sound of the clips and the voice (ducked under every soundbite and line of the ' +
    'voice) and brought to the loudness of the plan; grain, vignette, BT.709 and the sound (AAC) are added with ffmpeg. The second output is a ' +
    'contact sheet of 12 frames, the third the subtitles of the soundbites as SRT. Free of charge.',
  inputs: [
    { id: 'video', type: 'video', required: true },
    { id: 'nat', type: 'audio' },
    { id: 'graphics', type: 'text', required: true },
    { id: 'format', type: 'text', required: true },
    { id: 'music', type: 'audio', required: true },
    { id: 'voice', type: 'audio', multiple: true, max: contract.MAX_VOICEOVER },
    { id: 'logo', type: 'image' },
    { id: 'brand', type: 'text' }
  ],
  outputs: [
    { id: 'video', type: 'video' },
    { id: 'sheet', type: 'image' },
    { id: 'subtitles', type: 'text' }
  ],
  params: [{ id: 'quality', kind: 'select', options: ['draft', 'standard', 'high'], default: 'standard' }],
  cost: { unit: 'local' },
  timeoutMs: RENDER_TIMEOUT_MS,
  async: true,
  available: () => {
    if (!rendernode.enabled()) return 'No render node configured';
    return ffmpegAvailable();
  },
  execute: async (ctx, inputs, params) => {
    const log = (line) => ctx.log(line);
    const started = Date.now();
    const binaries = ffmpeg.binaries();
    const graphics = readGraphics(textOf(inputs, 'graphics'));
    const format = readFormat(textOf(inputs, 'format'), null);
    const size = contract.FORMAT_SIZES[format];
    const videoFile = assets.assetFilePath(inputs.video);
    const video = await ops.probeMedia(videoFile, { ffprobePath: binaries.ffprobe, signal: ctx.signal });
    if (!video.video) throw eventError(null, 'video: the file has no picture');
    if (video.video.width !== size.width || video.video.height !== size.height) log(`video: ${video.video.width}x${video.video.height}, the format is ${size.width}x${size.height}: it is scaled`);
    if (!(video.duration >= graphics.duration - 0.5)) throw eventError(null, `video: ${secondsText(video.duration || 0)} s, the plan needs ${secondsText(graphics.duration)} s`);
    const musicFile = assets.assetFilePath(inputs.music);
    const music = await ops.probeMedia(musicFile, { ffprobePath: binaries.ffprobe, signal: ctx.signal });
    if (!music.audio) throw eventError(null, 'music: the file has no sound');
    const voices = [];
    for (const value of itemsOf(inputs, 'voice')) {
      const file = assets.assetFilePath(value);
      const probe = await ops.probeMedia(file, { ffprobePath: binaries.ffprobe, signal: ctx.signal });
      voices.push({ file, seconds: probe.duration || 0 });
    }
    const missingVoice = (graphics.voiceover || []).filter((line) => !voices[line.index]);
    if (missingVoice.length) log(`${missingVoice.length} lines of the voice have no audio: they are left out`);
    const logoValue = inputs.logo && inputs.logo.assetId && inputs.logo.sessionId === ctx.sessionId ? inputs.logo : null;
    if (graphics.endcard && graphics.endcard.logo && !logoValue) log('the end card asks for a logo, but none is connected: the end card without it');

    const runFfmpeg = (args, timeoutMs = ffmpeg.PROCESS_TIMEOUT_MS) => ctx.withLocalSlot(() => ffmpeg.runProcess(binaries.ffmpeg, args, { timeoutMs, signal: ctx.signal }));
    const scratch = await assets.createScratchDir(ctx.sessionId);
    const temp = [];
    try {
      // 1. the chunks on the render nodes
      const chunks = composition.eventChunks(graphics);
      const endStart = graphics.endcard ? graphics.duration - graphics.endcard.seconds : Infinity;
      const logoFile = logoValue ? `${logoValue.assetId}${path.extname(assets.assetFilePath(logoValue))}` : null;
      log(`${secondsText(graphics.duration)} s of film, ${format}, ${chunks.length} chunks, quality ${params.quality}`);
      const drawn = Date.now();
      const rendered = await chunkRenderer.renderChunks(ctx, {
        chunks,
        quality: params.quality,
        temp,
        log,
        fps: FPS,
        format: size.renderFormat,
        codes: RENDER_CODES,
        prepare: async (chunk) => {
          const file = path.join(scratch, `chunk-${chunk.index + 1}.mp4`);
          await runFfmpeg(postLib.cutClipArgs({ inputFile: videoFile, outFile: file, start: chunk.start, frames: chunk.frames, width: size.width, height: size.height }));
          const clip = await ctx.saveOutputFile({ kind: 'video', ext: '.mp4', sourceFile: file, prompt: `Event footage ${chunk.index + 1}`, cost: 0, duration: chunk.clipSeconds });
          temp.push(clip.assetId);
          const withLogo = logoFile && chunk.start + chunk.duration > endStart - 0.5 ? logoFile : null;
          const html = composition.buildChunkPage({ graphics, format, chunk, clipFile: `${clip.assetId}${path.extname(clip.file)}`, logoFile: withLogo });
          return { html, label: `Event ${chunk.index + 1}/${chunks.length}`, clipId: clip.assetId, assetIds: withLogo ? [clip.assetId, logoValue.assetId] : [clip.assetId] };
        }
      });
      const renderSeconds = (Date.now() - drawn) / 1000;

      // 2. the sound
      const mixed = Date.now();
      const runCapture = async (args) => (await ctx.withLocalSlot(() => ffmpeg.runProcess(binaries.ffmpeg, args, { timeoutMs: ffmpeg.PROCESS_TIMEOUT_MS, signal: ctx.signal }))).stderr || '';
      const sound = await mixSound({
        graphics,
        files: { music: musicFile, nat: inputs.nat ? assets.assetFilePath(inputs.nat) : null, voices },
        scratch,
        run: (args) => runFfmpeg(args),
        runCapture,
        log
      });
      log(sound.gain === null ? 'the loudness of the mix could not be measured: it is left as it is' : `sound: ${sound.measured.toFixed(1)} LUFS, ${sound.gain >= 0 ? '+' : ''}${sound.gain.toFixed(1)} dB to ${mixLib.mixOf(graphics).lufs} LUFS, ducked ${sound.windows.length} times`);

      // 3. joined and finished
      const listFile = path.join(scratch, 'chunks.txt');
      await fsp.writeFile(listFile, postLib.concatListText(rendered.map((item) => assets.assetFilePath(item.value))), 'utf8');
      const outFile = path.join(scratch, 'film.mp4');
      const inputColor = await colourOf(assets.assetFilePath(rendered[0].value), ctx.signal);
      const built = mixLib.finishArgs({ listFile, audioFile: sound.file, outFile, format, graphics, inputColor });
      await runFfmpeg(built.args, Math.max(ffmpeg.PROCESS_TIMEOUT_MS, Math.ceil(built.seconds * 4) * 1000 + 120000));
      const problems = postLib.verifyOutput(await probeFilm(outFile, ctx.signal), { frames: built.frames, seconds: built.seconds, width: size.width, height: size.height });
      if (problems.length) throw eventError(ERRORS.EVENTRENDER_VERIFY_FAILED, `the finished film is not right: ${problems.join('; ')}`, { problems: problems.join('; ') });
      const sheetFile = path.join(scratch, 'sheet.png');
      try {
        await runFfmpeg(postLib.contactSheetArgs({ inputFile: outFile, outFile: sheetFile, frames: built.frames, width: size.width, height: size.height }).args);
      } catch (err) {
        if (chunkRenderer.isFatal(err, ctx)) throw err;
        throw eventError(ERRORS.EVENTRENDER_VERIFY_FAILED, `the contact sheet could not be made from the film: ${String(err?.message || err).slice(0, 200)}`, { problems: 'the contact sheet could not be made from the film' });
      }
      const filmValue = await ctx.saveOutputFile({ kind: 'video', ext: '.mp4', sourceFile: outFile, prompt: 'Event video', cost: 0, duration: built.seconds });
      const sheetValue = await ctx.saveOutputFile({ kind: 'image', ext: '.png', sourceFile: sheetFile, prompt: 'Contact sheet of the event video', cost: 0 });
      log(`${built.frames} frames, ${secondsText(built.seconds)} s; render ${secondsText(renderSeconds)} s, sound and finishing ${secondsText((Date.now() - mixed) / 1000)} s, all ${secondsText((Date.now() - started) / 1000)} s`);
      return { variants: [{ video: filmValue, sheet: sheetValue, subtitles: textValue(mixLib.subtitlesSrt(graphics, format)) }] };
    } finally {
      await assets.removeScratchDir(scratch).catch(() => {});
      if (temp.length) await store.removeAssets(ctx.sessionId, temp).catch(() => {});
    }
  }
};

const definitions = [cutDefinition, renderDefinition];

function registerAll(registry) {
  for (const definition of definitions) registry.register(definition);
}

module.exports = { definitions, registerAll, runCut, mixSound, readShots, readGraphics, readFormat, photoInfo, RENDER_CODES };
