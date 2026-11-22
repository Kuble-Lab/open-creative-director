'use strict';
const access = require('./access');

function registerRtkHostRoutes(app, { host = require('./rtk-host').defaultHost, env = process.env } = {}) {
  function base(req) {
    try {
      if (env.PUBLIC_BASE_URL) {
        const value = new URL(env.PUBLIC_BASE_URL);
        if (value.protocol !== 'https:' || value.username || value.password || value.search || value.hash) throw new Error();
        return value.href.replace(/\/$/, '');
      }
      if (!access.isActive(env)) {
        const raw = req.get('host');
        if (typeof raw === 'string' && /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(raw)) {
          const value = new URL('http://' + raw);
          return value.origin;
        }
      }
    } catch (_) { /* Never use an untrusted Host header as an OAuth redirect. */ }
    throw Object.assign(new Error('Die Rücksprungadresse für den Website-Host ist nicht eingerichtet.'), { status: 503, code: 'HOST_UNAVAILABLE' });
  }
  app.use('/api/website-host', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    const viewer = access.viewerOf(req, env);
    if (viewer.active && !viewer.identified) return res.status(401).json({ error: 'Bitte zuerst anmelden.', code: 'LOGIN_UNCONFIRMED' });
    next();
  });
  const route = (manage, fn) => async (req, res) => {
    try {
      const viewer = access.viewerOf(req, env);
      if (manage && !host.enabled()) return res.status(404).json({ error: 'Der Website-Host ist nicht eingerichtet.', code: 'HOST_DISABLED' });
      if (manage && !viewer.admin) return res.status(403).json({ error: 'Nur Admins dürfen den Website-Host verbinden.', code: 'FORBIDDEN' });
      if (viewer.active && !['GET', 'HEAD'].includes(req.method) && req.get('origin') !== new URL(base(req)).origin) return res.status(403).json({ error: 'Ungültiger Anfrageursprung.', code: 'FORBIDDEN' });
      await fn(req, res, viewer);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Die Anfrage beim Website-Host ist fehlgeschlagen.', code: err.code || 'HOST_UNAVAILABLE' });
    }
  };
  app.get('/api/website-host/status', route(false, async (req, res, viewer) => {
    if (!host.enabled()) return res.json({ enabled: false, connected: false, canManage: viewer.admin });
    const status = host.status();
    res.json({ enabled: status.enabled, connected: status.connected, canManage: viewer.admin, ...(viewer.admin ? { connectedAt: status.connectedAt, connectedBy: status.connectedBy } : {}) });
  }));
  app.post('/api/website-host/connect', route(true, async (req, res, viewer) => res.json(await host.start(viewer.email, base(req) + '/api/website-host/oauth/callback'))));
  app.get('/api/website-host/oauth/callback', route(true, async (req, res, viewer) => {
    const redirectBase = base(req);
    const query = {};
    for (const name of ['state', 'code', 'error', 'iss']) query[name] = typeof req.query[name] === 'string' ? req.query[name] : '';
    let outcome = 'connected';
    try { await host.complete(viewer.email, query); } catch (_) { outcome = 'failed'; }
    res.redirect(303, redirectBase + '/?websiteHost=' + outcome);
  }));
  app.delete('/api/website-host/auth', route(true, async (req, res) => res.json(await host.disconnect())));
}
module.exports = { registerRtkHostRoutes };
