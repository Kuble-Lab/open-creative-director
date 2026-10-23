'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const magnific = require('../magnific');
const store = require('../store');
const costs = require('../costs');
const { validate } = require('../magnific-schema');

const JOB_TIMEOUT_MS = 10 * 60 * 1000;
// Video upscale, HDR and cut-outs run on GPU queues that take far longer than an image.
const VIDEO_JOB_TIMEOUT_MS = 30 * 60 * 1000;
const FREE = /^(account_balance|simulate_cost|creation_status|creations_(get|wait|search|request_upload|finalize_upload)|images_upscale_modes_list|video_upscale_models_list)$/;
const MIMES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac' };
// MIME types creations_request_upload accepts (live schema, 2026-10-22). GIF is not among them.
const UPLOAD_MIMES = new Set(['image/jpeg', 'image/png', 'image/svg+xml', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/flac']);
// Magnific answers some tools with JSON text and others with an indented "key: value" listing. The listing is
// read as flat pairs only, which is enough for identifiers, status and URLs.
function listing(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const match = /^\s*-?\s*([A-Za-z_][\w]*):\s*"?([^"\s][^"]*?)"?\s*$/.exec(line);
    if (match && !Object.hasOwn(out, match[1])) out[match[1]] = match[2];
  }
  return out;
}
function parsed(answer) {
  if (answer?.structured) return answer.structured;
  if (answer && typeof answer === 'object') return answer;
  try { return JSON.parse(answer); } catch (_) { return { text: String(answer || ''), ...listing(answer) }; }
}
function objects(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 10) return [];
  return [value, ...Object.values(value).flatMap((v) => objects(v, depth + 1))];
}
function creditsOf(value) {
  const visit = (object, depth = 0) => {
    if (!object || typeof object !== 'object' || depth > 10) return null;
    for (const key of ['credits', 'cost_credits', 'estimated_credits', 'total_credits', 'credit_cost']) {
      if (typeof object[key] === 'number' && Number.isFinite(object[key]) && object[key] >= 0) return object[key];
    }
    for (const [key, child] of Object.entries(object)) {
      if (/balance|account|remaining|available/i.test(key)) continue;
      const result = visit(child, depth + 1);
      if (result !== null) return result;
    }
    return null;
  };
  return visit(parsed(value));
}
async function checkedCall(name, args, options) {
  const tool = (await magnific.listTools()).find((t) => t.name === name);
  if (!tool) throw new Error(`Magnific tool ${name} is not available for this account.`);
  validate(args, tool.inputSchema);
  return parsed(await magnific.mcpCall(name, args, options));
}
// Resolve naming differences from the actual account schema. Unknown required fields are never guessed.
async function semanticArgs(name, fields) {
  const tool = (await magnific.listTools()).find((t) => t.name === name);
  if (!tool) throw new Error(`Magnific tool ${name} is not available.`);
  const args = {};
  for (const [aliases, value] of fields) {
    const key = aliases.split('|').find((k) => Object.hasOwn(tool.inputSchema?.properties || {}, k));
    if (key) args[key] = value;
  }
  validate(args, tool.inputSchema);
  return args;
}
async function semanticCall(name, fields, options) { return checkedCall(name, await semanticArgs(name, fields), options); }
function creationIds(value, allowBare = false) {
  const ids = [];
  const visit = (obj, context = '', depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 10) return;
    for (const key of ['creationIdentifier', 'creation_id', 'creationId']) if (typeof obj[key] === 'string') ids.push(obj[key]);
    if (typeof obj.identifier === 'string' && (obj.status || obj.tool || obj.url)) ids.push(obj.identifier);
    for (const key of ['identifiers', 'creation_ids', 'creationIds']) if (Array.isArray(obj[key])) ids.push(...obj[key].filter((v) => typeof v === 'string'));
    const kind = String(obj.type || obj.kind || '').toLowerCase();
    if (typeof obj.id === 'string' && (obj.download_url || obj.downloadUrl || /^(creations?|results)$/.test(context) ||
        ['image', 'video', 'audio', 'creation'].includes(kind) || (allowBare && obj.status && !kind))) ids.push(obj.id);
    for (const [key, child] of Object.entries(obj)) {
      if (Array.isArray(child)) child.forEach((item) => visit(item, key, depth + 1));
      else visit(child, key, depth + 1);
    }
  };
  visit(parsed(value));
  return [...new Set(ids)];
}
// Full-resolution result URL: creation_status/creations_wait put it under results.url, creations_get at the top.
function resultUrl(value) {
  const found = objects(parsed(value)).find((o) => typeof o.results?.url === 'string' || typeof o.url === 'string' || typeof o.download_url === 'string');
  return found ? (found.results?.url || found.url || found.download_url) : undefined;
}
const uploads = new Map();
function clearUploads() { uploads.clear(); }
function checkAborted(ctx) {
  if (ctx?.signal?.aborted) { const error = new Error('Magnific request cancelled.'); error.name = 'AbortError'; throw error; }
}
async function uploadAsset(ctx, id) {
  checkAborted(ctx);
  const entry = (await store.readLedger(ctx.sessionId)).find((a) => a.id === id);
  if (!entry || entry.pending || !entry.file || path.basename(entry.file) !== entry.file) throw new Error('Magnific: asset is missing or unfinished.');
  const ext = path.extname(entry.file).toLowerCase();
  const mime = MIMES[ext];
  if (!mime) throw new Error('Magnific: unsupported upload type.');
  const file = path.join(store.sessionAssetDir(ctx.sessionId), entry.file);
  const stat = await fs.stat(file);
  const max = mime.startsWith('image/') ? (ext === '.svg' ? 10 : 25) : mime.startsWith('audio/') ? 50 : 200;
  if (!stat.isFile() || !stat.size || stat.size > max * 1024 * 1024) throw new Error(`Magnific: upload exceeds ${max} MB or is empty.`);
  const cacheKey = `${ctx.sessionId}:${id}:${stat.size}:${stat.mtimeMs}`;
  const cached = uploads.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return cached.value;
  if (!UPLOAD_MIMES.has(mime)) throw new Error('Magnific: unsupported upload type.');
  const filename = `${id}${ext}`;
  checkAborted(ctx);
  const requested = await checkedCall('creations_request_upload', { mimeType: mime });
  const upload = objects(requested).find((obj) => obj.proxyUploadUrl || obj.upload_url || obj.uploadUrl);
  const url = upload?.proxyUploadUrl || upload?.upload_url || upload?.uploadUrl;
  let target;
  try { target = new URL(url); } catch (_) { throw new Error('Magnific did not return a secure upload URL.'); }
  if (target.protocol !== 'https:' || target.username || target.password || target.hash) throw new Error('Magnific did not return a secure upload URL.');
  if (typeof upload.path !== 'string' || !upload.path) throw new Error('Magnific did not return an upload path.');
  try {
    const response = await global.fetch(url, { method: 'PUT', redirect: 'error', body: await fs.readFile(file),
      headers: { 'Content-Type': mime, 'Content-Length': String(stat.size) }, signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error();
  } catch (_) { throw new Error('Magnific upload failed or timed out.'); }
  // visible: false keeps the working copies out of the account's library.
  const finalized = await checkedCall('creations_finalize_upload', { path: upload.path, fileName: filename, visible: false });
  const creationId = creationIds(finalized, true)[0];
  if (!creationId) throw new Error('Magnific did not confirm a creation ID for the upload.');
  const value = { creationId, url: resultUrl(finalized) };
  uploads.set(cacheKey, { value, expiresAt: Date.now() + 60 * 60 * 1000 });
  return value;
}
// Explicit markers keep arbitrary strings and ids in a general tool call untouched.
async function resolveAssets(ctx, value) {
  if (Array.isArray(value)) return Promise.all(value.map((v) => resolveAssets(ctx, v)));
  if (value && typeof value === 'object') {
    if (Object.keys(value).every((k) => ['asset_id', 'as'].includes(k)) && value.asset_id) {
      const uploaded = await uploadAsset(ctx, value.asset_id);
      if (value.as === 'url') { if (!uploaded.url) throw new Error('Magnific upload returned no URL. Use a creation ID.'); return uploaded.url; }
      return uploaded.creationId;
    }
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await resolveAssets(ctx, v)])));
  }
  return value;
}
async function estimate(name, args) {
  const tool = (await magnific.listTools()).find((t) => t.name === name);
  if (!tool) throw new Error('Magnific estimate: unknown tool.');
  validate(args, tool.inputSchema);
  return semanticCall('simulate_cost', [['tool_name|tool|name', name], ['arguments|args|parameters', args]]);
}
function costEntry(ctx, name, credits, bookingId) {
  return { ts: new Date().toISOString(), sessionId: ctx.sessionId, type: 'magnific', model: name,
    cost: 0, user: ctx.user || 'lokal', billing: 'magnific', ...(credits === null ? {} : { credits }), bookingId, ...costs.viaFields() };
}
async function record(entry) {
  try { await costs.recordCost(entry); return true; }
  catch (_) { console.warn('[magnific] Cost booking deferred.'); return false; }
}
async function submit(ctx, name, args) {
  checkAborted(ctx);
  // The estimate is free; failures leave the price explicitly unknown. Never silently report zero credits.
  let credits = null;
  if (!FREE.test(name)) { try { credits = creditsOf(await estimate(name, args)); } catch (_) { /* unknown */ } }
  ctx.emit?.({ type: 'tool_start', tool: 'magnific_call', label: `Magnific ${name}: ${credits === null ? 'unknown credits' : `${credits} credits`}` });
  checkAborted(ctx);
  const result = await checkedCall(name, args);
  const reported = creditsOf(result);
  credits = reported ?? credits;
  // A result may echo its inputs; only new creations become jobs.
  const inputs = new Set(Object.entries(args || {}).filter(([k, v]) => /creationIdentifier$|^audioUrl$/.test(k) && typeof v === 'string').map(([, v]) => v));
  const ids = creationIds(result, /^(images_|video_|audio_)/.test(name)).filter((id) => !inputs.has(id));
  const bookingId = `magnific:${crypto.randomUUID()}`;
  const accountingEntry = FREE.test(name) ? null : costEntry(ctx, name, credits, bookingId);
  if (!ids.length || /^(models3d_|scene3d_)/.test(name)) {
    if (accountingEntry) await record(accountingEntry);
    return { toolResult: JSON.stringify(result).slice(0, 24000), inject: [] };
  }
  const kind = name.startsWith('video_') ? 'video' : name.startsWith('audio_') ? 'audio' : 'image';
  const asset = await store.reserveAsset(ctx.sessionId, { kind, ext: kind === 'image' ? '.png' : kind === 'video' ? '.mp4' : '.mp3', prompt: name, model: name });
  const job = { jobId: crypto.randomUUID(), creationIds: ids, provider: 'magnific', source: 'magnific', kind,
    assetId: asset.id, file: asset.file, status: 'pending', model: name, prompt: name, user: ctx.user || 'lokal',
    createdAt: new Date().toISOString(), timeoutAt: Date.now() + (kind === 'video' ? VIDEO_JOB_TIMEOUT_MS : JOB_TIMEOUT_MS), cost: 0, costUnit: 'magnific_credits', billing: 'magnific_credits', credits,
    ...costs.viaFields(), ...(accountingEntry ? { accountingStatus: 'pending', accountingEntry } : {}) };
  await store.mutateSession(ctx.sessionId, (session) => session.jobs.push(job));
  if (accountingEntry && await record(accountingEntry)) {
    await store.mutateSession(ctx.sessionId, (session) => {
      const saved = store.findSessionJob(session.jobs, job);
      saved.accountingStatus = 'booked'; delete saved.accountingEntry;
    });
  }
  const { accountingEntry: _privateEntry, ...publicJob } = job;
  ctx.emit?.({ type: 'generation_job', ...publicJob });
  // Give quick creations a chance to finish; long jobs remain durable and are picked up by the regular poller.
  await checkedCall('creations_wait', { identifiers: ids.slice(0, 8), timeoutSeconds: 8 }, { timeoutMs: 15000 }).catch(() => {});
  return { toolResult: `Magnific job ${job.jobId}; result asset ${asset.id}. Billed in Magnific credits (${credits ?? 'unknown'}).`, inject: [], job };
}
// A Magnific job is asked at most every 30 s: the poller runs every few seconds over all open jobs, and Magnific counts
// every MCP request against a per-minute budget of the account.
const POLL_SPACING_MS = 30 * 1000;
const lastPolled = new Map();
async function pollJob(sessionId, job, { wait = false } = {}) {
  const key = (job.creationIds || []).join(',');
  const last = lastPolled.get(key) || 0;
  if (!wait && Date.now() - last < POLL_SPACING_MS) return false;
  lastPolled.set(key, Date.now());
  if (lastPolled.size > 2000) lastPolled.delete(lastPolled.keys().next().value);
  const states = [];
  for (let i = 0; i < job.creationIds.length; i += 8) {
    const answer = await checkedCall('creations_wait', { identifiers: job.creationIds.slice(i, i + 8), timeoutSeconds: wait ? 20 : 0 }, { timeoutMs: 30000 });
    const rows = objects(answer).filter((o) => typeof o.status === 'string' && (o.identifier || o.creationIdentifier));
    states.push(...(rows.length ? rows : [answer]));
  }
  const statuses = states.map((o) => String(o.status || '').toLowerCase());
  if (statuses.some((s) => ['failed', 'error', 'cancelled', 'canceled', 'rejected'].includes(s))) throw new Error('Magnific creation failed.');
  if (statuses.length < job.creationIds.length || statuses.some((s) => !['completed', 'done', 'success', 'succeeded', 'ready'].includes(s))) return false;
  const records = states.map((state) => resultUrl(state)).filter(Boolean).map((url) => ({ download_url: url }));
  if (!records.length) throw new Error('Magnific returned no download URL.');
  const assets = [];
  for (const [i, row] of records.entries()) {
    const download = await magnific.downloadResult(row.download_url || row.downloadUrl, { maxBytes: 500 * 1024 * 1024 });
    const mime = download.contentType.split(';')[0];
    const ext = Object.keys(MIMES).find((k) => MIMES[k] === mime);
    if (!ext) throw new Error('Magnific returned an unsupported media type.');
    const kind = mime.split('/')[0];
    if (i === 0) {
      const temporary = path.join(store.sessionAssetDir(sessionId), `.magnific-${crypto.randomUUID()}${ext}`);
      try {
        await fs.writeFile(temporary, download.buffer);
        assets.push(await store.completeAssetFile(sessionId, job.assetId, temporary, { kind, ext, cost: 0 }));
      } finally { await fs.rm(temporary, { force: true }); }
    } else assets.push(await store.saveAsset(sessionId, { kind, buffer: download.buffer, ext, prompt: job.prompt, model: job.model, cost: 0 }));
  }
  await store.mutateSession(sessionId, (session) => {
    const target = store.findSessionJob(session.jobs, job);
    if (!target || target.status === 'completed') return;
    Object.assign(target, { status: 'completed', kind: assets[0].kind, completedAt: new Date().toISOString(), resultAssetIds: assets.map((a) => a.id), file: assets[0].file });
    session.messages.push({ role: 'user', hidden: true, content: `[System] Magnific results: ${assets.map((a) => a.id).join(', ')}.`, ts: new Date().toISOString() });
  });
  return true;
}
async function runCall(ctx, args) {
  if (!magnific.status().connected) throw new Error(magnific.DISCONNECTED_MESSAGE);
  const name = String(args.tool || '');
  // Check the target first, then validate the fully resolved request before submission.
  if (!(await magnific.listTools()).some((tool) => tool.name === name)) throw new Error('Magnific: unknown tool.');
  const resolved = await resolveAssets(ctx, args.arguments || {});
  return submit(ctx, name, resolved);
}
async function upscaleArgs(creationId, mode, scale) {
  const args = { creationIdentifier: creationId, mode, scale: `${Number(scale)}x` };
  const tool = (await magnific.listTools()).find((t) => t.name === 'images_upscale');
  if (!tool) throw new Error('Magnific tool images_upscale is not available.');
  validate(args, tool.inputSchema);
  return args;
}
async function runUpscale(ctx, args) {
  const entry = (await store.readLedger(ctx.sessionId)).find((a) => a.id === args.asset_id);
  if (require('../nodes/assets').typeFromLedgerEntry(entry) !== 'image') throw new Error('Magnific upscale requires an image asset from this session.');
  const catalog = require('../nodes/magnific-catalog');
  await catalog.load();
  catalog.check(args.mode, Number(args.scale));
  const uploaded = await uploadAsset(ctx, args.asset_id);
  return submit(ctx, 'images_upscale', await upscaleArgs(uploaded.creationId, args.mode, args.scale));
}
// Node-only: one session asset goes in as creationIdentifier (or audioUrl/videoUrl/backgroundCreationIdentifier), the
// remaining arguments are the node's fixed params. The live input schema checks everything before any spend.
const MEDIA_FIELDS = { creationIdentifier: true, audioUrl: true, videoUrl: true };
async function mediaArgs(ctx, args) {
  const name = String(args.tool || '');
  const field = String(args.field || 'creationIdentifier');
  if (!MEDIA_FIELDS[field]) throw new Error('Magnific: unsupported input field.');
  const tool = (await magnific.listTools()).find((t) => t.name === name);
  if (!tool) throw new Error(`Magnific tool ${name} is not available for this account.`);
  const uploaded = await uploadAsset(ctx, args.asset_id);
  const extra = {};
  for (const [key, assetId] of Object.entries(args.extra_assets || {})) extra[key] = (await uploadAsset(ctx, assetId)).creationId;
  const full = { ...(args.arguments || {}), ...extra, [field]: uploaded.creationId };
  validate(full, tool.inputSchema);
  return { name, full };
}
async function runMedia(ctx, args) {
  if (!ctx?.nodeView) throw new Error('magnific_media is only available in the node view.');
  if (!magnific.status().connected) throw new Error(magnific.DISCONNECTED_MESSAGE);
  const { name, full } = await mediaArgs(ctx, args);
  return submit(ctx, name, full);
}
// video_generate for the node view: the prompt and settings of the node, a first frame as start keyframe, or (with an
// audio reference, which the schema does not allow next to a keyframe) the frame as image reference plus the audio.
// A character of the person's Magnific library (e.g. "gu" or "@gu") as a Seedance reference. The library answers as JSON or
// as an indented listing; both are read. An unknown name is an error, never a guess.
async function characterRef(name) {
  const wanted = String(name || '').trim().replace(/^@/, '');
  const answer = await checkedCall('library_list', { type: 'character', search: wanted });
  const found = [];
  for (const object of objects(answer)) {
    if (object && (typeof object.id === 'number' || /^\d+$/.test(String(object.id || ''))) && typeof object.name === 'string') found.push({ id: String(object.id), name: object.name });
  }
  const textAnswer = typeof answer?.text === 'string' ? answer.text : '';
  for (const match of textAnswer.matchAll(/-\s*id:\s*"?(\d+)"?\s*\n\s*name:\s*"?([^"\n]+?)"?\s*(?:\n|$)/g)) found.push({ id: match[1], name: match[2].trim() });
  const hit = found.find((entry) => entry.name.toLowerCase() === wanted.toLowerCase());
  if (!hit) throw new Error(`character: Magnific has no character named "${wanted}" in this account's library.`);
  return { type: 'character', custom_model_id: hit.id, name: hit.name, modifier_key: `@${hit.name}` };
}
async function videoArgs(ctx, args) {
  const tool = (await magnific.listTools()).find((t) => t.name === 'video_generate');
  if (!tool) throw new Error('Magnific tool video_generate is not available for this account.');
  const full = { prompt: String(args.prompt || '').slice(0, 30000), duration: Number(args.duration) };
  for (const key of ['slug', 'resolution', 'aspectRatio']) if (args[key]) full[key] = String(args[key]);
  if (typeof args.withSoundEffects === 'boolean') full.withSoundEffects = args.withSoundEffects;
  const frame = args.first_frame ? (await uploadAsset(ctx, args.first_frame)).creationId : null;
  const audio = args.audio ? (await uploadAsset(ctx, args.audio)).creationId : null;
  const character = args.character ? await characterRef(args.character) : null;
  // A character or an audio reference needs the references list; the frame then goes there too (start frames and references exclude each other).
  if (audio || character) {
    full.references = [...(frame ? [{ type: 'image', url: frame }] : []), ...(character ? [character] : []), ...(audio ? [{ type: 'audio', url: audio }] : [])];
    if (character && !full.prompt.includes(character.modifier_key)) full.prompt = `${full.prompt}\n${character.modifier_key} is the person of the character reference; keep his or her face exactly.`.slice(0, 30000);
  } else if (frame) full.keyframes = { start: { type: 'image', url: frame } };
  validate(full, tool.inputSchema);
  return full;
}
async function runVideo(ctx, args) {
  if (!ctx?.nodeView) throw new Error('magnific_video is only available in the node view.');
  if (!magnific.status().connected) throw new Error(magnific.DISCONNECTED_MESSAGE);
  const full = await videoArgs(ctx, args);
  // Magnific makes only a few videos of an account at the same time and refuses the next one with "parallel limit ...
  // a slot frees in ~300s" (nothing billed). A clip of a list then waits for a free slot instead of failing the node.
  const deadline = Date.now() + PARALLEL_WAIT_MS;
  for (;;) {
    try {
      return await submit(ctx, 'video_generate', full);
    } catch (err) {
      if (!/parallel limit/i.test(err.message || '') || Date.now() >= deadline) throw err;
      const hinted = Number((String(err.message).match(/~\s*(\d+)\s*s/) || [])[1]);
      const seconds = Math.min(Math.max(Number.isFinite(hinted) && hinted > 0 ? Math.ceil(hinted / 4) : 60, 20), 120) + Math.floor(Math.random() * 15);
      ctx.emit?.({ type: 'tool_start', tool: 'magnific_call', label: `Magnific: all video slots busy, next try in ${seconds} s` });
      await videoWait.pause(ctx, seconds * 1000);
    }
  }
}
const PARALLEL_WAIT_MS = 20 * 60 * 1000;
// An object so the tests can replace the pause.
const videoWait = { pause: (ctx, ms) => pause(ctx, ms) };
function pause(ctx, ms) {
  checkAborted(ctx);
  return new Promise((resolve, reject) => {
    const done = () => { ctx?.signal?.removeEventListener?.('abort', stop); resolve(); };
    const timer = setTimeout(done, ms);
    const stop = () => { clearTimeout(timer); try { checkAborted(ctx); } catch (err) { reject(err); } };
    ctx?.signal?.addEventListener?.('abort', stop, { once: true });
  });
}
async function runTools(_ctx, args) {
  const query = String(args.query || '').trim().toLowerCase();
  const found = (await magnific.listTools()).filter((tool) => `${tool.name} ${tool.description}`.toLowerCase().includes(query));
  const exact = found.find((tool) => tool.name.toLowerCase() === query);
  const selected = exact ? [exact] : found.slice(0, 20);
  const shortSchema = (schema) => ({ type: schema.type, required: schema.required,
    properties: Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => [key, {
      type: value.type, enum: value.enum, description: String(value.description || '').slice(0, 140),
      ...(value.items ? { items: { type: value.items.type } } : {}) }])) });
  return { toolResult: JSON.stringify({ total: found.length, tools: selected.map((tool) => ({ name: tool.name,
    description: String(tool.description || '').slice(0, 300), inputSchema: exact ? tool.inputSchema : shortSchema(tool.inputSchema) })),
    hint: 'Search an exact tool name for its full input schema.' }), inject: [] };
}
const executors = {
  magnific_balance: async () => ({ toolResult: JSON.stringify(await checkedCall('account_balance', {})), inject: [] }),
  magnific_tools: runTools,
  magnific_estimate: async (ctx, args) => ({ toolResult: JSON.stringify(await estimate(args.tool, await resolveAssets(ctx, args.arguments || {}))), inject: [] }),
  magnific_call: runCall,
  magnific_upscale_image: runUpscale,
  magnific_media: runMedia,
  magnific_video: runVideo
};
module.exports = { lastPolled, videoWait, characterRef, clearUploads, executors, parsed, objects, creditsOf, checkedCall, semanticCall, semanticArgs, creationIds, resultUrl, uploadAsset, upscaleArgs, mediaArgs, videoArgs, estimate, pollJob, JOB_TIMEOUT_MS };
