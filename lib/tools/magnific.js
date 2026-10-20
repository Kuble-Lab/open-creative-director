'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const magnific = require('../magnific');
const store = require('../store');
const costs = require('../costs');
const { validate } = require('../magnific-schema');

const JOB_TIMEOUT_MS = 10 * 60 * 1000;
const FREE = /^(account_balance|simulate_cost|creation_status|creations_(get|wait|search|request_upload|finalize_upload)|images_upscale_modes_list)$/;
const MIMES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4' };
function parsed(answer) {
  if (answer?.structured) return answer.structured;
  if (answer && typeof answer === 'object') return answer;
  try { return JSON.parse(answer); } catch (_) { return { text: String(answer || '') }; }
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
const idFields = (ids) => [['creation_ids|ids', ids], ['creation_id|id', ids[0]]];
function creationIds(value, allowBare = false) {
  const ids = [];
  const visit = (obj, context = '', depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 10) return;
    for (const key of ['creation_id', 'creationId']) if (typeof obj[key] === 'string') ids.push(obj[key]);
    for (const key of ['creation_ids', 'creationIds']) if (Array.isArray(obj[key])) ids.push(...obj[key].filter((v) => typeof v === 'string'));
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
  const filename = `${id}${ext}`;
  checkAborted(ctx);
  const requested = await semanticCall('creations_request_upload', [
    ['files', [{ filename, content_type: mime, size: stat.size }]],
    ['filename|file_name', filename], ['content_type|mime_type', mime], ['size|file_size', stat.size]
  ]);
  const upload = objects(requested).find((obj) => obj.upload_url || obj.uploadUrl);
  const url = upload?.upload_url || upload?.uploadUrl;
  let target;
  try { target = new URL(url); } catch (_) { throw new Error('Magnific did not return a secure upload URL.'); }
  if (target.protocol !== 'https:' || target.username || target.password || target.hash) throw new Error('Magnific did not return a secure upload URL.');
  const uploadId = upload.upload_id || upload.id || upload.creation_id;
  if (!uploadId) throw new Error('Magnific did not return an upload ID.');
  try {
    const response = await global.fetch(url, { method: 'PUT', redirect: 'error', body: await fs.readFile(file),
      headers: { 'Content-Type': upload.content_type || mime, 'Content-Length': String(stat.size) }, signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error();
  } catch (_) { throw new Error('Magnific upload failed or timed out.'); }
  const finalized = await semanticCall('creations_finalize_upload', [
    ['upload_ids', [uploadId]], ['upload_id|id', uploadId], ['files|uploads', [{ upload_id: uploadId, filename, content_type: mime }]]
  ]);
  const creationId = creationIds(finalized)[0];
  if (!creationId) throw new Error('Magnific did not confirm a creation ID for the upload.');
  const value = { creationId, url: objects(finalized).find((obj) => obj.url || obj.download_url)?.url || objects(finalized).find((obj) => obj.download_url)?.download_url };
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
  const ids = creationIds(result, /^(images_|video_|audio_)/.test(name));
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
    createdAt: new Date().toISOString(), timeoutAt: Date.now() + JOB_TIMEOUT_MS, cost: 0, costUnit: 'magnific_credits', billing: 'magnific_credits', credits,
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
  await semanticCall('creations_wait', idFields(ids), { timeoutMs: 10000 }).catch(() => {});
  return { toolResult: `Magnific job ${job.jobId}; result asset ${asset.id}. Billed in Magnific credits (${credits ?? 'unknown'}).`, inject: [], job };
}
async function pollJob(sessionId, job, { wait = false } = {}) {
  if (wait) await semanticCall('creations_wait', idFields(job.creationIds), { timeoutMs: 10000 });
  const states = [];
  for (const id of job.creationIds) states.push(await semanticCall('creation_status', idFields([id]), { timeoutMs: 15000 }));
  const statuses = states.flatMap((v) => objects(v).map((o) => String(o.status || '').toLowerCase())).filter(Boolean);
  if (statuses.some((s) => ['failed', 'error', 'cancelled', 'rejected'].includes(s))) throw new Error('Magnific creation failed.');
  if (states.some((state) => !objects(state).some((o) => ['completed', 'done', 'success', 'succeeded', 'ready'].includes(String(o.status || '').toLowerCase())))) return false;
  const details = await semanticCall('creations_get', idFields(job.creationIds));
  const records = objects(details).filter((o) => typeof (o.download_url || o.downloadUrl) === 'string');
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
  return semanticArgs('images_upscale', [['creation_id|image_id|image|source', creationId], ['creation_ids|images', [creationId]], ['mode', mode], ['scale|scale_factor', Number(scale)]]);
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
  magnific_upscale_image: runUpscale
};
module.exports = { clearUploads, executors, parsed, objects, creditsOf, checkedCall, semanticCall, semanticArgs, creationIds, uploadAsset, upscaleArgs, estimate, pollJob, JOB_TIMEOUT_MS };
