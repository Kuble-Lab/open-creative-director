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
const promptPresets = require('./lib/prompt-presets');
const admins = require('./lib/admins');
const access = require('./lib/access');
const users = require('./lib/users');
const adminMonitoring = require('./lib/admin-monitoring');
const nodeWorkflows = require('./lib/nodes/workflows-store');
const { createEngine: createNodeEngine } = require('./lib/nodes/engine');
const { registerNodeRoutes } = require('./lib/nodes/routes');
const nodeHiggsfieldCatalog = require('./lib/nodes/higgsfield-catalog');

loadEnv();
settings.loadSettings();
store.ensureDirs();

const fileConfig = loadConfig();
const runtime = {
  imageModel: fileConfig.imageModel,
  videoModel: fileConfig.videoModel,
  brainModels: fileConfig.brainModels,
  defaultBrain: fileConfig.defaultBrain,
  publicBaseUrl: fileConfig.publicBaseUrl
};

const BASE_PORT = Number.parseInt(process.env.PORT, 10) || 3111;
const app = express();
let higgsfieldConnectTimer = null;
let higgsfieldPollInFlight = false;
let higgsfieldBalanceCache = null;

app.use(createWhoamiMiddleware());
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

async function canUseFolder(req, name) {
  const viewer = access.viewerOf(req);
  if (!viewer.active || viewer.admin) return true;
  const entries = (await folderEntries()).get(name) || [];
  return entries.length === 0 || entries.some((entry) => access.canUse(entry, viewer));
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
  return session.jobs.map((job) => ({
    jobId: job.jobId,
    assetId: job.assetId,
    status: job.status,
    prompt: job.prompt,
    submittedAt: job.submittedAt,
    createdAt: job.createdAt || job.submittedAt || null,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    error: job.error || null,
    cost: typeof job.cost === 'number' ? job.cost : null,
    source: job.source || null,
    provider: job.provider || null,
    kind: job.kind || 'video',
    resultAssetIds: Array.isArray(job.resultAssetIds) ? job.resultAssetIds : [],
    renderNodeId: job.renderNodeId || null,
    nodeId: job.renderNodeId || job.nodeId || null,
    nodeName: job.nodeName || renderNodes.get(job.renderNodeId || job.nodeId)?.name || null,
    url: job.status === 'completed' && job.file ? store.assetUrl(session.id, job.file) : null
  }));
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

function publicRuntimeConfig() {
  const brainModels = availableBrainModels(runtime.brainModels, chatgpt.status().connected);
  return {
    hasKey: or.hasKey(),
    brainModels,
    defaultBrain: availableDefaultBrain(runtime.defaultBrain, brainModels),
    imageModel: runtime.imageModel,
    videoModel: runtime.videoModel,
    gts: { enabled: gts.hasToken() },
    fal: { enabled: fal.hasKey() }
  };
}

/* ---------- API ---------- */

app.get('/api/prompt-presets', (_req, res) => {
  try {
    res.json(promptPresets.listPresets());
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
  res.json(publicRuntimeConfig());
});

app.get('/api/settings', (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, 'Zugriff verweigert.');
  res.json({ keys: settings.listSettingsStatus() });
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
app.get('/api/me', (req, res) => {
  const viewer = access.viewerOf(req);
  res.set('Cache-Control', 'no-store');
  res.json({
    active: viewer.active,
    identified: viewer.identified,
    email: viewer.email,
    role: access.roleOf(viewer),
    isAdmin: viewer.admin,
    isSuperAdmin: viewer.superadmin,
    logoutUrl: viewer.active ? logoutUrl() : null
  });
});

// The people a chat or workflow can be shared with (admins, people added in the settings, people seen before).
// Not an access list. Any identified person may read it; it is empty and inactive in the local mode.
app.get('/api/team', (req, res) => {
  const viewer = access.viewerOf(req);
  if (!viewer.active) return res.json({ active: false, members: [] });
  if (!viewer.identified) return fail(res, 403, 'Zugriff verweigert.');
  try {
    res.set('Cache-Control', 'no-store');
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

app.post('/api/users', (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const email = users.addUser(req.body?.email);
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

app.get('/api/rendernode/status', async (_req, res) => {
  res.json(await renderNodeStatus());
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
    res.json(await chatgpt.importFromCodexCli());
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
    return { costRows, runRows, jobRows, errorRows };
  },
  getRuntime: () => ({ imageModel: runtime.imageModel, videoModel: runtime.videoModel, brainModel: runtime.defaultBrain })
});

app.get('/api/gts/search', async (req, res) => {
  if (!gts.hasToken()) {
    return fail(res, 503, 'GTS ist nicht konfiguriert. Bitte GTS_API_TOKEN unter ⚙️ Einstellungen hinterlegen.');
  }
  try {
    res.json({ matches: await gts.smartSearch(req.query.q, 20) });
  } catch (err) {
    fail(res, 502, err.message);
  }
});

app.get('/api/brandings', async (_req, res) => {
  try {
    res.json({ brandings: await brandings.listBrandings() });
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

app.get('/api/roles', async (_req, res) => {
  try {
    res.json({ roles: await roles.listRoles() });
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
      folders = allFolders.filter((name) => {
        const entries = byFolder.get(name) || [];
        return entries.length === 0 || entries.some((entry) => access.canUse(entry, viewer));
      });
    }
    const sessionCounts = new Map();
    for (const session of sessionResult.sessions) {
      if (!session.folder) continue;
      sessionCounts.set(session.folder, (sessionCounts.get(session.folder) || 0) + 1);
    }
    const details = await Promise.all(
      folders.map(async (name) => ({
        name,
        hasProfile: Boolean(await store.readFolderProfile(name)),
        sessionCount: sessionCounts.get(name) || 0
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
    res.status(201).json({ folder: { name: created, hasProfile: false, sessionCount: 0 } });
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
    res.json({ profile: await store.visibleFolderProfile(await store.readFolderProfile(name), access.viewerOf(req)) });
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
    const { sessions, total } = await store.listSessions({ q, limit, offset, viewer: access.viewerOf(req) });
    res.json({ sessions, total, offset, hasMore: offset + sessions.length < total });
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
    if (hasRole && body.role !== null && !(await roles.getRole(body.role.trim()))) {
      return fail(res, 400, 'Rolle nicht gefunden');
    }
    // A new chat starts private: it belongs to the person who creates it (none when anonymous / local).
    const session = await store.createSession({
      folder: hasFolder ? body.folder : null,
      role: hasRole ? body.role : null,
      owner: access.ownerForNew(viewer)
    });
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
    const validatedBrandings = hasBrandings ? await validateExistingBrandingIds(changes.brandings) : null;
    if (hasRole && changes.role !== null && !(await roles.getRole(changes.role.trim()))) {
      return fail(res, 400, 'Rolle nicht gefunden');
    }
    const session = await store.updateSessionMeta(id, {
      ...(hasTitle ? { title: changes.title } : {}),
      ...(hasFolder ? { folder: changes.folder } : {}),
      ...(hasBrandings ? { brandings: validatedBrandings } : {}),
      ...(hasRole ? { role: changes.role } : {})
    });
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
      sharing = access.buildSharing(req.body, session, (email) => users.isMember(email));
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

app.get('/api/sessions/:id', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;
  try {
    if (!(await guardSession(req, res, id))) return;
    const session = await store.readSession(id);
    const ledger = await store.readLedger(id);
    const viewer = access.viewerOf(req);
    res.json({
      session: {
        id: session.id,
        title: session.title,
        folder: typeof session.folder === 'string' && session.folder.trim() ? session.folder.trim() : null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messages: session.messages.filter((message) => !message.hidden).map((message) => ({ ...message })),
        brandings: session.brandings,
        contextFiles: session.contextFiles,
        role: session.role || null,
        ...(viewer.active ? access.describe(session, viewer) : {})
      },
      assets: ledger.map((entry) => ({ ...entry, url: store.assetUrl(id, entry.file) })),
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
    res.json({ contextBrains: session.contextBrains });
  } catch (err) {
    if (err.code === 'ENOENT') return fail(res, 404, 'Session nicht gefunden');
    fail(res, 500, err.message);
  }
});

app.post('/api/sessions/:id/context', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;
  if (!(await guardSession(req, res, id))) return;
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

app.post('/api/sessions/:id/message', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;
  if (!(await guardSession(req, res, id))) return;

  try {
    await store.readSession(id);
  } catch (_) {
    return fail(res, 404, 'Session nicht gefunden');
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
  const configPayload = publicRuntimeConfig();
  const requestedChatGPTModel = chatgpt.BRAIN_MODELS.includes(brainModel);
  const model = configPayload.brainModels.includes(brainModel) ? brainModel : configPayload.defaultBrain;

  try {
    if (requestedChatGPTModel && !chatgpt.status().connected) throw new Error(chatgpt.DISCONNECTED_MESSAGE);
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
    console.error('[chat]', err);
    emit({ type: 'error', message: err.message || 'Unbekannter Fehler', fatal: true });
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
}

if (require.main === module) startServer();

module.exports = { app, startServer, renderNodeStatus, isAdmin, isSuperAdmin, publicRuntimeConfig };
