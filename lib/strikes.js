'use strict';

// Only stable refusal codes and identifiers reach disk. Provider messages are inspected, never stored.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const access = require('./access');
const { PATHS } = require('./config');
const DAY = 86400000;
const NON_CONTENT = new Set(['VIDEO_FRAME_RATIO', 'VIDEO_FRAME_UNREADABLE', 'FLUX_MAX_KEYFRAMES_COUNT', 'FLUX_MAX_KEYFRAME_TIMES_COUNT', 'FLUX_MAX_KEYFRAME_TIMES_ORDER', 'FLUX_MAX_KEYFRAME_TIMES_UNIQUE']);
const KNOWN = new Set(['PLANNER_CONTENT_FILTER', 'IMAGE_SAFETY_EXHAUSTED', 'FAL_CONTENT_CHECKER']);
const normalize = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const positiveInteger = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

// Order matters: (1) codes that are never a strike, (2) the known refusal codes, (3) texts that are never a strike,
// (4) refusal texts. A known code wins over the text, because a message can quote the person's own prompt
// (IMAGE_SAFETY_EXHAUSTED carries the blocked line) and must not talk a refusal away with a word like "timeout".
const NEVER_CODE = /^(?:VIDEO_REAL_PERSON(?:_JOB)?|VIDEO_MODEL_REFUSED|ip_detected|BUDGET_.*|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|ABORT_ERR|ERR_CANCELED)$|(?:^|_)(?:VALIDATION|FORMAT|NETWORK|TIMEOUT|ABORT|ABORTED|CANCELLED|CANCELED|RESTART|RESTARTED|INVALID)(?:_|$)/i;
const NEVER_TEXT = /\b(?:VIDEO_REAL_PERSON(?:_JOB)?|VIDEO_MODEL_REFUSED|BUDGET_[A-Z_]+)\b|InputImageSensitiveContentDetected|may contain real person|echte Person|reale Person|IP-\/Markenreferenz|\bip_detected\b|Server restarted during the run|\b(?:timed? out|timeout|aborted|cancelled|canceled|ECONNRESET|ECONNREFUSED|ENOTFOUND)\b|network error|validation (?:error|failed)|invalid (?:format|parameter)|abgebrochen|Neustart|Zeitlimit erreicht/i;
const REFUSAL_TEXT = /content[_ -]filter|content[ _-]?checker|content[_ -]policy[_ -]violation|flagged.{0,60}moderation|(?:blocked|refused).{0,30}(?:for |by |due to )?safety|\bnsfw\b|sensitive[_ ]content|Inhaltsfilter|\b(?:IMAGE_SAFETY|IMAGE_PROHIBITED_CONTENT|PROHIBITED_CONTENT)\b|Gemini could not generate an image \((?:SAFETY|BLOCKLIST|SPII)\)/i;

function classify({ message = '', code = '' } = {}) {
  const detail = String(message || '');
  const reason = String(code || '');
  if (NON_CONTENT.has(reason) || NEVER_CODE.test(reason)) return null;
  if (KNOWN.has(reason)) return { strike: true, code: reason };
  if (NEVER_TEXT.test(`${reason} ${detail}`)) return null;
  return REFUSAL_TEXT.test(`${reason} ${detail}`) ? { strike: true, code: 'CONTENT_REFUSED' } : null;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function createStrikes({ dataDir = path.join(PATHS.root, 'data'), now = Date.now, env = process.env,
  isAdmin = (email) => access.isAdminEmail(email, env), warn = (...args) => console.warn(...args) } = {}) {
  const journalFile = path.join(dataDir, 'strikes.json');
  const blockedFile = path.join(dataDir, 'blocked-users.json');
  let blockCache;
  let warned = false;
  const signature = (file) => {
    try { const stat = fs.statSync(file); return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`; }
    catch (err) { if (err.code === 'ENOENT') return 'none'; throw err; }
  };
  function read(file, array) {
    let value;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (err) { if (err.code === 'ENOENT') return array ? [] : {}; throw err; }
    if (!value || (array ? !Array.isArray(value) : typeof value !== 'object' || Array.isArray(value))) throw new Error('INVALID_STRIKES_FILE');
    if (array && value.some((row) => !row || typeof row.id !== 'string' || !Number.isFinite(Date.parse(row.ts)) || typeof row.user !== 'string' || typeof row.code !== 'string' || !['run', 'job'].includes(row.source))) throw new Error('INVALID_STRIKES_JOURNAL');
    if (!array && Object.values(value).some((row) => !row || typeof row !== 'object' || Array.isArray(row) || (row.blockedAt && !Number.isFinite(Date.parse(row.blockedAt))))) throw new Error('INVALID_BLOCK_LIST');
    return value;
  }
  function blocks() {
    const sig = signature(blockedFile);
    if (blockCache?.sig !== sig) blockCache = { sig, value: read(blockedFile, false) };
    return blockCache.value;
  }
  function saveBlocks(value) {
    atomicJson(blockedFile, value);
    blockCache = { sig: signature(blockedFile), value };
  }
  function journal() {
    return read(journalFile, true).filter((row) => row && typeof row.id === 'string' && Number.isFinite(Date.parse(row.ts)) && Date.parse(row.ts) >= now() - 365 * DAY)
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).slice(-5000);
  }
  const adminOf = (email) => Boolean(isAdmin(email));
  function isBlocked(raw) {
    try {
      const email = normalize(raw);
      if (!access.normalizeEmail(email) || adminOf(email)) return false;
      return Boolean(blocks()[email]?.blockedAt);
    } catch (_) {
      if (!warned) { warned = true; warn('[strikes] Block list could not be read.'); }
      return false;
    }
  }
  function validEmail(raw) {
    const email = access.normalizeEmail(raw);
    if (!email) throw Object.assign(new Error('Invalid email'), { code: 'INVALID_EMAIL' });
    return email;
  }
  function block(raw, { by = 'system', reason = 'manual' } = {}) {
    const email = validEmail(raw);
    if (adminOf(email)) throw Object.assign(new Error('Admins cannot be blocked'), { code: 'CANNOT_BLOCK_ADMIN' });
    const current = blocks();
    if (!current[email]?.blockedAt) saveBlocks({ ...current, [email]: { blockedAt: new Date(now()).toISOString(), by: normalize(by), reason: reason === 'strikes' ? 'strikes' : 'manual' } });
    return evaluate().users.find((user) => user.email === email);
  }
  function unblock(raw) {
    const email = validEmail(raw);
    saveBlocks({ ...blocks(), [email]: { blockedAt: null, unblockedAt: new Date(now()).toISOString() } });
    return evaluate().users.find((user) => user.email === email);
  }
  function evaluate() {
    const rows = journal();
    const blocked = blocks();
    const windowDays = positiveInteger(env.STRIKE_WINDOW_DAYS, 30);
    const limit = positiveInteger(env.STRIKE_LIMIT, 3);
    const perUser = new Map();
    for (const row of rows) {
      if (!perUser.has(row.user)) perUser.set(row.user, []);
      perUser.get(row.user).push(row);
    }
    const emails = new Set([...perUser.keys(), ...Object.keys(blocked)]);
    const users = [...emails].sort().map((email) => {
      const mine = perUser.get(email) || [];
      const count = mine.filter((row) => Date.parse(row.ts) >= now() - windowDays * DAY && Date.parse(row.ts) <= now()).length;
      const admin = adminOf(email);
      const blockable = Boolean(access.normalizeEmail(email)) && !admin;
      const entry = blocked[email];
      const active = blockable && Boolean(entry?.blockedAt);
      return { email, count, total: mine.length, lastTs: mine.at(-1)?.ts || null,
        state: count >= limit ? 'due' : count > 0 && count === limit - 1 ? 'near' : 'ok', blocked: active,
        blockedAt: active ? entry.blockedAt : null, blockedReason: active ? entry.reason : null, admin, blockable };
    });
    const fields = ['id', 'ts', 'user', 'source', 'code', 'provider', 'model', 'workflowId', 'runId', 'sessionId', 'jobId'];
    return { windowDays, limit, autoBlock: env.STRIKE_AUTO_BLOCK === '1', users,
      recent: rows.slice(-50).reverse().map((row) => Object.fromEntries(fields.map((key) => [key, row[key] ?? null]))) };
  }
  function sync({ runRows = [], jobRows = [] } = {}) {
    const rows = journal(); // An unreadable file aborts before any write.
    const ids = new Set(rows.map((row) => row.id));
    function add(row, source) {
      if (!['failed', 'error'].includes(row.status)) return;
      const runId = row.id || row.runId;
      if (source === 'run' ? !row.workflowId || !runId : !row.sessionId || !row.jobId) return;
      const id = source === 'run' ? `run:${row.workflowId}:${runId}` : `job:${row.sessionId}:${row.jobId}`;
      if (ids.has(id)) return;
      const failures = Array.isArray(row.failures) ? row.failures : [];
      // Keep each node's code beside its text so an excluded node cannot taint another refusal.
      const candidates = [...failures, { code: row.errorCode || row.code, message: row.error }];
      if (!failures.length && Array.isArray(row.codes)) candidates.push(...row.codes.map((code) => ({ code, message: row.error })));
      const refusal = candidates.map((item) => ({ item, match: classify(item) })).find((entry) => entry.match);
      if (!refusal) return;
      const ts = source === 'run' ? row.finishedAt || row.startedAt : row.ts;
      if (!Number.isFinite(Date.parse(ts)) || Date.parse(ts) < now() - 365 * DAY || Date.parse(ts) > now()) return;
      const user = normalize(row.user) || 'lokal';
      const entry = { id, ts: new Date(ts).toISOString(), user, source, code: refusal.match.code };
      for (const key of ['provider', 'model']) if (typeof (refusal.item[key] || row[key]) === 'string') entry[key] = (refusal.item[key] || row[key]).slice(0, 200);
      if (source === 'run') Object.assign(entry, { workflowId: row.workflowId, runId });
      else Object.assign(entry, { sessionId: row.sessionId, jobId: row.jobId });
      rows.push(entry); ids.add(id);
    }
    runRows.forEach((row) => add(row, 'run'));
    jobRows.forEach((row) => add(row, 'job'));
    const retained = rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).slice(-5000);
    // Also persist retention cleanup when the input brought no new strikes.
    const previous = read(journalFile, true);
    if (JSON.stringify(previous) !== JSON.stringify(retained)) atomicJson(journalFile, retained);
    if (env.STRIKE_AUTO_BLOCK === '1') {
      const report = evaluate();
      const blocked = blocks();
      const previousIds = new Set(previous.map((row) => row.id));
      const added = new Set(retained.filter((row) => !previousIds.has(row.id)).map((row) => row.user));
      for (const user of report.users) {
        const release = blocked[user.email]?.unblockedAt;
        if (user.blockable && user.state === 'due' && !user.blocked && (!release || added.has(user.email) || Date.parse(user.lastTs) > Date.parse(release))) block(user.email, { by: 'system', reason: 'strikes' });
      }
    }
    return evaluate();
  }
  return { classify, sync, evaluate, block, unblock, isBlocked, list: () => ({ ...blocks() }) };
}

const MESSAGES = Object.freeze({
  de: 'Dein Konto ist gesperrt. Du kannst bisherige Ergebnisse ansehen und herunterladen, aber nichts Neues erzeugen. Wende dich an die Kursleitung oder eine Administratorin oder einen Administrator.',
  en: 'Your account is blocked. You can view and download previous results, but cannot create anything new. Contact your course leader or an administrator.',
  es: 'Tu cuenta está bloqueada. Puedes ver y descargar resultados anteriores, pero no crear nada nuevo. Contacta con la dirección del curso o con una persona administradora.'
});
function createBlockGuard({ strikes = defaultStore, isActive = access.isActive } = {}) {
  return (req, res, next) => {
    if (!isActive() || !String(req.path || '').toLowerCase().startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !strikes.isBlocked(req.kubleUser)) return next();
    return res.status(403).json({ code: 'ACCOUNT_BLOCKED', error: MESSAGES.de, messages: MESSAGES });
  };
}
const defaultStore = createStrikes();
module.exports = { classify, createStrikes, defaultStore, createBlockGuard, atomicJson, positiveInteger, MESSAGES };
