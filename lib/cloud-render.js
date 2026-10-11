'use strict';

// Render servers in the cloud (WP54): when render jobs wait and no free computer takes them, the app rents a server at
// Hetzner Cloud, made from a snapshot with the render agent (render-node/cloud-image.sh), and deletes it again before its
// paid hour is over. Hetzner bills every hour that has begun, and a server that is only switched off is billed in full, so
// a server is always deleted, never stopped.
//
//   start     a job waits and no free worker takes it: mode «reserve» (default) after reserveWaitMs, or at once when no worker
//             that may take it is online at all; mode «first» at once. One server per tick, at most maxServers at a time.
//   pair      every server gets a fresh system code (lib/render-agents.js createSystemPairingCode) in its user_data; the
//             computer it pairs belongs to the system, renders for everybody and carries the key of its server. No token is
//             ever in the snapshot; a deleted server's computer is removed at once, so its token stops working. A server is
//             online from the first request of its computer (queue.agentOnline), not from the pairing: the first start
//             pairs before it installs, and it can still fail after the pairing.
//   delete    the queue is empty, the computer of the server holds no job and the paid hour is nearly over (from minute
//             deleteFromMinute after the creation); or at the hard limit (hardLimitMs, also while it renders); or when it
//             was not online within bootTimeoutMs (not paired, or paired and silent); or when it was online and its computer
//             has not asked for offlineMs; or, while idle, when the cloud is switched off.
//   cap       every server is booked in a ledger (hours begun × the hourly price of the API) by the month of its creation;
//             nothing starts when the next hour would go over the monthly cap.
//   reconcile every reconcileMs: servers with our labels that the manager does not know, or that are over the hard limit, are
//             deleted (and booked); servers that are gone are booked out; computers without a server are removed; servers
//             with the label ocd-render but another instance id are left alone and shown in the status.
//   token     it cannot be removed or changed while servers exist (they can only be deleted with the token of their
//             project), except when Hetzner refuses the old one; a server the new token does not see is reported.
//   errors    a refusal of the API (limits, resource_unavailable, 401, a wrong snapshot) is a clear status and a backoff that
//             grows (backoffMs), never a loop of starts; three servers in a row that do not pair pause the starts until the
//             settings are saved again.
//
// On disk (folder 700, files 600, replaced atomically): data/cloud-render/settings.json (the settings with the API token: keep
// it out of backups), state.json (the servers, the id of this installation, the backoff, the last error), instance.json (the
// id once more) and ledger.json (with the id in every entry). The id is never made anew while one of them knows it. The
// token never appears in a log, an answer to the browser or an error: the admin sees only whether it is set.
//
// Hetzner Cloud API v1: POST /servers, DELETE /servers/{id}, GET /servers?label_selector=…, GET /server_types?name=… (prices,
// and the availability per location in server_types[].locations[].available; GET /datacenters is gone since 2026-06).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.hetzner.cloud/v1';
const LABEL = 'ocd-render';
const LABEL_VALUE = 'cloud';
const KEY_PATTERN = /^cr-[0-9a-f]{12}$/;
const INSTANCE_PATTERN = /^[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const HOUR_MS = 60 * 60 * 1000;
const MODES = Object.freeze(['reserve', 'first']);

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  serverType: 'cpx42',
  location: 'nbg1',
  snapshotId: '',
  sshKey: '',
  mode: 'reserve',
  maxServers: 1,
  monthlyCapEur: 30
});

const DEFAULTS = Object.freeze({
  tickMs: 5000,
  reconcileMs: 5 * 60 * 1000,
  firstReconcileMs: 5000,
  reserveWaitMs: 20000,
  deleteFromMinute: 50,
  hardLimitMs: 3 * HOUR_MS,
  bootTimeoutMs: 15 * 60 * 1000,
  offlineMs: 10 * 60 * 1000,
  bootSeconds: 60,
  bootFailuresToPause: 3,
  backoffMs: [60000, 2 * 60000, 5 * 60000, 10 * 60000, 30 * 60000],
  deleteRetryMs: 30000,
  requestTimeoutMs: 30000,
  ledgerMonths: 13
});

class CloudRenderError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'CloudRenderError';
    this.code = code;
    this.status = status;
  }
}

// A refusal or failure of the Hetzner API: `code` is the error code of the API (resource_unavailable, unauthorized …),
// `status` the HTTP status (0 without an answer). The message never carries the token.
class HetznerError extends Error {
  constructor(message, code, status = 0) {
    super(message);
    this.name = 'HetznerError';
    this.code = code;
    this.status = status;
  }
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const iso = (ms) => new Date(ms).toISOString();
const ms = (text) => {
  const value = Date.parse(text || '');
  return Number.isFinite(value) ? value : 0;
};
const monthOf = (at) => iso(at).slice(0, 7);
const round2 = (value) => Math.round(value * 100) / 100;

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isPlainObject(value) ? value : null;
  } catch (_) {
    return null;
  }
}

/* ---------- settings ---------- */

// The settings as stored (with the token); anything unknown or invalid falls back to the default.
function cleanSettings(raw) {
  const value = isPlainObject(raw) ? raw : {};
  const text = (item, pattern, fallback) => (typeof item === 'string' && pattern.test(item.trim()) ? item.trim() : fallback);
  const whole = (item, min, max, fallback) => (Number.isInteger(item) && item >= min && item <= max ? item : fallback);
  return {
    enabled: value.enabled === true,
    token: typeof value.token === 'string' && TOKEN_PATTERN.test(value.token) ? value.token : '',
    serverType: text(value.serverType, /^[a-z0-9-]{2,30}$/, DEFAULT_SETTINGS.serverType),
    location: text(value.location, /^[a-z0-9-]{2,20}$/, DEFAULT_SETTINGS.location),
    snapshotId: text(value.snapshotId, /^[0-9]{1,20}$/, ''),
    sshKey: text(value.sshKey, /^[A-Za-z0-9 ._@-]{1,64}$/, ''),
    mode: MODES.includes(value.mode) ? value.mode : DEFAULT_SETTINGS.mode,
    maxServers: whole(value.maxServers, 1, 10, DEFAULT_SETTINGS.maxServers),
    monthlyCapEur: typeof value.monthlyCapEur === 'number' && Number.isFinite(value.monthlyCapEur) && value.monthlyCapEur >= 0 && value.monthlyCapEur <= 10000
      ? round2(value.monthlyCapEur)
      : DEFAULT_SETTINGS.monthlyCapEur
  };
}

// A change of the admin: every field optional, each checked strictly (a wrong value is an error, not a default).
function applyPatch(current, patch) {
  if (!isPlainObject(patch)) throw new CloudRenderError('Die Änderung muss ein Objekt sein.', 'INVALID_SETTINGS');
  const next = { ...current };
  const fail = (message) => {
    throw new CloudRenderError(message, 'INVALID_SETTINGS');
  };
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') fail('enabled muss true oder false sein.');
    next.enabled = patch.enabled;
  }
  if (patch.token !== undefined) {
    if (typeof patch.token !== 'string') fail('Der Token muss ein Text sein.');
    const token = patch.token.trim();
    // the message never repeats what was typed
    if (token && !TOKEN_PATTERN.test(token)) fail('Der Hetzner-Token hat nicht die erwartete Form (20 bis 128 Buchstaben und Ziffern).');
    next.token = token;
  }
  const textField = (name, pattern, message, { empty = false } = {}) => {
    if (patch[name] === undefined) return;
    const raw = typeof patch[name] === 'number' ? String(patch[name]) : patch[name];
    if (typeof raw !== 'string') fail(message);
    const clean = raw.trim();
    if (!clean && empty) {
      next[name] = '';
      return;
    }
    if (!pattern.test(clean)) fail(message);
    next[name] = clean;
  };
  textField('serverType', /^[a-z0-9-]{2,30}$/, 'Der Servertyp ist ungültig (z. B. cpx42).');
  textField('location', /^[a-z0-9-]{2,20}$/, 'Der Ort ist ungültig (z. B. nbg1).');
  textField('snapshotId', /^[0-9]{1,20}$/, 'Die Snapshot-ID ist eine Zahl.', { empty: true });
  textField('sshKey', /^[A-Za-z0-9 ._@-]{1,64}$/, 'Der Name des SSH-Keys ist ungültig.', { empty: true });
  if (patch.mode !== undefined) {
    if (!MODES.includes(patch.mode)) fail('Der Modus ist reserve oder first.');
    next.mode = patch.mode;
  }
  if (patch.maxServers !== undefined) {
    const value = Number(patch.maxServers);
    if (!Number.isInteger(value) || value < 1 || value > 10) fail('Höchstens 1 bis 10 Server.');
    next.maxServers = value;
  }
  if (patch.monthlyCapEur !== undefined) {
    const value = Number(patch.monthlyCapEur);
    if (!Number.isFinite(value) || value < 0 || value > 10000) fail('Der Monatsdeckel ist ein Betrag von 0 bis 10000 €.');
    next.monthlyCapEur = round2(value);
  }
  return next;
}

/* ---------- user_data ---------- */

// The cloud-config of a new server: cloud-init writes the pairing for the first start (render-node/cloud-image.sh installs
// the unit that reads it, fetches the package with the code, pairs and starts the agent). Every value is checked to contain
// no quote, space or line break, so the file is read without a shell.
function cloudInit({ server, code, name }) {
  const safe = (value, pattern) => {
    const text = String(value || '');
    if (!pattern.test(text)) throw new CloudRenderError('Ungültiger Wert für user_data.', 'INVALID_USER_DATA');
    return text;
  };
  const lines = [
    `OCD_SERVER='${safe(server, /^https?:\/\/[A-Za-z0-9.:[\]/_-]{1,300}$/)}'`,
    `OCD_CODE='${safe(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)}'`,
    `OCD_NAME='${safe(name, /^[A-Za-z0-9._-]{1,40}$/)}'`
  ];
  return [
    '#cloud-config',
    'write_files:',
    '  - path: /etc/ocd-render/pairing.env',
    "    permissions: '0600'",
    '    owner: root:root',
    '    content: |',
    ...lines.map((line) => `      ${line}`),
    ''
  ].join('\n');
}

/* ---------- the manager ---------- */

// dir        data/cloud-render
// agents     lib/render-agents.js store (createSystemPairingCode, forgetSystemCode, listAgents, remove)
// queue      lib/render-queue.js, or a function that returns it (demand, revokeAgent, agentOnline)
// serverUrl  () -> the public address of the app the servers pair with (PUBLIC_BASE_URL)
function createCloudRender({ dir, agents, queue, serverUrl = () => process.env.PUBLIC_BASE_URL, fetchImpl, apiBase = API_BASE, now = Date.now, random = crypto.randomBytes, limits = {}, log = console } = {}) {
  if (!dir) throw new Error('cloud render: dir is required');
  const config = { ...DEFAULTS, ...limits };
  const files = { settings: path.join(dir, 'settings.json'), state: path.join(dir, 'state.json'), instance: path.join(dir, 'instance.json'), ledger: path.join(dir, 'ledger.json') };
  const request = fetchImpl || ((...args) => global.fetch(...args));
  const queueOf = () => (typeof queue === 'function' ? queue() : queue);
  let settings = null;
  let state = null;
  let ledger = null;
  let priceCache = null; // { key, at, priceHourlyEur }
  const upAt = new Map(); // key of an online server -> when its computer was last seen asking for work (memory)
  let chain = Promise.resolve();
  let timers = [];

  /* --- files --- */

  function loadSettings() {
    if (!settings) settings = cleanSettings(readJson(files.settings));
    return settings;
  }

  // The id of this installation (the label ocd-instance of its servers): from state.json, else instance.json, else the newest
  // open entry of the ledger; made anew only when none of them knows it. A new id would leave the servers of the old one
  // running unseen (the reconcile lists them as foreign, it does not delete them).
  function instanceIdOf(raw) {
    const valid = (value) => (typeof value === 'string' && INSTANCE_PATTERN.test(value) ? value : null);
    const fromFile = valid(readJson(files.instance)?.instanceId);
    let id = valid(raw.instanceId) || fromFile;
    if (!id) {
      const open = loadLedger().entries.filter((entry) => !entry.endedAt && valid(entry.instanceId)).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
      if (open.length) {
        id = open[0].instanceId;
        log.warn?.('[cloud-render] state.json und instance.json fehlen: ID der Installation aus dem Kassenbuch übernommen.');
      }
    }
    if (!id) id = random(6).toString('hex');
    if (fromFile !== id) {
      try {
        writeJsonAtomic(files.instance, { version: 1, instanceId: id });
      } catch (err) {
        log.warn?.(`[cloud-render] instance.json konnte nicht gespeichert werden: ${err.message}`);
      }
    }
    return id;
  }

  function loadState() {
    if (state) return state;
    const raw = readJson(files.state) || {};
    state = {
      instanceId: instanceIdOf(raw),
      servers: Array.isArray(raw.servers) ? raw.servers.filter((server) => isPlainObject(server) && KEY_PATTERN.test(String(server.key))) : [],
      failures: Number.isInteger(raw.failures) && raw.failures >= 0 ? raw.failures : 0,
      bootFailures: Number.isInteger(raw.bootFailures) && raw.bootFailures >= 0 ? raw.bootFailures : 0,
      backoffUntil: Number.isFinite(raw.backoffUntil) ? raw.backoffUntil : 0,
      paused: raw.paused === true,
      lastError: isPlainObject(raw.lastError) ? raw.lastError : null,
      capNotice: typeof raw.capNotice === 'string' ? raw.capNotice : null,
      tokenRefused: raw.tokenRefused === true,
      foreign: Array.isArray(raw.foreign) ? raw.foreign.filter(isPlainObject).slice(0, 50) : [],
      bootSeconds: Number.isFinite(raw.bootSeconds) && raw.bootSeconds > 0 ? raw.bootSeconds : config.bootSeconds
    };
    // the pairing codes live in memory: a server that had not paired when the app stopped never will
    // (a server whose creation was not answered has no id: the reconcile finds it by its labels and deletes it)
    for (const server of state.servers) {
      if ((server.status === 'creating' || server.status === 'booting') && !agentOf(server)) {
        server.status = 'booting';
        server.codeLost = true;
      }
    }
    if (raw.instanceId !== state.instanceId) saveState();
    return state;
  }

  function saveState() {
    try {
      writeJsonAtomic(files.state, { version: 1, ...state });
    } catch (err) {
      log.warn?.(`[cloud-render] Zustand konnte nicht gespeichert werden: ${err.message}`);
    }
  }

  function loadLedger() {
    if (ledger) return ledger;
    const raw = readJson(files.ledger) || {};
    ledger = { entries: Array.isArray(raw.entries) ? raw.entries.filter((entry) => isPlainObject(entry) && typeof entry.key === 'string') : [] };
    return ledger;
  }

  function saveLedger() {
    const oldest = monthOf(now() - config.ledgerMonths * 31 * 24 * HOUR_MS);
    ledger.entries = ledger.entries.filter((entry) => entry.month >= oldest);
    try {
      writeJsonAtomic(files.ledger, { version: 1, entries: ledger.entries });
    } catch (err) {
      log.warn?.(`[cloud-render] Ledger konnte nicht gespeichert werden: ${err.message}`);
    }
  }

  /* --- the ledger --- */

  function costOf(entry, at = now()) {
    const end = entry.endedAt ? ms(entry.endedAt) : at;
    const hours = Math.max(1, Math.ceil((end - ms(entry.createdAt)) / HOUR_MS));
    return hours * (Number(entry.priceHourlyEur) || 0);
  }

  function monthSpent(at = now()) {
    const month = monthOf(at);
    return round2(loadLedger().entries.filter((entry) => entry.month === month).reduce((sum, entry) => sum + costOf(entry, at), 0));
  }

  function book({ key, serverId, serverType, location, createdAt, priceHourlyEur, endedAt = null }) {
    loadLedger();
    if (ledger.entries.some((entry) => entry.key === key && entry.serverId === serverId)) return;
    ledger.entries.push({ key, serverId, serverType, location, createdAt, endedAt, priceHourlyEur, month: createdAt.slice(0, 7), instanceId: state?.instanceId || null });
    saveLedger();
  }

  function bookOut(server, at = now()) {
    loadLedger();
    const entry = ledger.entries.find((item) => item.key === server.key && !item.endedAt);
    if (!entry) return;
    entry.endedAt = iso(at);
    saveLedger();
  }

  /* --- the API --- */

  function redact(text) {
    let clean = String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ');
    const token = loadSettings().token;
    if (token) clean = clean.split(token).join('[token]');
    return clean.slice(0, 300);
  }

  async function api(method, pathname, { body } = {}) {
    const token = loadSettings().token;
    if (!token) throw new HetznerError('Kein Hetzner-Token gesetzt.', 'no_token', 0);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    timer.unref?.();
    let res;
    try {
      res = await request(`${apiBase}${pathname}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal
      });
    } catch (err) {
      const reason = controller.signal.aborted ? 'Zeitlimit' : String(err?.cause?.code || err?.code || err?.name || 'Netzwerk');
      throw new HetznerError(redact(`Hetzner ist nicht erreichbar (${reason}).`), 'network', 0);
    } finally {
      clearTimeout(timer);
    }
    // whether Hetzner refuses the token (only then may it be replaced while servers exist)
    if (res.status === 401 || res.ok) noteTokenRefused(res.status === 401);
    const text = res.status === 204 ? '' : await res.text().catch(() => '');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    }
    if (!res.ok) {
      const code = String(data?.error?.code || (res.status === 401 ? 'unauthorized' : `http_${res.status}`)).slice(0, 60);
      throw new HetznerError(redact(`Hetzner: ${data?.error?.message || `HTTP ${res.status}`} (${code})`), code, res.status);
    }
    return data || {};
  }

  // The hourly price (EUR, with VAT when the API gives it) of the server type at the location, and whether it is available
  // there; from GET /server_types before every start (availability changes; starts are rare). The last price is kept for the
  // cap of the queue's standby.
  async function offer(current) {
    const key = `${current.serverType}@${current.location}`;
    const data = await api('GET', `/server_types?name=${encodeURIComponent(current.serverType)}`);
    const type = (Array.isArray(data.server_types) ? data.server_types : []).find((item) => item?.name === current.serverType);
    if (!type) throw new HetznerError(`Hetzner kennt den Servertyp ${current.serverType} nicht.`, 'server_type_unknown', 404);
    const nameOf = (entry) => (typeof entry === 'string' ? entry : entry?.name || entry?.location?.name || entry?.location || '');
    // without a list of locations the type counts as available (the creation says otherwise)
    const locations = Array.isArray(type.locations) ? type.locations : null;
    const place = locations ? locations.find((entry) => nameOf(entry) === current.location) : {};
    const price = (Array.isArray(type.prices) ? type.prices : []).find((entry) => nameOf(entry) === current.location);
    const hourly = Number(price?.price_hourly?.gross ?? price?.price_hourly?.net);
    priceCache = {
      key,
      at: now(),
      available: Boolean(place) && place.available !== false && type.deprecated !== true,
      priceHourlyEur: Number.isFinite(hourly) && hourly > 0 ? hourly : null
    };
    return priceCache;
  }

  // Every server with the label of the render servers (of this installation and of others: the reconcile tells them apart).
  async function listRemote() {
    const selector = encodeURIComponent(`${LABEL}=${LABEL_VALUE}`);
    const servers = [];
    for (let page = 1; page <= 20; page += 1) {
      const data = await api('GET', `/servers?label_selector=${selector}&per_page=50&page=${page}`);
      servers.push(...(Array.isArray(data.servers) ? data.servers : []));
      if (!data.meta?.pagination?.next_page) break;
    }
    return servers;
  }

  /* --- errors and backoff --- */

  function noteTokenRefused(value) {
    loadState();
    if (state.tokenRefused === value) return;
    state.tokenRefused = value;
    saveState();
  }

  // A server made with an earlier token that the current one does not see: deleted, or in another project (and still billed).
  function noteUnseen(server) {
    if (!server.tokenChanged) return;
    noteError(new HetznerError(`Der Server ${server.name} ist mit dem neuen Token nicht sichtbar: gelöscht oder in einem anderen Hetzner-Projekt. Bitte in der Hetzner Console des alten Projekts prüfen.`, 'server_not_visible'), { backoff: false });
  }

  function noteError(err, { backoff = true } = {}) {
    const at = now();
    state.lastError = { at: iso(at), code: String(err?.code || 'error').slice(0, 60), message: redact(err?.message || err) };
    if (backoff) {
      state.failures += 1;
      const delays = config.backoffMs;
      const delay = err?.status === 401 ? delays[delays.length - 1] : delays[Math.min(state.failures - 1, delays.length - 1)];
      state.backoffUntil = at + delay;
      log.warn?.(`[cloud-render] ${state.lastError.message} Nächster Versuch in ${Math.round(delay / 1000)} s.`);
    } else {
      log.warn?.(`[cloud-render] ${state.lastError.message}`);
    }
    saveState();
  }

  /* --- servers and their computers --- */

  function agentOf(server) {
    let list = [];
    try {
      list = agents.listAgents();
    } catch (_) {
      return null;
    }
    return list.find((agent) => agent.cloud === server.key) || null;
  }

  // Does the computer ask for work (lib/render-queue.js agentOnline: a request in the last 45 s, or a job it reports on)?
  // Paired is not enough: the first start pairs before it installs, and it can fail after the pairing.
  function agentUp(agent) {
    if (!agent) return false;
    const target = queueOf();
    if (!target || typeof target.agentOnline !== 'function') return true;
    try {
      return Boolean(target.agentOnline(agent.id));
    } catch (_) {
      return false;
    }
  }

  function removeAgent(agentId) {
    try {
      agents.remove(agentId);
    } catch (_) {
      /* gone already */
    }
    try {
      queueOf()?.revokeAgent(agentId);
    } catch (_) {
      /* the queue hands its jobs out again on its own */
    }
  }

  function priceOfServer(remote, fallback) {
    const prices = Array.isArray(remote?.server_type?.prices) ? remote.server_type.prices : [];
    const location = remote?.datacenter?.location?.name || remote?.location?.name || null;
    const price = prices.find((entry) => (entry?.location?.name || entry?.location) === location) || prices[0];
    const hourly = Number(price?.price_hourly?.gross ?? price?.price_hourly?.net);
    return Number.isFinite(hourly) && hourly > 0 ? hourly : fallback;
  }

  // Ends a server for good: booked out, its computer removed (its token stops working), its open code dropped.
  function finish(server, reason) {
    const at = now();
    bookOut(server, at);
    const agent = agentOf(server);
    if (agent) removeAgent(agent.id);
    if (server.agentId && (!agent || agent.id !== server.agentId)) removeAgent(server.agentId);
    try {
      agents.forgetSystemCode?.(server.key);
    } catch (_) {
      /* no code */
    }
    state.servers = state.servers.filter((entry) => entry !== server);
    upAt.delete(server.key);
    saveState();
    log.info?.(`[cloud-render] Server ${server.name} gelöscht (${reason}).`);
  }

  async function deleteServer(server, reason) {
    if (server.status !== 'deleting') {
      server.status = 'deleting';
      server.deleteReason = reason;
      server.deleteTries = 0;
      // the computer stops getting jobs at once; a job it holds goes back into the queue
      const agent = agentOf(server);
      if (agent) removeAgent(agent.id);
      saveState();
    }
    if (server.id) {
      try {
        await api('DELETE', `/servers/${encodeURIComponent(server.id)}`);
      } catch (err) {
        if (err.status !== 404) {
          server.deleteTries = (server.deleteTries || 0) + 1;
          server.retryAt = now() + config.deleteRetryMs * Math.min(10, server.deleteTries);
          noteError(err, { backoff: false });
          return false;
        }
        noteUnseen(server);
      }
    }
    finish(server, server.deleteReason || reason);
    return true;
  }

  /* --- what is going on --- */

  const ageOf = (server, at = now()) => at - ms(server.createdAt);
  const minuteOfHour = (age) => (age % HOUR_MS) / 60000;
  const live = () => loadState().servers.filter((server) => server.status !== 'deleting');

  function publicUrl() {
    const value = String(serverUrl() || '').trim().replace(/\/+$/, '');
    return /^https?:\/\/[A-Za-z0-9.:[\]/_-]{1,300}$/.test(value) ? value : '';
  }

  // What is missing before a server can start: token, snapshot, the public address of the app.
  function problems(current = loadSettings()) {
    const list = [];
    if (!current.token) list.push('token');
    if (!current.snapshotId) list.push('snapshot');
    if (!publicUrl()) list.push('publicUrl');
    return list;
  }

  const ready = () => {
    const current = loadSettings();
    return current.enabled && problems(current).length === 0;
  };

  function capReached(at = now()) {
    const price = priceCache?.priceHourlyEur;
    return monthSpent(at) + (Number(price) || 0) > loadSettings().monthlyCapEur;
  }

  // For the queue (lib/render-queue.js standby): may a server come for a waiting job, how many boot, and when the first is ready.
  function standby() {
    if (!ready()) return null;
    loadState();
    const at = now();
    const booting = live().filter((server) => server.status !== 'online');
    const online = live().length - booting.length;
    const startable = !state.paused && state.backoffUntil <= at && live().length < loadSettings().maxServers && !capReached(at);
    const firstAge = booting.length ? Math.max(...booting.map((server) => ageOf(server, at))) : 0;
    let reason = null;
    if (state.paused) reason = 'Render-Server in der Cloud: pausiert, weil Server nicht starteten.';
    else if (capReached(at)) reason = 'Render-Server in der Cloud: Monatsdeckel erreicht.';
    else if (state.lastError?.code === 'unauthorized' && state.backoffUntil > at) reason = 'Render-Server in der Cloud: Hetzner lehnt den Token ab.';
    return {
      available: booting.length > 0 || online > 0 || startable,
      starting: booting.length,
      startingSeconds: booting.length ? Math.max(0, Math.round(state.bootSeconds - firstAge / 1000)) : null,
      reason
    };
  }

  /* --- the rounds --- */

  // Links the computers that paired to their servers; a server is online from the first request of its computer (and the
  // time until then is how long a server takes to start). An online server notes when its computer last asked for work.
  function syncAgents() {
    const at = now();
    for (const server of live()) {
      const agent = agentOf(server);
      if (!agent) continue;
      const up = agentUp(agent);
      if (server.status === 'booting') {
        let changed = false;
        if (server.agentId !== agent.id) {
          server.agentId = agent.id;
          changed = true;
        }
        if (up) {
          server.status = 'online';
          server.onlineAt = iso(at);
          const seconds = ageOf(server, at) / 1000;
          if (seconds > 0 && seconds < 3600) state.bootSeconds = Math.round(state.bootSeconds * 0.5 + seconds * 0.5);
          state.bootFailures = 0;
          changed = true;
        }
        if (changed) saveState();
      }
      // after a restart of the app the first look counts as a sign of life (the computers ask again within seconds)
      if (server.status === 'online' && (up || !upAt.has(server.key))) upAt.set(server.key, at);
    }
  }

  async function housekeep(current, demand) {
    const at = now();
    const busy = new Set(demand.busyAgents);
    for (const server of [...loadState().servers]) {
      if (server.status === 'creating') continue;
      if (server.status === 'deleting') {
        if (!server.retryAt || server.retryAt <= at) await deleteServer(server, server.deleteReason);
        continue;
      }
      const agent = agentOf(server);
      const age = ageOf(server, at);
      const working = Boolean(agent && busy.has(agent.id));
      if (age >= config.hardLimitMs) {
        await deleteServer(server, 'harte Grenze');
      } else if (!agent && server.agentId) {
        await deleteServer(server, 'Rechner entfernt');
      } else if (server.status !== 'online' && ((!agent && server.codeLost) || age >= config.bootTimeoutMs)) {
        // not online in time: not paired (snapshot, network, PUBLIC_BASE_URL), or paired and its computer never asked for
        // work (the first start failed after the pairing); a code lost by a restart of the app is no fault of the server
        const lost = !agent && server.codeLost;
        await deleteServer(server, lost ? 'Kopplungscode nach Neustart verloren' : agent ? 'gekoppelt, fragt aber nicht ab' : 'nicht gekoppelt');
        if (!lost) {
          state.bootFailures += 1;
          if (state.bootFailures >= config.bootFailuresToPause) state.paused = true;
          noteError(new HetznerError(agent
            ? `Der Server ${server.name} hat sich gekoppelt, sein Agent fragt aber nicht ab (Einrichtung beim ersten Start fehlgeschlagen: npm ci, Browser oder ffmpeg).`
            : `Der Server ${server.name} hat sich nicht gekoppelt (Snapshot, Netz oder PUBLIC_BASE_URL prüfen).`, 'boot_timeout'));
        }
      } else if (server.status === 'online' && !agentUp(agent) && at - (upAt.get(server.key) ?? at) >= config.offlineMs) {
        // it was online and its computer is silent since (stopped for another version, crashed): it renders nothing
        await deleteServer(server, 'Rechner meldet sich nicht mehr');
      } else if (working) {
        continue;
      } else if (!current.enabled) {
        await deleteServer(server, 'ausgeschaltet');
      } else if (server.status === 'online' && !demand.queued.length && minuteOfHour(age) >= config.deleteFromMinute) {
        await deleteServer(server, 'Stunde fast um, nichts zu tun');
      }
    }
  }

  async function maybeStart(current, demand) {
    const at = now();
    if (state.paused || state.backoffUntil > at) return;
    if (live().length >= current.maxServers || !demand.queued.length) return;
    const waiting = demand.queued.filter((job) => current.mode === 'first' || !job.workerOnline || job.waitedMs >= config.reserveWaitMs);
    const idle = new Set(demand.idleAgents);
    // a server that is not online yet (also one that paired and still installs) comes; an online one only when idle
    const coming = live().filter((server) => {
      if (server.status !== 'online') return true;
      const agent = agentOf(server);
      return Boolean(agent) && idle.has(agent.id);
    }).length;
    if (waiting.length <= coming) return;
    // the cap with the price known from the last offer: no request to Hetzner every round while the cap is reached
    if (priceCache && capReached(at)) return noteCap(current, at);
    let info;
    try {
      info = await offer(current);
    } catch (err) {
      noteError(err);
      return;
    }
    if (!info.available) {
      noteError(new HetznerError(`Hetzner bietet ${current.serverType} in ${current.location} gerade nicht an.`, 'resource_unavailable'));
      return;
    }
    const price = info.priceHourlyEur || 0;
    if (monthSpent(at) + price > current.monthlyCapEur) return noteCap(current, at);
    await startServer(current, price);
  }

  // once a month in the status and the log: the cap is reached, no server starts
  function noteCap(current, at) {
    const month = monthOf(at);
    if (state.capNotice === month) return;
    state.capNotice = month;
    state.lastError = { at: iso(at), code: 'cap_reached', message: `Monatsdeckel von ${current.monthlyCapEur} € erreicht: Es startet kein Render-Server mehr.` };
    log.warn?.(`[cloud-render] ${state.lastError.message}`);
    saveState();
  }

  async function startServer(current, price) {
    const key = `cr-${random(6).toString('hex')}`;
    const name = `ocd-render-${key.slice(3)}`;
    let pairing;
    try {
      pairing = agents.createSystemPairingCode(key);
    } catch (err) {
      noteError(err);
      return;
    }
    const server = { key, id: null, name, serverType: current.serverType, location: current.location, status: 'creating', createdAt: iso(now()), agentId: null, priceHourlyEur: price };
    state.servers.push(server);
    saveState();
    try {
      const data = await api('POST', '/servers', {
        body: {
          name,
          server_type: current.serverType,
          image: current.snapshotId,
          location: current.location,
          start_after_create: true,
          labels: { [LABEL]: LABEL_VALUE, 'ocd-instance': state.instanceId, 'ocd-server': key },
          user_data: cloudInit({ server: publicUrl(), code: pairing.code, name: `cloud-${key.slice(3, 9)}` }),
          ...(current.sshKey ? { ssh_keys: [current.sshKey] } : {})
        }
      });
      const remote = data.server || {};
      if (!Number.isFinite(Number(remote.id))) throw new HetznerError('Hetzner lieferte keine Server-ID.', 'invalid_answer', 0);
      server.id = Number(remote.id);
      server.status = 'booting';
      if (ms(remote.created)) server.createdAt = iso(ms(remote.created));
      server.priceHourlyEur = priceOfServer(remote, price);
      book({ key, serverId: server.id, serverType: server.serverType, location: server.location, createdAt: server.createdAt, priceHourlyEur: server.priceHourlyEur });
      state.failures = 0;
      state.backoffUntil = 0;
      saveState();
      log.info?.(`[cloud-render] Server ${name} (${current.serverType}, ${current.location}) gestartet.`);
    } catch (err) {
      // a server that was made although the answer did not arrive is found by its labels at the next reconcile
      state.servers = state.servers.filter((entry) => entry !== server);
      try {
        agents.forgetSystemCode(key);
      } catch (_) {
        /* no code */
      }
      noteError(err);
    }
  }

  async function tick() {
    const current = loadSettings();
    loadState();
    if (!current.enabled && !state.servers.length) return;
    const target = queueOf();
    let demand = { queued: [], busyAgents: [], idleAgents: [] };
    try {
      if (target && typeof target.demand === 'function') demand = await target.demand();
    } catch (err) {
      log.warn?.(`[cloud-render] Warteschlange nicht lesbar: ${err.message}`);
    }
    syncAgents();
    await housekeep(current, demand);
    if (ready()) await maybeStart(current, demand);
  }

  async function reconcile() {
    const current = loadSettings();
    loadState();
    if (!current.token) return;
    let listed;
    try {
      listed = await listRemote();
    } catch (err) {
      noteError(err, { backoff: err.status === 401 });
      return;
    }
    const at = now();
    const remote = listed.filter((item) => item?.labels?.['ocd-instance'] === state.instanceId);
    // the label of the render servers with another id: another installation in the same project, or this one after its id
    // was lost; never deleted here (it may render for another app), shown in the status so the admin can delete it
    const foreign = listed
      .filter((item) => item?.labels?.['ocd-instance'] !== state.instanceId)
      .slice(0, 50)
      .map((item) => ({
        id: Number(item.id) || null,
        name: String(item.name || item.id || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 63),
        instance: String(item.labels?.['ocd-instance'] || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 63),
        createdAt: iso(ms(item.created) || at)
      }));
    let changed = false;
    if (JSON.stringify(foreign) !== JSON.stringify(state.foreign || [])) {
      state.foreign = foreign;
      changed = true;
    }
    for (const item of remote) {
      const key = item?.labels?.['ocd-server'];
      const known = state.servers.find((server) => server.id === Number(item.id));
      if (known?.tokenChanged) {
        // the new token sees it: nothing to report
        delete known.tokenChanged;
        changed = true;
      }
      if (!known) {
        // a server of this installation that the manager does not know: deleted and booked
        const created = ms(item.created) || at;
        const stray = { key: KEY_PATTERN.test(String(key)) ? key : `cr-${random(6).toString('hex')}`, id: Number(item.id), name: String(item.name || item.id).slice(0, 63), serverType: item.server_type?.name || current.serverType, location: item.datacenter?.location?.name || current.location, status: 'booting', createdAt: iso(created), agentId: null, priceHourlyEur: priceOfServer(item, priceCache?.priceHourlyEur || 0) };
        book({ key: stray.key, serverId: stray.id, serverType: stray.serverType, location: stray.location, createdAt: stray.createdAt, priceHourlyEur: stray.priceHourlyEur });
        state.servers.push(stray);
        await deleteServer(stray, 'unbekannt');
      } else if (known.status !== 'deleting' && ageOf(known, at) >= config.hardLimitMs) {
        await deleteServer(known, 'harte Grenze');
      }
    }
    // servers that are gone (deleted elsewhere): booked out, their computers removed
    for (const server of [...state.servers]) {
      if (server.status === 'creating' || !server.id) continue;
      if (!remote.some((item) => Number(item.id) === server.id)) {
        noteUnseen(server);
        finish(server, 'bei Hetzner nicht mehr vorhanden');
      }
    }
    if (changed) saveState();
    // computers of servers that do not exist any more
    let list = [];
    try {
      list = agents.listAgents();
    } catch (_) {
      list = [];
    }
    for (const agent of list) {
      if (agent.cloud && !state.servers.some((server) => server.key === agent.cloud)) removeAgent(agent.id);
    }
  }

  // One round after the other (a start, a delete and a reconcile never overlap).
  function serial(fn) {
    const next = chain.then(fn);
    chain = next.catch((err) => log.warn?.(`[cloud-render] ${redact(err?.message || err)}`));
    return next;
  }

  /* --- for the admin --- */

  function publicSettings(current = loadSettings()) {
    const { token, ...rest } = current;
    return { ...rest, tokenSet: Boolean(token) };
  }

  function status() {
    const current = loadSettings();
    loadState();
    const at = now();
    let phase = 'off';
    if (current.enabled) {
      if (problems(current).length) phase = 'not_configured';
      else if (state.paused) phase = 'paused';
      else if (state.lastError?.code === 'unauthorized' && state.backoffUntil > at) phase = 'unauthorized';
      else if (state.backoffUntil > at) phase = 'backoff';
      else if (live().some((server) => server.status !== 'online')) phase = 'starting';
      else if (live().length) phase = 'running';
      else if (capReached(at)) phase = 'cap_reached';
      else phase = 'ready';
    } else if (state.servers.length) {
      // also while a DELETE is retried: the server still runs (and costs)
      phase = 'stopping';
    }
    const target = queueOf();
    return {
      settings: publicSettings(current),
      phase,
      problems: problems(current),
      servers: state.servers.map((server) => {
        const agent = agentOf(server);
        let activity = null;
        try {
          activity = agent && target ? target.agentActivity(agent) : null;
        } catch (_) {
          activity = null;
        }
        const entry = loadLedger().entries.find((item) => item.key === server.key);
        return {
          key: server.key,
          name: server.name,
          serverId: server.id,
          status: server.status,
          serverType: server.serverType,
          location: server.location,
          createdAt: server.createdAt,
          ageSeconds: Math.max(0, Math.round(ageOf(server, at) / 1000)),
          online: Boolean(activity?.online),
          rendering: activity ? activity.rendering.length : 0,
          costEur: entry ? round2(costOf(entry, at)) : 0
        };
      }),
      foreign: (state.foreign || []).map((item) => ({ name: item.name, serverId: item.id, instance: item.instance, ageSeconds: Math.max(0, Math.round((at - ms(item.createdAt)) / 1000)) })),
      month: { month: monthOf(at), spentEur: monthSpent(at), capEur: current.monthlyCapEur, priceHourlyEur: priceCache?.priceHourlyEur || null },
      lastError: state.lastError,
      backoffUntil: state.backoffUntil > at ? iso(state.backoffUntil) : null,
      bootSeconds: state.bootSeconds
    };
  }

  function updateSettings(patch) {
    const before = loadSettings();
    const next = applyPatch(before, patch);
    loadState();
    if (before.token !== next.token && state.servers.length) {
      // the servers can only be deleted with the token of their project: it stays while they exist
      if (!next.token) throw new CloudRenderError('Solange Render-Server da sind, bleibt der Token. Zuerst «Server jetzt löschen».', 'SERVERS_RUNNING', 409);
      if (!state.tokenRefused) throw new CloudRenderError('Solange Render-Server da sind, lässt sich der Token nicht wechseln. Zuerst «Server jetzt löschen»; nur einen Token, den Hetzner ablehnt, kann man ersetzen.', 'SERVERS_RUNNING', 409);
      // Hetzner refuses the old token: the new one replaces it, and a server it does not see is reported, not dropped silently
      for (const server of state.servers) server.tokenChanged = true;
    }
    writeJsonAtomic(files.settings, next);
    settings = next;
    // a new token, type, place or snapshot: the next start may try at once
    if (['token', 'serverType', 'location', 'snapshotId', 'sshKey', 'enabled'].some((name) => before[name] !== next[name]) || patch.enabled === true) {
      state.failures = 0;
      state.backoffUntil = 0;
      state.paused = false;
      state.bootFailures = 0;
      if (before.token !== next.token) {
        state.tokenRefused = false;
        if (state.lastError?.code === 'unauthorized') state.lastError = null;
      }
      priceCache = null;
      saveState();
    }
    return status();
  }

  // «Server jetzt löschen»: every server, also one that renders (its job goes back into the queue). It switches the cloud off
  // as well, else the next round would start a new server for that job (and a new paid hour) at once.
  function deleteAll() {
    return serial(async () => {
      const current = loadSettings();
      if (current.enabled) {
        settings = { ...current, enabled: false };
        writeJsonAtomic(files.settings, settings);
      }
      loadState();
      for (const server of [...state.servers]) {
        if (server.status === 'creating') continue;
        await deleteServer(server, 'von Hand gelöscht');
      }
      return status();
    });
  }

  function start() {
    if (timers.length) return;
    const every = (fn, interval) => {
      const timer = setInterval(() => {
        serial(fn).catch(() => {});
      }, interval);
      timer.unref?.();
      timers.push(timer);
    };
    every(tick, config.tickMs);
    every(reconcile, config.reconcileMs);
    const first = setTimeout(() => serial(reconcile).catch(() => {}), config.firstReconcileMs);
    first.unref?.();
    timers.push(first);
  }

  function stop() {
    for (const timer of timers) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    timers = [];
  }

  return {
    config,
    start,
    stop,
    ready,
    routesAll: ready,
    standby,
    status,
    updateSettings,
    deleteAll,
    // for tests: one round now, the files read again
    tick: () => serial(tick),
    reconcile: () => serial(reconcile),
    reload() {
      settings = null;
      state = null;
      ledger = null;
      priceCache = null;
      upAt.clear();
    }
  };
}

let defaultInstance = null;
function defaultManager() {
  if (!defaultInstance) {
    const { PATHS } = require('./config');
    defaultInstance = createCloudRender({
      dir: path.join(PATHS.root, 'data', 'cloud-render'),
      agents: require('./render-agents').defaultStore,
      queue: () => require('./rendernode').queue()
    });
  }
  return defaultInstance;
}

module.exports = {
  API_BASE,
  DEFAULT_SETTINGS,
  DEFAULTS,
  CloudRenderError,
  HetznerError,
  cleanSettings,
  applyPatch,
  cloudInit,
  createCloudRender,
  defaultManager
};
