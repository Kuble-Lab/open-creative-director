'use strict';

// Video generation, editing and fal queue tools, moved from lib/tools.js.

const videoModels = require('../video-models');
const discovery = require('../discovery');
const store = require('../store');
const publicrefs = require('../publicrefs');
const resultMeta = require('../result-meta');
const or = require('../openrouter');
const videoRefusal = require('../video-refusal');
const alephEdit = require('../nodes/aleph-edit');
const fluxEdit = require('../nodes/flux-video-edit');
const path = require('path');
const fal = require('../fal');
const fluxMax = require('../flux3-max');
const fsp = require('fs/promises');
const {
  referenceIdArray,
  requireRasterAsset,
  referencesFromAssetIds,
  validateMediaReferenceAssets,
  removePublishedRefs,
  shorten,
  removeReservedAsset,
  budgetFieldsOf,
  jobMetaFields,
  FAL_KINDS,
  FAL_MAX_INPUT_BYTES,
  FAL_MAX_MEDIA_FILES,
  FAL_UPLOAD_MIME,
  FAL_JOB_TIMEOUT_MS
} = require('./shared');

async function buildVideoPayload(ctx, args, options = {}) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt fehlt');
  const refIds = referenceIdArray(args, 'reference_asset_ids', 30);
  const videoRefIds = referenceIdArray(args, 'reference_video_asset_ids', 10);
  const audioRefIds = referenceIdArray(args, 'reference_audio_asset_ids', 10);
  const firstFrameAssetId = String(args.first_frame_asset_id || '').trim();
  // An end frame is only offered by the node view (video.generate, for the models that take one); the chat has no such argument.
  const lastFrameAssetId = ctx.nodeView === true ? String(args.last_frame_asset_id || '').trim() : '';
  if (lastFrameAssetId && !firstFrameAssetId) throw new Error('last_frame_asset_id braucht first_frame_asset_id');
  const mode = args.mode === 'image_to_video' || firstFrameAssetId ? 'image_to_video' : 'text_to_video';
  const referenceLimits = videoModels.referenceLimits(ctx.config.videoModel);
  // Off for the node view and for the old way without the picker (ctx.skipVideoModelLimits), which keep their own limits.
  if (referenceLimits && !options.skipModelLimits && ctx.skipVideoModelLimits !== true && ctx.nodeView !== true) {
    // The model picker only offers models that take the references of the job; this is the same rule for a direct call.
    const modelName = ctx.config.videoModel;
    if (refIds.length > referenceLimits.images) {
      throw new Error(`${modelName} nimmt hoechstens ${referenceLimits.images} Referenzbilder (angegeben: ${refIds.length}).`);
    }
    if (videoRefIds.length > referenceLimits.videos) {
      throw new Error(`${modelName} nimmt hoechstens ${referenceLimits.videos} Video-Referenzen (angegeben: ${videoRefIds.length}).`);
    }
    if (audioRefIds.length > referenceLimits.audios) {
      throw new Error(`${modelName} nimmt hoechstens ${referenceLimits.audios} Audio-Referenzen (angegeben: ${audioRefIds.length}).`);
    }
  }
  const capabilities = options.capabilities || await discovery.videoCapabilities(ctx.config.videoModel);
  const corrections = [];
  const supportedResolutions = Array.isArray(capabilities.resolutions) ? capabilities.resolutions : [];
  const fallbackResolution = supportedResolutions.includes('720p')
    ? '720p'
    : [...supportedResolutions].sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10))[0] || '720p';
  const requestedResolution = typeof args.resolution === 'string' && args.resolution.trim()
    ? args.resolution.trim()
    : fallbackResolution;
  const resolution = supportedResolutions.includes(requestedResolution)
    ? requestedResolution
    : fallbackResolution;
  if (resolution !== requestedResolution) {
    corrections.push(`resolution ${requestedResolution} nicht unterstützt, auf ${resolution} korrigiert.`);
  }

  const payload = {
    model: ctx.config.videoModel,
    prompt,
    resolution
  };
  if (args.duration_seconds !== undefined && args.duration_seconds !== null) {
    const requestedDuration = Number(args.duration_seconds);
    if (Number.isFinite(requestedDuration)) {
      const roundedDuration = Math.round(requestedDuration);
      const minDuration = Number.isFinite(capabilities.durations?.min) ? capabilities.durations.min : 4;
      const maxDuration = Number.isFinite(capabilities.durations?.max) ? capabilities.durations.max : 30;
      const duration = Math.min(
        maxDuration,
        Math.max(minDuration, roundedDuration)
      );
      payload.duration = duration;
      if (duration !== requestedDuration) {
        corrections.push(`duration_seconds ${requestedDuration} auf ${duration} korrigiert.`);
      }
    }
  }

  const requestedAspectRatio = typeof args.aspect_ratio === 'string' ? args.aspect_ratio.trim() : '';
  if (mode === 'image_to_video') {
    if (!firstFrameAssetId) throw new Error('first_frame_asset_id fehlt fuer mode=image_to_video');
    if (requestedAspectRatio) {
      corrections.push('aspect_ratio bei Image-to-Video entfernt, da das Startbild das Format definiert.');
    }
  } else if (requestedAspectRatio) {
    if (Array.isArray(capabilities.aspectRatios) && capabilities.aspectRatios.includes(requestedAspectRatio)) {
      payload.aspect_ratio = requestedAspectRatio;
    } else {
      corrections.push(`aspect_ratio ${requestedAspectRatio} nicht unterstützt und weggelassen.`);
    }
  }

  if (mode === 'image_to_video') {
    await requireRasterAsset(ctx.sessionId, firstFrameAssetId);
    // A model that takes only some formats (Runway Gen-4.5: 16:9 or 9:16) would crop another start image. Refused here, before
    // the file is read for the request and before anything is paid; the card of the chat has left such a model out already.
    const frameSize = await videoModels.firstFrameSize(ctx.sessionId, firstFrameAssetId);
    const frameProblem = videoModels.frameRatioProblem(ctx.config.videoModel, frameSize, { requireSize: true });
    if (frameProblem) throw videoModels.frameRatioRefusal({ name: videoModels.profileName(ctx.config.videoModel) || ctx.config.videoModel }, frameProblem);
    // ... and such a model is told the format of the start image. Without aspect_ratio OpenRouter takes 16:9 for Gen-4.5, and a 9:16
    // start image comes back cropped to 16:9 (live test 2026-10-04: sent 720 x 1280, got 1280 x 720, 0.60 USD paid). The other models
    // keep the format of their start image on their own, so they get none.
    const frameRatio = videoModels.frameRatioFor(ctx.config.videoModel, frameSize);
    if (frameRatio) payload.aspect_ratio = frameRatio;
    const url = await store.assetDataUrl(ctx.sessionId, firstFrameAssetId);
    payload.frame_images = [{ type: 'image_url', image_url: { url }, frame_type: 'first_frame' }];
    if (lastFrameAssetId) {
      await requireRasterAsset(ctx.sessionId, lastFrameAssetId);
      const lastUrl = await store.assetDataUrl(ctx.sessionId, lastFrameAssetId);
      payload.frame_images.push({ type: 'image_url', image_url: { url: lastUrl }, frame_type: 'last_frame' });
    }
  }
  if (refIds.length > 0) {
    payload.input_references = await referencesFromAssetIds(ctx.sessionId, refIds);
  }

  const publishedRefs = [];
  try {
    if (videoRefIds.length || audioRefIds.length) {
      if (!String(process.env.PUBLIC_BASE_URL || '').trim()) {
        throw new Error('Audio-/Video-Referenzen brauchen PUBLIC_BASE_URL (Produktion). Bilder-Referenzen funktionieren weiterhin.');
      }
      await validateMediaReferenceAssets(
        ctx.sessionId,
        videoRefIds,
        new Set(['.mp4', '.webm']),
        'Video-Referenz (erlaubt: MP4 oder WebM)'
      );
      await validateMediaReferenceAssets(
        ctx.sessionId,
        audioRefIds,
        new Set(['.mp3', '.wav', '.m4a', '.aac']),
        'Audio-Referenz (erlaubt: MP3, WAV, M4A oder AAC)'
      );
    }
    const references = payload.input_references ? payload.input_references.slice() : [];
    for (const id of videoRefIds) {
      const published = await publicrefs.publishAsset(ctx.sessionId, id);
      publishedRefs.push(published.file);
      references.push({ type: 'video_url', video_url: { url: published.url } });
    }
    for (const id of audioRefIds) {
      const published = await publicrefs.publishAsset(ctx.sessionId, id);
      publishedRefs.push(published.file);
      references.push({ type: 'audio_url', audio_url: { url: published.url } });
    }
    if (references.length) payload.input_references = references;
    return { payload, prompt, mode, corrections, publishedRefs };
  } catch (err) {
    await removePublishedRefs(publishedRefs);
    throw err;
  }
}

// What can be checked without a model and without publishing anything: a card must not open for a job that could never
// start (a missing first frame, an asset that is not there, references the server cannot publish).
async function precheckVideoArgs(ctx, args) {
  const refIds = referenceIdArray(args, 'reference_asset_ids', 30);
  const videoRefIds = referenceIdArray(args, 'reference_video_asset_ids', 10);
  const audioRefIds = referenceIdArray(args, 'reference_audio_asset_ids', 10);
  const firstFrameAssetId = String(args.first_frame_asset_id || '').trim();
  if ((args.mode === 'image_to_video' || firstFrameAssetId) && !firstFrameAssetId) {
    throw new Error('first_frame_asset_id fehlt fuer mode=image_to_video');
  }
  const ledger = await store.readLedger(ctx.sessionId);
  for (const id of [firstFrameAssetId, ...refIds].filter(Boolean)) {
    const entry = ledger.find((item) => item.id === id);
    if (!entry) throw new Error(`Asset ${id} existiert nicht in dieser Session.`);
    if (entry.pending) throw new Error(`Asset ${id} ist noch nicht fertig.`);
    await requireRasterAsset(ctx.sessionId, id);
  }
  if (videoRefIds.length || audioRefIds.length) {
    if (!String(process.env.PUBLIC_BASE_URL || '').trim()) {
      throw new Error('Audio-/Video-Referenzen brauchen PUBLIC_BASE_URL (Produktion). Bilder-Referenzen funktionieren weiterhin.');
    }
    await validateMediaReferenceAssets(ctx.sessionId, videoRefIds, new Set(['.mp4', '.webm']), 'Video-Referenz (erlaubt: MP4 oder WebM)');
    await validateMediaReferenceAssets(ctx.sessionId, audioRefIds, new Set(['.mp3', '.wav', '.m4a', '.aac']), 'Audio-Referenz (erlaubt: MP3, WAV, M4A oder AAC)');
  }
}

// What the job remembers of the choice that started it: the readable name of the model and the estimate the card showed
// (the upper end is what the budget reserves), so the running job can say "about $0.84".
function videoEstimateFields(option) {
  const fields = {};
  if (option.name) fields.modelName = resultMeta.stripProvider(option.name);
  if (Number.isFinite(option.estimateUsd) && option.estimateUsd >= 0) fields.estimateUsd = option.estimateUsd;
  const min = option.price && option.price.minTotal;
  if (Number.isFinite(min) && min >= 0 && Number.isFinite(option.estimateUsd) && min < option.estimateUsd) fields.estimateMinUsd = min;
  return fields;
}

function formatUsdRange(price) {
  if (!price) return null;
  const money = (value) => `$${value < 0.1 ? value.toFixed(3) : value.toFixed(2)}`;
  return Math.abs(price.maxTotal - price.minTotal) > 0.005 ? `${money(price.minTotal)}-${money(price.maxTotal)}` : money(price.minTotal);
}

// The chat asks for the model first (lib/video-models.js): this stores the request, shows the card and ends the turn.
// The job starts later from the click (server.js), which calls this tool again with ctx.selectedVideoModel.
async function openVideoModelChoice(ctx, args, prompt) {
  const plan = ctx.videoPlan;
  const request = await videoModels.createRequest({ sessionId: ctx.sessionId, args, plan, user: ctx.user });
  if (ctx.videoChoiceError) {
    const fields = { lastError: ctx.videoChoiceError.messageDe || ctx.videoChoiceError.message, lastErrorCode: ctx.videoChoiceError.code };
    Object.assign(request, fields);
    await store.mutateSession(ctx.sessionId, (session) => Object.assign(session.videoModelRequests.find((r) => r.id === request.id), fields));
  }
  const choice = videoModels.publicChoice(request, plan.budgetStatus || null);
  ctx.emit({ type: 'video_model_choice', choice });
  const names = request.options.map((option) => option.name).join(', ');
  return {
    toolResult:
      `Video-Modellwahl ${request.id} wartet auf den User (Modelle: ${names}). Es wurde noch nichts gestartet und nichts berechnet. ` +
      'Der User waehlt in der Oberflaeche ein Modell; erst sein Klick startet die kostenpflichtige Erzeugung. ' +
      (request.refusedProviders && request.refusedProviders.length
        ? `Die Modelle von ${request.refusedProviders.join(', ')} sind gesperrt, weil dieser Anbieter das Bild abgelehnt hat (echte Person moeglich). `
        : '') +
      'Rufe generate_video nicht erneut auf, solange die Auswahl wartet, und frage nicht zusaetzlich im Text nach dem Modell.',
    inject: [{
      role: 'assistant',
      hidden: true,
      videoModelRequestId: request.id,
      content: `[System] Warte auf die Video-Modellwahl ${request.id} durch den User. Prompt: ${shorten(prompt, 120)}`
    }],
    videoModelChoiceId: request.id,
    halt: true
  };
}

async function runGenerateVideo(ctx, args) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt fehlt');
  if (ctx.videoPlan && ctx.videoPlan.kind === 'card' && !ctx.selectedVideoModel) {
    await precheckVideoArgs(ctx, args);
    return openVideoModelChoice(ctx, args, prompt);
  }
  ctx.emit({ type: 'tool_start', tool: 'generate_video', label: `Starte Video: ${shorten(prompt, 90)}` });

  if (ctx.config.videoModel === fluxMax.MODEL) return runGenerateFluxMax(ctx, args);

  const built = await buildVideoPayload(ctx, args);
  const { payload, mode, corrections, publishedRefs } = built;

  let asset;
  try {
    asset = await store.reserveAsset(ctx.sessionId, {
      kind: 'video',
      ext: '.mp4',
      prompt,
      model: ctx.config.videoModel,
      modelName: ctx.videoOption ? ctx.videoOption.name : undefined
    });
  } catch (err) {
    await removePublishedRefs(publishedRefs);
    throw err;
  }
  let submitted;
  try {
    submitted = await or.createVideo(payload);
  } catch (err) {
    await removePublishedRefs(publishedRefs);
    await store.withLock(ctx.sessionId, async () => {
      const entries = await store.readLedger(ctx.sessionId);
      await store.writeLedger(
        ctx.sessionId,
        entries.filter((e) => e.id !== asset.id)
      );
    });
    // A refused image (real person): one stable error with readable texts instead of the raw provider answer. The
    // refusal came at the start, so no job exists and the budget reservation is released by executeTool.
    const refusal = videoRefusal.refusalOf(err, { model: payload.model });
    if (!refusal) throw err;
    // A model remembered for the chat started without the card: remember the refusal for these images, so that the next
    // call opens the card with the provider marked instead of starting the same model again.
    if (ctx.videoPlan && ctx.videoPlan.kind === 'direct' && !ctx.selectedVideoModel) {
      await videoModels.rememberImageRefusal({ sessionId: ctx.sessionId, args, provider: refusal.provider }).catch(() => {});
    }
    throw refusal;
  }

  const jobId = submitted?.id;
  if (!jobId) {
    await removePublishedRefs(publishedRefs);
    await removeReservedAsset(ctx.sessionId, asset.id);
    throw new Error('Video-API lieferte keine Job-ID.');
  }

  const submittedAt = new Date().toISOString();
  const job = {
    jobId,
    assetId: asset.id,
    file: asset.file,
    status: submitted.status || 'pending',
    prompt,
    mode,
    model: ctx.config.videoModel,
    ...(ctx.videoOption ? videoEstimateFields(ctx.videoOption) : {}),
    user: ctx.user || 'lokal',
    submittedAt,
    createdAt: submittedAt,
    startedAt: ['running', 'in_progress', 'processing'].includes(String(submitted.status || '').toLowerCase())
      ? submittedAt
      : null,
    pollingUrl: submitted.polling_url || null,
    cost: null,
    error: null,
    publicRefFiles: publishedRefs,
    ...(ctx.videoModelRequestId ? { videoModelRequestId: ctx.videoModelRequestId } : {}),
    ...budgetFieldsOf(ctx)
  };
  await store.mutateSession(ctx.sessionId, (session) => {
    session.jobs.push(job);
  });

  ctx.emit({
    type: 'video_job',
    jobId,
    assetId: asset.id,
    prompt,
    status: job.status,
    source: null,
    provider: null,
    kind: 'video',
    model: job.model,
    ...jobMetaFields(job),
    createdAt: submittedAt,
    startedAt: job.startedAt
  });

  const plan = ctx.videoPlan;
  const estimate = plan && plan.kind === 'direct' ? formatUsdRange(plan.option.price) : null;
  const remembered = plan && plan.kind === 'direct'
    ? ` Der User hat fuer diesen Chat ${plan.option.name} (${job.model}) gewaehlt; es wurde ohne Rueckfrage damit gestartet. ` +
      `Nenne dem User Modell und geschaetzten Preis${estimate ? ` (${estimate} fuer ${plan.option.durationSeconds} s)` : ' (Preis unbekannt)'}.`
    : '';
  return {
    toolResult: `Video-Job ${asset.id} gestartet (Job-ID ${jobId}, Modus ${mode}, Modell ${job.model}). Ergebnis folgt asynchron in einigen Minuten. Sag dem User kurz, was gerade generiert wird.${remembered}${corrections.length ? ` Hinweis: ${corrections.join(' ')}` : ''}`,
    inject: [],
    job,
    corrections
  };
}

// Chat adapter: the same validated plan and uploader as the nodes, with the chat's stricter image format rule.
async function runGenerateFluxMax(ctx, args) {
  if (args.last_frame_asset_id || args.reference_asset_ids?.length || args.reference_video_asset_ids?.length || args.reference_audio_asset_ids?.length) {
    throw new Error('FLUX.3 Max (fal): the chat takes a start image only, no end image or reference files');
  }
  const first = String(args.first_frame_asset_id || '').trim();
  if (args.mode === 'image_to_video' && !first) throw new Error('first_frame_asset_id fehlt');
  let ratio = args.aspect_ratio || 'auto';
  if (first) {
    await requireRasterAsset(ctx.sessionId, first);
    const size = await videoModels.firstFrameSize(ctx.sessionId, first);
    const problem = videoModels.frameRatioProblem(fluxMax.MODEL, size, { requireSize: true });
    if (problem) throw videoModels.frameRatioRefusal({ name: fluxMax.NAME }, problem);
    ratio = videoModels.frameRatioFor(fluxMax.MODEL, size);
  }
  const plan = fluxMax.plan({ prompt: args.prompt, params: { duration: args.duration_seconds ?? 5,
    resolution: args.resolution ?? '720p', aspect_ratio: ratio }, first: first ? '@@flux_max_first@@' : null });
  try {
    const outcome = await runFalGenerate({ ...ctx, fluxMaxArgs: args }, { ...plan, kind: 'video',
      media: first ? [{ placeholder: '@@flux_max_first@@', assetIds: [first] }] : [] });
    outcome.toolResult += ` Modell ${fluxMax.NAME}, geschätzte Kosten ${formatUsdRange(ctx.videoOption?.price) || `$${plan.estimateUsd.toFixed(3)}`}.`;
    return outcome;
  } catch (error) {
    if (error.code !== 'FAL_CONTENT_CHECKER' || ctx.videoPlan?.kind !== 'direct') throw error;
    const listed = await videoModels.listOptions(args, fluxMax.MODEL, { sessionId: ctx.sessionId });
    return openVideoModelChoice({ ...ctx, videoPlan: { ...listed, budgetStatus: ctx.videoPlan.budgetStatus }, videoChoiceError: error }, args, plan.prompt);
  }
}

// Node view only (WP41). Edits an EXISTING video with a model of OpenRouter that takes the video as an input (Runway Aleph 2.0,
// lib/nodes/aleph-edit.js, and FLUX Video Edit, lib/nodes/flux-video-edit.js; each file holds everything that is assumed about its
// model): publishes the video under an address of this server, starts the job and registers it in the session. The poller
// (lib/poller.js) fetches the result and books usage.cost.
//   args.model          the model; only a model of VIDEO_EDIT_MODELS
//   args.prompt         the instruction
//   args.video_asset_id OR args.video_file   a finished video of the session, or a file a node cut itself in a scratch folder of it
//   args.estimateUsd    what the node expects the run to cost (the budget reserves it; the job shows it as "about")
// The job carries ctx.partKey where the node makes a long video in parts (the next run finds the finished parts by it), and ctx.partRedo
// where the part was made again on request (the numbers of the field; a later run with the same numbers does not make it a second time).
// model id -> the file that knows the model (its request, its name)
const VIDEO_EDIT_MODELS = new Map([[alephEdit.MODEL, alephEdit], [fluxEdit.MODEL, fluxEdit]]);

async function runEditVideoOpenRouter(ctx, args) {
  const model = String(args.model || '').trim();
  const spec = VIDEO_EDIT_MODELS.get(model);
  if (!spec) throw new Error(`Modell ${shorten(model || '(leer)', 60)} ist kein Videobearbeitungsmodell dieser App.`);
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt fehlt');
  const assetId = String(args.video_asset_id || '').trim();
  const videoFile = String(args.video_file || '').trim();
  if (Boolean(assetId) === Boolean(videoFile)) throw new Error('Genau eines von video_asset_id oder video_file angeben.');
  let estimateUsd = null;
  if (args.estimateUsd !== undefined && args.estimateUsd !== null) {
    estimateUsd = Number(args.estimateUsd);
    if (!Number.isFinite(estimateUsd) || estimateUsd < 0 || estimateUsd > 10000) throw new Error('estimateUsd ist ungueltig');
  }
  if (ctx.signal?.aborted) throw new Error('Abgebrochen');
  if (!String(process.env.PUBLIC_BASE_URL || '').trim()) {
    throw new Error('Video-Referenzen brauchen PUBLIC_BASE_URL (Produktion).');
  }
  if (assetId) {
    await validateMediaReferenceAssets(ctx.sessionId, [assetId], new Set(['.mp4', '.webm']), 'Video-Referenz (erlaubt: MP4 oder WebM)');
  } else {
    // a file only from a scratch folder of this session (what a node cut itself), and only a video: nothing else is made public
    const scratchPrefix = require('../nodes/assets').SCRATCH_PREFIX;
    const relative = path.relative(path.resolve(store.sessionAssetDir(ctx.sessionId)), path.resolve(videoFile)).split(path.sep);
    if (relative.length !== 2 || !relative[0].startsWith(scratchPrefix) || !relative[1] || relative.includes('..')) {
      throw new Error('video_file muss in einem Arbeitsordner dieser Session liegen.');
    }
    if (!['.mp4', '.webm'].includes(path.extname(videoFile).toLowerCase())) throw new Error('video_file: erlaubt sind MP4 oder WebM.');
  }
  ctx.emit({ type: 'tool_start', tool: 'edit_video_openrouter', label: `Starte Videobearbeitung: ${shorten(prompt, 90)}` });

  const publishedRefs = [];
  let asset = null;
  let registered = false;
  try {
    const published = assetId ? await publicrefs.publishAsset(ctx.sessionId, assetId) : await publicrefs.publishFile(ctx.sessionId, videoFile);
    publishedRefs.push(published.file);
    const payload = { model, prompt, ...spec.requestExtras(), input_references: [spec.videoReference(published.url)] };
    asset = await store.reserveAsset(ctx.sessionId, {
      kind: 'video',
      ext: '.mp4',
      prompt,
      model,
      modelName: ctx.videoOption ? ctx.videoOption.name : spec.NAME
    });
    let submitted;
    try {
      submitted = await or.createVideo(payload);
    } catch (err) {
      await removeReservedAsset(ctx.sessionId, asset.id);
      asset = null;
      // a real person on the video: one stable error with readable texts instead of the raw answer
      const refusal = videoRefusal.refusalOf(err, { model });
      throw refusal || err;
    }
    const jobId = submitted?.id;
    if (!jobId) {
      await removeReservedAsset(ctx.sessionId, asset.id);
      asset = null;
      throw new Error('Video-API lieferte keine Job-ID.');
    }
    const submittedAt = new Date().toISOString();
    const job = {
      jobId,
      assetId: asset.id,
      file: asset.file,
      status: submitted.status || 'pending',
      prompt,
      mode: 'video_edit',
      model,
      modelName: spec.NAME,
      ...(estimateUsd !== null ? { estimateUsd } : {}),
      user: ctx.user || 'lokal',
      submittedAt,
      createdAt: submittedAt,
      startedAt: ['running', 'in_progress', 'processing'].includes(String(submitted.status || '').toLowerCase()) ? submittedAt : null,
      pollingUrl: submitted.polling_url || null,
      cost: null,
      error: null,
      publicRefFiles: publishedRefs,
      ...(ctx.partKey ? { partKey: String(ctx.partKey).slice(0, 100) } : {}),
      ...(ctx.partKey && ctx.partRedo ? { partRedo: String(ctx.partRedo).slice(0, 60) } : {}),
      ...budgetFieldsOf(ctx)
    };
    await store.mutateSession(ctx.sessionId, (session) => {
      session.jobs.push(job);
    });
    registered = true;
    ctx.emit({
      type: 'video_job',
      jobId,
      assetId: asset.id,
      prompt,
      status: job.status,
      source: null,
      provider: null,
      kind: 'video',
      model,
      ...jobMetaFields(job),
      createdAt: submittedAt,
      startedAt: job.startedAt
    });
    return {
      toolResult: `Video-Bearbeitung ${asset.id} gestartet (Job-ID ${jobId}, Modell ${model}). Das Ergebnis folgt asynchron.`,
      inject: [],
      job,
      corrections: []
    };
  } catch (err) {
    // the published copy is of no use once the job did not start; after the job exists the poller removes it
    if (!registered) await removePublishedRefs(publishedRefs);
    throw err;
  }
}

// Strings of a JSON value that equal the placeholder (any depth).
function countFalPlaceholder(node, placeholder) {
  if (typeof node === 'string') return node === placeholder ? 1 : 0;
  if (Array.isArray(node)) return node.reduce((sum, item) => sum + countFalPlaceholder(item, placeholder), 0);
  if (node && typeof node === 'object') return Object.values(node).reduce((sum, item) => sum + countFalPlaceholder(item, placeholder), 0);
  return 0;
}

function replaceFalPlaceholders(node, replacements) {
  if (typeof node === 'string') return replacements.has(node) ? replacements.get(node) : node;
  if (Array.isArray(node)) return node.map((item) => replaceFalPlaceholders(item, replacements));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, replaceFalPlaceholders(value, replacements)]));
  }
  return node;
}

function falPricing(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('pricing muss ein Objekt sein');
  const perSecond = Number(raw.perSecond);
  if (!Number.isFinite(perSecond) || perSecond <= 0 || perSecond > 100) throw new Error('pricing.perSecond muss eine Zahl zwischen 0 und 100 sein');
  const pricing = { perSecond };
  if (raw.overSeconds !== undefined && raw.overSeconds !== null) {
    const overSeconds = Number(raw.overSeconds);
    const overMultiplier = Number(raw.overMultiplier);
    if (!Number.isFinite(overSeconds) || overSeconds <= 0 || !Number.isFinite(overMultiplier) || overMultiplier < 1 || overMultiplier > 10) {
      throw new Error('pricing.overSeconds und pricing.overMultiplier sind ungueltig');
    }
    pricing.overSeconds = overSeconds;
    pricing.overMultiplier = overMultiplier;
  }
  // Result field that carries the billed seconds; null = the result says nothing reliable, the estimate is used.
  if (raw.durationField === null) pricing.durationField = null;
  else if (raw.durationField === undefined) pricing.durationField = 'duration';
  else if (typeof raw.durationField === 'string' && /^[a-z][a-z_]{0,31}$/.test(raw.durationField)) pricing.durationField = raw.durationField;
  else throw new Error('pricing.durationField ist ungueltig');
  return pricing;
}

// Node view only. Uploads the referenced session assets to the fal storage, queues one job at fal.ai and registers it
// in the session; the poller (lib/poller.js) fetches the result. Nothing is uploaded or submitted unless every check
// passes. `input` is the model input without the media fields; `media` entries say which field receives which asset URLs.
async function runFalGenerate(ctx, args) {
  return require('../fal-run').run(ctx, () => submitFalGenerate(ctx, args));
}

async function submitFalGenerate(ctx, args) {
  const signal = ctx.signal;
  const throwIfAborted = () => {
    if (signal?.aborted) throw fal.abortError();
  };
  throwIfAborted();
  if (!fal.hasKey()) throw new Error(fal.MISSING_KEY_MESSAGE);
  const endpoint = String(args.endpoint || '').trim();
  if (!fal.isValidEndpointId(endpoint)) throw new Error(`Ungueltige fal.ai-Endpoint-ID: ${shorten(endpoint || '(leer)', 80)}`);
  const kind = args.kind === undefined || args.kind === null ? 'video' : String(args.kind);
  if (!FAL_KINDS.includes(kind)) throw new Error(`kind muss ${FAL_KINDS.join(', ')} sein`);
  if (!args.input || typeof args.input !== 'object' || Array.isArray(args.input)) throw new Error('input muss ein Objekt sein');
  let input;
  try {
    const text = JSON.stringify(args.input);
    if (text.length > FAL_MAX_INPUT_BYTES) throw new Error('zu gross');
    input = JSON.parse(text);
  } catch (_) {
    throw new Error('input ist kein gueltiges JSON-Objekt oder groesser als 1 MB');
  }
  let estimateUsd = null;
  if (args.estimateUsd !== undefined && args.estimateUsd !== null) {
    estimateUsd = Number(args.estimateUsd);
    if (!Number.isFinite(estimateUsd) || estimateUsd < 0 || estimateUsd > 10000) throw new Error('estimateUsd ist ungueltig');
  }
  const pricing = falPricing(args.pricing);
  const prompt = shorten(typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt : `fal.ai ${endpoint}`, 500);

  // media entries: { field, assetIds, multiple } fill a top-level field of the input; { placeholder, assetIds, multiple }
  // replaces every string of the input (at any depth) that equals the placeholder (free-form fal nodes).
  const rawMedia = args.media === undefined || args.media === null ? [] : args.media;
  if (!Array.isArray(rawMedia)) throw new Error('media muss ein Array sein');
  const names = new Set();
  const plan = [];
  let fileCount = 0;
  for (const entry of rawMedia) {
    const field = entry?.field === undefined || entry?.field === null ? '' : String(entry.field).trim();
    const placeholder = entry?.placeholder === undefined || entry?.placeholder === null ? '' : String(entry.placeholder);
    if (Boolean(field) === Boolean(placeholder)) throw new Error('media: genau eines von field oder placeholder angeben');
    if (field && !/^[a-z][a-z0-9_]{0,63}$/.test(field)) throw new Error(`Ungueltiger media-Feldname: ${shorten(field, 40)}`);
    if (placeholder && !/^@@[A-Za-z0-9_:.-]{1,60}@@$/.test(placeholder)) throw new Error(`Ungueltiger media-Platzhalter: ${shorten(placeholder, 40)}`);
    const name = field || placeholder;
    if (names.has(name) || (field && Object.prototype.hasOwnProperty.call(input, field))) throw new Error(`Das Feld ${name} ist doppelt belegt`);
    names.add(name);
    const ids = Array.isArray(entry.assetIds) ? entry.assetIds.map((id) => String(id || '').trim()) : [];
    if (!ids.length || ids.some((id) => !id)) throw new Error(`media.${name}: assetIds fehlt`);
    if (entry.multiple !== true && ids.length > 1) throw new Error(`media.${name}: nur eine Datei erlaubt (${ids.length} angegeben)`);
    fileCount += ids.length;
    plan.push({ field, placeholder, name, ids, multiple: entry.multiple === true });
  }
  if (plan.some((item) => item.placeholder) && !plan.every((item) => !item.placeholder || countFalPlaceholder(input, item.placeholder) > 0)) {
    throw new Error('Ein media-Platzhalter kommt in der Eingabe nicht vor');
  }
  if (fileCount > FAL_MAX_MEDIA_FILES) throw new Error(`Hoechstens ${FAL_MAX_MEDIA_FILES} Dateien pro fal.ai-Job (${fileCount} angegeben)`);

  // Every asset must exist in THIS session, be finished, have a known media type and fit the upload cap.
  const ledger = await store.readLedger(ctx.sessionId);
  const dir = store.sessionAssetDir(ctx.sessionId);
  const uploads = [];
  for (const item of plan) {
    for (const id of item.ids) {
      const asset = ledger.find((entry) => entry.id === id);
      if (!asset) throw new Error(`Asset ${id} existiert nicht in dieser Session.`);
      if (asset.pending) throw new Error(`Asset ${id} ist noch nicht fertig.`);
      const file = String(asset.file || '');
      const ext = path.extname(file).toLowerCase();
      if (!file || path.basename(file) !== file || !Object.prototype.hasOwnProperty.call(FAL_UPLOAD_MIME, ext)) {
        throw new Error(`Asset ${id} (${ext || 'ohne Endung'}) kann nicht zu fal.ai hochgeladen werden (erlaubt: Bild, Video oder Audio).`);
      }
      let stat;
      try {
        stat = await fsp.stat(path.join(dir, file));
      } catch (_) {
        throw new Error(`Die Datei von Asset ${id} fehlt.`);
      }
      if (stat.size > fal.MAX_UPLOAD_BYTES) {
        throw new Error(`Asset ${id} ist groesser als ${fal.MAX_UPLOAD_BYTES / (1024 * 1024)} MB und kann nicht zu fal.ai hochgeladen werden.`);
      }
      uploads.push({ name: item.name, id, file, contentType: FAL_UPLOAD_MIME[ext] });
    }
  }
  ctx.emit({ type: 'tool_start', tool: 'fal_generate', label: `Starte fal.ai ${endpoint}: ${shorten(prompt, 80)}` });

  // Uploads run one after the other; each URL lands in its field (a list for `multiple`).
  const urlsByName = new Map(plan.map((item) => [item.name, []]));
  const urlByAsset = new Map(); // an asset referenced twice is uploaded once
  for (const upload of uploads) {
    throwIfAborted();
    if (!urlByAsset.has(upload.id)) {
      const uploaded = await fal.uploadFile(path.join(dir, upload.file), { contentType: upload.contentType, fileName: upload.file, signal });
      urlByAsset.set(upload.id, uploaded.url);
    }
    urlsByName.get(upload.name).push(urlByAsset.get(upload.id));
  }
  const replacements = new Map();
  for (const item of plan) {
    const value = item.multiple ? urlsByName.get(item.name) : urlsByName.get(item.name)[0];
    if (item.field) input[item.field] = value;
    else replacements.set(item.placeholder, value);
  }
  if (replacements.size) input = replaceFalPlaceholders(input, replacements);

  // Last chance to stop before the job is queued (and billed) at fal.ai.
  throwIfAborted();
  const assetKind = kind === 'auto' ? 'video' : kind;
  const asset = await store.reserveAsset(ctx.sessionId, {
    kind: assetKind,
    ext: assetKind === 'image' ? '.png' : assetKind === 'audio' ? '.mp3' : assetKind === 'model3d' ? '.glb' : '.mp4',
    prompt,
    model: endpoint,
    ...(endpoint.startsWith(`${fluxMax.BASE}/`) ? { modelName: fluxMax.NAME } : {})
  });
  let submitted;
  try {
    throwIfAborted();
    submitted = await fal.submit(endpoint, input);
  } catch (err) {
    await removeReservedAsset(ctx.sessionId, asset.id);
    if (endpoint.startsWith(`${fluxMax.BASE}/`) && fluxMax.contentRefusal(err)) {
      err.code = 'FAL_CONTENT_CHECKER';
      err.messageDe = 'fal.ai hat den Auftrag durch den Inhaltsfilter abgelehnt. Ändere den Prompt oder das Bild oder wähle ein anderes Modell.';
    }
    throw err;
  }
  // The same request id twice would let two jobs overwrite each other: stop instead of creating a duplicate.
  const existingSession = await store.readSession(ctx.sessionId);
  const duplicate = (existingSession.jobs || []).find((entry) => entry.jobId === submitted.requestId);
  if (duplicate) {
    await removeReservedAsset(ctx.sessionId, asset.id);
    throw new Error(
      `fal.ai lieferte die bereits fuer ${duplicate.assetId} verwendete Job-ID. Der Auftrag wurde nicht angelegt - bitte erneut senden.`
    );
  }
  const submittedAt = new Date().toISOString();
  const job = {
    jobId: submitted.requestId,
    provider: 'fal',
    source: 'fal',
    kind: assetKind,
    resultKind: kind,
    assetId: asset.id,
    file: asset.file,
    status: 'pending',
    prompt,
    mode: 'fal_generate',
    model: endpoint,
    ...(endpoint.startsWith(`${fluxMax.BASE}/`) ? videoEstimateFields({ ...ctx.videoOption, name: fluxMax.NAME, estimateUsd }) : {}),
    ...(ctx.videoModelRequestId ? { videoModelRequestId: ctx.videoModelRequestId } : {}),
    ...(ctx.fluxMaxArgs && ctx.videoPlan?.kind === 'direct' ? { videoModelArgs: ctx.fluxMaxArgs } : {}),
    endpoint,
    statusUrl: submitted.statusUrl,
    responseUrl: submitted.responseUrl,
    cancelUrl: submitted.cancelUrl,
    user: ctx.user || 'lokal',
    submittedAt,
    createdAt: submittedAt,
    startedAt: null,
    timeoutAt: Date.now() + FAL_JOB_TIMEOUT_MS,
    costEstimateUsd: estimateUsd,
    pricing,
    keepResult: args.keepResult === true,
    // a node that makes a long video in parts finds the finished parts of an earlier run by this key (lib/nodes/video-edit-parts.js)
    ...(ctx.partKey ? { partKey: String(ctx.partKey).slice(0, 100) } : {}),
    ...(ctx.partKey && ctx.partRedo ? { partRedo: String(ctx.partRedo).slice(0, 60) } : {}),
    cost: null,
    costUnit: 'usd_estimate',
    error: null,
    ...budgetFieldsOf(ctx)
  };
  await store.mutateSession(ctx.sessionId, (session) => session.jobs.push(job));
  ctx.emit({
    type: 'generation_job',
    jobId: job.jobId,
    assetId: asset.id,
    prompt,
    status: job.status,
    source: 'fal',
    provider: 'fal',
    kind: assetKind,
    ...jobMetaFields(job),
    createdAt: submittedAt,
    startedAt: null
  });
  return {
    toolResult: `fal.ai-Job ${asset.id} gestartet (${endpoint}). Das Ergebnis folgt asynchron.`,
    inject: [],
    job
  };
}

module.exports = {
  runGenerateVideo,
  runFalGenerate,
  runEditVideoOpenRouter,
  buildVideoPayload
};
