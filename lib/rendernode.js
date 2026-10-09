'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const renderNodesStore = require('./rendernodes-store');
const { QUEUE_NODE_ID } = require('./render-queue');

const SUBMIT_TIMEOUT_MS = 30000;
const STATUS_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 120000;
const HEALTH_TIMEOUT_MS = 3000;
const STATUS_CACHE_MS = 15000;
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_LEGACY_ASSET_BYTES = 24 * 1024 * 1024;
const QUALITIES = new Set(['draft', 'standard', 'high']);
const RESOLUTIONS = new Set(['landscape', 'portrait', 'square']);

function normaliseAssetFiles(assets) {
  if (!assets || typeof assets !== 'object' || !Array.isArray(assets.files)) return null;
  const files = assets.files.map((entry) => ({
    filename: String(entry?.filename || ''),
    path: String(entry?.path || ''),
    size: Number(entry?.size)
  }));
  for (const file of files) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(file.filename) || file.filename.includes('..')) {
      throw new RenderNodeError(`Ungueltiger Render-Asset-Dateiname: ${file.filename || '-'}`);
    }
    if (!file.path || !Number.isFinite(file.size) || file.size < 0) {
      throw new RenderNodeError(`Ungueltige Render-Asset-Metadaten fuer ${file.filename}`);
    }
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  return { files, totalBytes };
}

function chooseAssetTransport({ streamingUploads, totalBytes, nodeName = 'unbekannt' }) {
  if (streamingUploads) return 'streaming';
  if (totalBytes <= MAX_LEGACY_ASSET_BYTES) return 'base64';
  throw new RenderNodeError(
    `Render-Node ${nodeName} unterstuetzt noch keine grossen Uploads - Node-Service aktualisieren.`
  );
}

class RenderNodeError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'RenderNodeError';
    this.status = status;
  }
}

// queue        the queue of the own computers (lib/render-queue.js), or a function that returns it; null = none (WP46)
// agentsCount  how many computers are paired (they make the render tools available without a render node)
function createRenderNodeClient({ store = renderNodesStore, env = process.env, fetchImpl, queue = null, agentsCount = () => 0 } = {}) {
  const statusCache = new Map();
  const fetchRequest = fetchImpl || ((...args) => global.fetch(...args));
  const queueOf = () => (typeof queue === 'function' ? queue() : queue);

  function fallbackNode() {
    const url = String(env.RENDER_NODE_URL || '').trim().replace(/\/+$/, '');
    if (!url) return null;
    return {
      id: 'node-default',
      name: 'Standard',
      url,
      token: String(env.RENDER_NODE_TOKEN || '').trim(),
      enabled: true,
      implicit: true
    };
  }

  function listConfiguredNodes() {
    const stored = store.listNodes();
    if (stored.length > 0) return stored.map((node) => ({ ...node, implicit: false }));
    const fallback = fallbackNode();
    return fallback ? [fallback] : [];
  }

  function listNodes() {
    return listConfiguredNodes().filter((node) => node.enabled);
  }

  function pairedAgents() {
    try {
      return Number(agentsCount()) || 0;
    } catch (_) {
      return 0;
    }
  }

  // Render nodes, or paired own computers: the render tools are offered.
  function enabled() {
    return listNodes().length > 0 || pairedAgents() > 0;
  }

  // Is there anything the poller can ask about render jobs?
  function pollable() {
    if (listConfiguredNodes().length > 0 || pairedAgents() > 0) return true;
    const current = queueOf();
    return Boolean(current && typeof current.hasOpenJobs === 'function' && current.hasOpenJobs());
  }

  function requireNode(nodeId, { bestEffort = false } = {}) {
    const nodes = listConfiguredNodes();
    if (nodeId) {
      const exact = nodes.find((node) => node.id === nodeId);
      if (exact) return exact;
      if (!bestEffort) throw new RenderNodeError(`Render-Node ${nodeId} ist nicht mehr konfiguriert.`);
    }
    const fallback = nodes[0];
    if (!fallback) throw new RenderNodeError('Kein Render-Node konfiguriert.');
    return fallback;
  }

  async function errorFromResponse(res, operation) {
    let detail = '';
    try {
      const text = await res.text();
      try {
        const body = JSON.parse(text);
        detail = body?.error?.message || body?.error || body?.message || text;
      } catch (_) {
        detail = text;
      }
    } catch (_) {
      /* Unlesbare Fehlerantwort ignorieren. */
    }
    const suffix = detail ? `: ${String(detail).slice(0, 600)}` : '';
    return new RenderNodeError(`${operation} fehlgeschlagen (HTTP ${res.status})${suffix}`, res.status);
  }

  async function request(node, pathname, options, timeoutMs, operation, consume, { authenticated = true } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const headers = { ...(options?.headers || {}) };
      if (authenticated) headers.Authorization = `Bearer ${node.token}`;
      const res = await fetchRequest(`${node.url}${pathname}`, {
        ...options,
        headers,
        signal: controller.signal
      });
      if (!res.ok) throw await errorFromResponse(res, operation);
      return consume(res);
    } catch (err) {
      if (err instanceof RenderNodeError) throw err;
      if (controller.signal.aborted) {
        throw new RenderNodeError(`${operation} hat nach ${Math.round(timeoutMs / 1000)} Sekunden das Zeitlimit erreicht.`);
      }
      throw new RenderNodeError(`${operation} fehlgeschlagen: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function health(timeoutMs = HEALTH_TIMEOUT_MS, nodeId) {
    const node = requireNode(nodeId, { bestEffort: !nodeId });
    return request(
      node,
      '/health',
      { method: 'GET' },
      timeoutMs,
      `Render-Node-Healthcheck fuer ${node.name}`,
      (res) => res.json(),
      { authenticated: false }
    );
  }

  async function readNodeStatus(node) {
    try {
      const body = await request(
        node,
        '/health',
        { method: 'GET' },
        HEALTH_TIMEOUT_MS,
        `Render-Node-Healthcheck fuer ${node.name}`,
        (res) => res.json(),
        { authenticated: false }
      );
      const online = body?.ok === true;
      return {
        online,
        running: online && Boolean(body?.running),
        queue: online && Number.isFinite(Number(body?.queue)) ? Math.max(0, Number(body.queue)) : 0,
        streamingUploads: online && body?.streamingUploads === true
      };
    } catch (_) {
      return { online: false, running: false, queue: 0, streamingUploads: false };
    }
  }

  async function nodeStatus(node) {
    const target = typeof node === 'string' ? requireNode(node) : node;
    if (!target || typeof target.id !== 'string' || !target.url) {
      throw new RenderNodeError('Render-Node fuer Statusabfrage ist ungueltig.');
    }
    const now = Date.now();
    const cached = statusCache.get(target.id);
    if (cached?.value && now < cached.expiresAt) return { ...cached.value };
    if (cached?.pending) return cached.pending;
    const pending = readNodeStatus(target).then((value) => {
      statusCache.set(target.id, { value, expiresAt: Date.now() + STATUS_CACHE_MS, pending: null });
      return { ...value };
    });
    statusCache.set(target.id, { value: null, expiresAt: 0, pending });
    return pending;
  }

  function resetStatusCache(nodeId) {
    if (nodeId) statusCache.delete(nodeId);
    else statusCache.clear();
  }

  async function aggregateStatus() {
    const nodes = listNodes();
    const statuses = await Promise.all(nodes.map(async (node) => ({
      id: node.id,
      name: node.name,
      ...await nodeStatus(node)
    })));
    return {
      enabled: nodes.length > 0,
      nodes: statuses,
      online: statuses.some((node) => node.online),
      running: statuses.some((node) => node.running),
      queue: statuses.reduce((sum, node) => sum + node.queue, 0)
    };
  }

  async function uploadAssets(node, assetFiles) {
    const created = await request(
      node,
      '/uploads',
      { method: 'POST' },
      SUBMIT_TIMEOUT_MS,
      `Upload-Staging auf ${node.name}`,
      (res) => res.json()
    );
    const uploadId = String(created?.uploadId || '');
    if (!uploadId) throw new RenderNodeError(`Render-Node ${node.name} lieferte keine Upload-ID.`);
    for (const file of assetFiles.files) {
      await request(
        node,
        `/uploads/${encodeURIComponent(uploadId)}/${encodeURIComponent(file.filename)}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(file.size)
          },
          body: fs.createReadStream(file.path),
          duplex: 'half'
        },
        UPLOAD_TIMEOUT_MS,
        `Upload von ${file.filename} auf ${node.name}`,
        (res) => res.json()
      );
    }
    return uploadId;
  }

  async function legacyAssets(assetFiles) {
    const encoded = {};
    for (const file of assetFiles.files) {
      const buffer = await fsp.readFile(file.path);
      encoded[file.filename] = buffer.toString('base64');
    }
    return encoded;
  }

  // `fps` (optional, a whole number from 1 to 60) is the frame rate of the render; without it the render node uses its own default.
  // `options.owner` (WP46) is the person of the chat or workflow: when a computer that may render for them is online, the job
  // goes into the queue of the own computers (the answer then names QUEUE_NODE_ID as its node); `options.label` is shown to them.
  async function submit(html, quality = 'standard', assets, resolution, fps, options) {
    const document = String(html || '');
    if (!document.trim()) throw new RenderNodeError('HTML-Composition fehlt.');
    if (!QUALITIES.has(quality)) {
      throw new RenderNodeError(`Ungueltige Render-Qualitaet: ${quality}. Erlaubt sind draft, standard und high.`);
    }
    if (resolution !== undefined && !RESOLUTIONS.has(resolution)) {
      throw new RenderNodeError(`Ungueltige Render-Aufloesung: ${resolution}. Erlaubt sind landscape, portrait und square.`);
    }
    if (fps !== undefined && !(Number.isInteger(fps) && fps >= 1 && fps <= 60)) {
      throw new RenderNodeError(`Ungueltige Bildrate: ${fps}. Erlaubt sind ganze Zahlen von 1 bis 60.`);
    }

    // WP46: a computer of the owner (or one that renders for the owner) is online, so the job goes into the central queue.
    // Without such a computer everything below runs exactly as before.
    const owner = options && typeof options === 'object' ? options.owner : undefined;
    const current = owner !== undefined ? queueOf() : null;
    if (current && current.acceptsOwner(owner)) {
      const assetFiles = normaliseAssetFiles(assets);
      try {
        return await current.enqueue({
          html: document,
          quality,
          assetFiles,
          legacyAssets: !assetFiles && assets !== undefined ? assets : null,
          resolution,
          fps,
          owner,
          label: options.label
        });
      } catch (err) {
        throw new RenderNodeError(err.message, err.status || 0);
      }
    }

    const nodes = listNodes();
    const candidates = (await Promise.all(nodes.map(async (node, index) => ({
      node,
      index,
      status: await nodeStatus(node)
    })))).filter((candidate) => candidate.status.online);
    if (candidates.length === 0) throw new RenderNodeError('Kein Render-Node online.');
    const idle = candidates.find((candidate) => !candidate.status.running && candidate.status.queue === 0);
    const selected = idle || candidates.sort((a, b) => a.status.queue - b.status.queue || a.index - b.index)[0];

    const jobId = await sendJob(selected.node, selected.status, { html: document, quality, assets, resolution, fps });
    return { jobId, nodeId: selected.node.id };
  }

  // Sends one job to one render node: the assets (streamed or inline), then POST /render. Returns the job id of the node.
  // The queue of the own computers (WP46) hands its jobs to a free render node through here as well, with `assetFiles`
  // already read (then `assets` is left out).
  async function sendJob(node, status, { html, quality, assets, assetFiles: given, resolution, fps }) {
    const payload = { html, quality };
    const assetFiles = given !== undefined ? given : normaliseAssetFiles(assets);
    if (assetFiles && assetFiles.files.length > 0) {
      const transport = chooseAssetTransport({
        streamingUploads: status.streamingUploads,
        totalBytes: assetFiles.totalBytes,
        nodeName: node.name
      });
      if (transport === 'streaming') payload.uploadId = await uploadAssets(node, assetFiles);
      else payload.assets = await legacyAssets(assetFiles);
    } else if (assets !== undefined && !assetFiles) {
      // Backward-compatible programmatic callers may still pass a base64 object.
      payload.assets = assets;
    }
    if (resolution !== undefined) payload.resolution = resolution;
    if (fps !== undefined) payload.fps = fps;
    const body = await request(
      node,
      '/render',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      },
      SUBMIT_TIMEOUT_MS,
      `Render-Auftrag auf ${node.name}`,
      (res) => res.json()
    );
    if (!body?.jobId) throw new RenderNodeError('Render-Node lieferte keine Job-ID.');
    resetStatusCache(node.id);
    return String(body.jobId);
  }

  // A job of the queue of the own computers (WP46): answered from the queue, in the form of a render node.
  function fromQueue(operation) {
    const current = queueOf();
    if (!current) throw new RenderNodeError('Die Warteschlange der eigenen Rechner ist nicht verfuegbar.');
    try {
      return operation(current);
    } catch (err) {
      throw new RenderNodeError(err.message, err.status || 0);
    }
  }

  async function jobStatus(jobId, nodeId) {
    const id = String(jobId || '').trim();
    if (!id) throw new RenderNodeError('Render-Job-ID fehlt.');
    if (nodeId === QUEUE_NODE_ID) return fromQueue((current) => current.status(id));
    return pushJobStatus(id, nodeId);
  }

  async function pushJobStatus(id, nodeId) {
    const node = requireNode(nodeId, { bestEffort: !nodeId });
    return request(
      node,
      `/jobs/${encodeURIComponent(id)}`,
      { method: 'GET' },
      STATUS_TIMEOUT_MS,
      `Statusabfrage fuer Render-Job ${id}`,
      (res) => res.json()
    );
  }

  async function download(jobId, nodeId) {
    const id = String(jobId || '').trim();
    if (!id) throw new RenderNodeError('Render-Job-ID fehlt.');
    if (nodeId === QUEUE_NODE_ID) {
      const current = queueOf();
      if (!current) throw new RenderNodeError('Die Warteschlange der eigenen Rechner ist nicht verfuegbar.');
      let buffer;
      try {
        buffer = await current.readResult(id);
      } catch (err) {
        throw new RenderNodeError(`Download fuer Render-Job ${id} fehlgeschlagen: ${err.message}`, err.status || 0);
      }
      if (buffer.length === 0) throw new RenderNodeError(`Render-Job ${id} lieferte eine leere Datei.`);
      return buffer;
    }
    return pushDownload(id, nodeId);
  }

  async function pushDownload(id, nodeId) {
    const node = requireNode(nodeId, { bestEffort: !nodeId });
    const buffer = await request(
      node,
      `/jobs/${encodeURIComponent(id)}/file`,
      { method: 'GET' },
      DOWNLOAD_TIMEOUT_MS,
      `Download fuer Render-Job ${id}`,
      async (res) => Buffer.from(await res.arrayBuffer())
    );
    if (buffer.length === 0) throw new RenderNodeError(`Render-Job ${id} lieferte eine leere Datei.`);
    return buffer;
  }

  // Where a job of the queue renders right now (the name of the computer or render node), or null.
  function whereOf(jobId, nodeId) {
    if (nodeId !== QUEUE_NODE_ID) return null;
    const current = queueOf();
    return current ? current.whereOf(String(jobId || '')) : null;
  }

  return {
    enabled,
    pollable,
    listNodes,
    listConfiguredNodes,
    health,
    nodeStatus,
    aggregateStatus,
    resetStatusCache,
    submit,
    jobStatus,
    download,
    whereOf,
    queue: queueOf,
    // the push side for the queue of the own computers: free render nodes get its jobs through here
    pushAdapter: {
      listNodes,
      nodeStatus,
      sendJob,
      jobStatus: pushJobStatus,
      download: pushDownload,
      resetStatusCache
    }
  };
}

// May this computer render a job of `owner` (WP46)? 0 its owner's own job, 1 a job of somebody in an active team of its owner
// ("also for my teams"), 2 any job (a shared computer, "for everybody": only while its owner is an admin), -1 no.
function defaultMayServe(agent, owner) {
  const access = require('./access');
  const jobOwner = String(owner || '').trim().toLowerCase() || 'lokal';
  const active = access.isActive();
  const identified = !active || Boolean(access.normalizeEmail(jobOwner));
  if (identified && agent.owner === jobOwner) return 0;
  if (active && identified && agent.shareTeams) {
    try {
      const teams = access.teamsStore();
      const mine = new Set(teams.activeTeamIdsOf(agent.owner));
      if (mine.size && teams.activeTeamIdsOf(jobOwner).some((id) => mine.has(id))) return 1;
    } catch (_) {
      /* no teams: no team jobs */
    }
  }
  if (agent.shareAll && (!active || access.isAdminEmail(agent.owner))) return 2;
  return -1;
}

let defaultQueue = null;
function defaultQueueOf() {
  if (!defaultQueue) {
    const { PATHS } = require('./config');
    const { createRenderQueue } = require('./render-queue');
    defaultQueue = createRenderQueue({
      dir: path.join(PATHS.root, 'data', 'render-queue'),
      agents: require('./render-agents').defaultStore,
      mayServe: defaultMayServe,
      push: client.pushAdapter
    });
  }
  return defaultQueue;
}

const client = createRenderNodeClient({
  queue: defaultQueueOf,
  agentsCount: () => require('./render-agents').defaultStore.count()
});

module.exports = {
  RenderNodeError,
  createRenderNodeClient,
  defaultMayServe,
  QUEUE_NODE_ID,
  queue: defaultQueueOf,
  enabled: client.enabled,
  pollable: client.pollable,
  whereOf: client.whereOf,
  listNodes: client.listNodes,
  listConfiguredNodes: client.listConfiguredNodes,
  health: client.health,
  nodeStatus: client.nodeStatus,
  aggregateStatus: client.aggregateStatus,
  resetStatusCache: client.resetStatusCache,
  submit: client.submit,
  jobStatus: client.jobStatus,
  download: client.download,
  SUBMIT_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS,
  HEALTH_TIMEOUT_MS,
  STATUS_CACHE_MS,
  UPLOAD_TIMEOUT_MS,
  MAX_LEGACY_ASSET_BYTES,
  chooseAssetTransport
};
