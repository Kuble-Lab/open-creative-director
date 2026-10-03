'use strict';

// Management of the keys for the agent access: the API behind the settings page "Agent access (MCP)".
//
//   GET    /api/mcp/keys        the keys of the caller (admins: all keys), the address of the endpoint and the defaults
//   POST   /api/mcp/keys        { name, right, maxRunUsd?, maxMonthUsd?, expiresInDays? } -> 201 { key, secret }
//                               the secret is in this answer and nowhere else, ever
//   PATCH  /api/mcp/keys/:id    { name?, maxRunUsd?, maxMonthUsd? } (owner or admin)
//   DELETE /api/mcp/keys/:id    revokes the key (owner or admin); the record stays in the list as "revoked"
//
// Who may: admins and internal people (and the single local user without user management). Participants and guests get
// 403 FORBIDDEN_FOR_ROLE, anonymous callers 403. A key belongs to the person who creates it; an admin sees every key and
// can revoke every key. Somebody else's key does not exist for a non-admin (404).

const access = require('../access');
const keysLib = require('./keys');

// The address agents are given: the public base URL of the app when it is set, else derived from the request.
function endpointUrl(req, env = process.env) {
  const configured = String(env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (configured) return `${configured}/mcp`;
  const headers = req.headers || {};
  const forwarded = String(headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const protocol = forwarded === 'https' || forwarded === 'http' ? forwarded : req.protocol === 'https' ? 'https' : 'http';
  const trustProxy = /^(1|true|yes)$/i.test(String(env.TRUST_PROXY_HOST || '').trim());
  const host = String((trustProxy && headers['x-forwarded-host']) || headers.host || '').split(',')[0].trim();
  return `${protocol}://${host}/mcp`;
}

function registerKeyRoutes(app, { keys = keysLib.defaultStore, usage = null, env = process.env } = {}) {
  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

  // The viewer of the request, or null after answering (403). With `forNewKey` the person also has to be on the team list
  // still (admins always are): the rule that decides whether a key works when it is used (keys.viewerOfOwner), so nobody
  // makes a key that would be refused at once.
  function allowedViewer(req, res, { forNewKey = false } = {}) {
    const viewer = access.viewerOf(req, env);
    if (!viewer.active) return viewer; // single local user
    if (!viewer.identified) {
      res.status(403).json({ error: 'Zugriff verweigert.' });
      return null;
    }
    if (!viewer.admin && viewer.kind !== 'internal') {
      res.status(403).json({
        error: 'Der Agent-Zugang ist für dein Konto nicht verfügbar.',
        code: 'FORBIDDEN_FOR_ROLE',
        feature: 'mcp'
      });
      return null;
    }
    if (forNewKey && !keys.viewerOfOwner(ownerOf(viewer))) {
      res.status(403).json({
        error: 'Der Agent-Zugang ist für dein Konto nicht verfügbar.',
        code: 'FORBIDDEN_FOR_ROLE',
        feature: 'mcp'
      });
      return null;
    }
    return viewer;
  }

  const ownerOf = (viewer) => (viewer.active ? viewer.email : keysLib.LOCAL_OWNER);

  function fail(res, err) {
    if (err instanceof keysLib.KeyNotFoundError) return res.status(404).json({ error: err.message, code: err.code });
    if (err instanceof keysLib.KeyValidationError) return res.status(400).json({ error: err.message, code: err.code });
    if (err instanceof keysLib.KeyStoreError) return res.status(503).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Der Schlüssel konnte nicht verarbeitet werden.' });
  }

  // The key an id names, if the caller may see it (own key, or any key for an admin); else null (answered 404).
  function reachable(viewer, id, res) {
    const key = keys.get(id);
    if (!key || (!viewer.admin && key.owner !== ownerOf(viewer))) {
      res.status(404).json({ error: 'Dieser Schlüssel wurde nicht gefunden.', code: 'KEY_NOT_FOUND' });
      return null;
    }
    return key;
  }

  async function withUsage(list) {
    if (typeof usage !== 'function') return list;
    const out = [];
    for (const key of list) out.push({ ...key, monthUsedUsd: await usage(key) });
    return out;
  }

  app.get('/api/mcp/keys', async (req, res) => {
    const viewer = allowedViewer(req, res);
    if (!viewer) return undefined;
    try {
      res.set('Cache-Control', 'no-store');
      const all = viewer.admin;
      res.json({
        scope: all ? 'all' : 'own',
        keys: await withUsage(keys.list(all ? {} : { owner: ownerOf(viewer) })),
        endpoint: endpointUrl(req, env),
        defaults: keysLib.DEFAULTS,
        limits: { nameChars: keysLib.LIMITS.nameChars, maxRunUsd: keysLib.LIMITS.maxRunUsd, maxMonthUsd: keysLib.LIMITS.maxMonthUsd, maxExpiresInDays: keysLib.LIMITS.maxExpiresInDays },
        rights: keysLib.RIGHTS
      });
    } catch (err) {
      fail(res, err);
    }
    return undefined;
  });

  app.post('/api/mcp/keys', (req, res) => {
    const viewer = allowedViewer(req, res, { forNewKey: true });
    if (!viewer) return undefined;
    try {
      const input = body(req);
      const created = keys.create({
        name: input.name,
        right: input.right,
        maxRunUsd: input.maxRunUsd,
        maxMonthUsd: input.maxMonthUsd,
        expiresInDays: input.expiresInDays,
        owner: ownerOf(viewer),
        createdBy: ownerOf(viewer)
      });
      res.set('Cache-Control', 'no-store');
      res.status(201).json(created);
    } catch (err) {
      fail(res, err);
    }
    return undefined;
  });

  app.patch('/api/mcp/keys/:id', (req, res) => {
    const viewer = allowedViewer(req, res);
    if (!viewer) return undefined;
    try {
      if (!reachable(viewer, req.params.id, res)) return undefined;
      const input = body(req);
      res.set('Cache-Control', 'no-store');
      res.json({ key: keys.update(req.params.id, { name: input.name, maxRunUsd: input.maxRunUsd, maxMonthUsd: input.maxMonthUsd }) });
    } catch (err) {
      fail(res, err);
    }
    return undefined;
  });

  app.delete('/api/mcp/keys/:id', (req, res) => {
    const viewer = allowedViewer(req, res);
    if (!viewer) return undefined;
    try {
      if (!reachable(viewer, req.params.id, res)) return undefined;
      res.set('Cache-Control', 'no-store');
      res.json({ key: keys.revoke(req.params.id, ownerOf(viewer)) });
    } catch (err) {
      fail(res, err);
    }
    return undefined;
  });
}

module.exports = { registerKeyRoutes, endpointUrl };
