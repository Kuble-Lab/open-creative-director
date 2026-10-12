'use strict';

// Motion rendering and video concatenation tools, moved from lib/tools.js.

const store = require('../store');
const path = require('path');
const fsp = require('fs/promises');
const ffmpeg = require('../ffmpeg');
const motionHtml = require('../../public/nodes/motion-html');
const rendernode = require('../rendernode');
const {
  MAX_RENDER_ASSETS,
  MAX_RENDER_ASSET_BYTES,
  MAX_CONCAT_ASSETS,
  shorten,
  recordToolCost,
  removeReservedAsset,
  RENDER_FORMATS,
  jobMetaFields
} = require('./shared');

async function renderAssetsFromIds(sessionId, rawIds) {
  if (rawIds === undefined || rawIds === null) return { files: [], totalBytes: 0 };
  if (!Array.isArray(rawIds)) throw new Error('asset_ids muss ein Array sein');
  if (rawIds.length > MAX_RENDER_ASSETS) {
    throw new Error(`asset_ids darf hoechstens ${MAX_RENDER_ASSETS} Assets enthalten`);
  }

  const ids = [];
  const seen = new Set();
  for (const rawId of rawIds) {
    if (typeof rawId !== 'string' || !rawId.trim()) {
      throw new Error('asset_ids darf nur nicht-leere Session-Asset-IDs enthalten');
    }
    const id = rawId.trim();
    if (!store.isValidId(id)) throw new Error(`Ungueltige Asset-ID: ${id}`);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  const ledger = await store.readLedger(sessionId);
  const files = [];
  let totalBytes = 0;
  for (const id of ids) {
    const entry = ledger.find((item) => item.id === id);
    if (!entry) throw new Error(`Asset ${id} existiert nicht in dieser Session.`);
    if (entry.pending) throw new Error(`Asset ${id} ist noch nicht fertig.`);

    const storedFile = String(entry.file || '');
    if (!storedFile || path.basename(storedFile) !== storedFile || !/^[A-Za-z0-9._-]+$/.test(storedFile)) {
      throw new Error(`Asset ${id} hat einen ungueltigen Dateinamen.`);
    }
    const ext = path.extname(storedFile);
    if (!ext) throw new Error(`Asset ${id} hat keine Dateiendung.`);
    const filename = `${id}${ext}`;

    let stat;
    const filePath = path.join(store.sessionAssetDir(sessionId), storedFile);
    try {
      stat = await fsp.stat(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error(`Asset ${id} konnte nicht gelesen werden: Datei fehlt.`);
      throw new Error(`Asset ${id} konnte nicht gelesen werden: ${err.message}`);
    }
    if (!stat.isFile()) throw new Error(`Asset ${id} konnte nicht gelesen werden: keine Datei.`);
    totalBytes += stat.size;
    if (totalBytes > MAX_RENDER_ASSET_BYTES) {
      throw new Error('Die Render-Assets sind zusammen groesser als 500 MB.');
    }
    files.push({ filename, path: filePath, size: stat.size });
  }
  return { files, totalBytes };
}

function validateConcatArgs(args) {
  if (!Array.isArray(args?.asset_ids)) throw new Error('asset_ids muss ein Array sein');
  if (args.asset_ids.length < 2 || args.asset_ids.length > MAX_CONCAT_ASSETS) {
    throw new Error(`asset_ids muss 2 bis ${MAX_CONCAT_ASSETS} Video-Assets enthalten`);
  }
  return args.asset_ids.map((rawId) => {
    if (typeof rawId !== 'string' || !rawId.trim()) {
      throw new Error('asset_ids darf nur nicht-leere Session-Asset-IDs enthalten');
    }
    const id = rawId.trim();
    if (!store.isValidId(id)) throw new Error(`Ungueltige Asset-ID: ${id}`);
    return id;
  });
}

async function concatVideoSources(sessionId, ids) {
  const ledger = await store.readLedger(sessionId);
  const directory = store.sessionAssetDir(sessionId);
  const sources = [];
  for (const id of ids) {
    const entry = ledger.find((item) => item.id === id);
    if (!entry) throw new Error(`Asset ${id} existiert nicht in dieser Session.`);
    if (entry.pending) throw new Error(`Asset ${id} ist noch nicht fertig.`);
    if (entry.kind !== 'video') throw new Error(`Asset ${id} ist kein Video-Asset.`);
    const storedFile = String(entry.file || '');
    if (!storedFile || path.basename(storedFile) !== storedFile || !/^[A-Za-z0-9._-]+$/.test(storedFile)) {
      throw new Error(`Asset ${id} hat einen ungueltigen Dateinamen.`);
    }
    const file = path.join(directory, storedFile);
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) throw new Error('keine Datei');
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error(`Asset ${id} konnte nicht gelesen werden: Datei fehlt.`);
      throw new Error(`Asset ${id} konnte nicht gelesen werden: ${err.message}`);
    }
    sources.push(file);
  }
  return sources;
}

async function runConcatVideos(ctx, args) {
  const ids = validateConcatArgs(args);
  const label = String(args.label || '').trim() || 'Finaler Zusammenschnitt';
  const binaries = ffmpeg.binaries();
  if (!binaries.available) throw new Error('concat_videos ist nicht verfuegbar, weil ffmpeg oder ffprobe fehlt.');
  const sources = await concatVideoSources(ctx.sessionId, ids);
  const startedAt = Date.now();
  const deadline = startedAt + ffmpeg.PROCESS_TIMEOUT_MS;
  const remaining = () => Math.max(1, deadline - Date.now());

  ctx.emit({
    type: 'tool_start',
    tool: 'concat_videos',
    label: `Fuege Videos zusammen: ${shorten(label, 90)}`
  });

  const scratch = await fsp.mkdtemp(path.join(store.sessionAssetDir(ctx.sessionId), '.concat-'));
  let outputFile = path.join(scratch, 'output.mp4');
  const listFile = path.join(scratch, 'inputs.txt');
  let reserved = null;
  try {
    const probes = [];
    for (const source of sources) {
      probes.push(await ffmpeg.probeVideo(source, {
        ffprobePath: binaries.ffprobe,
        timeoutMs: Math.min(30000, remaining())
      }));
    }
    // Clips that all have an alpha channel are joined into a WebM that keeps it (VP9 with alpha), when this ffmpeg can read and write it;
    // anything else is joined as before (MP4, and alpha clips among others lose theirs).
    const allAlpha = probes.every((probe) => probe.video && probe.video.alpha === true);
    const alphaJoin =
      allAlpha &&
      ffmpeg.alphaVideoAvailable({ ffmpegPath: binaries.ffmpeg }) &&
      !probes.some((probe) => ffmpeg.alphaDecoderOptions(probe.video, { ffmpegPath: binaries.ffmpeg }).lost);
    if (alphaJoin) outputFile = path.join(scratch, 'output.webm');
    let strategy = alphaJoin ? 'alpha' : ffmpeg.concatStrategy(probes);
    try {
      await ffmpeg.concatVideos({
        files: sources,
        probes,
        outputFile,
        listFile,
        strategy,
        ffmpegPath: binaries.ffmpeg,
        timeoutMs: remaining()
      });
    } catch (err) {
      if (strategy !== 'copy' || Date.now() >= deadline) throw err;
      strategy = 'reencode';
      await fsp.rm(outputFile, { force: true });
      await ffmpeg.concatVideos({
        files: sources,
        probes,
        outputFile,
        listFile,
        strategy,
        ffmpegPath: binaries.ffmpeg,
        timeoutMs: remaining()
      });
    }
    const finalProbe = await ffmpeg.probeVideo(outputFile, {
      ffprobePath: binaries.ffprobe,
      timeoutMs: Math.min(30000, remaining())
    });
    reserved = await store.reserveAsset(ctx.sessionId, {
      kind: 'video',
      ext: alphaJoin ? '.webm' : '.mp4',
      prompt: label
    });
    const asset = await store.completeAssetFile(ctx.sessionId, reserved.id, outputFile, {
      cost: 0,
      duration: finalProbe.duration,
      ...(alphaJoin ? { extra: { alpha: Boolean(finalProbe.video?.alpha) } } : {})
    });
    await recordToolCost({
      ts: new Date().toISOString(),
      sessionId: ctx.sessionId,
      assetId: asset.id,
      type: 'video',
      model: 'ffmpeg',
      cost: 0,
      user: ctx.user || 'lokal',
      billing: 'local'
    });
    return {
      toolResult:
        `Videos als ${asset.id} zusammengefuegt (${strategy === 'copy' ? 'verlustfrei' : strategy === 'alpha' ? 'neu kodiert, mit Transparenz' : 'neu kodiert'}, ` +
        `${finalProbe.duration ? `${finalProbe.duration.toFixed(1)} s` : 'Dauer unbekannt'}).`,
      inject: [],
      asset: { id: asset.id, url: asset.url, kind: 'video', prompt: asset.prompt, cost: 0 },
      // every clip had alpha but this ffmpeg could not keep it (no libvpx-vp9 / libopus, or no libvpx decoder): the node view logs it
      ...(allAlpha && !alphaJoin ? { alphaLost: true } : {})
    };
  } catch (err) {
    if (reserved) await removeReservedAsset(ctx.sessionId, reserved.id);
    throw err;
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
}

// German error text for a failed motionHtml.checkComposition() result (ASCII umlauts like the rest of this file).
function compositionProblemMessage(problem) {
  const { format, width, height } = problem;
  const root =
    `<div id="main-composition" data-composition-id="main" data-width="${width}" data-height="${height}" ` +
    'data-start="0" data-duration="SEKUNDEN">...</div>';
  if (problem.code === 'not_html') {
    return (
      'Kein HTML: Der uebergebene Text enthaelt kein HTML-Tag, er ist eine Anweisung oder Beschreibung und kein Code. ' +
      `Erwartet wird eine vollstaendige HTML/GSAP-Komposition mit dem Wurzel-Element ${root} ` +
      '(Format ' + format + ', ' + width + 'x' + height + '). ' +
      'Videos aneinanderzuhaengen geht mit concat_videos (Node "Videos aneinanderhaengen"); ' +
      'fuer eine Animation aus einer Beschreibung zuerst den HTML-Code schreiben lassen (Node "Motion-HTML-Autor") und diesen Code hier uebergeben.'
    );
  }
  return (
    `Die Composition-Masse (data-width/data-height) muessen zum Format ${format} passen: ` +
    `${width}x${height}. Gefunden: ${problem.foundWidth || '?'}x${problem.foundHeight || '?'}. ` +
    `Das Wurzel-Element braucht data-width="${width}" und data-height="${height}", zum Beispiel ${root}. ` +
    'Bitte HTML anpassen (body/html-CSS und data-Attribute) und erneut rendern.'
  );
}

async function runRenderMotionGraphics(ctx, args) {
  const html = String(args.html || '');
  const label = String(args.label || '').trim();
  const quality = args.quality === undefined || args.quality === null || args.quality === ''
    ? 'standard'
    : String(args.quality);
  const format = args.format === undefined || args.format === null || args.format === ''
    ? 'landscape'
    : String(args.format);
  // The frame rate is not offered to the model (the tool definition does not list it); the nodes that draw a fixed rate (the HUD of the music
  // video, 24 fps) pass it. Left out, the render goes out as it always did.
  const fps = args.fps === undefined || args.fps === null || args.fps === '' ? undefined : Number(args.fps);
  if (!html.trim()) throw new Error('html fehlt');
  if (!label) throw new Error('label fehlt');
  if (!['draft', 'standard', 'high'].includes(quality)) {
    throw new Error('quality muss draft, standard oder high sein');
  }
  if (!Object.prototype.hasOwnProperty.call(RENDER_FORMATS, format)) {
    throw new Error('format muss landscape, portrait oder square sein');
  }
  if (fps !== undefined && !(Number.isInteger(fps) && fps >= 1 && fps <= 60)) {
    throw new Error('fps muss eine ganze Zahl von 1 bis 60 sein');
  }
  const problem = motionHtml.checkComposition(html, format);
  if (problem) throw new Error(compositionProblemMessage(problem));
  const assets = await renderAssetsFromIds(ctx.sessionId, args.asset_ids);

  ctx.emit({
    type: 'tool_start',
    tool: 'render_motion_graphics',
    label: `Rendere Motion Graphics: ${shorten(label, 90)}`
  });

  const asset = await store.reserveAsset(ctx.sessionId, {
    kind: 'video',
    ext: '.mp4',
    prompt: label,
    model: 'hyperframes/rendernode'
  });

  let submission;
  try {
    // The owner (the person of the chat or workflow) decides whether the job may go to an own computer (WP46, lib/render-queue.js);
    // without a frame rate the fifth argument stays undefined and the render node uses its own default, as before.
    // `renderGroup` (node view, WP54): the chunks of one node run are one film in the queue, for the place shown to the person.
    const signal = ctx.signal && ctx.runSignal ? AbortSignal.any([ctx.signal, ctx.runSignal]) : ctx.signal || ctx.runSignal;
    submission = await rendernode.submit(html, quality, assets, format, fps, { owner: ctx.user || 'lokal', label, ...(signal ? { signal } : {}), ...(ctx.renderGroup ? { group: ctx.renderGroup } : {}) });
  } catch (err) {
    await removeReservedAsset(ctx.sessionId, asset.id);
    throw err;
  }
  const { jobId, nodeId } = submission;
  const nodeName = rendernode.listConfiguredNodes().find((node) => node.id === nodeId)?.name || null;

  const submittedAt = new Date().toISOString();
  const job = {
    jobId,
    assetId: asset.id,
    file: asset.file,
    status: 'pending',
    prompt: label,
    mode: 'motion_graphics',
    source: 'rendernode',
    renderNodeId: nodeId,
    nodeName,
    model: 'hyperframes/rendernode',
    user: ctx.user || 'lokal',
    quality,
    format,
    ...(fps === undefined ? {} : { fps }),
    submittedAt,
    createdAt: submittedAt,
    startedAt: null,
    pollingUrl: null,
    cost: null,
    error: null
  };
  await store.mutateSession(ctx.sessionId, (session) => {
    session.jobs.push(job);
  });

  await recordToolCost({
    ts: job.submittedAt,
    sessionId: ctx.sessionId,
    assetId: asset.id,
    type: 'motion',
    model: job.model,
    cost: 0,
    user: job.user
  });

  ctx.emit({
    type: 'video_job',
    jobId,
    assetId: asset.id,
    prompt: label,
    status: job.status,
    source: job.source,
    provider: 'rendernode',
    kind: 'video',
    ...jobMetaFields(job),
    renderNodeId: nodeId,
    nodeId,
    nodeName,
    createdAt: submittedAt,
    startedAt: null
  });

  return {
    toolResult: `Motion-Graphics-Job ${asset.id} gestartet (Job-ID ${jobId}, Qualitaet ${quality}). Das Ergebnis folgt asynchron, typischerweise in wenigen Sekunden. Sag dem User kurz, was gerade gerendert wird.`,
    inject: [],
    job
  };
}

module.exports = {
  runRenderMotionGraphics,
  runConcatVideos,
  renderAssetsFromIds,
  validateConcatArgs
};
