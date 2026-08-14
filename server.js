'use strict';

const express = require('express');
const compression = require('compression');
const path = require('path');
const archiver = require('archiver');

const { PATHS, loadEnv, loadConfig } = require('./lib/config');
const store = require('./lib/store');
const or = require('./lib/openrouter');
const brain = require('./lib/brain');
const gts = require('./lib/gts');
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
const promptPresets = require('./lib/prompt-presets');
const admins = require('./lib/admins');

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
app.use(compression({
  filter: (req, res) => {
    const type = String(res.getHeader('Content-Type') || '');
    if (type.includes('text/event-stream')) return false;
    return compression.filter(req, res);
  }
}));
app.use(express.json({ limit: '60mb' }));
app.use(express.static(PATHS.publicDir));
app.use('/assets', express.static(PATHS.assetsDir, { maxAge: '30d', immutable: true }));

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

function isAdmin(req) {
  if (!String(process.env.AUTH_WHOAMI_URL || '').trim()) return true;
  const email = String(req.kubleUser || '').trim().toLowerCase();
  if (!email) return false;
  if (admins.envAdminEmails().includes(email)) return true;
  try {
    return admins.listStoredAdmins().includes(email);
  } catch (_) {
    return false;
  }
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
  return session.jobs.map((job) => ({
    jobId: job.jobId,
    assetId: job.assetId,
    status: job.status,
    prompt: job.prompt,
    submittedAt: job.submittedAt,
    completedAt: job.completedAt || null,
    error: job.error || null,
    cost: typeof job.cost === 'number' ? job.cost : null,
    source: job.source || null,
    provider: job.provider || null,
    kind: job.kind || 'video',
    resultAssetIds: Array.isArray(job.resultAssetIds) ? job.resultAssetIds : [],
    renderNodeId: job.renderNodeId || null,
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

function startHiggsfieldConnectPolling(expiresIn) {
  stopHiggsfieldConnectPolling();
  const expiresAt = Date.now() + Math.max(1, Number(expiresIn) || 900) * 1000;
  higgsfieldConnectTimer = setInterval(async () => {
    if (higgsfieldPollInFlight) return;
    if (Date.now() >= expiresAt) return stopHiggsfieldConnectPolling();
    higgsfieldPollInFlight = true;
    try {
      const result = await higgsfield.pollConnect();
      if (result.connected || !result.pending) stopHiggsfieldConnectPolling();
    } catch (err) {
      console.warn('[higgsfield] Device-Flow-Polling:', err.message);
    } finally {
      higgsfieldPollInFlight = false;
    }
  }, 3000);
  higgsfieldConnectTimer.unref?.();
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

/* ---------- API ---------- */

app.get('/api/prompt-presets', (_req, res) => {
  try {
    res.json(promptPresets.listPresets());
  } catch (err) {
    fail(res, 500, err.message);
  }
});

app.post('/api/prompt-presets/custom', (req, res) => {
  try {
    const preset = promptPresets.createCustomPreset(req.body);
    res.status(201).json({ preset, presets: promptPresets.listPresets() });
  } catch (err) {
    fail(res, promptPresetsErrorStatus(err), err.message);
  }
});

app.put('/api/prompt-presets/custom/:id', (req, res) => {
  try {
    const preset = promptPresets.updateCustomPreset(req.params.id, req.body);
    res.json({ preset, presets: promptPresets.listPresets() });
  } catch (err) {
    fail(res, promptPresetsErrorStatus(err), err.message);
  }
});

app.delete('/api/prompt-presets/custom/:id', (req, res) => {
  try {
    promptPresets.deleteCustomPreset(req.params.id);
    res.json({ presets: promptPresets.listPresets() });
  } catch (err) {
    fail(res, promptPresetsErrorStatus(err), err.message);
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    hasKey: or.hasKey(),
    brainModels: runtime.brainModels,
    defaultBrain: runtime.defaultBrain,
    imageModel: runtime.imageModel,
    videoModel: runtime.videoModel,
    gts: { enabled: gts.hasToken() }
  });
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
    const result = await higgsfield.startConnect();
    higgsfieldBalanceCache = null;
    startHiggsfieldConnectPolling(result.expiresIn);
    res.json(result);
  } catch (err) {
    fail(res, 502, err.message);
  }
});

app.delete('/api/higgsfield/auth', async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, 'Zugriff verweigert.');
  try {
    stopHiggsfieldConnectPolling();
    higgsfieldBalanceCache = null;
    await higgsfield.disconnect();
    res.json({ connected: false, refreshExpiresAt: null, pending: false });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

app.get('/api/costs/summary', async (_req, res) => {
  try {
    const entries = await costs.readCosts();
    const sessionIds = [...new Set(entries.map((entry) => entry.sessionId))];
    const sessionTitles = {};
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        try {
          const session = await store.readSession(sessionId);
          if (session.title) sessionTitles[sessionId] = session.title;
        } catch (_) {
          /* Geloeschte Sessions bleiben ohne Titel in der Statistik. */
        }
      })
    );
    res.json(costs.summariseCosts(entries, { sessionTitles }));
  } catch (err) {
    fail(res, 500, err.message);
  }
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
  try {
    const role = await roles.createRole(req.body);
    res.status(201).json({ role });
  } catch (err) {
    fail(res, err instanceof TypeError || /darf|muss|Zeichen/.test(err.message) ? 400 : 500, err.message);
  }
});

app.put('/api/roles/:id', async (req, res) => {
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
  const id = requireBrandingId(req, res);
  if (!id) return;
  try {
    await brandings.deleteBranding(id);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err.code === 'BRANDING_NOT_FOUND' ? 404 : 500, err.message);
  }
});

app.get('/api/folders', async (_req, res) => {
  try {
    const [folders, sessionResult] = await Promise.all([
      store.listFolders(),
      store.listSessions({ limit: Number.MAX_SAFE_INTEGER })
    ]);
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
    if (err.code === 'FOLDER_EXISTS') return fail(res, 409, err.message);
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
    const renamed = await store.renameFolder(oldName, newName);
    res.json({ ok: true, oldName, name: renamed });
  } catch (err) {
    if (err.code === 'FOLDER_EXISTS') return fail(res, 409, err.message);
    if (err.code === 'FOLDER_NOT_FOUND') return fail(res, 404, err.message);
    fail(res, 500, err.message);
  }
});

app.delete('/api/folders/:name', async (req, res) => {
  const name = requireFolderName(req, res);
  if (!name) return;
  try {
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
    if (!(await store.listFolders()).includes(name)) return fail(res, 404, 'Projekt nicht gefunden');
    res.json({ members: await cast.listMembers(name) });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

app.delete('/api/cast/:id', async (req, res) => {
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
    res.json({ profile: await store.readFolderProfile(name) });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

app.put('/api/folders/:name/profile', async (req, res) => {
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
    const { sessions, total } = await store.listSessions({ q, limit, offset });
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
    if (hasRole && body.role !== null && !(await roles.getRole(body.role.trim()))) {
      return fail(res, 400, 'Rolle nicht gefunden');
    }
    const session = await store.createSession({
      folder: hasFolder ? body.folder : null,
      role: hasRole ? body.role : null
    });
    res.status(201).json({
      session: { id: session.id, title: session.title, folder: session.folder || null, role: session.role || null, updatedAt: session.updatedAt }
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

app.get('/api/sessions/:id', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;
  try {
    const session = await store.readSession(id);
    const ledger = await store.readLedger(id);
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
        role: session.role || null
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
    await store.deleteSession(id);
    res.json({ ok: true });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

app.post('/api/sessions/:id/message', async (req, res) => {
  const id = requireSessionId(req, res);
  if (!id) return;

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
  const model = runtime.brainModels.includes(brainModel) ? brainModel : runtime.defaultBrain;

  try {
    if (!or.hasKey()) throw new Error('Kein OPENROUTER_API_KEY gesetzt. Unter ⚙️ Einstellungen hinterlegen.');
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

app.get('*', (req, res) => {
  res.sendFile(path.join(PATHS.publicDir, 'index.html'));
});

/* ---------- startup ---------- */

const BIND_HOST = process.env.HOST || '0.0.0.0';

function listen(port, attemptsLeft) {
  const server = app.listen(port, BIND_HOST, () => {
    console.log(`\n  Video Creative Director laeuft auf http://localhost:${port}`);
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

module.exports = { app, startServer, renderNodeStatus, isAdmin };
