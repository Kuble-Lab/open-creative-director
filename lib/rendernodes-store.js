'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { PATHS } = require('./config');

const RENDER_NODES_FILE = path.join(PATHS.root, 'data', 'render-nodes.json');
const NODE_ID_PATTERN = /^node-[0-9a-f]{8}$/;
const MAX_NAME_LENGTH = 40;
const MAX_URL_LENGTH = 2000;
const MAX_TOKEN_LENGTH = 500;

class RenderNodesValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RenderNodesValidationError';
  }
}

class RenderNodeNotFoundError extends Error {
  constructor(id) {
    super(`Render-Node ${id} wurde nicht gefunden.`);
    this.name = 'RenderNodeNotFoundError';
  }
}

function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RenderNodesValidationError('Die Render-Node-Daten muessen ein Objekt sein.');
  }
  return value;
}

function requireAllowedFields(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new RenderNodesValidationError(`Das Feld ${key} ist fuer Render-Nodes nicht erlaubt.`);
    }
  }
}

function validateName(raw) {
  if (typeof raw !== 'string') throw new RenderNodesValidationError('Der Node-Name muss ein String sein.');
  const name = raw.trim();
  if (!name) throw new RenderNodesValidationError('Der Node-Name darf nicht leer sein.');
  if ([...name].length > MAX_NAME_LENGTH) {
    throw new RenderNodesValidationError(`Der Node-Name darf maximal ${MAX_NAME_LENGTH} Zeichen lang sein.`);
  }
  return name;
}

function validateUrl(raw) {
  if (typeof raw !== 'string') throw new RenderNodesValidationError('Die Node-URL muss ein String sein.');
  const clean = raw.trim();
  if (!clean) throw new RenderNodesValidationError('Die Node-URL darf nicht leer sein.');
  if ([...clean].length > MAX_URL_LENGTH) {
    throw new RenderNodesValidationError(`Die Node-URL darf maximal ${MAX_URL_LENGTH} Zeichen lang sein.`);
  }
  let parsed;
  try {
    parsed = new URL(clean);
  } catch (_) {
    throw new RenderNodesValidationError('Die Node-URL ist ungueltig.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new RenderNodesValidationError('Die Node-URL muss mit http:// oder https:// beginnen.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new RenderNodesValidationError('Die Node-URL darf keine Zugangsdaten, Query oder Fragment enthalten.');
  }
  return clean.replace(/\/+$/, '');
}

function validateToken(raw) {
  if (typeof raw !== 'string') throw new RenderNodesValidationError('Der Node-Token muss ein String sein.');
  const token = raw.trim();
  if (!token) throw new RenderNodesValidationError('Der Node-Token darf nicht leer sein.');
  if ([...token].length > MAX_TOKEN_LENGTH) {
    throw new RenderNodesValidationError(`Der Node-Token darf maximal ${MAX_TOKEN_LENGTH} Zeichen lang sein.`);
  }
  return token;
}

function validateEnabled(raw) {
  if (typeof raw !== 'boolean') throw new RenderNodesValidationError('enabled muss ein Boolean sein.');
  return raw;
}

function maskToken(value) {
  const clean = String(value || '');
  if (!clean) return null;
  if ([...clean].length < 12) return '…gesetzt';
  const characters = [...clean];
  return `${characters.slice(0, 4).join('')}…${characters.slice(-4).join('')}`;
}

function createRenderNodesStore({
  file = RENDER_NODES_FILE,
  idGenerator = () => `node-${crypto.randomBytes(4).toString('hex')}`
} = {}) {
  let nodes = null;

  function cloneNodes() {
    return nodes.map((node) => ({ ...node }));
  }

  function validateStoredNode(raw) {
    const value = requireObject(raw);
    requireAllowedFields(value, new Set(['id', 'name', 'url', 'token', 'enabled']));
    if (typeof value.id !== 'string' || !NODE_ID_PATTERN.test(value.id)) {
      throw new RenderNodesValidationError('Eine gespeicherte Render-Node-ID ist ungueltig.');
    }
    return {
      id: value.id,
      name: validateName(value.name),
      url: validateUrl(value.url),
      token: validateToken(value.token),
      enabled: validateEnabled(value.enabled)
    };
  }

  function loadNodes() {
    let parsed = [];
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new Error('data/render-nodes.json ist ungueltig oder konnte nicht gelesen werden.');
      }
    }
    if (!Array.isArray(parsed)) throw new Error('data/render-nodes.json muss ein JSON-Array enthalten.');
    nodes = parsed.map(validateStoredNode);
    if (new Set(nodes.map((node) => node.id)).size !== nodes.length) {
      throw new Error('data/render-nodes.json enthaelt doppelte Node-IDs.');
    }
    return cloneNodes();
  }

  function ensureLoaded() {
    if (nodes === null) loadNodes();
  }

  function writeNodes() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporaryFile = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryFile, `${JSON.stringify(nodes, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(temporaryFile, 0o600);
    fs.renameSync(temporaryFile, file);
    fs.chmodSync(file, 0o600);
  }

  function listNodes() {
    ensureLoaded();
    return cloneNodes();
  }

  function createNode(raw) {
    ensureLoaded();
    const value = requireObject(raw);
    requireAllowedFields(value, new Set(['name', 'url', 'token']));
    const clean = {
      name: validateName(value.name),
      url: validateUrl(value.url),
      token: validateToken(value.token)
    };
    let id;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      id = idGenerator();
      if (NODE_ID_PATTERN.test(id) && !nodes.some((node) => node.id === id)) break;
      id = null;
    }
    if (!id) throw new Error('Es konnte keine eindeutige Render-Node-ID erzeugt werden.');
    const node = {
      id,
      ...clean,
      enabled: true
    };
    nodes = [...nodes, node];
    try {
      writeNodes();
    } catch (err) {
      nodes = nodes.filter((entry) => entry.id !== id);
      throw err;
    }
    return { ...node };
  }

  function updateNode(id, raw) {
    ensureLoaded();
    if (typeof id !== 'string' || !NODE_ID_PATTERN.test(id)) throw new RenderNodeNotFoundError(id);
    const index = nodes.findIndex((node) => node.id === id);
    if (index < 0) throw new RenderNodeNotFoundError(id);
    const value = requireObject(raw);
    requireAllowedFields(value, new Set(['name', 'url', 'token', 'enabled']));
    if (Object.keys(value).length === 0) {
      throw new RenderNodesValidationError('Mindestens ein Render-Node-Feld muss angegeben werden.');
    }
    const updated = { ...nodes[index] };
    if (Object.prototype.hasOwnProperty.call(value, 'name')) updated.name = validateName(value.name);
    if (Object.prototype.hasOwnProperty.call(value, 'url')) updated.url = validateUrl(value.url);
    if (Object.prototype.hasOwnProperty.call(value, 'token')) updated.token = validateToken(value.token);
    if (Object.prototype.hasOwnProperty.call(value, 'enabled')) updated.enabled = validateEnabled(value.enabled);
    const previous = nodes;
    nodes = nodes.map((node, nodeIndex) => nodeIndex === index ? updated : node);
    try {
      writeNodes();
    } catch (err) {
      nodes = previous;
      throw err;
    }
    return { ...updated };
  }

  function deleteNode(id) {
    ensureLoaded();
    if (typeof id !== 'string' || !NODE_ID_PATTERN.test(id)) throw new RenderNodeNotFoundError(id);
    const existing = nodes.find((node) => node.id === id);
    if (!existing) throw new RenderNodeNotFoundError(id);
    const previous = nodes;
    nodes = nodes.filter((node) => node.id !== id);
    try {
      writeNodes();
    } catch (err) {
      nodes = previous;
      throw err;
    }
    return { ...existing };
  }

  return { loadNodes, listNodes, createNode, updateNode, deleteNode };
}

const store = createRenderNodesStore();

module.exports = {
  RENDER_NODES_FILE,
  NODE_ID_PATTERN,
  MAX_NAME_LENGTH,
  MAX_URL_LENGTH,
  MAX_TOKEN_LENGTH,
  RenderNodesValidationError,
  RenderNodeNotFoundError,
  maskToken,
  createRenderNodesStore,
  loadNodes: store.loadNodes,
  listNodes: store.listNodes,
  createNode: store.createNode,
  updateNode: store.updateNode,
  deleteNode: store.deleteNode
};
