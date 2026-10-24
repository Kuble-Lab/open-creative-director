'use strict';

// Higgsfield discovery, uploads and generation tools, moved from lib/tools.js.

const higgsfield = require('../higgsfield');
const fs = require('fs');
const store = require('../store');
const path = require('path');
const fsp = require('fs/promises');
const publicrefs = require('../publicrefs');
const {
  HIGGSFIELD_MODEL_TEXT_LIMIT,
  HIGGSFIELD_AUDIO_REFERENCE_ROLE,
  shorten,
  HIGGSFIELD_UPLOAD_TIMEOUT_MS,
  MAX_RENDER_ASSET_BYTES,
  removePublishedRefs,
  referenceIdArray,
  HIGGSFIELD_MAX_AUDIO_REFS,
  validateMediaReferenceAssets,
  removeReservedAsset,
  HIGGSFIELD_JOB_TIMEOUT_MS,
  HIGGSFIELD_VIDEO_JOB_TIMEOUT_MS,
  recordToolCost,
  jobMetaFields,
  budgetFieldsOf,
  HIGGSFIELD_DEFAULT_AUDIO_MODEL,
  HIGGSFIELD_SPEECH_MODELS,
  HIGGSFIELD_MAX_SPEECH_REFS,
  HIGGSFIELD_SPEECH_FORMATS,
  HIGGSFIELD_SPEECH_VARIANTS
} = require('./shared');

function requireHiggsfieldConnection() {
  if (!higgsfield.status().connected) throw new Error(higgsfield.DISCONNECTED_MESSAGE);
}

function truncateHiggsfieldText(value) {
  const text = String(value || '');
  return text.length > HIGGSFIELD_MODEL_TEXT_LIMIT
    ? `${text.slice(0, HIGGSFIELD_MODEL_TEXT_LIMIT - 14)}\n[… gekuerzt]`
    : text;
}

async function runHiggsfieldModels(_ctx, args) {
  requireHiggsfieldConnection();
  const model = String(args.model || '').trim();
  const goal = String(args.goal || '').trim();
  const payload = model
    ? { action: 'get', model_id: model }
    : goal
      ? { action: 'recommend', query: goal }
      : { action: 'list' };
  if (args.type) payload.type = String(args.type);
  return { toolResult: truncateHiggsfieldText(await higgsfield.mcpCall('models_explore', payload, { retry: 'safe' })), inject: [] };
}

// Parses JSON that may be followed by extra prose (models_explore appends e.g. "Unlim configs" text).
function parseJsonLoose(text) {
  const raw = String(text || '');
  try {
    return JSON.parse(raw);
  } catch (_) {
    /* fall through to the balanced-prefix scan */
  }
  const start = raw.search(/[{[]/);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

function parseModelDetails(text, modelId) {
  const parsed = parseJsonLoose(text);
  if (!parsed) return null;
  const items = Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed) ? parsed : [parsed];
  return items.find((item) => item?.id === modelId) || items[0] || null;
}

// Roles containing "audio" belong to audio slots (see audioRoleFromModel); image references never use them.
function referenceRoleFromModel(model, outputKind) {
  const medias = Array.isArray(model?.medias) ? model.medias : [];
  const roles = medias
    .filter((media) => !media?.type || media.type === 'image')
    .flatMap((media) => Array.isArray(media?.roles) ? media.roles : [])
    .filter((role) => typeof role === 'string' && role.trim() && !/audio/i.test(role));
  const preferred = outputKind === 'video'
    ? ['start_image', 'first_frame', 'image', 'reference_image']
    : ['image', 'reference_image', 'input_image', 'subject'];
  return preferred.find((role) => roles.includes(role)) || roles[0] || 'image';
}

// Audio slot of a model: the first media role containing "audio" (a speech reference or a lip-sync track) and, when a
// slot with only audio roles states it, how many tracks it takes. The roles decide, not the slot type: models_explore
// types every slot as "image", also the one that takes audio_references next to image_references. null = the model
// declares no audio input.
function audioSlotFromModel(model) {
  const medias = Array.isArray(model?.medias) ? model.medias : [];
  for (const media of medias) {
    const roles = (Array.isArray(media?.roles) ? media.roles : []).filter((role) => typeof role === 'string' && role.trim());
    const role = roles.find((item) => /audio/i.test(item));
    if (!role) continue;
    const audioOnly = roles.every((item) => /audio/i.test(item));
    return { role, max: audioOnly && Number.isFinite(media.max) && media.max > 0 ? Math.floor(media.max) : null };
  }
  return null;
}

function audioRoleFromModel(model) {
  return audioSlotFromModel(model)?.role || null;
}

// The model record of a models_explore get answer, or null when the answer is not a model (error text, no id).
async function readHiggsfieldModel(modelId) {
  try {
    const details = parseModelDetails(await higgsfield.mcpCall('models_explore', { action: 'get', model_id: modelId }, { retry: 'safe' }), modelId);
    return details && typeof details.id === 'string' ? details : null;
  } catch (_) {
    return null;
  }
}

// The audio slot to use for a model. A readable model decides (no audio role: null, nothing may be submitted); a model
// that cannot be read at all gets the documented role.
function audioSlotFor(details) {
  return details ? audioSlotFromModel(details) : { role: HIGGSFIELD_AUDIO_REFERENCE_ROLE, max: null };
}

// Media type and MIME type per file extension for the media_upload path.
const HIGGSFIELD_UPLOAD_TYPES = Object.freeze({
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.mp3': { kind: 'audio', mime: 'audio/mpeg' },
  '.wav': { kind: 'audio', mime: 'audio/wav' },
  '.m4a': { kind: 'audio', mime: 'audio/mp4' },
  '.aac': { kind: 'audio', mime: 'audio/aac' }
});

const HIGGSFIELD_AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac']);

// Signed upload URLs are credentials: they must never end up in an error message or a log line.
function redactUrls(text) {
  return String(text || '').replace(/https?:\/\/[^\s"'<>\\)\]]+/gi, '[URL]');
}

// Finds the first object carrying an upload_url in a parsed media_upload answer ({ uploads: [{ ... }] } or similar).
function findUploadRecord(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  if (!Array.isArray(value) && (typeof value.upload_url === 'string' || typeof value.uploadUrl === 'string')) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findUploadRecord(child, depth + 1);
    if (found) return found;
  }
  return null;
}

// Extracts { uploadUrl, mediaId, contentType } from the text of media_upload. The answer format has NOT been
// verified against the live API, so this accepts JSON, JSON embedded in prose, and finally plain text
// ("upload_url: https://...", a curl command with PUT, or a PUT line).
function parseHiggsfieldUpload(text) {
  const raw = String(text || '');
  const record = findUploadRecord(parseJsonLoose(raw));
  let uploadUrl = record ? String(record.upload_url ?? record.uploadUrl ?? '').trim() : '';
  let mediaId = record ? String(record.media_id ?? record.mediaId ?? record.id ?? '').trim() : '';
  const contentType = record && typeof record.content_type === 'string' ? record.content_type.trim() : '';
  if (!uploadUrl) {
    const labelled = raw.match(/upload_?url["']?\s*[:=]\s*["']?(https:\/\/[^\s"'<>\\]+)/i);
    const curl = raw.match(/\bPUT\b[^\n]*?["']?(https:\/\/[^\s"'<>\\]+)/i);
    // Only an explicitly labelled upload_url or a PUT line counts: a bare URL in prose (a hint, a pricing link) is
    // never taken for the upload target, so a private file is not sent to an unrelated address.
    uploadUrl = (labelled && labelled[1]) || (curl && curl[1]) || '';
  }
  if (!mediaId) {
    const labelled = raw.match(/media_?id["']?\s*[:=]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    mediaId = labelled ? labelled[1] : higgsfield.extractJobIds(raw.replace(/https?:\/\/\S+/gi, ' '))[0] || '';
  }
  if (!/^https:\/\//i.test(uploadUrl) || !mediaId) {
    throw new Error(`Higgsfield lieferte keine Upload-URL oder media_id (Antwortformat von media_upload unbekannt): ${shorten(redactUrls(raw), 300)}`);
  }
  return { uploadUrl, mediaId, contentType };
}

// PUTs one file to a presigned upload_url (streamed, Content-Length set: S3 refuses chunked uploads).
async function putHiggsfieldFile(uploadUrl, { filePath, size, contentType }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HIGGSFIELD_UPLOAD_TIMEOUT_MS);
  timer.unref?.();
  const body = fs.createReadStream(filePath);
  let response;
  try {
    response = await global.fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': String(size) },
      body,
      duplex: 'half',
      signal: controller.signal
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Upload zu Higgsfield hat nach ${Math.round(HIGGSFIELD_UPLOAD_TIMEOUT_MS / 60000)} Minuten das Zeitlimit erreicht.`);
    }
    throw Object.assign(new Error(`Upload zu Higgsfield fehlgeschlagen: ${shorten(redactUrls(err.message), 200)}`), { transient: true });
  } finally {
    clearTimeout(timer);
    body.destroy();
  }
  let detail = '';
  if (!response.ok) {
    // S3 style XML errors carry a short <Code>; the rest of the body may echo parts of the signed request.
    try {
      const code = /<Code>([^<]{1,80})<\/Code>/.exec(await response.text());
      detail = code ? `, ${code[1].replace(/[^A-Za-z0-9_.-]/g, '')}` : '';
    } catch (_) {
      /* no detail */
    }
    const error = new Error(`Upload zu Higgsfield fehlgeschlagen (HTTP ${response.status}${detail}).`);
    error.transient = response.status === 429 || response.status >= 500;
    throw error;
  }
  await response.arrayBuffer().catch(() => {});
}

// The presigned PUT can simply be sent again (same file, same address) after a broken connection or a 5xx.
const HIGGSFIELD_PUT_RETRY_DELAYS_MS = [3000, 8000];
async function putHiggsfieldFileWithRetry(uploadUrl, file, { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await putHiggsfieldFile(uploadUrl, file);
    } catch (err) {
      if (err.transient !== true || attempt >= HIGGSFIELD_PUT_RETRY_DELAYS_MS.length) throw err;
      console.warn(`[higgsfield] ${err.message} - neuer Versuch in ${HIGGSFIELD_PUT_RETRY_DELAYS_MS[attempt] / 1000} s`);
      await sleep(HIGGSFIELD_PUT_RETRY_DELAYS_MS[attempt]);
    }
  }
}

// Reports a refused media_confirm; the text answer is JSON as far as known (unverified).
function assertHiggsfieldConfirmed(text) {
  const parsed = parseJsonLoose(text);
  const object = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const first = Array.isArray(object.results) && object.results[0] && typeof object.results[0] === 'object' ? object.results[0] : {};
  const error = typeof object.error === 'string' && object.error.trim()
    ? object.error
    : /^(failed|error|rejected)$/i.test(String(first.status || '')) ? `Status ${first.status}` : '';
  if (error) throw new Error(`Higgsfield konnte den Upload nicht bestaetigen: ${shorten(redactUrls(error), 200)}`);
}

// Uploads session assets with media_upload -> PUT -> media_confirm; no public server address is needed.
async function uploadHiggsfieldMedia(ctx, ids) {
  const ledger = await store.readLedger(ctx.sessionId);
  const directory = store.sessionAssetDir(ctx.sessionId);
  const mediaIds = [];
  for (const id of ids) {
    const entry = ledger.find((item) => item.id === id);
    if (!entry) throw new Error(`Asset ${id} existiert nicht in dieser Session.`);
    if (entry.pending) throw new Error(`Asset ${id} ist noch nicht fertig.`);
    const storedFile = String(entry.file || '');
    if (!storedFile || path.basename(storedFile) !== storedFile || !/^[A-Za-z0-9._-]+$/.test(storedFile)) {
      throw new Error(`Asset ${id} hat einen ungueltigen Dateinamen.`);
    }
    const ext = path.extname(storedFile).toLowerCase();
    const type = HIGGSFIELD_UPLOAD_TYPES[ext];
    if (!type) throw new Error(`Asset ${id} (${ext || 'ohne Endung'}) kann nicht zu Higgsfield hochgeladen werden.`);
    const filePath = path.join(directory, storedFile);
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error(`Asset ${id} konnte nicht gelesen werden: Datei fehlt.`);
      throw new Error(`Asset ${id} konnte nicht gelesen werden: ${err.message}`);
    }
    if (!stat.isFile() || stat.size === 0) throw new Error(`Asset ${id} konnte nicht gelesen werden: keine oder leere Datei.`);
    if (stat.size > MAX_RENDER_ASSET_BYTES) throw new Error(`Asset ${id} ist groesser als 500 MB und kann nicht zu Higgsfield hochgeladen werden.`);

    const created = parseHiggsfieldUpload(
      await higgsfield.mcpCall('media_upload', { filename: `${id}${ext}`, content_type: type.mime }, { retry: 'safe' })
    );
    // The signature may cover the Content-Type, so send exactly the one Higgsfield answered with.
    await putHiggsfieldFileWithRetry(created.uploadUrl, { filePath, size: stat.size, contentType: created.contentType || type.mime });
    assertHiggsfieldConfirmed(await higgsfield.mcpCall('media_confirm', { type: type.kind, media_id: created.mediaId }, { retry: 'safe' }));
    mediaIds.push(created.mediaId);
  }
  return { mediaIds, publishedFiles: [] };
}

// Brings session assets into Higgsfield and returns their media ids. With PUBLIC_BASE_URL the assets are
// published under it and imported by URL; the caller removes the published ref files once the job has been
// submitted (or failed). Without it the bytes are uploaded via media_upload (nothing is published).
async function importHiggsfieldMedia(ctx, ids) {
  if (!String(process.env.PUBLIC_BASE_URL || '').trim()) return uploadHiggsfieldMedia(ctx, ids);
  const publishedFiles = [];
  const mediaIds = [];
  try {
    for (const id of ids) {
      const published = await publicrefs.publishAsset(ctx.sessionId, id);
      publishedFiles.push(published.file);
      const imported = await higgsfield.mcpCall('media_import_url', { url: published.url }, { retry: 'safe' });
      const mediaId = higgsfield.extractJobIds(imported)[0];
      if (!mediaId) throw new Error(`Higgsfield lieferte fuer Referenz ${id} keine media_id.`);
      mediaIds.push(mediaId);
    }
    return { mediaIds, publishedFiles };
  } catch (err) {
    await removePublishedRefs(publishedFiles);
    throw err;
  }
}

// Reference images (and, for the node view only, audio tracks) of a generation. The audio role and its limit are read
// from the model and checked BEFORE anything is imported or submitted, so a model without an audio slot costs nothing.
// Audio references need at least one image or video reference next to them (a rule of the Higgsfield API).
async function importHiggsfieldReferences(ctx, modelId, outputKind, rawIds, rawAudioIds) {
  const ids = referenceIdArray({ reference_asset_ids: rawIds }, 'reference_asset_ids', 12);
  const audioIds = referenceIdArray({ reference_audio_asset_ids: rawAudioIds }, 'reference_audio_asset_ids', HIGGSFIELD_MAX_AUDIO_REFS);
  if (!ids.length && !audioIds.length) return { medias: [], publishedFiles: [], mediaIds: [] };
  if (audioIds.length && !ids.length) {
    throw new Error('Audio-Referenzen brauchen mindestens eine Bild- oder Video-Referenz (reference_asset_ids). Es wurde nichts eingereicht.');
  }
  if (ids.length) {
    await validateMediaReferenceAssets(
      ctx.sessionId,
      ids,
      new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mp3', '.wav', '.m4a', '.aac']),
      'Higgsfield-Referenz'
    );
  }
  if (audioIds.length) {
    await validateMediaReferenceAssets(ctx.sessionId, audioIds, HIGGSFIELD_AUDIO_EXTS, 'Audio-Referenz (erlaubt: MP3, WAV, M4A oder AAC)');
  }

  // The safe Higgsfield fallback for unclear image roles is "image"; audio uses the documented role only when the
  // model cannot be read at all.
  const details = await readHiggsfieldModel(modelId);
  const role = details ? referenceRoleFromModel(details, outputKind) : 'image';
  let audioSlot = null;
  if (audioIds.length) {
    audioSlot = audioSlotFor(details);
    if (!audioSlot) {
      throw new Error(
        `Das Higgsfield-Modell ${modelId} deklariert keine Audio-Referenz (keine Medien-Rolle mit "audio"). ` +
          'Es wurde nichts eingereicht.'
      );
    }
    if (audioSlot.max !== null && audioIds.length > audioSlot.max) {
      throw new Error(
        `Das Higgsfield-Modell ${modelId} akzeptiert hoechstens ${audioSlot.max} Audio-Referenzen (${audioIds.length} angegeben). ` +
          'Es wurde nichts eingereicht.'
      );
    }
  }

  const { mediaIds, publishedFiles } = await importHiggsfieldMedia(ctx, [...ids, ...audioIds]);
  const medias = [
    ...mediaIds.slice(0, ids.length).map((value) => ({ value, role })),
    ...mediaIds.slice(ids.length).map((value) => ({ value, role: audioSlot.role }))
  ];
  return { medias, publishedFiles, mediaIds };
}

// Model-specific parameters only the node view may pass (args.extra_params). runHiggsfieldGenerate ignores
// them unless ctx.nodeView is set, because the Director's closed tool schema is not enforced server-side.
const HIGGSFIELD_RESERVED_PARAMS = new Set(['model', 'prompt', 'medias', 'use_unlim']);

// Type-checks one extra param against its models_explore definition. Returns { value } or { error }.
function coerceHiggsfieldParam(spec, value) {
  const options = Array.isArray(spec.options) ? spec.options : null;
  const fromOptions = (candidate) => {
    if (!options) return { value: candidate };
    const match = options.find((option) => String(option) === String(candidate));
    return match === undefined ? { error: `Wert ${JSON.stringify(candidate)} ist keine gueltige Option` } : { value: match };
  };
  if (spec.type === 'string') {
    // options like "24000" are strings for the API: a number naming one of them is fine
    const candidate = typeof value === 'number' && options && options.some((option) => String(option) === String(value)) ? String(value) : value;
    if (typeof candidate !== 'string') return { error: 'muss ein String sein' };
    return fromOptions(candidate);
  }
  if (spec.type === 'number' || spec.type === 'integer') {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number)) return { error: spec.type === 'integer' ? 'muss eine ganze Zahl sein' : 'muss eine Zahl sein' };
    if (spec.type === 'integer' && !Number.isInteger(number)) return { error: 'muss eine ganze Zahl sein' };
    if (Number.isFinite(spec.min) && number < spec.min) return { error: `ist kleiner als ${spec.min}` };
    if (Number.isFinite(spec.max) && number > spec.max) return { error: `ist groesser als ${spec.max}` };
    return fromOptions(number);
  }
  if (spec.type === 'bool') {
    if (typeof value === 'boolean') return { value };
    if (value === 'true' || value === 'false') return { value: value === 'true' };
    return { error: 'muss true oder false sein' };
  }
  if (spec.type === 'string_array') {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return { error: 'muss eine Liste von Strings sein' };
    return { value };
  }
  return { error: `hat den nicht unterstuetzten Typ ${spec.type}` };
}

// Adds the whitelisted extra params to `params` and returns correction notes for dropped ones.
// Every key must exist in the model's parameters[] (models_explore get); unknown, reserved or
// ill-typed keys are dropped. Without a verifiable model nothing is guessed: the call fails before any spend.
async function applyHiggsfieldExtraParams(params, modelId, extra) {
  const corrections = [];
  if (extra === undefined || extra === null) return corrections;
  if (typeof extra !== 'object' || Array.isArray(extra)) throw new Error('extra_params muss ein Objekt sein');
  const keys = Object.keys(extra);
  if (!keys.length) return corrections;

  let model = null;
  try {
    model = parseModelDetails(await higgsfield.mcpCall('models_explore', { action: 'get', model_id: modelId }, { retry: 'safe' }), modelId);
  } catch (_) {
    model = null;
  }
  if (!model || !Array.isArray(model.parameters)) {
    throw new Error(`Higgsfield-Modell ${modelId} konnte nicht geprueft werden - extra_params wurden nicht angewendet.`);
  }
  const schema = new Map(model.parameters.map((spec) => [spec?.name, spec]));
  for (const key of keys) {
    if (HIGGSFIELD_RESERVED_PARAMS.has(key)) {
      corrections.push(`extra_params.${key} ist reserviert und wurde entfernt.`);
      continue;
    }
    const spec = schema.get(key);
    if (!spec) {
      corrections.push(`extra_params.${key} ist fuer ${modelId} nicht definiert und wurde entfernt.`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      corrections.push(`extra_params.${key} ist bereits gesetzt und wurde entfernt.`);
      continue;
    }
    const checked = coerceHiggsfieldParam(spec, extra[key]);
    if (checked.error) {
      corrections.push(`extra_params.${key} ${checked.error} und wurde entfernt.`);
      continue;
    }
    params[key] = checked.value;
  }
  return corrections;
}

// Shared by generation, edit and speech tools: reserves the result asset, submits the MCP call, persists the job
// (the poller completes it) and journals the zero-cost entry. `excludeIds` are UUIDs that can never be the job id
// (e.g. the imported source media of an edit). `kind` is image, video or audio; the poller replaces the reserved
// extension with the one of the downloaded result.
async function submitHiggsfieldJob(ctx, { kind, mcpTool, mcpArgs, prompt, model, mode, publishedFiles = [], excludeIds = [] }) {
  const checkAborted = () => {
    if (ctx.signal?.aborted || ctx.runSignal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
  };
  let asset;
  try {
    checkAborted();
    asset = await store.reserveAsset(ctx.sessionId, {
      kind,
      ext: kind === 'image' ? '.png' : kind === 'audio' ? '.wav' : '.mp4',
      prompt,
      model
    });
  } catch (err) {
    await removePublishedRefs(publishedFiles);
    throw err;
  }

  let submitText;
  try {
    checkAborted();
    submitText = await higgsfield.mcpCall(mcpTool, mcpArgs, { retry: 'submit' });
  } catch (err) {
    await removePublishedRefs(publishedFiles);
    await removeReservedAsset(ctx.sessionId, asset.id);
    throw err;
  }
  await removePublishedRefs(publishedFiles);

  const jobId = higgsfield.extractJobIds(submitText).find((id) => !excludeIds.includes(id));
  if (!jobId) {
    await removeReservedAsset(ctx.sessionId, asset.id);
    throw new Error(`Higgsfield lieferte keine Job-ID: ${shorten(submitText, 500)}`);
  }
  // Higgsfield antwortet als TEXT; gelegentlich steht darin die Job-ID des
  // vorherigen Auftrags. Zwei Jobs mit derselben ID wuerden sich gegenseitig
  // ueberschreiben, darum hier abbrechen statt ein Duplikat anzulegen.
  const existingSession = await store.readSession(ctx.sessionId);
  const duplicate = (existingSession.jobs || []).find((entry) => entry.jobId === jobId);
  if (duplicate) {
    await removeReservedAsset(ctx.sessionId, asset.id);
    throw new Error(
      `Higgsfield lieferte die bereits fuer ${duplicate.assetId} verwendete Job-ID ${jobId}. ` +
      'Der Auftrag wurde nicht angelegt - bitte erneut senden.'
    );
  }
  const submittedAt = new Date().toISOString();
  const job = {
    jobId,
    provider: 'higgsfield',
    source: 'higgsfield',
    kind,
    assetId: asset.id,
    file: asset.file,
    status: 'pending',
    prompt,
    mode,
    model,
    user: ctx.user || 'lokal',
    submittedAt,
    createdAt: submittedAt,
    startedAt: null,
    timeoutAt: Date.now() + (kind === 'video' ? HIGGSFIELD_VIDEO_JOB_TIMEOUT_MS : HIGGSFIELD_JOB_TIMEOUT_MS),
    cost: 0,
    costUnit: 'higgsfield_credits',
    error: null,
    ...(ctx.videoModelRequestId ? { videoModelRequestId: ctx.videoModelRequestId } : {}),
    ...budgetFieldsOf(ctx),
    ...(ctx.higgsfieldBilling ? {
      higgsfieldUsdPerCredit: ctx.higgsfieldBilling.rate,
      estimateCredits: ctx.higgsfieldBilling.credits,
      estimateUsd: ctx.higgsfieldBilling.estimateUsd,
      chargedCredits: require('../higgsfield-billing').reportedCredits({ text: submitText }),
      unknownCostUsd: ctx.budgetGrant?.reservedUsd || require('../budget').ASYNC_HOLD_USD()
    } : {})
  };
  await store.mutateSession(ctx.sessionId, (session) => session.jobs.push(job));
  ctx.budgetGrant?.submitted?.();
  await recordToolCost({
    ts: submittedAt,
    sessionId: ctx.sessionId,
    assetId: asset.id,
    type: 'higgsfield',
    model,
    cost: 0,
    user: job.user
  });

  ctx.emit({
    type: 'generation_job',
    jobId,
    assetId: asset.id,
    prompt,
    status: job.status,
    source: 'higgsfield',
    provider: 'higgsfield',
    kind,
    ...jobMetaFields(job),
    createdAt: submittedAt,
    startedAt: null
  });
  return { asset, job };
}

// Models that need a video as input (motion control, video edit) cannot run through the generation tools: they have no
// video input, and every reference goes out with one image role. The node view refuses such a model before the run
// (lib/nodes/nodes-generate.js, videoNeedIssue); this is the same rule for the Director, whose higgsfield_models still
// lists these models. Returns the error to throw, or null.
function higgsfieldVideoNeedError(modelId) {
  // required here, not at the top: lib/nodes/higgsfield-catalog.js requires this module while it loads
  const catalog = require('../nodes/higgsfield-catalog');
  const known = catalog.peekModel(modelId);
  const need = catalog.videoNeed(known || { id: modelId });
  if (!need) return null;
  const node = need === 'motion'
    ? 'Bewegung uebertragen (Higgsfield) / Motion transfer (Higgsfield)'
    : 'Video mit Referenzen bearbeiten / Edit video with references';
  return new Error(
    `Das Higgsfield-Modell ${known?.name || modelId} braucht ein Video als Eingabe, und dieses Werkzeug hat keinen Video-Eingang. ` +
      `Das geht in der Node-Ansicht mit dem Node "${node}"; hier ein anderes Modell waehlen. Es wurde nichts eingereicht.`
  );
}

async function runHiggsfieldGeneration(ctx, args, kind) {
  requireHiggsfieldConnection();
  const model = String(args.model || '').trim();
  const prompt = String(args.prompt || '').trim();
  if (!model) throw new Error('model fehlt');
  if (!prompt) throw new Error('prompt fehlt');
  const videoNeed = higgsfieldVideoNeedError(model);
  if (videoNeed) throw videoNeed;
  const tool = kind === 'image' ? 'higgsfield_generate_image' : 'higgsfield_generate_video';
  ctx.emit({
    type: 'tool_start',
    tool,
    label: `${kind === 'image' ? 'Starte Higgsfield-Bild' : 'Starte Higgsfield-Video'}: ${shorten(prompt, 80)}`
  });

  const params = { model, prompt, use_unlim: false };
  if (args.aspect_ratio) params.aspect_ratio = String(args.aspect_ratio);
  if (args.resolution) params.resolution = String(args.resolution);
  // duration and extra_params are checked before any reference is uploaded, so a refused call sends no file to Higgsfield.
  if (kind === 'video' && args.duration !== undefined && args.duration !== null) {
    const duration = Number(args.duration);
    if (!Number.isInteger(duration)) throw new Error('duration muss eine ganze Zahl sein');
    params.duration = duration;
  }
  const corrections = await applyHiggsfieldExtraParams(params, model, ctx.nodeView === true ? args.extra_params : undefined);

  // reference_audio_asset_ids is node view only (like extra_params): the Director's closed schema has no audio slot.
  const refs = await importHiggsfieldReferences(
    ctx,
    model,
    kind,
    args.reference_asset_ids,
    ctx.nodeView === true ? args.reference_audio_asset_ids : undefined
  );
  if (refs.medias.length) params.medias = refs.medias;

  const { asset, job } = await submitHiggsfieldJob(ctx, {
    kind,
    mcpTool: kind === 'image' ? 'generate_image_batch' : 'generate_video_batch',
    mcpArgs: { requests: [{ index: 0, params }] },
    prompt,
    model,
    mode: kind === 'image' ? 'higgsfield_image' : 'higgsfield_video',
    publishedFiles: refs.publishedFiles,
    excludeIds: refs.mediaIds
  });
  return {
    toolResult:
      `Higgsfield-${kind === 'image' ? 'Bild' : 'Video'}-Job ${asset.id} gestartet (Job-ID ${job.jobId}, Modell ${model}). ` +
      'Das Ergebnis folgt asynchron. Abrechnung erfolgt in Higgsfield-Credits; den aktuellen Stand zeigt higgsfield_check_balance.' +
      (corrections.length ? ` Hinweis: ${corrections.join(' ')}` : ''),
    inject: [],
    job,
    corrections
  };
}

// Higgsfield edit tools of the node view (experimental, not offered to the Director). Each spec lists the media
// kinds of its sources (in order), the kind of its result and build(mediaIds, params, kind), which returns the MCP
// arguments. The sources are imported into Higgsfield first (media_import_url or media_upload) and passed by media id
// under the tool's own field names. The MCP schemas (docs/higgsfield-tools.json) nest all arguments under `params`.
// The first five pass their params through; the newer ones check every value against the schema enums and drop
// unknown keys (their schemas have additionalProperties: false).
const HIGGSFIELD_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

const HIGGSFIELD_VIDEO_EXTS = new Set(['.mp4', '.webm']);

const HIGGSFIELD_DUBBING_LANGUAGES = Object.freeze([
  'eng', 'cmn', 'fra', 'hin', 'ita', 'jpn', 'kor', 'por', 'rus', 'tur', 'spa', 'deu', 'ara', 'pol', 'ind', 'fil', 'swe', 'fin'
]);

const HIGGSFIELD_VOICE_TYPES = Object.freeze(['preset', 'element']);

const HIGGSFIELD_MOTION_RESOLUTIONS = Object.freeze(['720p', '1080p']);

const HIGGSFIELD_SCENE_CONTROLS = Object.freeze(['image', 'video']);

// Genjutsu motion transfer (models_explore get hf_mult_motion_control, read through the app on 2026-10-24): one media slot
// with the roles image_references and video_references, the param resolution (480p, 720p, 1080p). Higgsfield documents
// a source clip of 4 to 30 s and up to 8 reference images (people, a setting, an outfit).
const HIGGSFIELD_GENJUTSU_MODEL = 'hf_mult_motion_control';
const HIGGSFIELD_GENJUTSU_RESOLUTIONS = Object.freeze(['480p', '720p', '1080p']);
const HIGGSFIELD_GENJUTSU_MAX_IMAGES = 8;
const HIGGSFIELD_GENJUTSU_MIN_SECONDS = 4;
const HIGGSFIELD_GENJUTSU_MAX_SECONDS = 30;

// A value of a fixed set: missing/blank falls back to `fallback` (undefined = required).
function higgsfieldEnum(params, key, allowed, fallback) {
  const raw = params[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    if (fallback === undefined) throw new Error(`${key} fehlt (erlaubt: ${allowed.join(', ')})`);
    return fallback;
  }
  const value = String(raw).trim();
  if (!allowed.includes(value)) throw new Error(`${key} "${shorten(value, 40)}" ist ungueltig (erlaubt: ${allowed.join(', ')})`);
  return value;
}

const HIGGSFIELD_EDIT_TOOLS = Object.freeze({
  remove_background: {
    sources: (kind) => [kind],
    output: (kind) => kind,
    build: ([mediaId], params, kind) => ({ ...params, media_id: mediaId, media_type: kind })
  },
  upscale_image: {
    sources: () => ['image'],
    output: () => 'image',
    build: ([mediaId], params) => ({ ...params, image_id: mediaId })
  },
  upscale_video: {
    sources: () => ['video'],
    output: () => 'video',
    build: ([mediaId], params) => ({ ...params, video_id: mediaId })
  },
  outpaint_image: {
    sources: () => ['image'],
    output: () => 'image',
    build: ([mediaId], params) => ({ ...params, image_id: mediaId })
  },
  reframe: {
    sources: () => ['video'],
    output: () => 'video',
    build: ([mediaId], params) => ({ ...params, medias: [{ value: mediaId, role: 'video' }] })
  },
  dubbing: {
    sources: () => ['video'],
    output: () => 'video',
    build: ([mediaId], params) => ({
      video_id: mediaId,
      target_language: higgsfieldEnum(params, 'target_language', HIGGSFIELD_DUBBING_LANGUAGES)
    })
  },
  voice_change: {
    sources: () => ['video'],
    output: () => 'video',
    build: ([mediaId], params) => {
      const voiceId = String(params.voice_id ?? '').trim();
      if (!voiceId) throw new Error('voice_id fehlt');
      return {
        video_id: mediaId,
        voice_id: voiceId,
        voice_type: higgsfieldEnum(params, 'voice_type', HIGGSFIELD_VOICE_TYPES, 'preset')
      };
    }
  },
  motion_control: {
    sources: () => ['image', 'video'],
    output: () => 'video',
    build: ([imageId, motionVideoId], params) => ({
      image_id: imageId,
      motion_video_id: motionVideoId,
      resolution: higgsfieldEnum(params, 'resolution', HIGGSFIELD_MOTION_RESOLUTIONS, '720p'),
      scene_control: higgsfieldEnum(params, 'scene_control', HIGGSFIELD_SCENE_CONTROLS, 'image')
    })
  },
  // Not an MCP tool of its own: a generation of the model Genjutsu (generate_video_batch) with the source video and
  // 1 to 8 reference images. The prompt is optional (it says which image replaces which person).
  genjutsu: {
    sources: (_kind, count) => ['video', ...Array.from({ length: Math.max(1, count - 1) }, () => 'image')],
    maxSources: 1 + HIGGSFIELD_GENJUTSU_MAX_IMAGES,
    output: () => 'video',
    mcpTool: 'generate_video_batch',
    model: HIGGSFIELD_GENJUTSU_MODEL,
    build: ([videoId, ...imageIds], params) => {
      const prompt = String(params.prompt ?? '').trim();
      return {
        requests: [{
          index: 0,
          params: {
            model: HIGGSFIELD_GENJUTSU_MODEL,
            ...(prompt ? { prompt } : {}),
            resolution: higgsfieldEnum(params, 'resolution', HIGGSFIELD_GENJUTSU_RESOLUTIONS, '720p'),
            use_unlim: false,
            medias: [
              { value: videoId, role: 'video_references' },
              ...imageIds.map((value) => ({ value, role: 'image_references' }))
            ]
          }
        }]
      };
    }
  }
});

async function runHiggsfieldEdit(ctx, args) {
  requireHiggsfieldConnection();
  const tool = String(args.tool || '').trim();
  const spec = Object.prototype.hasOwnProperty.call(HIGGSFIELD_EDIT_TOOLS, tool) ? HIGGSFIELD_EDIT_TOOLS[tool] : null;
  if (!spec) throw new Error(`Unbekanntes Higgsfield-Edit-Tool: ${tool || '(leer)'}`);
  const kind = args.kind === 'video' ? 'video' : args.kind === 'image' ? 'image' : null;
  if (!kind) throw new Error('kind muss image oder video sein');
  const ids = Array.isArray(args.source_asset_ids) ? args.source_asset_ids.map((id) => String(id || '').trim()) : [];
  if (spec.maxSources && ids.length > spec.maxSources) {
    throw new Error(`source_asset_ids darf hoechstens ${spec.maxSources} Asset-IDs enthalten (${ids.length} angegeben)`);
  }
  const sourceKinds = spec.sources(kind, ids.length);
  const outputKind = spec.output(kind);
  if (ids.length !== sourceKinds.length || ids.some((id) => !id)) {
    throw new Error(
      sourceKinds.length === 1
        ? 'source_asset_ids muss genau eine Asset-ID enthalten'
        : `source_asset_ids muss genau ${sourceKinds.length} Asset-IDs enthalten (${sourceKinds.map((item) => (item === 'video' ? 'Video' : 'Bild')).join(', ')})`
    );
  }
  for (let index = 0; index < ids.length; index += 1) {
    const video = sourceKinds[index] === 'video';
    await validateMediaReferenceAssets(ctx.sessionId, [ids[index]], video ? HIGGSFIELD_VIDEO_EXTS : HIGGSFIELD_IMAGE_EXTS, video ? 'Video-Quelle' : 'Bild-Quelle');
  }
  const toolParams = args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? args.params : {};
  // Dry run with placeholder ids: bad params fail here, before anything is uploaded or imported.
  spec.build(ids.map(() => '00000000-0000-0000-0000-000000000000'), toolParams, kind);
  ctx.emit({ type: 'tool_start', tool: 'higgsfield_edit', label: `Starte Higgsfield ${tool}: ${ids.join(' + ')}` });

  const imported = await importHiggsfieldMedia(ctx, ids);
  let mcpParams;
  try {
    mcpParams = spec.build(imported.mediaIds, toolParams, kind);
  } catch (err) {
    await removePublishedRefs(imported.publishedFiles);
    throw err;
  }
  const { asset, job } = await submitHiggsfieldJob(ctx, {
    kind: outputKind,
    mcpTool: spec.mcpTool || tool,
    mcpArgs: spec.mcpTool ? mcpParams : { params: mcpParams },
    prompt: `Higgsfield ${tool}: ${ids.join(' + ')}`,
    model: spec.model || tool,
    mode: 'higgsfield_edit',
    publishedFiles: imported.publishedFiles,
    excludeIds: imported.mediaIds
  });
  return {
    toolResult: `Higgsfield-${tool}-Job ${asset.id} gestartet (Job-ID ${job.jobId}). Das Ergebnis folgt asynchron.`,
    inject: [],
    job
  };
}

// Speech output of the node view (generate_audio_batch with one request) with seed_audio or text2speech_v2.
// The voice is a preset or a workspace element; seed_audio also takes up to two reference audios, passed under the
// audio role the model declares (models_explore get; audio_references when the model cannot be read at all).
// Everything that can be wrong is checked before anything is imported or submitted, so a bad call costs nothing.
async function runHiggsfieldSpeech(ctx, args) {
  requireHiggsfieldConnection();
  const model = String(args.model || '').trim() || HIGGSFIELD_DEFAULT_AUDIO_MODEL;
  if (!HIGGSFIELD_SPEECH_MODELS.includes(model)) {
    throw new Error(`Das Modell ${shorten(model, 60)} ist fuer die Sprachausgabe nicht vorgesehen (erlaubt: ${HIGGSFIELD_SPEECH_MODELS.join(', ')})`);
  }
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt fehlt');
  const voiceId = String(args.voice_id ?? '').trim();
  // voice_type and voice_id only work as a pair
  if (!voiceId && String(args.voice_type ?? '').trim()) throw new Error('voice_type und voice_id gehoeren zusammen: voice_id fehlt');
  const voiceType = higgsfieldEnum(args, 'voice_type', HIGGSFIELD_VOICE_TYPES, 'preset');
  const audioIds = referenceIdArray(args, 'reference_audio_asset_ids', 50);
  if (audioIds.length > HIGGSFIELD_MAX_SPEECH_REFS) {
    throw new Error(`Die Sprachausgabe akzeptiert hoechstens ${HIGGSFIELD_MAX_SPEECH_REFS} Referenz-Audiodateien (${audioIds.length} angegeben)`);
  }
  if (model === 'text2speech_v2') {
    if (audioIds.length) throw new Error('text2speech_v2 nimmt keine Referenz-Audiodatei (nur seed_audio)');
    if (!voiceId) throw new Error('voice_id fehlt (text2speech_v2 braucht eine Stimme)');
  } else if (!voiceId && !audioIds.length) {
    throw new Error('voice_id fehlt (oder eine Referenz-Audiodatei angeben)');
  }

  // extra_params (node view only): the voice comes from the voice fields alone, and only formats the app can store pass.
  const corrections = [];
  const extraInput = ctx.nodeView === true ? args.extra_params : undefined;
  const extra = extraInput && typeof extraInput === 'object' && !Array.isArray(extraInput) ? { ...extraInput } : extraInput;
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const key of ['voice_id', 'voice_type']) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) {
        delete extra[key];
        corrections.push(`extra_params.${key} ist fuer die Sprachausgabe reserviert (Stimme separat waehlen) und wurde entfernt.`);
      }
    }
    if (extra.format !== undefined && !HIGGSFIELD_SPEECH_FORMATS.includes(extra.format)) {
      throw new Error(
        `Das Audioformat "${shorten(String(extra.format), 20)}" wird von der App nicht unterstuetzt ` +
          `(erlaubt: ${HIGGSFIELD_SPEECH_FORMATS.join(', ')}; pcm und ogg_opus lassen sich nicht abspielen). Es wurde nichts eingereicht.`
      );
    }
  }
  const variantError = `variant fehlt oder ist ungueltig (text2speech_v2 braucht eine dieser Varianten: ${HIGGSFIELD_SPEECH_VARIANTS.join(', ')})`;
  if (model === 'text2speech_v2' && !HIGGSFIELD_SPEECH_VARIANTS.includes(extra?.variant)) throw new Error(variantError);

  let audioRole = null;
  if (audioIds.length) {
    await validateMediaReferenceAssets(ctx.sessionId, audioIds, HIGGSFIELD_AUDIO_EXTS, 'Audio-Referenz (erlaubt: MP3, WAV, M4A oder AAC)');
    const slot = audioSlotFor(await readHiggsfieldModel(model));
    if (!slot) {
      throw new Error(`Das Higgsfield-Modell ${model} deklariert keine Audio-Referenz (keine Medien-Rolle mit "audio"). Es wurde nichts eingereicht.`);
    }
    if (slot.max !== null && audioIds.length > slot.max) {
      throw new Error(`Das Higgsfield-Modell ${model} akzeptiert hoechstens ${slot.max} Audio-Referenzen (${audioIds.length} angegeben). Es wurde nichts eingereicht.`);
    }
    audioRole = slot.role;
  }
  ctx.emit({ type: 'tool_start', tool: 'higgsfield_speech', label: `Starte Higgsfield-Sprachausgabe: ${shorten(prompt, 80)}` });

  const imported = audioIds.length ? await importHiggsfieldMedia(ctx, audioIds) : { mediaIds: [], publishedFiles: [] };
  const params = { model, prompt, use_unlim: false };
  if (voiceId) {
    params.voice_type = voiceType;
    params.voice_id = voiceId;
  }
  if (imported.mediaIds.length) params.medias = imported.mediaIds.map((value) => ({ value, role: audioRole }));
  try {
    corrections.push(...await applyHiggsfieldExtraParams(params, model, extra));
    // the extra param may have been dropped (not defined for the model): never submit without the variant
    if (model === 'text2speech_v2' && !HIGGSFIELD_SPEECH_VARIANTS.includes(params.variant)) throw new Error(`${variantError}. Es wurde nichts eingereicht.`);
  } catch (err) {
    await removePublishedRefs(imported.publishedFiles);
    throw err;
  }

  const { asset, job } = await submitHiggsfieldJob(ctx, {
    kind: 'audio',
    mcpTool: 'generate_audio_batch',
    mcpArgs: { requests: [{ index: 0, params }] },
    prompt,
    model,
    mode: 'higgsfield_audio',
    publishedFiles: imported.publishedFiles,
    excludeIds: imported.mediaIds
  });
  return {
    toolResult:
      `Higgsfield-Audio-Job ${asset.id} gestartet (Job-ID ${job.jobId}, Modell ${model}). Das Ergebnis folgt asynchron.` +
      (corrections.length ? ` Hinweis: ${corrections.join(' ')}` : ''),
    inject: [],
    job,
    corrections
  };
}

function runHiggsfieldGenerateImage(ctx, args) {
  return runHiggsfieldGeneration(ctx, args, 'image');
}

function runHiggsfieldGenerateVideo(ctx, args) {
  return runHiggsfieldGeneration(ctx, args, 'video');
}

// generate_video with Kling 4.0 (Higgsfield) chosen on the video model card or remembered for the chat (lib/higgsfield-kling4.js).
// Takes the arguments of generate_video: the start and end image go out with their own media roles.
async function runHiggsfieldKling4Video(ctx, args) {
  requireHiggsfieldConnection();
  const kling4 = require('../higgsfield-kling4');
  const { params, frames, prompt } = kling4.plan(args);
  const ids = frames.map((frame) => frame.assetId);
  if (ids.length) await validateMediaReferenceAssets(ctx.sessionId, ids, HIGGSFIELD_IMAGE_EXTS, 'Start-/Endbild (erlaubt: PNG, JPEG, WebP oder GIF)');
  ctx.emit({ type: 'tool_start', tool: 'generate_video', label: `Starte ${kling4.NAME}: ${shorten(prompt, 80)}` });
  const { mediaIds, publishedFiles } = ids.length ? await importHiggsfieldMedia(ctx, ids) : { mediaIds: [], publishedFiles: [] };
  if (mediaIds.length) params.medias = mediaIds.map((value, index) => ({ value, role: frames[index].role }));
  const { asset, job } = await submitHiggsfieldJob(ctx, {
    kind: 'video',
    mcpTool: 'generate_video_batch',
    mcpArgs: { requests: [{ index: 0, params }] },
    prompt,
    model: kling4.HF_MODEL,
    mode: 'higgsfield_video',
    publishedFiles,
    excludeIds: mediaIds
  });
  return {
    toolResult:
      `Video-Job ${asset.id} gestartet (Job-ID ${job.jobId}, Modell ${kling4.NAME}, ${params.duration} s, ${params.resolution}). ` +
      'Das Ergebnis folgt asynchron. Abrechnung in Higgsfield-Credits; den aktuellen Stand zeigt higgsfield_check_balance. Sag dem User kurz, was gerade generiert wird.',
    inject: [],
    job,
    corrections: []
  };
}

async function runHiggsfieldCheckBalance() {
  requireHiggsfieldConnection();
  return {
    toolResult: `${await higgsfield.mcpCall('balance', {}, { retry: 'safe' })}\nAbrechnung: Higgsfield-Credits auf dem verbundenen Plan.`,
    inject: []
  };
}

module.exports = {
  runHiggsfieldModels,
  runHiggsfieldGenerateImage,
  runHiggsfieldGenerateVideo,
  runHiggsfieldKling4Video,
  runHiggsfieldEdit,
  runHiggsfieldSpeech,
  runHiggsfieldCheckBalance,
  parseJsonLoose,
  HIGGSFIELD_DUBBING_LANGUAGES,
  HIGGSFIELD_VOICE_TYPES,
  HIGGSFIELD_MOTION_RESOLUTIONS,
  HIGGSFIELD_GENJUTSU_RESOLUTIONS,
  HIGGSFIELD_GENJUTSU_MAX_IMAGES,
  HIGGSFIELD_GENJUTSU_MIN_SECONDS,
  HIGGSFIELD_GENJUTSU_MAX_SECONDS,
  HIGGSFIELD_SCENE_CONTROLS,
  audioRoleFromModel,
  audioSlotFromModel,
  parseHiggsfieldUpload
};
