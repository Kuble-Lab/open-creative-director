'use strict';
const { defaultSuno } = require('./suno');
const access = require('./access');
function registerSunoRoutes(app, { suno = defaultSuno, env = process.env } = {}) {
  function base() {
    const value = new URL(env.PUBLIC_BASE_URL || '');
    if (value.protocol !== 'https:' || value.username || value.password || value.search || value.hash) throw Object.assign(new Error('PUBLIC_BASE_URL muss eine feste HTTPS-Adresse sein.'), { status: 503 });
    return value.href.replace(/\/$/, '');
  }
  app.use('/api/suno', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    if (!access.isActive(env) || !access.normalizeEmail(req.kubleUser)) return res.status(401).json({ error: 'Bitte zuerst anmelden.' });
    if (!['GET', 'HEAD'].includes(req.method)) {
      try { if (req.get('origin') !== new URL(base()).origin) return res.status(403).json({ error: 'Ungültiger Anfrageursprung.' }); }
      catch (_) { return res.status(503).json({ error: 'Suno ist noch nicht eingerichtet.' }); }
    }
    next();
  });
  const route = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : 'Suno-Anfrage fehlgeschlagen.' }); }
  };
  app.get('/api/suno/status', route(async (req, res) => res.json(suno.status(req.kubleUser))));
  app.post('/api/suno/connect', route(async (req, res) => res.json(await suno.start(req.kubleUser, base() + '/api/suno/oauth/callback'))));
  app.get('/api/suno/oauth/callback', route(async (req, res) => {
    const query = {};
    for (const name of ['state', 'code', 'error', 'iss']) query[name] = typeof req.query[name] === 'string' ? req.query[name] : '';
    await suno.complete(req.kubleUser, query);
    res.redirect(303, base() + '/');
  }));
  app.delete('/api/suno/auth', route(async (req, res) => res.json(await suno.disconnect(req.kubleUser))));
  app.get('/api/suno/account', route(async (req, res) => res.json(await suno.mcpCall(req.kubleUser, 'account-me'))));
  app.get('/api/suno/usage', route(async (req, res) => res.json(await suno.mcpCall(req.kubleUser, 'account-usage'))));
  app.get('/api/suno/library', route(async (req, res) => {
    const args = { limit: 20 };
    if (typeof req.query.cursor === 'string' && req.query.cursor.length <= 2048) args.cursor = req.query.cursor;
    res.json(await suno.mcpCall(req.kubleUser, 'library-list', args));
  }));
}
module.exports = { registerSunoRoutes };
