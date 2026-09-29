'use strict';

// REST and SSE API of the node view (SPEC §11). registerNodeRoutes(app, deps) is called by
// server.js before the catch-all route. Handlers are thin: validation, status mapping and
// response shapes live here, everything else is delegated to the workflow store, the engine
// and the asset helpers. Errors use the existing `{ error }` shape (plus `code` and details).

const archiver = require('archiver');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const sessionStore = require('../store');
const toolsLib = require('../tools');
const nodeRegistry = require('./registry');
const eventsLib = require('./events');
const assetsLib = require('./assets');
const workflowsStore = require('./workflows-store');
const elevenlabsLib = require('../elevenlabs');
const templatesLib = require('./templates');
const { isPlainObject } = require('./types');

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const MAX_SVG_BYTES = 10 * 1024 * 1024; // SVGs are read into memory for rasterisation
const SSE_PING_MS = 15000;
const MAX_FOLDER_LENGTH = 60; // mirrors MAX_FOLDER_NAME_LENGTH in lib/store.js
const MAX_FILENAME_LENGTH = 200;
const DRAIN_TIMEOUT_MS = 5000;
const MAX_SEND_ASSETS = 24; // media files one send-to-chat call copies
const MAX_SEND_TEXT = 8000;

const STATUS_BY_CODE = Object.freeze({
  INVALID_ID: 400,
  INVALID_WORKFLOW: 400,
  INVALID_REQUEST: 400,
  INVALID_GRAPH: 400,
  WORKFLOW_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  ENTRY_NOT_FOUND: 404,
  NOT_FOUND: 404,
  REV_CONFLICT: 409,
  RUN_ACTIVE: 409,
  CHAT_BUSY: 409,
  ASSET_PENDING: 409,
  UNSUPPORTED_MEDIA: 415,
  TOO_LARGE: 413,
  RUN_LIMIT: 429,
  UNAVAILABLE: 503,
  UPSTREAM: 502
});

// Upload MIME -> extension (same set as extFromDataUrl in lib/brain.js, limited to node media types).
const UPLOAD_MIME_EXT = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'video/mp4': '.mp4',
  'video/webm': '.webm'
});

function routeError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

// Maps an error to { status, body }. Unknown errors become 500 with their message.
function describeError(err) {
  const status = STATUS_BY_CODE[err?.code] || 500;
  const body = { error: err?.message || 'Unknown error' };
  if (STATUS_BY_CODE[err?.code]) body.code = err.code;
  if (err?.code === 'REV_CONFLICT' && err.rev !== undefined) body.rev = err.rev;
  if (err?.code === 'RUN_ACTIVE') body.runId = err.runId || null;
  if (err?.code === 'INVALID_GRAPH' && Array.isArray(err.issues)) body.issues = err.issues;
  return { status, body };
}

function sendError(res, err) {
  const { status, body } = describeError(err);
  if (status === 500) console.error('[nodes]', err);
  if (res.headersSent) {
    try {
      res.end();
    } catch (_) {
      /* connection already gone */
    }
    return;
  }
  res.status(status).json(body);
}

function cleanFolderInput(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw routeError('INVALID_REQUEST', 'folder must be a string or null');
  const clean = value.trim();
  if (!clean) return null;
  if ([...clean].length > MAX_FOLDER_LENGTH) {
    throw routeError('INVALID_REQUEST', `folder must be at most ${MAX_FOLDER_LENGTH} characters`);
  }
  return clean;
}

function cleanNameInput(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw routeError('INVALID_REQUEST', 'name must be a string');
  return value;
}

function safeDownloadName(name) {
  const ascii = String(name || 'workflow').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return ascii || 'workflow';
}

/* ---------- upload helpers ---------- */

function decodeFilename(header) {
  let raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return '';
  try {
    raw = decodeURIComponent(raw);
  } catch (_) {
    /* keep the raw header value */
  }
  // eslint-disable-next-line no-control-regex
  return path.basename(raw.replace(/[\u0000-\u001f\u007f]/g, '')).slice(0, MAX_FILENAME_LENGTH);
}

// Resolves the stored extension of an upload from its MIME type, else from the file name.
// Returns { ext } with a whitelisted media extension ({ ext: '.svg', svg: true } for SVG, which is rasterised
// to a PNG on upload), or { error } for unsupported files.
function uploadExtension(contentType, filename) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  const nameExt = path.extname(filename || '').toLowerCase();
  if (mime === 'image/svg+xml' || nameExt === '.svg') return { ext: '.svg', svg: true };
  let ext = UPLOAD_MIME_EXT[mime] || null;
  if (!ext && assetsLib.typeFromExtension(nameExt)) ext = nameExt === '.jpeg' ? '.jpg' : nameExt;
  if (!ext) return { error: `Unsupported file type${mime ? ` (${mime})` : ''}` };
  return { ext };
}

// Streams the request body into `file` without buffering it in memory. Rejects with TOO_LARGE as soon
// as the cap is exceeded (the rest of the body is discarded, the request is not destroyed so the
// error response can still be delivered) and with UPLOAD_ABORTED when the client goes away.
function receiveBody(req, file, maxBytes) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file, { flags: 'wx' });
    let bytes = 0;
    let settled = false;
    let over = false;
    let ended = false;
    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) {
        out.destroy();
        reject(err);
      } else {
        resolve(value);
      }
    };
    out.on('error', (err) => settle(err));
    req.on('data', (chunk) => {
      if (over || settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        over = true;
        settle(routeError('TOO_LARGE', `Upload is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`));
        return;
      }
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    });
    req.on('end', () => {
      ended = true;
      if (over) return;
      out.end(() => settle(null, bytes));
    });
    req.on('error', (err) => settle(err));
    req.on('close', () => {
      if (!ended) settle(routeError('UPLOAD_ABORTED', 'Upload was interrupted'));
    });
  });
}

// Answers before the body was read: the connection is closed after the response and the unread
// body is discarded (bounded by a timeout) so clients still get to see the status.
function respondAndDrain(req, res, err) {
  const { status, body } = describeError(err);
  res.setHeader?.('Connection', 'close');
  res.status(status).json(body);
  if (typeof req.resume === 'function') {
    req.resume();
    if (typeof req.destroy === 'function') {
      const timer = setTimeout(() => req.destroy(), DRAIN_TIMEOUT_MS);
      timer.unref?.();
      req.once('close', () => clearTimeout(timer));
    }
  }
}

// Stores an SVG upload like the chat does (storeImportedSessionAsset keeps the SVG and adds a 1024 px PNG)
// and returns the value of the PNG, the only variant image nodes can use.
async function rasterizeSvgUpload(sessionId, sourceFile, filename) {
  const buffer = await fsp.readFile(sourceFile);
  const name = /\.svg$/i.test(filename) ? filename : `${filename || 'upload'}.svg`;
  const imported = await toolsLib.storeImportedSessionAsset(
    { sessionId, emit() {} },
    { buffer, filename: name, prompt: `Upload: ${name}`, sourceLabel: 'SVG-Upload', mimeType: 'image/svg+xml', kind: 'upload' }
  );
  if (!imported.rasterAsset) {
    // Invalid SVG: do not leave the unusable source behind in the workflow's ledger.
    await sessionStore.withLock(sessionId, async () => {
      const entries = await sessionStore.readLedger(sessionId);
      await sessionStore.writeLedger(sessionId, entries.filter((entry) => entry.id !== imported.asset.id));
    });
    await fsp.rm(path.join(sessionStore.sessionAssetDir(sessionId), imported.asset.file), { force: true });
    throw routeError('UNSUPPORTED_MEDIA', 'The SVG could not be rasterised; upload a PNG instead');
  }
  return assetsLib.valueFromAsset(sessionId, imported.rasterAsset.id);
}

/* ---------- outputs.zip helpers ---------- */

const MAX_ZIP_ITEMS = 500;

// Flattens a (possibly nested) list value into its leaf values.
function leafValues(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (value.type === 'list' && Array.isArray(value.items)) {
    for (const item of value.items) leafValues(item, out);
  } else {
    out.push(value);
  }
  return out;
}

function zipEntryName(index, label, leafIndex, leafCount, ext) {
  const base = safeDownloadName(label || 'output').slice(0, 60);
  const number = String(index + 1).padStart(2, '0');
  const suffix = leafCount > 1 ? `-${String(leafIndex + 1).padStart(2, '0')}` : '';
  return `${number}-${base}${suffix}${ext}`;
}

// Output files of the output.result nodes: the currently selected results, or (with `run`) the
// history entries that run produced. Returns [{ name, file? , text? }] in canvas order.
function collectZipItems({ workflow, results, run, registry }) {
  const outputs = workflow.graph.nodes
    .filter((node) => node.type === 'output.result')
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const items = [];
  outputs.forEach((node, nodeIndex) => {
    const nodeResults = results.nodes?.[node.id];
    if (!nodeResults) return;
    let entry = null;
    let variantIndex = 0;
    if (run) {
      const entryId = run.nodes?.[node.id]?.entry;
      entry = entryId ? (nodeResults.history || []).find((item) => item.id === entryId) : null;
      if (entry && nodeResults.selected?.entry === entry.id) variantIndex = nodeResults.selected.variant || 0;
    } else if (nodeResults.selected) {
      entry = (nodeResults.history || []).find((item) => item.id === nodeResults.selected.entry);
      variantIndex = nodeResults.selected.variant || 0;
    }
    const variant = entry?.variants?.[variantIndex] || entry?.variants?.[0];
    if (!variant) return;
    const def = registry.get(node.type);
    const label = String(node.params?.label || node.title || (def && def.label) || node.id).trim();
    const leaves = [];
    for (const value of Object.values(variant)) leafValues(value, leaves);
    leaves.forEach((leaf, leafIndex) => {
      if (['image', 'video', 'audio'].includes(leaf.type) && typeof leaf.file === 'string') {
        items.push({ name: zipEntryName(nodeIndex, label, leafIndex, leaves.length, path.extname(leaf.file).toLowerCase() || ''), value: leaf });
      } else if (leaf.type === 'text' && typeof leaf.value === 'string') {
        items.push({ name: zipEntryName(nodeIndex, label, leafIndex, leaves.length, '.txt'), text: leaf.value });
      } else if (leaf.type === 'number' && Number.isFinite(leaf.value)) {
        items.push({ name: zipEntryName(nodeIndex, label, leafIndex, leaves.length, '.txt'), text: String(leaf.value) });
      }
    });
  });
  return items.slice(0, MAX_ZIP_ITEMS);
}

/* ---------- send-to-chat helpers ---------- */

// True while the last assistant message has tool calls without all of their tool results. A message
// appended in that gap would split the pair and every later provider request of the chat would be rejected.
function hasOpenToolCalls(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let index = list.length - 1;
  while (index >= 0 && list[index].role !== 'assistant') index -= 1;
  if (index < 0) return false;
  const calls = Array.isArray(list[index].tool_calls) ? list[index].tool_calls : [];
  if (!calls.length) return false;
  const answered = new Set(list.slice(index + 1).filter((item) => item.role === 'tool').map((item) => item.tool_call_id));
  return calls.some((call) => !answered.has(call.id));
}

// The variant of a node result that send-to-chat forwards: an explicit entry / variant, else the selected one.
function pickVariant(nodeResults, entryId, variantIndex) {
  const selected = nodeResults && nodeResults.selected;
  const wantedEntry = entryId || (selected && selected.entry);
  const entry = wantedEntry ? (nodeResults.history || []).find((item) => item.id === wantedEntry) : null;
  if (!entry) throw routeError('ENTRY_NOT_FOUND', 'There is no result to send yet');
  const index = variantIndex !== undefined && variantIndex !== null ? variantIndex : selected && selected.entry === entry.id ? selected.variant || 0 : 0;
  if (!Number.isInteger(index) || index < 0 || !entry.variants || !entry.variants[index]) {
    throw routeError('INVALID_REQUEST', 'variant does not exist');
  }
  return entry.variants[index];
}

/* ---------- routes ---------- */

function registerNodeRoutes(app, deps = {}) {
  const {
    publicRuntimeConfig = () => ({ brainModels: [] }),
    engine,
    store = workflowsStore.defaultStore,
    registry = nodeRegistry.registry,
    sessions = sessionStore,
    events = eventsLib,
    assets = assetsLib,
    elevenlabs = elevenlabsLib,
    higgsfieldCatalog = null,
    isTurnActive = (sessionId) => require('../brain').isTurnActive(sessionId),
    resolveTemplate = (id, options) => templatesLib.resolveTemplate(id, options),
    listTemplates = (options) => templatesLib.listTemplates(options),
    optionSources: extraOptionSources = {},
    maxUploadBytes = MAX_UPLOAD_BYTES,
    pingMs = SSE_PING_MS
  } = deps;
  if (!engine) throw new Error('registerNodeRoutes needs an engine');

  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      sendError(res, err);
    }
  };
  const userOf = (req) => (typeof req.kubleUser === 'string' && req.kubleUser.trim() ? req.kubleUser.trim() : 'lokal');
  const paramId = (req, name, label) => {
    const id = req.params?.[name];
    if (!sessions.isValidId(id)) throw routeError('INVALID_ID', `Invalid ${label} id`);
    return id;
  };
  const workflowIdOf = (req) => paramId(req, 'id', 'workflow');
  const bodyOf = (req) => (isPlainObject(req.body) ? req.body : {});

  /* ----- registry and options ----- */

  const optionSources = {
    'brain-models': async () =>
      (publicRuntimeConfig().brainModels || []).map((model) =>
        isPlainObject(model) ? { value: model.value ?? model.id, label: model.label ?? model.name ?? model.id } : { value: model, label: model }
      ),
    'elevenlabs-voices': async () => {
      if (!elevenlabs.hasKey()) throw routeError('UNAVAILABLE', 'ElevenLabs API key is not configured');
      let voices;
      try {
        voices = await elevenlabs.listVoices();
      } catch (err) {
        throw routeError('UPSTREAM', `ElevenLabs voices could not be loaded: ${err.message}`);
      }
      return voices.map((voice) => ({ value: voice.voice_id, label: voice.name, ...(voice.labels ? { labels: voice.labels } : {}) }));
    },
    'higgsfield-image-models': async () => higgsfieldOptions('image'),
    'higgsfield-video-models': async () => higgsfieldOptions('video'),
    ...extraOptionSources
  };

  function requireCatalog() {
    if (!higgsfieldCatalog) throw routeError('UNAVAILABLE', 'The Higgsfield model catalogue is not available');
    return higgsfieldCatalog;
  }

  async function higgsfieldOptions(type) {
    const models = await requireCatalog().listModels(type);
    return (models || []).map((model) => ({ value: model.id, label: model.name || model.id }));
  }

  app.get('/api/nodes/registry', wrap(async (_req, res) => {
    res.json(registry.publicRegistry());
  }));

  app.get('/api/nodes/options/:source', wrap(async (req, res) => {
    const source = String(req.params.source || '');
    const loader = Object.prototype.hasOwnProperty.call(optionSources, source) ? optionSources[source] : null;
    if (!loader) throw routeError('NOT_FOUND', 'Unknown option source');
    res.json({ options: await loader(req) });
  }));

  app.get('/api/nodes/higgsfield-models/:modelId', wrap(async (req, res) => {
    const modelId = String(req.params.modelId || '');
    if (!modelId || modelId.length > 200) throw routeError('INVALID_REQUEST', 'Invalid model id');
    const catalog = requireCatalog();
    const model = await catalog.getModel(modelId);
    if (!model) throw routeError('NOT_FOUND', 'Model not found');
    res.json(typeof catalog.describeModel === 'function' ? catalog.describeModel(model) : { model });
  }));

  /* ----- workflows ----- */

  // Starter workflows (SPEC §15) with their availability on this server; ?lang=de|en|es translates texts.
  app.get('/api/workflow-templates', wrap(async (req, res) => {
    const lang = templatesLib.pickLang(typeof req.query?.lang === 'string' ? req.query.lang : '');
    res.json({ templates: await listTemplates({ lang }) });
  }));

  app.get('/api/workflows', wrap(async (req, res) => {
    const q = typeof req.query?.q === 'string' ? req.query.q : undefined;
    res.json({ workflows: await store.listWorkflows({ q }) });
  }));

  app.post('/api/workflows', wrap(async (req, res) => {
    const body = bodyOf(req);
    const name = cleanNameInput(body.name);
    const folder = cleanFolderInput(body.folder);
    let document = body.document;
    if (document === undefined || document === null) {
      document = undefined;
      if (body.templateId !== undefined && body.templateId !== null) {
        if (typeof body.templateId !== 'string' || !body.templateId) throw routeError('INVALID_REQUEST', 'templateId must be a string');
        document = await resolveTemplate(body.templateId, { lang: templatesLib.pickLang(body.lang) });
        if (!document) throw routeError('NOT_FOUND', 'Template not found');
      }
    } else if (Buffer.byteLength(JSON.stringify(document)) > store.limits.maxDocumentBytes) {
      throw routeError('TOO_LARGE', 'Document is larger than 2 MB');
    }
    const created = await store.createWorkflow({ name, folder: folder || null, document, user: userOf(req) });
    res.status(201).json(created);
  }));

  // Registered before the `:id` routes so `import` is never mistaken for a workflow id.
  app.post('/api/workflows/import', wrap(async (req, res) => {
    const body = bodyOf(req);
    if (!isPlainObject(body.document)) throw routeError('INVALID_REQUEST', 'document is required');
    if (Buffer.byteLength(JSON.stringify(body.document)) > store.limits.maxDocumentBytes) {
      throw routeError('TOO_LARGE', 'Document is larger than 2 MB');
    }
    const created = await store.createWorkflow({
      document: body.document,
      name: cleanNameInput(body.name),
      folder: cleanFolderInput(body.folder) || null,
      user: userOf(req)
    });
    res.status(201).json(created);
  }));

  app.get('/api/workflows/:id', wrap(async (req, res) => {
    const id = workflowIdOf(req);
    const { workflow, results } = await store.getWorkflow(id);
    res.json({ workflow, results, activeRun: engine.activeRun(id)?.runId || null });
  }));

  app.put('/api/workflows/:id', wrap(async (req, res) => {
    const id = workflowIdOf(req);
    const body = bodyOf(req);
    const saved = await store.saveGraph(id, {
      baseRev: body.baseRev,
      graph: body.graph,
      // The name is deliberately not taken from the autosave: a stale tab would undo a rename made elsewhere.
      // Renaming goes through PATCH only.
      description: body.description === undefined || body.description === null ? undefined : String(body.description),
      app: body.app,
      user: userOf(req)
    });
    res.json(saved);
  }));

  app.patch('/api/workflows/:id', wrap(async (req, res) => {
    const id = workflowIdOf(req);
    const body = bodyOf(req);
    const name = cleanNameInput(body.name);
    const folder = cleanFolderInput(body.folder);
    if (name === undefined && folder === undefined) throw routeError('INVALID_REQUEST', 'name or folder is required');
    await store.readWorkflow(id);
    res.json(await store.patchMeta(id, { name, folder, user: userOf(req) }));
  }));

  // Deletes the workflow including its backing session and all assets; the UI asks for confirmation.
  app.delete('/api/workflows/:id', wrap(async (req, res) => {
    const id = workflowIdOf(req);
    await store.readWorkflow(id);
    const active = engine.activeRun(id);
    if (active) throw routeError('RUN_ACTIVE', 'A run is active for this workflow; cancel it first', { runId: active.runId });
    await store.deleteWorkflow(id);
    res.json({ ok: true, id });
  }));

  app.post('/api/workflows/:id/duplicate', wrap(async (req, res) => {
    const id = workflowIdOf(req);
    const name = cleanNameInput(bodyOf(req).name);
    await store.readWorkflow(id);
    res.status(201).json(await store.duplicateWorkflow(id, { name: name || undefined, user: userOf(req) }));
  }));

  app.get('/api/workflows/:id/export', wrap(async (req, res) => {
    const id = workflowIdOf(req);
    const document = await store.exportWorkflow(id);
    const filename = `${safeDownloadName(document.name)}.ocd-workflow.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(`${document.name}.ocd-workflow.json`)}`
    );
    res.send(JSON.stringify(document, null, 2));
  }));

  /* ----- assets ----- */

  app.post('/api/workflows/:id/uploads', wrap(async (req, res) => {
    const id = workflowIdOf(req);
    const workflow = await store.readWorkflow(id);
    const filename = decodeFilename(req.headers?.['x-filename']);
    const resolved = uploadExtension(req.headers?.['content-type'], filename);
    if (resolved.error) return respondAndDrain(req, res, routeError('UNSUPPORTED_MEDIA', resolved.error));
    const accept = typeof req.query?.accept === 'string' ? req.query.accept : '';
    // An SVG becomes a PNG on upload, so it counts as an image.
    const uploadType = resolved.svg ? 'image' : assets.typeFromExtension(resolved.ext);
    if (accept && uploadType !== accept) {
      return respondAndDrain(req, res, routeError('UNSUPPORTED_MEDIA', `Expected a ${accept} file`));
    }
    const limit = resolved.svg ? Math.min(maxUploadBytes, MAX_SVG_BYTES) : maxUploadBytes;
    const declared = Number.parseInt(req.headers?.['content-length'], 10);
    if (Number.isFinite(declared) && declared > limit) {
      return respondAndDrain(req, res, routeError('TOO_LARGE', `Upload is larger than ${Math.round(limit / (1024 * 1024))} MB`));
    }

    const scratch = await assets.createScratchDir(workflow.sessionId);
    let value = null;
    let rasterized = false;
    let failure = null;
    try {
      const sourceFile = path.join(scratch, `upload${resolved.ext}`);
      const bytes = await receiveBody(req, sourceFile, limit);
      if (bytes === 0) throw routeError('INVALID_REQUEST', 'Upload is empty');
      if (resolved.svg) {
        value = await rasterizeSvgUpload(workflow.sessionId, sourceFile, filename);
        rasterized = true;
      } else {
        value = await assets.saveUploadFile(workflow.sessionId, { sourceFile, ext: resolved.ext, name: filename });
      }
    } catch (err) {
      failure = err;
    } finally {
      // Clean up before answering so a finished request never leaves temp files behind.
      await assets.removeScratchDir(scratch);
    }
    if (failure) {
      if (failure.code === 'UPLOAD_ABORTED') return; // nobody is listening any more
      if (failure.code === 'TOO_LARGE') return respondAndDrain(req, res, failure);
      throw failure;
    }
    res.json(rasterized ? { value, rasterized: true } : { value });
  }));

  // Copies a finished asset from any chat session into the backing session and returns its value.
  app.post('/api/workflows/:id/import-asset', wrap(async (req, res) => {
    const id = workflowIdOf(req);
    const body = bodyOf(req);
    if (!sessions.isValidId(body.sessionId)) throw routeError('INVALID_ID', 'Invalid session id');
    if (!sessions.isValidId(body.assetId)) throw routeError('INVALID_ID', 'Invalid asset id');
    const workflow = await store.readWorkflow(id);
    const ledger = await sessions.readLedger(body.sessionId);
    const entry = ledger.find((item) => item.id === body.assetId);
    if (!entry) throw routeError('NOT_FOUND', 'Asset not found');
    if (entry.pending) throw routeError('ASSET_PENDING', 'Asset is not finished yet');
    if (!assets.typeFromLedgerEntry(entry)) throw routeError('UNSUPPORTED_MEDIA', 'Asset cannot be used as image, video or audio');
    const value =
      body.sessionId === workflow.sessionId
        ? assets.valueFromLedgerEntry(workflow.sessionId, entry)
        : await assets.copyAsset(body.sessionId, body.assetId, workflow.sessionId);
    res.json({ value });
  }));

  app.get('/api/workflows/:id/assets', wrap(async (req, res) => {
    const id = workflowIdOf(req);
    const workflow = await store.readWorkflow(id);
    res.json({ assets: await assets.listSessionAssets(workflow.sessionId) });
  }));

  // Copies the media of a node result into a chat session and appends a visible user message with
  // `uploadIds` (rendered as upload bubble by the chat); text results are quoted in the message.
  app.post('/api/workflows/:id/send-to-chat', wrap(async (req, res) => {
    const id = workflowIdOf(req);
    const body = bodyOf(req);
    if (!sessions.isValidId(body.sessionId)) throw routeError('INVALID_ID', 'Invalid session id');
    const nodeId = String(body.nodeId || '');
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(nodeId)) throw routeError('INVALID_ID', 'Invalid node id');
    if (body.entry !== undefined && body.entry !== null && (typeof body.entry !== 'string' || !sessions.isValidId(body.entry))) {
      throw routeError('INVALID_REQUEST', 'entry must be a history entry id');
    }
    if (body.variant !== undefined && body.variant !== null && (!Number.isInteger(body.variant) || body.variant < 0)) {
      throw routeError('INVALID_REQUEST', 'variant must be a non-negative integer');
    }
    if (body.port !== undefined && body.port !== null && (typeof body.port !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(body.port))) {
      throw routeError('INVALID_REQUEST', 'port must be a port id');
    }
    const { workflow, results } = await store.getWorkflow(id);
    if (body.sessionId === workflow.sessionId) throw routeError('INVALID_REQUEST', 'Choose a chat as target');
    let chat;
    try {
      chat = await sessions.readSession(body.sessionId);
    } catch (err) {
      if (err.code === 'ENOENT') throw routeError('NOT_FOUND', 'Chat not found');
      throw err;
    }
    if (chat.kind === 'workflow') throw routeError('INVALID_REQUEST', 'Choose a chat as target');
    const busyError = () => routeError('CHAT_BUSY', 'The Director is still working in this chat. Try again when it has finished.');
    if (isTurnActive(body.sessionId) || hasOpenToolCalls(chat.messages)) throw busyError();
    const node = workflow.graph.nodes.find((item) => item.id === nodeId);
    const nodeResults = results.nodes && results.nodes[nodeId];
    if (!node || !nodeResults) throw routeError('NOT_FOUND', 'There are no results to send yet');
    const variant = pickVariant(nodeResults, body.entry || undefined, body.variant === null ? undefined : body.variant);
    const ports = body.port ? [body.port] : Object.keys(variant);
    const leaves = [];
    for (const port of ports) if (port in variant) leafValues(variant[port], leaves);

    const media = [];
    const seen = new Set();
    for (const leaf of leaves) {
      if (!['image', 'video', 'audio'].includes(leaf.type) || !sessions.isValidId(leaf.assetId) || !sessions.isValidId(leaf.sessionId)) continue;
      const key = `${leaf.sessionId}/${leaf.assetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      media.push(leaf);
    }
    if (media.length > MAX_SEND_ASSETS) throw routeError('INVALID_REQUEST', `At most ${MAX_SEND_ASSETS} files can be sent at once`);
    const texts = leaves
      .filter((leaf) => (leaf.type === 'text' && typeof leaf.value === 'string') || (leaf.type === 'number' && Number.isFinite(leaf.value)))
      .map((leaf) => String(leaf.value).trim())
      .filter(Boolean);
    if (!media.length && !texts.length) throw routeError('NOT_FOUND', 'The result has nothing to send');

    const label = String(node.params?.label || node.title || registry.get(node.type)?.label || node.id).trim();
    const copied = [];
    try {
      for (const leaf of media) copied.push(await assets.copyAsset(leaf.sessionId, leaf.assetId, body.sessionId));
    } catch (err) {
      throw routeError('UNSUPPORTED_MEDIA', `A file could not be copied to the chat: ${err.message}`);
    }
    const lines = [`[Workflow «${workflow.name}»] Ergebnis «${label}» aus der Node-Ansicht uebernommen.`];
    if (copied.length) lines.push(`Gespeichert als Asset ${copied.map((value) => value.assetId).join(', ')}.`);
    if (texts.length) lines.push(`Text:\n${texts.join('\n---\n').slice(0, MAX_SEND_TEXT)}`);
    const message = { role: 'user', content: lines.join('\n'), ts: new Date().toISOString() };
    if (copied.length) message.uploadIds = copied.map((value) => value.assetId);
    await sessions.mutateSession(body.sessionId, (session) => {
      if (isTurnActive(body.sessionId) || hasOpenToolCalls(session.messages)) throw busyError();
      session.messages.push(message);
    });
    res.json({ ok: true, sessionId: body.sessionId, assetIds: copied.map((value) => value.assetId), texts: texts.length });
  }));

  /* ----- runs and events ----- */

  // The run user always comes from the authenticated request, never from the body.
  function runRequestOf(req) {
    const body = bodyOf(req);
    const request = { mode: body.mode, nodeIds: body.nodeIds, force: body.force === true, overrides: body.overrides, user: userOf(req) };
    if (body.rev !== undefined && body.rev !== null) {
      if (!Number.isInteger(body.rev)) throw routeError('INVALID_REQUEST', 'rev must be an integer');
      request.rev = body.rev;
    }
    return request;
  }

  app.post('/api/workflows/:id/runs/plan', wrap(async (req, res) => {
    const id = workflowIdOf(req);
    res.json(await engine.plan(id, runRequestOf(req)));
  }));

  app.post('/api/workflows/:id/runs', wrap(async (req, res) => {
    const id = workflowIdOf(req);
    const runId = await engine.start(id, runRequestOf(req));
    res.status(202).json({ runId });
  }));


  // Recent run records (newest first) without the per-node detail; feeds the cost summary of the UI.
  app.get('/api/workflows/:id/runs', wrap(async (req, res) => {
    const id = workflowIdOf(req);
    await store.readWorkflow(id);
    const limit = Math.max(1, Math.min(50, Number.parseInt(req.query?.limit, 10) || 10));
    const runs = (await store.listRuns(id)).slice(0, limit).map((run) => ({
      id: run.id,
      mode: run.mode,
      targets: run.targets,
      force: Boolean(run.force),
      user: run.user,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt || null,
      cost: run.cost || { usd: 0, credits: 0 },
      error: run.error || null
    }));
    res.json({ runs });
  }));

  // ZIP of the selected results of all output.result nodes (or of the entries one run produced).
  app.get('/api/workflows/:id/outputs.zip', wrap(async (req, res) => {
    const id = workflowIdOf(req);
    const { workflow, results } = await store.getWorkflow(id);
    let run = null;
    if (req.query?.runId !== undefined) {
      const runId = String(req.query.runId);
      if (!sessions.isValidId(runId)) throw routeError('INVALID_ID', 'Invalid run id');
      run = await store.readRun(id, runId);
    }
    const items = collectZipItems({ workflow, results, run, registry });
    if (!items.length) throw routeError('NOT_FOUND', 'There are no results to download yet');

    const filename = `${safeDownloadName(workflow.name)}-outputs.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(`${workflow.name}-outputs.zip`)}`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
      if (res.headersSent) {
        res.destroy(err);
        return;
      }
      res.removeHeader('Content-Disposition');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      sendError(res, err);
    });
    archive.pipe(res);
    for (const item of items) {
      if (item.text !== undefined) {
        archive.append(item.text, { name: item.name });
      } else {
        try {
          archive.file(assets.assetFilePath(item.value), { name: item.name });
        } catch (_) {
          /* a value without a stored file is skipped */
        }
      }
    }
    await archive.finalize();
  }));

  app.get('/api/workflows/:id/runs/:runId', wrap(async (req, res) => {
    const id = workflowIdOf(req);
    const runId = paramId(req, 'runId', 'run');
    await store.readWorkflow(id);
    res.json(await store.readRun(id, runId));
  }));

  app.post('/api/workflows/:id/runs/:runId/cancel', wrap(async (req, res) => {
    const id = workflowIdOf(req);
    const runId = paramId(req, 'runId', 'run');
    await store.readWorkflow(id);
    res.json({ ok: engine.cancel(id, runId) });
  }));

  // Selects a history entry and variant of a node (engine-owned results.json).
  app.patch('/api/workflows/:id/results/:nodeId', wrap(async (req, res) => {
    const id = workflowIdOf(req);
    const nodeId = String(req.params.nodeId || '');
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(nodeId)) throw routeError('INVALID_ID', 'Invalid node id');
    const body = bodyOf(req);
    if (typeof body.entry !== 'string' || !body.entry) throw routeError('INVALID_REQUEST', 'entry is required');
    const variant = body.variant === undefined ? 0 : body.variant;
    if (!Number.isInteger(variant) || variant < 0) throw routeError('INVALID_REQUEST', 'variant must be a non-negative integer');
    await store.readWorkflow(id);
    res.json(await store.selectVariant(id, nodeId, { entry: body.entry, variant }));
  }));

  app.get('/api/workflows/:id/events', wrap(async (req, res) => {
    const id = workflowIdOf(req);
    await store.readWorkflow(id);
    if (res.destroyed) return; // the client left while the workflow was being read

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    let closed = false;
    let unsubscribe = () => {};
    let keepAlive = null;
    const cleanup = () => {
      closed = true;
      unsubscribe();
      if (keepAlive) clearInterval(keepAlive);
    };
    const write = (chunk) => {
      if (closed) return;
      try {
        res.write(chunk);
      } catch (_) {
        cleanup();
      }
    };
    res.on('close', cleanup);

    // Snapshot and subscription happen in the same tick, so no event is lost in between.
    write(`data: ${JSON.stringify({ type: 'snapshot', activeRun: engine.activeRun(id) })}\n\n`);
    unsubscribe = events.subscribe(id, (event) => write(`data: ${JSON.stringify(event)}\n\n`));
    if (closed) unsubscribe();
    else {
      keepAlive = setInterval(() => write(': ping\n\n'), pingMs);
      keepAlive.unref?.();
    }
  }));
}

module.exports = {
  MAX_UPLOAD_BYTES,
  MAX_SVG_BYTES,
  SSE_PING_MS,
  STATUS_BY_CODE,
  registerNodeRoutes,
  describeError,
  uploadExtension,
  collectZipItems,
  pickVariant
};
