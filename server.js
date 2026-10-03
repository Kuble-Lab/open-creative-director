'use strict';

const express = require('express');
const compression = require('compression');
const path = require('path');
const archiver = require('archiver');

const {
  PATHS,
  loadEnv,
  loadConfig,
  availableBrainModels,
  availableDefaultBrain
} = require('./lib/config');
const store = require('./lib/store');
const or = require('./lib/openrouter');
const brain = require('./lib/brain');
const tools = require('./lib/tools');
const videoModels = require('./lib/video-models');
const workflowRuns = require('./lib/workflow-runs');
const videoRefusal = require('./lib/video-refusal');
const resultMeta = require('./lib/result-meta');
const gts = require('./lib/gts');
const fal = require('./lib/fal');
const poller = require('./lib/poller');
const discovery = require('./lib/discovery');
const rendernode = require('./lib/rendernode');
const renderNodesStore = require('./lib/rendernodes-store');
const costs = require('./lib/costs');
const brandings = require('./lib/brandings');
const brandingImport = require('./lib/branding-import');
const roles = require('./lib/roles');
const publicrefs = require('./lib/publicrefs');
const cast = require('./lib/cast');
const { createWhoamiMiddleware } = require('./lib/whoami');
const settings = require('./lib/settings');
const higgsfield = require('./lib/higgsfield');
const chatgpt = require('./lib/chatgpt');
const chatgptFallback = require('./lib/chatgpt-fallback');
const promptPresets = require('./lib/prompt-presets');
const admins = require('./lib/admins');
const access = require('./lib/access');
const users = require('./lib/users');
const teams = require('./lib/teams');
const teamGroups = require('./lib/team-groups');
const budget = require('./lib/budget');
const accessSync = require('./lib/access-sync');
const adminMonitoring = require('./lib/admin-monitoring');
const nodeWorkflows = require('./lib/nodes/workflows-store');
const { createEngine: createNodeEngine } = require('./lib/nodes/engine');
const { registerNodeRoutes } = require('./lib/nodes/routes');
const { createRunService, installRunService } = require('./lib/nodes/run-service');
const nodeHiggsfieldCatalog = require('./lib/nodes/higgsfield-catalog');

loadEnv();
settings.loadSettings();
store.ensureDirs();

const fileConfig = loadConfig();
const runtime = {
  imageModel: fileConfig.imageModel,
  imageModels: fileConfig.imageModels,
  videoModel: fileConfig.videoModel,
  brainModels: fileConfig.brainModels,
  defaultBrain: fileConfig.defaultBrain,
  restrictedBrainModels: fileConfig.restrictedBrainModels,
  publicBaseUrl: fileConfig.publicBaseUrl
};

const BASE_PORT = Number.parseInt(process.env.PORT, 10) || 3111;
const app = express();
let higgsfieldConnectTimer = null;
let higgsfieldPollInFlight = false;
let higgsfieldBalanceCache = null;

app.use(createWhoamiMiddleware());
// While a restriction is active (teams in use or INTERNAL_EMAIL_DOMAINS, see lib/access.js restrictionActive) an anonymous
// caller may be a participant whose login could not be confirmed: every /api route except the public ones answers 401
// LOGIN_UNCONFIRMED. Mounted before everything else so it also covers the SSE streams.
app.use(access.createUnconfirmedGuard());
// User management (only with AUTH_WHOAMI_URL): every identified person is recorded for the team list, and failed
// API requests go to the small monitoring journal.
const apiMonitor = adminMonitoring.createMonitor();
app.use((req, res, next) => {
  if (!access.isActive()) return next();
  const email = access.normalizeEmail(req.kubleUser);
  if (email) {
    try {
      users.touch(email);
    } catch (err) {
      console.warn('[users]', err.message);
    }
  }
  return apiMonitor.middleware(req, res, next);
});
app.use(compression({
  filter: (req, res) => {
    const type = String(res.getHeader('Content-Type') || '');
    if (type.includes('text/event-stream')) return false;
    return compression.filter(req, res);
  }
}));
app.use(express.json({ limit: '60mb' }));
// Usage and cost monitoring page: superadmins only, everybody else gets a plain 404.
app.use((req, res, next) => {
  let page;
  try {
    page = path.posix.normalize(decodeURIComponent(req.path)).toLowerCase();
  } catch (_) {
    return next();
  }
  if (page !== '/monitoring.html') return next();
  res.set('Cache-Control', 'no-store');
  if (!isSuperAdmin(req)) return res.sendStatus(404);
  return res.sendFile(path.join(PATHS.root, 'views', 'monitoring.html'));
});
app.use(express.static(PATHS.publicDir));

// Session assets. With user management the session behind /assets/<sessionId>/... decides: somebody who may not
// see the chat or workflow gets a 404, exactly like for an unknown id.
const assetStatic = express.static(PATHS.assetsDir, { maxAge: '30d', immutable: true });
const assetStaticPrivate = express.static(PATHS.assetsDir, {
  maxAge: '30d',
  immutable: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'private, max-age=2592000, immutable')
});
// An SVG opened directly is a document of the app's origin: keep scripts in it from running (it is still shown as an
// image wherever it is embedded), and let no response be read as another type.
app.use('/assets', (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  let name = String(req.path || '');
  try {
    name = decodeURIComponent(name);
  } catch (_) {
    /* an undecodable path is refused by the handlers below */
  }
  if (/\.svg$/i.test(name)) res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  next();
});
app.use('/assets', async (req, res, next) => {
  const viewer = access.viewerOf(req);
  if (!viewer.active) return assetStatic(req, res, next);
  // The static handler decodes the path itself and would follow ".." inside the assets folder into another
  // session, so the decoded path must be a plain /<sessionId>/<file...> without dot segments or a second layer of escapes.
  let decodedPath = '';
  try {
    decodedPath = decodeURIComponent(String(req.path || ''));
  } catch (_) {
    return res.sendStatus(404);
  }
  const segments = decodedPath.split('/').slice(1);
  if (
    decodedPath.includes('%') ||
    segments.length < 2 ||
    segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0'))
  ) {
    return res.sendStatus(404);
  }
  const sessionId = segments[0];
  if (!store.isValidId(sessionId)) return res.sendStatus(404);
  try {
    if (!access.canUse(await store.readSessionAccess(sessionId), viewer)) return res.sendStatus(404);
  } catch (_) {
    return res.sendStatus(404);
  }
  return assetStaticPrivate(req, res, next);
});

const PUBLIC_REF_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac'
};

app.get('/refs/:file', (req, res) => {
  const file = publicrefs.safeRefFilename(req.params.file);
  if (!file) return res.sendStatus(404);
  res.set('Cache-Control', 'private, max-age=0');
  res.type(PUBLIC_REF_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.sendFile(file, { root: PATHS.publicRefsDir, dotfiles: 'deny' }, (err) => {
    if (!err || res.headersSent) return;
    res.sendStatus(err.statusCode === 404 ? 404 : 500);
  });
});

/* ---------- helpers ---------- */

function fail(res, status, message) {
  res.status(status).json({ error: message });
}

const parseBrandingZipBody = express.raw({
  type: () => true,
  limit: brandingImport.MAX_ZIP_BYTES
});

function brandingZipBody(req, res, next) {
  parseBrandingZipBody(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') {
      return fail(res, 413, 'Das ZIP darf maximal 80 MB gross sein.');
    }
    return fail(res, 400, `Das ZIP konnte nicht empfangen werden: ${err.message}`);
  });
}

// Local mode (no AUTH_WHOAMI_URL): everybody. Otherwise admins (ADMIN_EMAILS, stored admins, superadmins).
function isAdmin(req) {
  return access.viewerOf(req).admin;
}

// SUPERADMIN_EMAILS only; never true in the local mode.
function isSuperAdmin(req) {
  return access.viewerOf(req).superadmin;
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  fail(res, 403, 'Zugriff verweigert.');
  return false;
}

function failWithCode(res, status, code, message) {
  res.status(status).json({ error: message, code });
}

// Participants and guests (lib/access.js): no internal resources, no existing data.
function isRestricted(req) {
  return access.isRestricted(access.viewerOf(req));
}

// Answers the errors of the account rules: 402 for the budget, 403 for something the account may not use.
// Returns true when it answered.
function failAccountRule(res, err) {
  if (err instanceof budget.BudgetError) {
    res.status(err.status).json({ error: err.messageDe, code: err.code, budget: err.budget, estimateUsd: err.estimateUsd, remainingUsd: err.remainingUsd });
    return true;
  }
  if (err instanceof access.RoleRestrictedError) {
    res.status(err.status).json({ error: err.messageDe, code: err.code, feature: err.feature });
    return true;
  }
  if (err instanceof access.LoginUnconfirmedError) {
    res.status(err.status).json({ error: err.messageDe, code: err.code, messages: err.messages });
    return true;
  }
  return false;
}

// 403 for participants and guests, with the feature named so the client can explain it.
function requireUnrestricted(req, res, feature, messageDe) {
  if (!isRestricted(req)) return true;
  failAccountRule(res, new access.RoleRestrictedError(feature, `${feature} is not available for your account`, messageDe));
  return false;
}

// Access to a chat for the request: 'use' (see, chat, edit settings), 'manage' (rename, move, delete) or 'share'.
// Answers 404 for a session the caller may not see and 403 for missing rights on one they can see.
// No-op (and no file read) in the local mode.
async function guardSession(req, res, id, level = 'use') {
  const viewer = access.viewerOf(req);
  if (!viewer.active) return true;
  let sharing;
  try {
    sharing = await store.readSessionAccess(id);
  } catch (err) {
    if (err.code === 'ENOENT') fail(res, 404, 'Session nicht gefunden');
    else fail(res, 500, err.message);
    return false;
  }
  if (!access.canUse(sharing, viewer)) {
    fail(res, 404, 'Session nicht gefunden');
    return false;
  }
  if (level === 'manage' && !access.canManage(sharing, viewer)) {
    failWithCode(res, 403, 'FORBIDDEN', 'Nur Besitzer oder Admins duerfen das aendern.');
    return false;
  }
  if (level === 'share' && !access.canShare(sharing, viewer)) {
    failWithCode(res, 403, 'FORBIDDEN', sharing.owner
      ? 'Nur Besitzer oder Admins duerfen die Freigabe aendern.'
      : 'Die Freigabe bestehender Eintraege aendern nur Admins.');
    return false;
  }
  return true;
}

// Project folders. A folder has no owner: what is in it decides. Somebody sees a folder if it is empty or holds at
// least one chat or workflow they may use; a folder that only holds other people's private entries does not exist
// for them. Renaming or deleting a folder needs admin rights or that every entry in it is the caller's (or has no owner).
async function folderEntries() {
  const { sessions } = await store.listSessions({ limit: Number.MAX_SAFE_INTEGER, includeHidden: true, includeSharing: true });
  const byFolder = new Map();
  for (const entry of sessions) {
    if (!entry.folder) continue;
    if (!byFolder.has(entry.folder)) byFolder.set(entry.folder, []);
    byFolder.get(entry.folder).push(entry);
  }
  return byFolder;
}

// Participants and guests see a project when it holds something they may use or when they created it themselves;
// an empty project of somebody else (an internal one) does not exist for them.
async function canUseFolder(req, name) {
  const viewer = access.viewerOf(req);
  if (!viewer.active || viewer.admin) return true;
  const entries = (await folderEntries()).get(name) || [];
  if (access.isRestricted(viewer)) {
    if (entries.some((entry) => access.canUse(entry, viewer))) return true;
    const owner = await store.folderOwner(name);
    if (owner) return Boolean(viewer.email) && owner === viewer.email;
    // A project without a creator on record is existing data: only a name that does not exist yet is free to use.
    return !(await store.listFolders()).some((existing) => store.sameFolderName(existing, name));
  }
  return entries.length === 0 || entries.some((entry) => access.canUse(entry, viewer));
}

// The project was created by the caller (only then a participant sees its production profile and cast).
async function ownsFolder(req, name) {
  const viewer = access.viewerOf(req);
  if (!viewer.active || viewer.admin) return true;
  return Boolean(viewer.email) && (await store.folderOwner(name)) === viewer.email;
}

async function canManageFolder(req, name) {
  const viewer = access.viewerOf(req);
  if (!viewer.active || viewer.admin) return true;
  const entries = (await folderEntries()).get(name) || [];
  return entries.every((entry) => access.canManage(entry, viewer));
}

// Why the caller may not rename or delete a project (null = may). Besides other people's entries there is admin-maintained
// data: the production profile (guidelines, context files, memory) and the cast belong to the admin-only routes, and
// deleting or renaming the project would remove or move exactly that data.
async function folderManageDenial(req, name, verb) {
  const viewer = access.viewerOf(req);
  if (!viewer.active || viewer.admin) return null;
  if (!(await canManageFolder(req, name))) {
    return `Nur Admins duerfen ein Projekt mit Eintraegen anderer Personen ${verb}.`;
  }
  const hasAdminData = Boolean(await store.readFolderProfile(name)) || (await cast.listMembers(name)).length > 0;
  return hasAdminData
    ? `Nur Admins duerfen ein Projekt mit Produktions-Profil, Kontextdateien oder Cast ${verb}.`
    : null;
}

// 409 for a name that is taken, but neutral when the taken project is one the caller cannot see (404 elsewhere):
// otherwise POST/PATCH would reveal the names of other people's private projects.
async function failFolderExists(req, res, name, err) {
  const viewer = access.viewerOf(req);
  if (viewer.active && !viewer.admin) {
    const existing = (await store.listFolders()).find((entry) => store.sameFolderName(entry, name));
    if (existing && !(await canUseFolder(req, existing))) return fail(res, 400, 'Dieser Projektname ist nicht verfuegbar.');
  }
  return fail(res, 409, err.message);
}

function promptPresetsErrorStatus(err) {
  if (err instanceof promptPresets.PromptPresetValidationError) return 400;
  if (err instanceof promptPresets.PromptPresetNotFoundError) return 404;
  return 500;
}

function adminsErrorStatus(err) {
  if (err instanceof admins.AdminValidationError) return 400;
  if (err instanceof admins.AdminNotFoundError) return 404;
  return 500;
}

function requireSessionId(req, res) {
  const id = req.params.id;
  if (!store.isValidId(id)) {
    fail(res, 400, 'Ungueltige Session-ID');
    return null;
  }
  return id;
}

function requireBrandingId(req, res) {
  const id = req.params.id;
  if (!store.isValidId(id)) {
    fail(res, 400, 'Ungueltige Branding-ID');
    return null;
  }
  return id;
}

function requireRoleId(req, res) {
  const id = req.params.id;
  if (!store.isValidId(id)) {
    fail(res, 400, 'Ungueltige Rollen-ID');
    return null;
  }
  return id;
}

function extractJsonObject(value) {
  const raw = typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.map((part) => part?.text || '').join('')
      : '';
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(clean);
  } catch (_) {
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
    throw new Error('Die Rollen-Antwort war kein gueltiges JSON-Objekt');
  }
}

function truncateCharacters(value, maxLength) {
  return [...String(value || '').trim()].slice(0, maxLength).join('');
}

async function validateExistingBrandingIds(values) {
  if (!Array.isArray(values)) throw new TypeError('brandings muss ein Array sein');
  if (values.length > 2) throw new Error('Es duerfen maximal 2 Brandings angehaengt werden');
  const ids = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new TypeError('Branding-IDs muessen nicht-leere Strings sein');
    }
    const id = value.trim();
    if (!store.isValidId(id)) throw new Error(`Ungueltige Branding-ID: ${id}`);
    if (!ids.includes(id)) ids.push(id);
  }
  for (const id of ids) await brandings.readBranding(id);
  return ids;
}

function exportFilename(name) {
  const stem = String(name || 'branding')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'branding';
  return `${stem}-branding.zip`;
}

const BRANDING_ASSET_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.pdf': 'application/pdf'
};

function clampNumber(raw, fallback, min, max) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function requireFolderName(req, res) {
  const name = typeof req.params.name === 'string' ? req.params.name.trim() : '';
  if (!name) {
    fail(res, 400, 'Projektname darf nicht leer sein');
    return null;
  }
  if ([...name].length > 60) {
    fail(res, 400, 'Projektname darf maximal 60 Zeichen lang sein');
    return null;
  }
  return name;
}

function jobsWithUrls(session) {
  const renderNodes = new Map(rendernode.listConfiguredNodes().map((node) => [node.id, node]));
  return session.jobs.map((job) => {
    const meta = resultMeta.describe(job);
    return {
      jobId: job.jobId,
      assetId: job.assetId,
      status: job.status,
      prompt: job.prompt,
      submittedAt: job.submittedAt,
      createdAt: job.createdAt || job.submittedAt || null,
      startedAt: job.startedAt || null,
      completedAt: job.completedAt || null,
      error: job.error || null,
      errorCode: job.errorCode || null,
      cost: typeof job.cost === 'number' ? job.cost : null,
      costEstimated: job.costEstimated === true,
      // The model with its readable name, the estimate the model card showed (video) and how the job is billed.
      model: meta.model || null,
      modelName: meta.modelName || null,
      estimateUsd: Number.isFinite(job.estimateUsd) ? job.estimateUsd : null,
      estimateMinUsd: Number.isFinite(job.estimateMinUsd) ? job.estimateMinUsd : null,
      billing: resultMeta.billingOf(job),
      source: job.source || null,
      provider: job.provider || null,
      kind: job.kind || 'video',
      resultAssetIds: Array.isArray(job.resultAssetIds) ? job.resultAssetIds : [],
      renderNodeId: job.renderNodeId || null,
      nodeId: job.renderNodeId || job.nodeId || null,
      nodeName: job.nodeName || renderNodes.get(job.renderNodeId || job.nodeId)?.name || null,
      url: job.status === 'completed' && job.file ? store.assetUrl(session.id, job.file) : null
    };
  });
}

// The ledger entries of a chat with what the cards show: the model that made each (`model`, `modelName`) and how it was
// billed (`billing`). The model comes from the entry itself, else from the job that produced it (results of jobs made before
// the entry recorded it, and the further results of a job). Nothing is guessed: an entry without a recorded model shows none.
function assetsWithUrls(session, ledger) {
  const jobByAssetId = new Map();
  for (const job of session.jobs || []) {
    if (job.assetId) jobByAssetId.set(job.assetId, job);
  }
  for (const job of session.jobs || []) {
    for (const resultAssetId of job.resultAssetIds || []) {
      if (!jobByAssetId.has(resultAssetId)) jobByAssetId.set(resultAssetId, job);
    }
  }
  return ledger.map((entry) => {
    const job = jobByAssetId.get(entry.id) || null;
    const own = resultMeta.describe(entry);
    const meta = own.model ? own : resultMeta.describe(job);
    const billing = resultMeta.billingOf(job);
    return { ...entry, ...meta, ...(billing ? { billing } : {}), url: store.assetUrl(session.id, entry.file) };
  });
}

async function renderNodeStatus() {
  return rendernode.aggregateStatus();
}

function resetRenderNodeStatusCache() {
  rendernode.resetStatusCache();
}

async function renderNodesAdminPayload() {
  const nodes = rendernode.listConfiguredNodes();
  return {
    nodes: await Promise.all(nodes.map(async (node) => {
      const status = node.enabled
        ? await rendernode.nodeStatus(node)
        : { online: false, running: false, queue: 0 };
      return {
        id: node.id,
        name: node.name,
        url: node.url,
        token: renderNodesStore.maskToken(node.token),
        enabled: Boolean(node.enabled),
        implicit: Boolean(node.implicit),
        ...status
      };
    }))
  };
}

function renderNodesErrorStatus(err) {
  if (err instanceof renderNodesStore.RenderNodesValidationError) return 400;
  if (err instanceof renderNodesStore.RenderNodeNotFoundError) return 404;
  return 500;
}

function parseHiggsfieldBalance(text) {
  const value = String(text || '');
  const credits = value.match(/Credits:\s*([0-9]+(?:\.[0-9]+)?)/i);
  const plan = value.match(/Plan:\s*([^|\r\n]+)/i);
  if (!credits && !plan) return null;
  return {
    ...(credits ? { credits: Number(credits[1]) } : {}),
    ...(plan ? { plan: plan[1].trim() } : {})
  };
}

function stopHiggsfieldConnectPolling() {
  if (higgsfieldConnectTimer) clearInterval(higgsfieldConnectTimer);
  higgsfieldConnectTimer = null;
  higgsfieldPollInFlight = false;
}

// OAuth login: the browser callback completes the connection. The timer only watches the pending state
// (no HTTP request) so that it stops as soon as the login is done or has expired.
function startHiggsfieldConnectPolling(expiresIn) {
  stopHiggsfieldConnectPolling();
  const expiresAt = Date.now() + Math.max(1, Number(expiresIn) || 600) * 1000;
  higgsfieldConnectTimer = setInterval(async () => {
    if (higgsfieldPollInFlight) return;
    if (Date.now() >= expiresAt) return stopHiggsfieldConnectPolling();
    higgsfieldPollInFlight = true;
    try {
      const result = await higgsfield.pollConnect();
      if (result.connected || !result.pending) stopHiggsfieldConnectPolling();
    } catch (err) {
      console.warn('[higgsfield] Anmeldestatus:', err.message);
    } finally {
      higgsfieldPollInFlight = false;
    }
  }, 3000);
  higgsfieldConnectTimer.unref?.();
}

const readMonitoringJobs = adminMonitoring.createJobsReader();

const HIGGSFIELD_CALLBACK_PATH = '/api/higgsfield/oauth/callback';

// Redirect URI of the OAuth login: PUBLIC_BASE_URL (without trailing slash) when set, otherwise derived from the
// request (X-Forwarded-Proto / Host; X-Forwarded-Host only with TRUST_PROXY_HOST=1). Behind a reverse proxy with a path prefix PUBLIC_BASE_URL must be set.
function higgsfieldRedirectUri(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (configured) return `${configured}${HIGGSFIELD_CALLBACK_PATH}`;
  const headers = req.headers || {};
  const forwarded = String(headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const protocol = forwarded === 'https' || forwarded === 'http' ? forwarded : (req.protocol === 'https' ? 'https' : 'http');
  // X-Forwarded-Host is client-controlled unless a trusted proxy sets it, so it is only read on explicit opt-in.
  const trustProxy = /^(1|true|yes)$/i.test(String(process.env.TRUST_PROXY_HOST || '').trim());
  const host = String((trustProxy && headers['x-forwarded-host']) || headers.host || '').split(',')[0].trim();
  return `${protocol}://${host}${HIGGSFIELD_CALLBACK_PATH}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function higgsfieldCallbackPage(ok, message) {
  const title = ok ? 'Higgsfield ist verbunden' : 'Higgsfield-Anmeldung fehlgeschlagen';
  const text = ok ? 'Higgsfield ist verbunden \u2013 du kannst dieses Fenster schliessen.' : message;
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#eee}main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.3rem}p{color:#bbb}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></main></body></html>
`;
}

function sendHiggsfieldCallbackPage(res, status, ok, message) {
  res.status(status);
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"
  });
  res.send(higgsfieldCallbackPage(ok, message));
}

async function higgsfieldStatusPayload() {
  const current = higgsfield.status();
  const payload = {
    connected: current.connected,
    refreshExpiresAt: current.refreshExpiresAt,
    pending: current.pending
  };
  if (!current.connected) return payload;

  const now = Date.now();
  if (higgsfieldBalanceCache?.expiresAt > now) {
    if (higgsfieldBalanceCache.value) payload.balance = higgsfieldBalanceCache.value;
    return payload;
  }
  if (!higgsfieldBalanceCache?.pending) {
    const pending = higgsfield.mcpCall('balance', {}, { timeoutMs: 5000 })
      .then((text) => {
        const value = parseHiggsfieldBalance(text);
        higgsfieldBalanceCache = { value, expiresAt: Date.now() + 60000, pending: null };
        return value;
      })
      .catch(() => {
        higgsfieldBalanceCache = { value: null, expiresAt: Date.now() + 10000, pending: null };
        return null;
      });
    higgsfieldBalanceCache = { value: null, expiresAt: 0, pending };
  }
  const balance = await higgsfieldBalanceCache.pending;
  const updated = higgsfield.status();
  if (!updated.connected) {
    return { connected: false, refreshExpiresAt: null, pending: updated.pending };
  }
  if (balance) payload.balance = balance;
  return payload;
}

// `viewer` (lib/access.js): participants and guests get no ChatGPT subscription models and no GTS, and with
// config.restrictedBrainModels only the brain models of that list.
function publicRuntimeConfig(viewer = null) {
  // An unconfirmed caller gets what a guest gets.
  const restricted = access.isRestricted(viewer) || access.isUnconfirmed(viewer);
  const brainModels = availableBrainModels(
    runtime.brainModels,
    chatgpt.status().connected && !restricted,
    restricted ? runtime.restrictedBrainModels : []
  );
  return {
    hasKey: or.hasKey(),
    brainModels,
    defaultBrain: availableDefaultBrain(runtime.defaultBrain, brainModels),
    imageModel: runtime.imageModel,
    imageModels: runtime.imageModels,
    videoModel: runtime.videoModel,
    gts: { enabled: gts.hasToken() && !restricted },
    fal: { enabled: fal.hasKey() },
    askVideoModel: settings.getPreference('askVideoModel')
  };
}

/* ---------- API ---------- */

app.get('/api/prompt-presets', (req, res) => {
  try {
    const presets = promptPresets.listPresets();
    // The custom templates are maintained by admins for the team: internal.
    res.json(isRestricted(req) ? presets.filter((preset) => !preset.custom) : presets);
  } catch (err) {
    fail(res, 500, err.message);
  }
});

app.post('/api/prompt-presets/custom', (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const preset = promptPresets.createCustomPreset(req.body);
    res.status(201).json({ preset, presets: promptPresets.listPresets() });
  } catch (err) {
    fail(res, promptPresetsErrorStatus(err), err.message);
  }
});

app.put('/api/prompt-presets/custom/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const preset = promptPresets.updateCustomPreset(req.params.id, req.body);
    res.json({ preset, presets: promptPresets.listPresets() });
  } catch (err) {
    fail(res, promptPresetsErrorStatus(err), err.message);
  }
});

app.delete('/api/prompt-presets/custom/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    promptPresets.deleteCustomPreset(req.params.id);
    res.json({ presets: promptPresets.listPresets() });
  } catch (err) {
    fail(res, promptPresetsErrorStatus(err), err.message);
  }
});

app.get('/api/config', (req, res) => {
  res.json(publicRuntimeConfig(access.viewerOf(req)));
});

app.get('/api/settings', (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, 'Zugriff verweigert.');
  res.json({ keys: settings.listSettingsStatus(), preferences: settings.listPreferences() });
});

// Plain on/off switches of the services tab (no secrets): GET /api/settings lists them, this changes one.
app.put('/api/settings/preferences', (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, 'Zugriff verweigert.');
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (typeof body.name !== 'string' || !settings.PREFERENCE_NAMES.includes(body.name)) {
    return fail(res, 400, 'Diese Einstellung ist nicht erlaubt.');
  }
  if (typeof body.value !== 'boolean') return fail(res, 400, 'Der Wert muss true oder false sein.');
  try {
    res.json({ preferences: settings.setPreference(body.name, body.value) });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

app.put('/api/settings', (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, 'Zugriff verweigert.');
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (typeof body.name !== 'string' || !settings.SETTING_NAMES.includes(body.name)) {
    return fail(res, 400, 'Dieser Settings-Key ist nicht erlaubt.');
  }
  if (typeof body.value !== 'string') return fail(res, 400, 'Der Settings-Wert muss ein String sein.');
  try {
    settings.setSetting(body.name, body.value);
    resetRenderNodeStatusCache();
    res.json({ keys: settings.listSettingsStatus() });
  } catch (err) {
    const status = err instanceof TypeError || /maximal|nicht erlaubt/.test(err.message) ? 400 : 500;
    fail(res, status, err.message);
  }
});

app.get('/api/admins', (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, 'Zugriff verweigert.');
  try {
    res.json({ admins: admins.listAdmins() });
  } catch (err) {
    fail(res, adminsErrorStatus(err), err.message);
  }
});

app.post('/api/admins', (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, 'Zugriff verweigert.');
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    admins.addAdmin(body.email);
    res.status(201).json({ admins: admins.listAdmins() });
  } catch (err) {
    fail(res, adminsErrorStatus(err), err.message);
  }
});

app.delete('/api/admins/:email', (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, 'Zugriff verweigert.');
  try {
    admins.deleteAdmin(req.params.email);
    res.json({ admins: admins.listAdmins() });
  } catch (err) {
    fail(res, adminsErrorStatus(err), err.message);
  }
});

/* ---------- user management ---------- */

// AUTH_LOGOUT_URL (optional): where the account menu sends people to sign out. Only http(s) URLs or absolute
// paths are handed to the browser.
function logoutUrl() {
  const value = String(process.env.AUTH_LOGOUT_URL || '').trim();
  if (!value) return null;
  return /^https?:\/\/[^\s]+$/i.test(value) || (/^\/(?!\/)\S*$/.test(value)) ? value : null;
}

// Who am I: mode, identity and role. Always answers (also in the local mode) so the UI can decide what to show.
// Participants (people in an active team) and guests also get their teams and budget:
//   participant  true for a participant, false for a guest
//   teams        [{ id, name }] the active teams of the person
//   budget       { limitUsd, spentUsd, reservedUsd, remainingUsd, since } (limit 0 for a guest)
// Everybody else gets the fields they always had.
app.get('/api/me', async (req, res) => {
  const viewer = access.viewerOf(req);
  res.set('Cache-Control', 'no-store');
  const payload = {
    active: viewer.active,
    identified: viewer.identified,
    email: viewer.email,
    role: access.roleOf(viewer),
    isAdmin: viewer.admin,
    isSuperAdmin: viewer.superadmin,
    logoutUrl: viewer.active ? logoutUrl() : null
  };
  // Only present when true: a restriction is active and the login could not be confirmed (see lib/access.js).
  if (access.isUnconfirmed(viewer)) payload.loginUnconfirmed = true;
  try {
    if (access.isRestricted(viewer)) {
      payload.participant = access.isParticipant(viewer);
      payload.teams = teams.membershipsOf(viewer.email).map((entry) => ({ id: entry.teamId, name: entry.name }));
      payload.budget = await budget.status(viewer);
    }
    res.json(payload);
  } catch (err) {
    fail(res, 500, err.message);
  }
});

// The people a chat or workflow can be shared with (admins, people added in the settings, people seen before).
// Not an access list. Any identified person may read it; it is empty and inactive in the local mode.
app.get('/api/team', (req, res) => {
  const viewer = access.viewerOf(req);
  if (!viewer.active) return res.json({ active: false, members: [] });
  if (!viewer.identified) return fail(res, 403, 'Zugriff verweigert.');
  try {
    res.set('Cache-Control', 'no-store');
    // Participants only see the members of their own teams; guests see nobody. The internal team list stays internal.
    if (access.isRestricted(viewer)) {
      const mates = access.isParticipant(viewer) ? teams.teammatesOf(viewer.email) : [];
      return res.json({ active: true, members: mates.map((email) => ({ email, role: 'user', me: email === viewer.email })) });
    }
    res.json({
      active: true,
      members: users.listMembers().map((member) => ({ email: member.email, role: member.role, me: member.email === viewer.email }))
    });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

function usersPayload() {
  return users.listMembers().map((member) => ({ ...member, removable: member.role !== 'admin' }));
}

app.get('/api/users', (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    res.json({ users: usersPayload() });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

// One address ({ email }) or several at once ({ emails: [...] } or { text } with a pasted block; read with the shared
// parser public/email-list.js). Several: { added, already, invalid, duplicates, users }; nothing is written if the
// list would not fit.
app.post('/api/users', (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (body.emails !== undefined || body.text !== undefined) {
      const result = users.addUsers(body.emails !== undefined ? body.emails : body.text);
      return res.status(result.added.length ? 201 : 200).json({ ...result, users: usersPayload() });
    }
    const email = users.addUser(body.email);
    res.status(201).json({ email, users: usersPayload() });
  } catch (err) {
    fail(res, err instanceof users.UserValidationError || err instanceof admins.AdminValidationError ? 400 : 500, err.message);
  }
});

app.delete('/api/users/:email', (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const email = users.deleteUser(req.params.email);
    res.json({ email, users: usersPayload() });
  } catch (err) {
    const status = err instanceof users.UserNotFoundError ? 404 : err instanceof users.UserValidationError || err instanceof admins.AdminValidationError ? 400 : 500;
    fail(res, status, err.message);
  }
});

/* ---------- teams (trainings with a USD budget per person) ---------- */

// Admin API. A team's members are participants: access through the team, a restricted view, a budget (see
// lib/teams.js, lib/access.js and lib/budget.js). Every change is followed by the optional allowlist sync
// (lib/access-sync.js); its state is part of the answers so the UI can show a warning.
teams.onChange(() => {
  void accessSync.sync();
});

function requireTeamAdmin(req, res) {
  const viewer = access.viewerOf(req);
  if (!viewer.active) {
    failWithCode(res, 400, 'USER_MANAGEMENT_INACTIVE', 'Die Benutzerverwaltung ist nicht aktiv.');
    return false;
  }
  return requireAdmin(req, res);
}

function failTeams(res, err) {
  if (err instanceof teams.TeamNotFoundError || err instanceof teams.MemberNotFoundError) return failWithCode(res, 404, err.code, err.message);
  if (err instanceof teams.TeamValidationError) return failWithCode(res, 400, err.code, err.message);
  return fail(res, 500, err.message);
}

function teamSummary(team) {
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    budgetUsd: team.budgetUsd,
    createdAt: team.createdAt,
    createdBy: team.createdBy,
    archived: team.archived,
    memberCount: team.members.length
  };
}

// The team with its members: budget of the membership, what the person has spent and has left (the person's
// overall figures: the highest limit and the latest start of all their teams count), and when they were last seen.
// `shared` ({ seen, statuses }) lets a list of teams read the cost journal and the user list once for all of them.
async function teamDetail(team, shared = null) {
  const seen = shared ? shared.seen : new Map(users.listMembers().map((member) => [member.email, member]));
  const statuses = shared ? shared.statuses : await budget.statusOfEmails(team.members.map((member) => member.email));
  const members = [];
  let spentUsd = 0;
  for (const member of team.members) {
    const status = statuses.get(member.email) || (await budget.statusOfEmail(member.email));
    spentUsd += status.spentUsd;
    members.push({
      email: member.email,
      addedAt: member.addedAt,
      budgetStart: member.budgetStart,
      budgetOverrideUsd: member.budgetOverrideUsd,
      teamLimitUsd: member.budgetOverrideUsd ?? team.budgetUsd,
      limitUsd: status.limitUsd,
      spentUsd: status.spentUsd,
      reservedUsd: status.reservedUsd,
      remainingUsd: status.remainingUsd,
      firstSeen: seen.get(member.email)?.firstSeen || null,
      lastSeen: seen.get(member.email)?.lastSeen || null
    });
  }
  members.sort((a, b) => a.email.localeCompare(b.email));
  return { ...teamSummary(team), spentUsd: Math.round(spentUsd * 1e6) / 1e6, members };
}

async function afterTeamChange() {
  await accessSync.settled();
  return accessSync.status();
}

// The teams the caller may share with: participants their own, internal people and admins every active team.
app.get('/api/teams/mine', (req, res) => {
  const viewer = access.viewerOf(req);
  if (!viewer.active) return res.json({ active: false, teams: [] });
  if (!viewer.identified) return fail(res, 403, 'Zugriff verweigert.');
  res.set('Cache-Control', 'no-store');
  const active = teams.activeTeams();
  let list = active;
  if (access.isGuest(viewer)) list = [];
  else if (access.isParticipant(viewer)) list = active.filter((team) => viewer.teamIds.includes(team.id));
  res.json({ active: true, teams: list.map((team) => ({ id: team.id, name: team.name, memberCount: team.memberCount })) });
});

app.get('/api/teams', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  try {
    res.set('Cache-Control', 'no-store');
    const list = [];
    const all = teams.listTeams();
    const shared = {
      seen: new Map(users.listMembers().map((member) => [member.email, member])),
      statuses: await budget.statusOfEmails(all.flatMap((team) => team.members.map((member) => member.email)))
    };
    for (const team of all) {
      const detail = await teamDetail(team, shared);
      const { members, ...summary } = detail;
      list.push(summary);
    }
    res.json({
      teams: list,
      sync: accessSync.status(),
      limits: teams.LIMITS,
      problem: teams.problem(),
      // Without INTERNAL_EMAIL_DOMAINS the app cannot tell colleagues from former participants (lib/access.js).
      internalDomainsMissing: access.isActive() && access.internalDomains().length === 0
    });
  } catch (err) {
    failTeams(res, err);
  }
});

app.post('/api/teams', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const team = teams.createTeam({
      name: body.name,
      description: body.description,
      budgetUsd: body.budgetUsd,
      createdBy: access.viewerOf(req).email
    });
    const sync = await afterTeamChange();
    res.status(201).json({ team: await teamDetail(team), sync });
  } catch (err) {
    failTeams(res, err);
  }
});

app.get('/api/teams/:id', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ team: await teamDetail(teams.getTeam(req.params.id)), sync: accessSync.status() });
  } catch (err) {
    failTeams(res, err);
  }
});

app.patch('/api/teams/:id', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const team = teams.updateTeam(req.params.id, body);
    const sync = await afterTeamChange();
    res.json({ team: await teamDetail(team), sync });
  } catch (err) {
    failTeams(res, err);
  }
});

app.delete('/api/teams/:id', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  try {
    const id = teams.deleteTeam(req.params.id);
    res.json({ ok: true, id, sync: await afterTeamChange() });
  } catch (err) {
    failTeams(res, err);
  }
});

// Body: { emails: [...] } (up to 500; each entry an address or a pasted block) or { text }. Answers with what happened
// to every address: added, already (in the team), invalid (pieces that are no address).
app.post('/api/teams/:id/members', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const result = teams.addMembers(req.params.id, body.emails !== undefined ? body.emails : body.text);
    const sync = await afterTeamChange();
    res.status(result.added.length ? 201 : 200).json({ ...result, team: await teamDetail(teams.getTeam(req.params.id)), sync });
  } catch (err) {
    failTeams(res, err);
  }
});

// Body: { budgetOverrideUsd: number | null } sets or clears the amount of one person; { resetBudget: true } starts
// counting again from now.
app.patch('/api/teams/:id/members/:email', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    teams.updateMember(req.params.id, req.params.email, body);
    res.json({ team: await teamDetail(teams.getTeam(req.params.id)), sync: await afterTeamChange() });
  } catch (err) {
    failTeams(res, err);
  }
});

app.delete('/api/teams/:id/members/:email', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  try {
    const email = teams.removeMember(req.params.id, req.params.email);
    const sync = await afterTeamChange();
    res.json({ ok: true, email, team: await teamDetail(teams.getTeam(req.params.id)), sync });
  } catch (err) {
    failTeams(res, err);
  }
});

app.get('/api/rendernode/status', async (req, res) => {
  const status = await renderNodeStatus();
  // The names of the render nodes are infrastructure: participants only get the totals.
  if (isRestricted(req)) {
    const { nodes, ...totals } = status;
    return res.json(totals);
  }
  res.json(status);
});

app.get('/api/rendernodes', async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, 'Zugriff verweigert.');
  try {
    res.json(await renderNodesAdminPayload());
  } catch (err) {
    fail(res, renderNodesErrorStatus(err), err.message);
  }
});

app.post('/api/rendernodes', async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, 'Zugriff verweigert.');
  try {
    renderNodesStore.createNode(req.body);
    resetRenderNodeStatusCache();
    res.status(201).json(await renderNodesAdminPayload());
  } catch (err) {
    fail(res, renderNodesErrorStatus(err), err.message);
  }
});

app.patch('/api/rendernodes/:id', async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, 'Zugriff verweigert.');
  try {
    renderNodesStore.updateNode(req.params.id, req.body);
    resetRenderNodeStatusCache();
    res.json(await renderNodesAdminPayload());
  } catch (err) {
    fail(res, renderNodesErrorStatus(err), err.message);
  }
});

app.delete('/api/rendernodes/:id', async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, 'Zugriff verweigert.');
  try {
    renderNodesStore.deleteNode(req.params.id);
    resetRenderNodeStatusCache();
    res.json(await renderNodesAdminPayload());
  } catch (err) {
    fail(res, renderNodesErrorStatus(err), err.message);
  }
});

app.get('/api/higgsfield/status', async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, 'Zugriff verweigert.');
  try {
    res.json(await higgsfieldStatusPayload());
  } catch (err) {
    fail(res, 500, err.message);
  }
});

app.post('/api/higgsfield/connect', async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, 'Zugriff verweigert.');
  try {
    const result = await higgsfield.startConnect({ redirectUri: higgsfieldRedirectUri(req) });
    higgsfieldBalanceCache = null;
    startHiggsfieldConnectPolling(result.expiresIn);
    res.json(result);
  } catch (err) {
    fail(res, 502, err.message);
  }
});

// Browser callback of the Higgsfield OAuth login (authorization code + PKCE); answers a small static page.
app.get(HIGGSFIELD_CALLBACK_PATH, async (req, res) => {
  if (!isAdmin(req)) return sendHiggsfieldCallbackPage(res, 403, false, 'Zugriff verweigert.');
  const param = (name) => (typeof req.query?.[name] === 'string' ? req.query[name] : '');
  try {
    await higgsfield.completeConnect({
      code: param('code'),
      state: param('state'),
      iss: param('iss'),
      error: param('error'),
      errorDescription: param('error_description')
    });
    stopHiggsfieldConnectPolling();
    higgsfieldBalanceCache = null;
    nodeHiggsfieldCatalog.clearCache(); // model and voice lists belong to the account that just signed in
    sendHiggsfieldCallbackPage(res, 200, true);
  } catch (err) {
    // A stray request (wrong state) leaves a still valid pending login untouched.
    if (!higgsfield.status().pending) stopHiggsfieldConnectPolling();
    sendHiggsfieldCallbackPage(res, 400, false, err.message);
  }
});

app.delete('/api/higgsfield/auth', async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, 'Zugriff verweigert.');
  try {
    stopHiggsfieldConnectPolling();
    higgsfieldBalanceCache = null;
    nodeHiggsfieldCatalog.clearCache();
    await higgsfield.disconnect();
    res.json({ connected: false, refreshExpiresAt: null, pending: false });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

app.get('/api/chatgpt/status', async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, 'Zugriff verweigert.');
  // Ein gespeicherter Token heisst noch nicht, dass die Verbindung lebt: laeuft der
  // Refresh-Token ab (7 Tage), meldet die App sonst weiter «verbunden», und der
  // Fehler faellt erst auf, wenn jemand ein Abo-Modell waehlt. Darum hier einmal
  // wirklich nachfragen - schlaegt es fehl, raeumt der Client den Token selbst auf.
  const gespeichert = chatgpt.status();
  if (gespeichert.connected) {
    try {
      await chatgpt.ensureAccessToken();
    } catch (err) {
      console.warn(`[chatgpt] Verbindung nicht mehr gueltig: ${err.message}`);
    }
  }
  res.json(chatgpt.status());
});

app.post('/api/chatgpt/import', async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, 'Zugriff verweigert.');
  try {
    const imported = await chatgpt.importFromCodexCli();
    chatgptFallback.resume(); // a fresh login ends the pause of the replacement through OpenRouter
    res.json(imported);
  } catch (err) {
    fail(res, err.status || 400, err.message);
  }
});

app.post('/api/chatgpt/disconnect', async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, 'Zugriff verweigert.');
  try {
    res.json(await chatgpt.disconnect());
  } catch (err) {
    fail(res, 500, err.message);
  }
});

// With user management admins see all costs, everybody else only their own (and only titles of chats they may see).
// `mine` always holds the caller's own totals for the account menu.
app.get('/api/costs/summary', async (req, res) => {
  try {
    const viewer = access.viewerOf(req);
    let entries = await costs.readCosts();
    const ownEntries = viewer.active ? entries.filter((entry) => viewer.email && entry.user.toLowerCase() === viewer.email) : [];
    if (viewer.active && !viewer.admin) entries = ownEntries;
    const sessionIds = [...new Set(entries.map((entry) => entry.sessionId))];
    const sessionTitles = {};
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        try {
          const session = await store.readSession(sessionId);
          if (viewer.active && !access.canUse(session, viewer)) return;
          if (session.title) sessionTitles[sessionId] = session.title;
        } catch (_) {
          /* Geloeschte Sessions bleiben ohne Titel in der Statistik. */
        }
      })
    );
    const summary = costs.summariseCosts(entries, { sessionTitles });
    if (!viewer.active) return res.json(summary);
    const own = costs.summariseCosts(ownEntries);
    return res.json({
      ...summary,
      scope: viewer.admin ? 'all' : 'own',
      mine: { total: own.total, currentMonth: own.currentMonth, currentWeek: own.currentWeek }
    });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

adminMonitoring.registerRoutes(app, {
  isSuperAdmin,
  monitor: apiMonitor,
  readData: async () => {
    const [costRows, runRows, jobRows, errorRows] = await Promise.all([
      costs.readCosts(),
      nodeWorkflows.defaultStore.listAllRuns(),
      readMonitoringJobs(),
      apiMonitor.readErrors().catch(() => [])
    ]);
    // Teams with the budget picture of every member (monitoring: filter and table per team).
    const teamRows = [];
    const allTeams = teams.listTeams();
    const statuses = await budget.statusOfEmails(allTeams.flatMap((team) => team.members.map((member) => member.email)));
    for (const team of allTeams) {
      const members = [];
      for (const member of team.members) {
        const status = statuses.get(member.email);
        members.push({ email: member.email, addedAt: member.addedAt, budgetStart: member.budgetStart, budgetOverrideUsd: member.budgetOverrideUsd, ...status });
      }
      teamRows.push({ id: team.id, name: team.name, archived: team.archived, budgetUsd: team.budgetUsd, members });
    }
    return { costRows, runRows, jobRows, errorRows, teamRows };
  },
  getRuntime: () => ({ imageModel: runtime.imageModel, videoModel: runtime.videoModel, brainModel: runtime.defaultBrain })
});

app.get('/api/gts/search', async (req, res) => {
  if (!requireUnrestricted(req, res, 'gts', 'Die Wissensdatenbank (GTS) ist für dein Konto nicht verfügbar.')) return;
  if (!gts.hasToken()) {
    return fail(res, 503, 'GTS ist nicht konfiguriert. Bitte GTS_API_TOKEN unter ⚙️ Einstellungen hinterlegen.');
  }
  try {
    res.json({ matches: await gts.smartSearch(req.query.q, 20) });
  } catch (err) {
    fail(res, 502, err.message);
  }
});

app.get('/api/brandings', async (req, res) => {
  try {
    res.json({ brandings: isRestricted(req) ? [] : await brandings.listBrandings() });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

app.post('/api/brandings/import', brandingZipBody, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rawFilename = String(req.get('x-file-name') || '').trim();
  let filename = rawFilename;
  try {
    filename = decodeURIComponent(rawFilename);
  } catch (_) {
    /* Der unveraenderte Header bleibt als sichere Namenshilfe erhalten. */
  }
  try {
    const result = await brandingImport.importBrandingZip({
      buffer: req.body,
      filename,
      name: typeof req.query.name === 'string' ? req.query.name : ''
    });
    res.status(201).json(result);
  } catch (err) {
    const known = err instanceof brandingImport.BrandingImportError;
    fail(res, known ? err.status : 500, known ? err.message : `Branding-Import fehlgeschlagen: ${err.message}`);
  }
});

app.get('/api/roles', async (req, res) => {
  try {
    // Roles are prompts written by admins for the team and may hold internal instructions: participants only get the
    // standard role (GET /api/roles/default).
    res.json({ roles: isRestricted(req) ? [] : await roles.listRoles() });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

app.get('/api/roles/default', async (_req, res) => {
  try {
    res.json({
      name: 'Creative Director (Standard)',
      prompt: await brain.readBasePrompt()
    });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

app.post('/api/roles', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const role = await roles.createRole(req.body);
    res.status(201).json({ role });
  } catch (err) {
    fail(res, err instanceof TypeError || /darf|muss|Zeichen/.test(err.message) ? 400 : 500, err.message);
  }
});

app.put('/api/roles/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = requireRoleId(req, res);
  if (!id) return;
  try {
    const role = await roles.updateRole(id, req.body);
    if (!role) return fail(res, 404, 'Rolle nicht gefunden');
    res.json({ role });
  } catch (err) {
    fail(res, err instanceof TypeError || /darf|muss|Zeichen|Ungueltige/.test(err.message) ? 400 : 500, err.message);
  }
});

app.delete('/api/roles/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = requireRoleId(req, res);
  if (!id) return;
  try {
    if (!(await roles.deleteRole(id))) return fail(res, 404, 'Rolle nicht gefunden');
    res.json({ ok: true });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

app.post('/api/roles/generate', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const name = truncateCharacters(req.body?.name, 60);
  const brief = truncateCharacters(req.body?.brief, 6000);
  if (!name) return fail(res, 400, 'Name darf nicht leer sein');
  if (!brief) return fail(res, 400, 'Beschreibe zuerst, was die Rolle tun soll');
  if (!or.hasKey()) return fail(res, 503, 'Kein OPENROUTER_API_KEY gesetzt');

  const systemPrompt = `Du erstellst eine praezise Rollen-Instruktion fuer einen Video- und Bild-Creative-Director-Agenten. Formuliere die Rolle direkt als Instruktion mit «Du bist ...». Decke Persona, Tonalitaet, Arbeitsweise, Output-Stil sowie klare Dos und Don'ts ab. Die Basis-Faehigkeiten und Tools des Creative Directors bleiben erhalten. Der Prompt darf maximal etwa 350 Woerter lang sein. Antworte ausschliesslich als JSON-Objekt mit den Feldern emoji, description und prompt. emoji umfasst 1 bis 2 Zeichen, description maximal 200 Zeichen, prompt maximal 4000 Zeichen. Schreibe Schweizer Hochdeutsch und verwende immer ss statt Eszett.`;
  const payload = {
    model: runtime.defaultBrain,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Name der Rolle: ${name}\n\nBriefing:\n${brief}` }
    ],
    response_format: { type: 'json_object' }
  };

  try {
    let completion;
    try {
      completion = await or.postJson('/chat/completions', payload);
    } catch (err) {
      if (err.status !== 400) throw err;
      const fallback = { ...payload };
      delete fallback.response_format;
      completion = await or.postJson('/chat/completions', fallback);
    }
    const parsed = extractJsonObject(completion?.choices?.[0]?.message?.content);
    const suggestion = roles.normaliseRoleInput({
      name,
      emoji: truncateCharacters(parsed.emoji, 2),
      description: truncateCharacters(parsed.description, 200),
      prompt: truncateCharacters(parsed.prompt, 4000)
    });
    const cost = Number(completion?.usage?.cost);
    if (Number.isFinite(cost) && cost >= 0) {
      try {
        await costs.recordCost({
          ts: new Date().toISOString(),
          sessionId: 'roles',
          type: 'brain',
          model: runtime.defaultBrain,
          cost,
          user: req.kubleUser || 'lokal'
        });
      } catch (costError) {
        console.warn('[costs] Rollen-Generator-Kosten konnten nicht erfasst werden:', costError.message);
      }
    }
    res.json(suggestion);
  } catch (err) {
    fail(res, err.status || 502, err.message);
  }
});

app.get('/api/brandings/:id/export', async (req, res) => {
  const id = requireBrandingId(req, res);
  if (!id) return;
  if (isRestricted(req)) return fail(res, 404, 'Branding nicht gefunden');
  try {
    const [branding, summary] = await Promise.all([
      brandings.readBranding(id),
      brandings.brandingSummary(id)
    ]);
    const readme = [
      `# Branding-Export: ${branding.name}`,
      '',
      'Dieses Archiv enthaelt das Design-System, seine Guidelines und alle zugehoerigen Assets.',
      '',
      summary
    ].join('\n');

    res.attachment(exportFilename(branding.name));
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      if (res.headersSent) res.destroy(err);
      else fail(res, 500, `Branding-Export fehlgeschlagen: ${err.message}`);
    });
    archive.pipe(res);
    archive.append(`${JSON.stringify(branding, null, 2)}\n`, { name: 'branding.json' });
    archive.append(readme, { name: 'README.md' });
    archive.directory(brandings.brandingAssetsDir(id), 'assets');
    await archive.finalize();
  } catch (err) {
    if (res.headersSent) return res.destroy(err);
    fail(res, err.code === 'BRANDING_NOT_FOUND' ? 404 : 500, err.message);
  }
});

app.get('/api/brandings/:id/assets/:filename', async (req, res) => {
  const id = requireBrandingId(req, res);
  if (!id) return;
  if (isRestricted(req)) return fail(res, 404, 'Branding nicht gefunden');
  try {
    const buffer = await brandings.readBrandingAsset(id, req.params.filename);
    const mime = BRANDING_ASSET_MIME[path.extname(req.params.filename).toLowerCase()] || 'application/octet-stream';
    res.type(mime).send(buffer);
  } catch (err) {
    const status = err.code === 'BRANDING_NOT_FOUND' || /nicht gefunden/.test(err.message) ? 404 : 400;
    fail(res, status, err.message);
  }
});

app.get('/api/brandings/:id', async (req, res) => {
  const id = requireBrandingId(req, res);
  if (!id) return;
  if (isRestricted(req)) return fail(res, 404, 'Branding nicht gefunden');
  try {
    res.json(await brandings.readBranding(id));
  } catch (err) {
    fail(res, err.code === 'BRANDING_NOT_FOUND' ? 404 : 500, err.message);
  }
});

app.delete('/api/brandings/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = requireBrandingId(req, res);
  if (!id) return;
  try {
    await brandings.deleteBranding(id);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err.code === 'BRANDING_NOT_FOUND' ? 404 : 500, err.message);
  }
});

app.get('/api/folders', async (req, res) => {
  try {
    const viewer = access.viewerOf(req);
    const [allFolders, sessionResult] = await Promise.all([
      store.listFolders(),
      store.listSessions({ limit: Number.MAX_SAFE_INTEGER, viewer })
    ]);
    let folders = allFolders;
    if (viewer.active && !viewer.admin) {
      const byFolder = await folderEntries();
      const restricted = access.isRestricted(viewer);
      const owners = restricted ? await store.readFolderOwners() : null;
      folders = allFolders.filter((name) => {
        const entries = byFolder.get(name) || [];
        if (restricted) {
          return entries.some((entry) => access.canUse(entry, viewer)) || Boolean(viewer.email && owners[name] === viewer.email);
        }
        return entries.length === 0 || entries.some((entry) => access.canUse(entry, viewer));
      });
    }
    const sessionCounts = new Map();
    // When the newest chat of a project changed: the side menu sorts projects by it, the way chats are sorted.
    // A project without chats has no date. Renaming a chat does not touch updatedAt, so it never reshuffles projects.
    const lastActivity = new Map();
    for (const session of sessionResult.sessions) {
      if (!session.folder) continue;
      sessionCounts.set(session.folder, (sessionCounts.get(session.folder) || 0) + 1);
      const changed = String(session.updatedAt || session.createdAt || '');
      if (changed > (lastActivity.get(session.folder) || '')) lastActivity.set(session.folder, changed);
    }
    const details = await Promise.all(
      folders.map(async (name) => ({
        name,
        hasProfile: Boolean(await store.readFolderProfile(name)) && (!access.isRestricted(viewer) || (await ownsFolder(req, name))),
        sessionCount: sessionCounts.get(name) || 0,
        lastActivity: lastActivity.get(name) || null
      }))
    );
    res.json({ folders: details });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

app.post('/api/folders', async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (typeof body.name !== 'string') return fail(res, 400, 'Projektname muss ein String sein');
  const name = body.name.trim();
  if (!name) return fail(res, 400, 'Projektname darf nicht leer sein');
  if ([...name].length > 60) return fail(res, 400, 'Projektname darf maximal 60 Zeichen lang sein');
  try {
    const created = await store.createFolder(name);
    const creator = access.viewerOf(req);
    if (creator.active && creator.email) await store.claimFolder(created, creator.email);
    res.status(201).json({ folder: { name: created, hasProfile: false, sessionCount: 0, lastActivity: null } });
  } catch (err) {
    if (err.code === 'FOLDER_EXISTS') return failFolderExists(req, res, name, err).catch((inner) => fail(res, 500, inner.message));
    fail(res, 500, err.message);
  }
});

app.patch('/api/folders/:name', async (req, res) => {
  const oldName = requireFolderName(req, res);
  if (!oldName) return;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (typeof body.name !== 'string') return fail(res, 400, 'Projektname muss ein String sein');
  const newName = body.name.trim();
  if (!newName) return fail(res, 400, 'Projektname darf nicht leer sein');
  if ([...newName].length > 60) return fail(res, 400, 'Projektname darf maximal 60 Zeichen lang sein');
  try {
    if (!(await canUseFolder(req, oldName))) return fail(res, 404, 'Projekt nicht gefunden');
    const denial = await folderManageDenial(req, oldName, 'umbenennen');
    if (denial) return failWithCode(res, 403, 'FORBIDDEN', denial);
    const renamed = await store.renameFolder(oldName, newName);
    res.json({ ok: true, oldName, name: renamed });
  } catch (err) {
    if (err.code === 'FOLDER_EXISTS') return failFolderExists(req, res, newName, err).catch((inner) => fail(res, 500, inner.message));
    if (err.code === 'FOLDER_NOT_FOUND') return fail(res, 404, err.message);
    fail(res, 500, err.message);
  }
});

app.delete('/api/folders/:name', async (req, res) => {
  const name = requireFolderName(req, res);
  if (!name) return;
  try {
    if (!(await canUseFolder(req, name))) return fail(res, 404, 'Projekt nicht gefunden');
    const denial = await folderManageDenial(req, name, 'loeschen');
    if (denial) return failWithCode(res, 403, 'FORBIDDEN', denial);
    const members = await cast.listMembers(name);
    await store.deleteFolder(name);
    await Promise.all(members.map((member) => cast.removeMember(member.id).catch((err) => {
      console.warn(`[cast] ${member.id} nach Projekt-Loeschung nicht aufgeraeumt: ${err.message}`);
    })));
    res.json({ ok: true, name });
  } catch (err) {
    if (err.code === 'FOLDER_NOT_EMPTY') return fail(res, 409, err.message);
    fail(res, 500, err.message);
  }
});

app.get('/api/folders/:name/cast', async (req, res) => {
  const name = requireFolderName(req, res);
  if (!name) return;
  try {
    if (!(await store.listFolders()).includes(name) || !(await canUseFolder(req, name))) {
      return fail(res, 404, 'Projekt nicht gefunden');
    }
    // The cast of a project belongs to whoever created the project; participants only see their own.
    if (isRestricted(req) && !(await ownsFolder(req, name))) return res.json({ members: [] });
    res.json({ members: await cast.listMembers(name) });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

app.delete('/api/cast/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = req.params.id;
  if (!store.isValidId(id)) return fail(res, 400, 'Ungueltige Cast-ID');
  try {
    if (!(await cast.removeMember(id))) return fail(res, 404, 'Cast-Mitglied nicht gefunden');
    res.json({ ok: true });
  } catch (err) {
    fail(res, err.code === 'CAST_NOT_FOUND' ? 404 : 500, err.message);
  }
});

app.get('/api/folders/:name/profile', async (req, res) => {
  const name = requireFolderName(req, res);
  if (!name) return;
  try {
    if (!(await canUseFolder(req, name))) return fail(res, 404, 'Projekt nicht gefunden');
    res.json({
      profile: await store.visibleFolderProfile(await store.readFolderProfile(name), access.viewerOf(req), { ownsFolder: await ownsFolder(req, name) })
    });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

app.put('/api/folders/:name/profile', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const name = requireFolderName(req, res);
  if (!name) return;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const guidelines = body.guidelines === undefined ? '' : body.guidelines;
  const contextBrains = body.contextBrains === undefined ? [] : body.contextBrains;
  const attachedBrandings = body.brandings === undefined ? [] : body.brandings;
  if (typeof guidelines !== 'string') return fail(res, 400, 'Richtlinien muessen ein String sein');
  if ([...guidelines.trim()].length > 30000) return fail(res, 400, 'Richtlinien duerfen maximal 30000 Zeichen lang sein');
  if (!Array.isArray(contextBrains)) return fail(res, 400, 'contextBrains muss ein Array sein');
  if (contextBrains.length > 5) return fail(res, 400, 'Ein Produktions-Profil darf maximal 5 GTS-Brains enthalten');
  if (contextBrains.some((id) => typeof id !== 'string' || !id.trim())) {
    return fail(res, 400, 'GTS-Brain-IDs muessen nicht-leere Strings sein');
  }

  try {
    const validatedBrandings = await validateExistingBrandingIds(attachedBrandings);
    const profile = await store.writeFolderProfile(name, {
      guidelines: guidelines.trim(),
      contextBrains: contextBrains.map((id) => id.trim()),
      brandings: validatedBrandings
    });
    res.json({ profile });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

app.post('/api/folders/:name/profile/context-files', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const name = requireFolderName(req, res);
  if (!name) return;
  try {
    if (!(await store.listFolders()).includes(name)) return fail(res, 404, 'Projekt nicht gefunden');
    const file = await store.addFolderContextFile(name, req.body?.name, req.body?.text);
    const profile = await store.readFolderProfile(name);
    res.status(201).json({ file, contextFiles: profile?.contextFiles || [] });
  } catch (err) {
    fail(res, err instanceof TypeError || /darf|muss|Datei|Kontext/.test(err.message) ? 400 : 500, err.message);
  }
});

app.delete('/api/folders/:name/profile/context-files/:fileId', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const name = requireFolderName(req, res);
  if (!name) return;
  try {
    if (!(await store.listFolders()).includes(name)) return fail(res, 404, 'Projekt nicht gefunden');
    const removed = await store.removeFolderContextFile(name, req.params.fileId);
    if (!removed) return fail(res, 404, 'Kontextdatei nicht gefunden');
    const profile = await store.readFolderProfile(name);
    res.json({ ok: true, contextFiles: profile?.contextFiles || [] });
  } catch (err) {
    fail(res, /Ungueltige/.test(err.message) ? 400 : 500, err.message);
  }
});

app.delete('/api/folders/:name/profile/memory/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const name = requireFolderName(req, res);
  if (!name) return;
  try {
    const removed = await store.removeFolderMemory(name, req.params.id);
    if (!removed) return fail(res, 404, 'Projekt-Memory-Eintrag nicht gefunden');
    res.json({ ok: true, profile: await store.readFolderProfile(name) });
  } catch (err) {
    fail(res, err.code === 'FOLDER_NOT_FOUND' ? 404 : 500, err.message);
  }
});

app.get('/api/sessions', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = clampNumber(req.query.limit, 20, 1, 100);
    const offset = clampNumber(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const folder = typeof req.query.folder === 'string' ? req.query.folder : '';
    const viewer = access.viewerOf(req);
    // Team groups (admins only): ?team=<id|none> lists one group, ?teams=1 adds the team to every chat. Everybody else
    // is refused for team= and gets no team information with teams=1: the team of other people is confidential.
    const team = typeof req.query.team === 'string' ? req.query.team.trim() : '';
    if (team) {
      if (!requireTeamAdmin(req, res)) return;
      if (team !== teamGroups.NONE && !store.isValidId(team)) return failWithCode(res, 400, 'INVALID_TEAM', 'Ungültiges Team.');
    }
    const withTeams = teamGroups.isAllowed(viewer) && req.query.teams === '1';
    const { sessions, total } = await store.listSessions({ q, folder, limit, offset, viewer, team, withTeams });
    res.json({ sessions, total, offset, hasMore: offset + sessions.length < total });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

// The groups of the team view (admins only): every team with chats, archived teams after the active ones, "internal"
// ({ id: 'none' }) last, each with the number of chats, the people and the latest activity. Complete however the
// chat list pages; the chats of one group come from GET /api/sessions?team=<id>.
app.get('/api/sessions/team-groups', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await store.listSessionTeamGroups({ viewer: access.viewerOf(req) }));
  } catch (err) {
    fail(res, 500, err.message);
  }
});

app.post('/api/sessions', async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const hasFolder = Object.prototype.hasOwnProperty.call(body, 'folder');
  const hasRole = Object.prototype.hasOwnProperty.call(body, 'role');
  if (hasFolder && body.folder !== null && typeof body.folder !== 'string') {
    return fail(res, 400, 'Projekt muss ein String oder null sein');
  }
  if (hasFolder && typeof body.folder === 'string' && !body.folder.trim()) {
    return fail(res, 400, 'Projektname darf nicht leer sein');
  }
  if (hasFolder && typeof body.folder === 'string' && [...body.folder.trim()].length > 60) {
    return fail(res, 400, 'Projektname darf maximal 60 Zeichen lang sein');
  }
  if (hasRole && body.role !== null && (typeof body.role !== 'string' || !store.isValidId(body.role.trim()))) {
    return fail(res, 400, 'Ungueltige Rollen-ID');
  }
  try {
    const viewer = access.viewerOf(req);
    if (viewer.active && hasFolder && typeof body.folder === 'string' && !(await canUseFolder(req, body.folder.trim()))) {
      return fail(res, 404, 'Projekt nicht gefunden');
    }
    if (hasRole && body.role !== null && !requireUnrestricted(req, res, 'roles', 'Eigene Rollen sind für dein Konto nicht verfügbar.')) return;
    if (hasRole && body.role !== null && !(await roles.getRole(body.role.trim()))) {
      return fail(res, 400, 'Rolle nicht gefunden');
    }
    const newFolderName = viewer.active && viewer.email && hasFolder && typeof body.folder === 'string' ? body.folder.trim() : '';
    const folderExisted = newFolderName
      ? (await store.listFolders()).some((existing) => store.sameFolderName(existing, newFolderName))
      : true;
    // A new chat starts private: it belongs to the person who creates it (none when anonymous / local).
    const session = await store.createSession({
      folder: hasFolder ? body.folder : null,
      role: hasRole ? body.role : null,
      owner: access.ownerForNew(viewer),
      teamId: teamGroups.teamForNew(viewer)
    });
    if (newFolderName && !folderExisted) await store.claimFolder(newFolderName, viewer.email);
    res.status(201).json({
      session: {
        id: session.id,
        title: session.title,
        folder: session.folder || null,
        role: session.role || null,
        updatedAt: session.updatedAt,
        ...(viewer.active ? access.describe(session, viewer) : {})
      }
    });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

app.patch('/api/sessions/:id', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;

  const changes = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const hasTitle = Object.prototype.hasOwnProperty.call(changes, 'title');
  const hasFolder = Object.prototype.hasOwnProperty.call(changes, 'folder');
  const hasBrandings = Object.prototype.hasOwnProperty.call(changes, 'brandings');
  const hasRole = Object.prototype.hasOwnProperty.call(changes, 'role');
  if (!hasTitle && !hasFolder && !hasBrandings && !hasRole) return fail(res, 400, 'Titel, Projekt, Brandings oder Rolle fehlt');
  if (hasTitle && typeof changes.title !== 'string') return fail(res, 400, 'Titel muss ein String sein');
  if (hasTitle && !changes.title.trim()) return fail(res, 400, 'Titel darf nicht leer sein');
  if (hasFolder && changes.folder !== null && typeof changes.folder !== 'string') {
    return fail(res, 400, 'Projekt muss ein String oder null sein');
  }
  if (hasFolder && typeof changes.folder === 'string' && !changes.folder.trim()) {
    return fail(res, 400, 'Projektname darf nicht leer sein');
  }
  if (hasFolder && typeof changes.folder === 'string' && [...changes.folder.trim()].length > 60) {
    return fail(res, 400, 'Projektname darf maximal 60 Zeichen lang sein');
  }
  if (hasRole && changes.role !== null && (typeof changes.role !== 'string' || !store.isValidId(changes.role.trim()))) {
    return fail(res, 400, 'Ungueltige Rollen-ID');
  }

  try {
    // Title and project belong to the owner; brandings and role are settings of the chat itself (everybody who may use it).
    if (!(await guardSession(req, res, id, hasTitle || hasFolder ? 'manage' : 'use'))) return;
    if (access.viewerOf(req).active && hasFolder && typeof changes.folder === 'string' && !(await canUseFolder(req, changes.folder.trim()))) {
      return fail(res, 404, 'Projekt nicht gefunden');
    }
    // Brandings and custom roles are internal resources: participants and guests may only clear them.
    if (hasBrandings && Array.isArray(changes.brandings) && changes.brandings.length && !requireUnrestricted(req, res, 'brandings', 'Brandings sind für dein Konto nicht verfügbar.')) return;
    if (hasRole && changes.role !== null && !requireUnrestricted(req, res, 'roles', 'Eigene Rollen sind für dein Konto nicht verfügbar.')) return;
    const validatedBrandings = hasBrandings ? await validateExistingBrandingIds(changes.brandings) : null;
    if (hasRole && changes.role !== null && !(await roles.getRole(changes.role.trim()))) {
      return fail(res, 400, 'Rolle nicht gefunden');
    }
    const patchViewer = access.viewerOf(req);
    const patchFolder = patchViewer.active && patchViewer.email && hasFolder && typeof changes.folder === 'string' ? changes.folder.trim() : '';
    const patchFolderExisted = patchFolder
      ? (await store.listFolders()).some((existing) => store.sameFolderName(existing, patchFolder))
      : true;
    const session = await store.updateSessionMeta(id, {
      ...(hasTitle ? { title: changes.title } : {}),
      ...(hasFolder ? { folder: changes.folder } : {}),
      ...(hasBrandings ? { brandings: validatedBrandings } : {}),
      ...(hasRole ? { role: changes.role } : {})
    });
    if (patchFolder && !patchFolderExisted) await store.claimFolder(patchFolder, patchViewer.email);
    res.json({ ok: true, session });
  } catch (err) {
    if (err.code === 'ENOENT') return fail(res, 404, 'Session nicht gefunden');
    if (hasBrandings && (err.code === 'BRANDING_NOT_FOUND' || err instanceof TypeError || /Branding/.test(err.message))) {
      return fail(res, 400, err.message);
    }
    fail(res, 500, err.message);
  }
});

// Sharing of a chat. Body: { shareMode: 'private' | 'team' | 'specific', sharedWith: [emails from the team list] }.
// Owner or admin; a chat without an owner (existing data) only admins, who then become its owner.
app.patch('/api/sessions/:id/share', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;
  const viewer = access.viewerOf(req);
  if (!viewer.active) return failWithCode(res, 400, 'USER_MANAGEMENT_INACTIVE', 'Die Benutzerverwaltung ist nicht aktiv.');
  try {
    if (!(await guardSession(req, res, id, 'share'))) return;
    const session = await store.readSession(id);
    if (session.kind === 'workflow') {
      return failWithCode(res, 400, 'INVALID_SHARING', 'Die Freigabe eines Workflows wird am Workflow geaendert.');
    }
    let sharing;
    try {
      const policy = access.sharingPolicy(viewer, { isKnownMember: (email) => users.isMember(email) });
      sharing = access.buildSharing(req.body, session, policy.isKnownMember, policy);
    } catch (err) {
      if (err instanceof access.AccessValidationError) return failWithCode(res, 400, err.code, err.message);
      throw err;
    }
    const updated = await store.updateSessionSharing(id, { ...sharing, ...(session.owner ? {} : { owner: viewer.email }) });
    res.json({ session: { id, ...access.describe(updated, viewer) } });
  } catch (err) {
    fail(res, err.code === 'ENOENT' ? 404 : 500, err.message);
  }
});

// Messages that came from a workflow carry `origin`; the client links back only when the caller may open that workflow
// (otherwise workflowId and nodeId are left out).
async function withOriginAccess(req, messages) {
  const viewer = access.viewerOf(req);
  const known = new Map();
  const canOpen = async (workflowId) => {
    if (typeof workflowId !== 'string') return false;
    if (!known.has(workflowId)) {
      try {
        const workflow = await nodeWorkflows.defaultStore.readWorkflow(workflowId);
        known.set(workflowId, !viewer.active || access.canUse(workflow, viewer));
      } catch (_) {
        known.set(workflowId, false);
      }
    }
    return known.get(workflowId);
  };
  const out = [];
  for (const message of messages) {
    if (message.origin && typeof message.origin === 'object') {
      const open = await canOpen(message.origin.workflowId);
      if (open) {
        out.push({ ...message, origin: { ...message.origin, canOpen: true } });
      } else {
        // Without the right to use the workflow, its ids stay on the server; the card shows the names only.
        const { workflowId, nodeId, ...visible } = message.origin;
        out.push({ ...message, origin: { ...visible, canOpen: false } });
      }
    } else {
      out.push(message);
    }
  }
  return out;
}

app.get('/api/sessions/:id', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;
  try {
    if (!(await guardSession(req, res, id))) return;
    let session = await store.readSession(id);
    // Workflow runs that finished while nobody watched (a restart, a missed end) are taken into the chat first.
    if (workflowRuns.hasRunning(session)) {
      await workflowRuns.syncSession(id).catch(() => {});
      session = await store.readSession(id);
    }
    const ledger = await store.readLedger(id);
    const viewer = access.viewerOf(req);
    const budgetStatus = await budget.status(viewer);
    res.json({
      session: {
        id: session.id,
        title: session.title,
        folder: typeof session.folder === 'string' && session.folder.trim() ? session.folder.trim() : null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messages: await workflowRuns.attachRuns(
          videoModels.attachChoices(
            await withOriginAccess(req, session.messages.filter((message) => !message.hidden).map((message) => ({ ...message }))),
            session,
            budgetStatus
          ),
          session,
          { viewer, budgetStatus }
        ),
        videoModelPreference: videoModels.publicPreference(session, viewer),
        brandings: viewer.active && access.isRestricted(viewer) ? [] : session.brandings,
        contextFiles: session.contextFiles,
        role: viewer.active && access.isRestricted(viewer) ? null : session.role || null,
        ...(viewer.active ? access.describe(session, viewer) : {})
      },
      assets: assetsWithUrls(session, ledger),
      jobs: jobsWithUrls(session)
    });
  } catch (err) {
    if (err.code === 'ENOENT') return fail(res, 404, 'Session nicht gefunden');
    fail(res, 500, err.message);
  }
});

app.get('/api/sessions/:id/jobs', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;
  try {
    if (!(await guardSession(req, res, id))) return;
    const session = await store.readSession(id);
    res.json({ jobs: jobsWithUrls(session) });
  } catch (err) {
    if (err.code === 'ENOENT') return fail(res, 404, 'Session nicht gefunden');
    fail(res, 500, err.message);
  }
});

app.get('/api/sessions/:id/context', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;
  try {
    if (!(await guardSession(req, res, id))) return;
    const session = await store.readSession(id);
    // The GTS knowledge attached to a chat is internal: participants get no titles and the prompt no content.
    res.json({ contextBrains: isRestricted(req) ? [] : session.contextBrains });
  } catch (err) {
    if (err.code === 'ENOENT') return fail(res, 404, 'Session nicht gefunden');
    fail(res, 500, err.message);
  }
});

app.post('/api/sessions/:id/context', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;
  if (!(await guardSession(req, res, id))) return;
  if (!requireUnrestricted(req, res, 'gts', 'Die Wissensdatenbank (GTS) ist für dein Konto nicht verfügbar.')) return;
  if (!gts.hasToken()) {
    return fail(res, 503, 'GTS ist nicht konfiguriert. Bitte GTS_API_TOKEN unter ⚙️ Einstellungen hinterlegen.');
  }
  const brainId = String(req.body?.brainId || '').trim();
  if (!brainId) return fail(res, 400, 'brainId fehlt');

  let found;
  try {
    found = await gts.getBrain(brainId);
  } catch (err) {
    return fail(res, err.status === 404 || err.status === 400 ? 404 : 502, err.message);
  }

  try {
    const contextBrains = await store.mutateSession(id, (session) => {
      if (!session.contextBrains.some((b) => b.id === found.id)) {
        session.contextBrains.push({ id: found.id, title: found.title });
      }
      return session.contextBrains.slice();
    });
    res.json({ contextBrains });
  } catch (err) {
    if (err.code === 'ENOENT') return fail(res, 404, 'Session nicht gefunden');
    fail(res, 500, err.message);
  }
});

app.delete('/api/sessions/:id/context/:brainId', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;
  const brainId = String(req.params.brainId || '');
  try {
    if (!(await guardSession(req, res, id))) return;
    const contextBrains = await store.mutateSession(id, (session) => {
      session.contextBrains = session.contextBrains.filter((b) => b.id !== brainId);
      return session.contextBrains.slice();
    });
    res.json({ contextBrains });
  } catch (err) {
    if (err.code === 'ENOENT') return fail(res, 404, 'Session nicht gefunden');
    fail(res, 500, err.message);
  }
});

app.post('/api/sessions/:id/context-files', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;
  try {
    if (!(await guardSession(req, res, id))) return;
    const file = await store.addContextFile(id, req.body?.name, req.body?.text);
    const session = await store.readSession(id);
    res.status(201).json({ file, contextFiles: session.contextFiles });
  } catch (err) {
    if (err.code === 'ENOENT') return fail(res, 404, 'Session nicht gefunden');
    fail(res, err instanceof TypeError || /darf|muss|Datei|Kontext/.test(err.message) ? 400 : 500, err.message);
  }
});

app.delete('/api/sessions/:id/context-files/:fileId', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;
  try {
    if (!(await guardSession(req, res, id))) return;
    const removed = await store.removeContextFile(id, req.params.fileId);
    if (!removed) return fail(res, 404, 'Kontextdatei nicht gefunden');
    const session = await store.readSession(id);
    res.json({ ok: true, contextFiles: session.contextFiles });
  } catch (err) {
    if (err.code === 'ENOENT') return fail(res, 404, 'Session nicht gefunden');
    fail(res, /Ungueltige/.test(err.message) ? 400 : 500, err.message);
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;
  try {
    if (!(await guardSession(req, res, id, 'manage'))) return;
    await store.deleteSession(id);
    res.json({ ok: true });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

/* ---------- video model picker (lib/video-models.js) ---------- */

// The click on a model of the card starts the video job. The model must be one of the options stored with the request,
// the price the budget reserves comes from that stored option too: nothing here comes from the client except the choice.
app.post('/api/sessions/:id/video-model-requests/:requestId', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;
  if (!(await guardSession(req, res, id))) return;
  const requestId = String(req.params.requestId || '').trim();
  const selectedModel = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  if (!store.isValidId(requestId)) return fail(res, 400, 'Ungueltige Video-Modellwahl.');
  if (!selectedModel || selectedModel.length > 120) return fail(res, 400, 'Videomodell fehlt.');

  const viewer = access.viewerOf(req);
  let selected;
  try {
    selected = await videoModels.beginRequest({ sessionId: id, requestId, selectedModel, budgetStatus: await budget.status(viewer) });
  } catch (err) {
    if (failAccountRule(res, err)) return;
    if (err.code === 'ENOENT') return fail(res, 404, 'Session nicht gefunden');
    // A model whose provider already refused the image of this request: nothing starts, the reason is readable.
    if (err.code === videoRefusal.MODEL_REFUSED_CODE) return failWithCode(res, err.status || 409, err.code, err.messageDe || err.message);
    return fail(res, err.status || 400, err.message);
  }

  try {
    const outcome = await tools.executeTool(
      {
        sessionId: id,
        config: { ...runtime, videoModel: selected.option.id },
        emit() {},
        user: req.kubleUser,
        viewer,
        selectedVideoModel: true,
        videoOption: selected.option,
        videoEstimateUsd: selected.option.estimateUsd,
        videoModelRequestId: selected.requestId
      },
      'generate_video',
      selected.args
    );
    // The provider has the job from here on. If the bookkeeping fails, the choice must not open again for a second paid
    // job: reopenRequest sees the job of this request and closes the choice as submitted instead.
    try {
      await videoModels.finishRequest({ sessionId: id, requestId, outcome, remember: req.body?.remember === true, viewer });
    } catch (finishError) {
      console.warn(`[video-model] ${requestId}: Nachbearbeitung nach dem Start fehlgeschlagen: ${finishError.message}`);
      await videoModels.reopenRequest({ sessionId: id, requestId, error: finishError }).catch(() => {});
    }
    const session = await store.readSession(id);
    const request = (session.videoModelRequests || []).find((item) => item && item.id === requestId);
    res.status(201).json({
      choice: videoModels.publicChoice(request, await budget.status(viewer)),
      job: jobsWithUrls(session).find((item) => item.jobId === outcome.job?.jobId) || null,
      videoModelPreference: videoModels.publicPreference(session, viewer)
    });
  } catch (err) {
    await videoModels.reopenRequest({ sessionId: id, requestId, error: err }).catch(() => {});
    if (failAccountRule(res, err)) return;
    // The provider refused the image (real person): the card reopens with its models marked, the answer carries the code.
    const refusal = videoRefusal.refusalOf(err, { model: selected.option.id });
    if (refusal) return failWithCode(res, refusal.status, refusal.code, refusal.messageDe);
    const status = err instanceof or.OpenRouterError ? Math.min(502, Math.max(400, err.status || 502)) : 400;
    fail(res, status, err.message);
  }
});

app.post('/api/sessions/:id/video-model-requests/:requestId/cancel', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;
  if (!(await guardSession(req, res, id))) return;
  const requestId = String(req.params.requestId || '').trim();
  if (!store.isValidId(requestId)) return fail(res, 400, 'Ungueltige Video-Modellwahl.');
  try {
    await videoModels.cancelRequest({ sessionId: id, requestId });
    const session = await store.readSession(id);
    const request = (session.videoModelRequests || []).find((item) => item && item.id === requestId);
    res.json({ choice: videoModels.publicChoice(request, await budget.status(access.viewerOf(req))) });
  } catch (err) {
    if (err.code === 'ENOENT') return fail(res, 404, 'Session nicht gefunden');
    fail(res, err.status || 500, err.message);
  }
});

// "Ask again": forgets the model this chat remembered.
app.delete('/api/sessions/:id/video-model-preference', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;
  if (!(await guardSession(req, res, id))) return;
  try {
    await videoModels.clearPreference(id, access.viewerOf(req));
    res.json({ videoModelPreference: null });
  } catch (err) {
    if (err.code === 'ENOENT') return fail(res, 404, 'Session nicht gefunden');
    fail(res, 500, err.message);
  }
});

/* ---------- workflow runs of the chat (lib/workflow-runs.js) ---------- */

const WORKFLOW_RUN_STATUS = Object.freeze({
  WORKFLOW_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  NOT_FOUND: 404,
  RUN_ACTIVE: 409,
  REV_CONFLICT: 409,
  COST_CHANGED: 409,
  CARD_OUTDATED: 409,
  NODE_UNAVAILABLE: 409,
  INVALID_GRAPH: 400,
  INVALID_REQUEST: 400,
  CONFIRMATION_REQUIRED: 400,
  RUN_LIMIT: 429,
  NOT_REQUESTER: 403
});

function failWorkflowRun(res, err) {
  if (failAccountRule(res, err)) return;
  if (err.code === 'ENOENT') return fail(res, 404, 'Session nicht gefunden');
  const status = err.status || WORKFLOW_RUN_STATUS[err.code];
  if (!status) return fail(res, 500, err.message);
  res.status(status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
}

async function publicWorkflowRun(sessionId, requestId, viewer) {
  const synced = await workflowRuns.syncRequest({ sessionId, requestId });
  if (!synced || !synced.request) return null;
  return workflowRuns.publicRun(synced.request, { viewer, budgetStatus: await budget.status(viewer), live: synced.live });
}

// The click on "Start": the run starts with the amount the card showed; plan and budget are checked again, and only one
// click starts the run.
app.post('/api/sessions/:id/workflow-runs/:requestId', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;
  if (!(await guardSession(req, res, id))) return;
  const requestId = String(req.params.requestId || '').trim();
  if (!store.isValidId(requestId)) return fail(res, 400, 'Ungueltiger Workflow-Lauf.');
  const viewer = access.viewerOf(req);
  try {
    await workflowRuns.startRequest({ sessionId: id, requestId, viewer, seen: req.body && typeof req.body === 'object' && Object.keys(req.body).length ? req.body : null });
    res.status(201).json({ run: await publicWorkflowRun(id, requestId, viewer) });
  } catch (err) {
    failWorkflowRun(res, err);
  }
});

// The state of a card (the client asks while a run is running or starting); a finished run is taken into the chat here too.
app.get('/api/sessions/:id/workflow-runs/:requestId', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;
  if (!(await guardSession(req, res, id))) return;
  const requestId = String(req.params.requestId || '').trim();
  if (!store.isValidId(requestId)) return fail(res, 400, 'Ungueltiger Workflow-Lauf.');
  try {
    const run = await publicWorkflowRun(id, requestId, access.viewerOf(req));
    if (!run) return fail(res, 404, 'Workflow-Lauf wurde nicht gefunden.');
    res.json({ run });
  } catch (err) {
    failWorkflowRun(res, err);
  }
});

// "Cancel": a card that waits is closed, a run that is running is stopped.
app.post('/api/sessions/:id/workflow-runs/:requestId/cancel', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;
  if (!(await guardSession(req, res, id))) return;
  const requestId = String(req.params.requestId || '').trim();
  if (!store.isValidId(requestId)) return fail(res, 400, 'Ungueltiger Workflow-Lauf.');
  const viewer = access.viewerOf(req);
  try {
    await workflowRuns.cancelRequest({ sessionId: id, requestId, viewer });
    const run = await publicWorkflowRun(id, requestId, viewer);
    if (!run) return fail(res, 404, 'Workflow-Lauf wurde nicht gefunden.');
    res.json({ run });
  } catch (err) {
    failWorkflowRun(res, err);
  }
});

app.post('/api/sessions/:id/message', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;
  if (!(await guardSession(req, res, id))) return;

  try {
    await store.readSession(id);
  } catch (_) {
    return fail(res, 404, 'Session nicht gefunden');
  }

  // Participants: no ChatGPT subscription, and a chat turn needs budget left (HTTP 402 before the stream starts).
  const askingViewer = access.viewerOf(req);
  if (access.isRestricted(askingViewer)) {
    try {
      if (!access.modelAllowed(askingViewer, req.body?.brainModel)) {
        throw new access.RoleRestrictedError('chatgpt', 'The ChatGPT subscription is not available for your account', 'Das ChatGPT-Abo ist für dein Konto nicht verfügbar.');
      }
      await budget.begin(askingViewer, { label: 'chat' });
    } catch (err) {
      if (failAccountRule(res, err)) return;
      return fail(res, 500, err.message);
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  const emit = (event) => {
    if (closed) return;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (_) {
      closed = true;
    }
  };

  const keepAlive = setInterval(() => {
    if (!closed) {
      try {
        res.write(': ping\n\n');
      } catch (_) {
        closed = true;
      }
    }
  }, 15000);

  const { text, brainModel, attachments, renderMode, brandingWizard } = req.body || {};
  const configPayload = publicRuntimeConfig(askingViewer);
  const requestedChatGPTModel = chatgpt.BRAIN_MODELS.includes(brainModel);
  let model = configPayload.brainModels.includes(brainModel) ? brainModel : configPayload.defaultBrain;
  // Subscription model chosen but the login is gone: with an OpenRouter key the answer still runs, as the replacement
  // of lib/chatgpt-fallback.js (with a notice and billed), instead of stopping with an error.
  const replacedByOpenRouter = requestedChatGPTModel && !chatgpt.status().connected && or.hasKey();
  if (replacedByOpenRouter) model = brainModel;

  try {
    // A model outside the list for participants and guests (an old tab, a hand-made request) gets the default model.
    if (brainModel && model !== brainModel && access.isRestricted(askingViewer) && runtime.restrictedBrainModels.length) {
      emit({ type: 'notice', code: 'BRAIN_MODEL_REPLACED', model });
    }
    if (requestedChatGPTModel && !chatgpt.status().connected && !replacedByOpenRouter) throw new Error(chatgpt.DISCONNECTED_MESSAGE);
    if (!brain.isChatGPTModel(model) && !or.hasKey()) {
      throw new Error('Kein OPENROUTER_API_KEY gesetzt. Unter ⚙️ Einstellungen hinterlegen.');
    }
    await brain.runTurn({
      sessionId: id,
      text,
      brainModel: model,
      attachments,
      config: runtime,
      emit,
      user: req.kubleUser,
      renderMode: renderMode === true,
      brandingWizard: brandingWizard === true
    });
    emit({ type: 'done' });
  } catch (err) {
    const accountRule = err instanceof budget.BudgetError || err instanceof access.RoleRestrictedError || err instanceof access.LoginUnconfirmedError;
    // The subscription failed and OpenRouter cannot take over: a sentence with a code, said in the interface language.
    const subscriptionDown = err instanceof chatgptFallback.SubscriptionUnavailableError;
    if (!accountRule) console.error('[chat]', subscriptionDown ? `${err.message} (${err.reason})` : err);
    emit({
      type: 'error',
      message: ((accountRule || subscriptionDown) && err.messageDe) || err.message || 'Unbekannter Fehler',
      ...(accountRule || subscriptionDown ? { code: err.code } : {}),
      ...(accountRule && err.feature ? { feature: err.feature } : {}),
      fatal: true
    });
    emit({ type: 'done' });
  } finally {
    clearInterval(keepAlive);
    if (!closed) res.end();
  }
});

// Node view API (registry, workflows, uploads, runs, SSE); must stay before the catch-all below.
const nodeEngine = createNodeEngine({ store: nodeWorkflows.defaultStore, getConfig: () => runtime });
registerNodeRoutes(app, {
  runtime,
  publicRuntimeConfig,
  engine: nodeEngine,
  higgsfieldCatalog: nodeHiggsfieldCatalog,
  canUseFolder: (req, folder) => canUseFolder(req, folder)
});
// The run service (lib/nodes/run-service.js) shares the engine of the node routes: one list of active runs for the
// node view, the Director and any other access.
installRunService(createRunService({ engine: nodeEngine }));

app.get('*', (req, res) => {
  res.sendFile(path.join(PATHS.publicDir, 'index.html'));
});

/* ---------- startup ---------- */

const BIND_HOST = process.env.HOST || '0.0.0.0';

function listen(port, attemptsLeft) {
  const server = app.listen(port, BIND_HOST, () => {
    console.log(`\n  Open Creative Director laeuft auf http://localhost:${port}`);
    console.log(`  Bildmodell: ${runtime.imageModel} | Videomodell: ${runtime.videoModel}`);
    if (!or.hasKey()) {
      console.log('  WARNUNG: kein OPENROUTER_API_KEY gesetzt - Generierung ist deaktiviert.');
    }
    console.log('');
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.warn(`[server] Port ${port} belegt, versuche ${port + 1}.`);
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error('[server]', err.message);
      process.exit(1);
    }
  });
}

function startServer() {
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
  });

  listen(BASE_PORT, 20);
  nodeWorkflows.defaultStore
    .markInterruptedRuns()
    .then((count) => {
      if (count > 0) console.log(`[nodes] ${count} unterbrochene(r) Workflow-Lauf/Laeufe markiert.`);
    })
    .catch((err) => console.warn('[nodes]', err.message));
  discovery
    .resolveModels(fileConfig)
    .then((models) => {
      runtime.imageModel = models.imageModel;
      runtime.videoModel = models.videoModel;
    })
    .catch((err) => console.warn('[discovery]', err.message));
  poller.start();
  if (access.isActive() && access.internalDomains().length === 0) {
    console.warn(
      '[access] WARNUNG: INTERNAL_EMAIL_DOMAINS ist leer. Ohne Domainliste gilt jede Person ohne Team als intern; ' +
        'Adressen, die in einem Team standen, werden als Gast behandelt. Setze INTERNAL_EMAIL_DOMAINS (z. B. example.com).'
    );
  }
  // Team members reach the allowlist of the login (only with ACCESS_ALLOWLIST_FILE and ACCESS_ALLOWLIST_ROUTE).
  if (accessSync.enabled()) void accessSync.sync();
}

if (require.main === module) startServer();

module.exports = { app, startServer, renderNodeStatus, isAdmin, isSuperAdmin, publicRuntimeConfig };
