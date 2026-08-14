'use strict';

const renderNodesStore = require('./rendernodes-store');

const SUBMIT_TIMEOUT_MS = 30000;
const STATUS_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 120000;
const HEALTH_TIMEOUT_MS = 3000;
const STATUS_CACHE_MS = 15000;
const QUALITIES = new Set(['draft', 'standard', 'high']);
const RESOLUTIONS = new Set(['landscape', 'portrait', 'square']);

class RenderNodeError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'RenderNodeError';
    this.status = status;
  }
}

function createRenderNodeClient({ store = renderNodesStore, env = process.env, fetchImpl } = {}) {
  const statusCache = new Map();
  const fetchRequest = fetchImpl || ((...args) => global.fetch(...args));

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

  function enabled() {
    return listNodes().length > 0;
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
        queue: online && Number.isFinite(Number(body?.queue)) ? Math.max(0, Number(body.queue)) : 0
      };
    } catch (_) {
      return { online: false, running: false, queue: 0 };
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

  async function submit(html, quality = 'standard', assets, resolution) {
    const document = String(html || '');
    if (!document.trim()) throw new RenderNodeError('HTML-Composition fehlt.');
    if (!QUALITIES.has(quality)) {
      throw new RenderNodeError(`Ungueltige Render-Qualitaet: ${quality}. Erlaubt sind draft, standard und high.`);
    }
    if (resolution !== undefined && !RESOLUTIONS.has(resolution)) {
      throw new RenderNodeError(`Ungueltige Render-Aufloesung: ${resolution}. Erlaubt sind landscape, portrait und square.`);
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

    const payload = { html: document, quality };
    if (assets !== undefined) payload.assets = assets;
    if (resolution !== undefined) payload.resolution = resolution;
    const body = await request(
      selected.node,
      '/render',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      },
      SUBMIT_TIMEOUT_MS,
      `Render-Auftrag auf ${selected.node.name}`,
      (res) => res.json()
    );
    if (!body?.jobId) throw new RenderNodeError('Render-Node lieferte keine Job-ID.');
    resetStatusCache(selected.node.id);
    return { jobId: String(body.jobId), nodeId: selected.node.id };
  }

  async function jobStatus(jobId, nodeId) {
    const id = String(jobId || '').trim();
    if (!id) throw new RenderNodeError('Render-Job-ID fehlt.');
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

  return {
    enabled,
    listNodes,
    listConfiguredNodes,
    health,
    nodeStatus,
    aggregateStatus,
    resetStatusCache,
    submit,
    jobStatus,
    download
  };
}

const client = createRenderNodeClient();

module.exports = {
  RenderNodeError,
  createRenderNodeClient,
  enabled: client.enabled,
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
  STATUS_CACHE_MS
};
