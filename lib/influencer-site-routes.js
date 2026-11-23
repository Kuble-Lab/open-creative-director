'use strict';

const crypto = require('crypto');
const access = require('./access');
const influencers = require('./influencers');
const pages = require('./influencer-pages');
const { defaultHost } = require('./rtk-host');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
const path = require('path');

function register(app, { host = defaultHost, influencerError, requireInfluencerId } = {}) {
  const route = (handler, { allowDisabled = false } = {}) => async (req, res) => {
    const id = requireInfluencerId(req, res);
    if (!id) return;
    try {
      const viewer = access.viewerOf(req);
      await influencers.readEditableInfluencer(id, viewer);
      if (!allowDisabled && !host.enabled()) throw Object.assign(new Error('Der Website-Host ist nicht eingerichtet.'), { code: 'SITE_DISABLED', status: 404 });
      await handler(req, res, id, { viewer, host });
    } catch (err) {
      if (String(err.code || '').startsWith('INFLUENCER_')) return influencerError(res, err);
      const known = /^(SITE_|HOST_)/.test(err.code || '');
      res.status(known ? err.status || 400 : 500).json({ error: known ? pages.safeMessage(err) : 'Die Seite konnte nicht verarbeitet werden.', code: known ? err.code : 'SITE_ERROR' });
    }
  };
  app.get('/api/influencers/:id/site', route(async (req, res, id, options) => res.json(await pages.readSite(id, options)), { allowDisabled: true }));
  app.patch('/api/influencers/:id/site', route(async (req, res, id, options) => res.json(await pages.updateSite(id, req.body, options))));
  app.get('/api/influencers/:id/site/slug', route(async (req, res, id, options) => res.json(await pages.checkSlug(id, req.query.slug, options))));
  app.post('/api/influencers/:id/site/items', route(async (req, res, id, options) => res.status(201).json(await pages.addItem(id, req.body, options))));
  app.delete('/api/influencers/:id/site/items/:itemId', route(async (req, res, id, options) => res.json(await pages.removeItem(id, req.params.itemId, options))));
  app.get('/api/influencers/:id/site/preview', route(async (req, res) => {
    if (req.path.endsWith('/')) return sendPreview(req, res);
    res.redirect(302, 'preview/'); // relative: the app may sit behind a path prefix
  }));
  async function sendPreview(req, res, id = req.params.id, options = { viewer: access.viewerOf(req), host }) {
    if (req.params[0] === 'index.html') throw Object.assign(new Error('Datei nicht gefunden.'), { code: 'SITE_NOT_FOUND', status: 404 });
    const file = await pages.previewFile(id, req.params[0] || 'index.html', options);
    let origin = '';
    try { const url = new URL(file.siteUrl); if (url.protocol === 'https:') origin = ` ${url.origin}`; } catch (_) { /* Drafts have no host origin. */ }
    // The page carries its accent colour in one small inline style block; only that exact text is allowed.
    const inline = /\.html$/.test(file.path) ? [...String(file.content).matchAll(/<style>([\s\S]*?)<\/style>/g)]
      .map((match) => ` 'sha256-${crypto.createHash('sha256').update(match[1]).digest('base64')}'`).join('') : '';
    res.set({ 'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'${inline}; img-src 'self'${origin}; media-src 'self'${origin}; frame-src https://www.youtube-nocookie.com; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; connect-src 'none'`,
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'Content-Type': MIME[path.extname(file.path).toLowerCase()] || 'application/octet-stream' });
    res.send(file.content);
  }
  app.get('/api/influencers/:id/site/preview/*', route(sendPreview));
  app.post('/api/influencers/:id/site/publish', route(async (req, res, id, options) => {
    const result = await pages.startPublish(id, { ...options, user: req.kubleUser, confirmPublic: req.body?.confirmPublic });
    res.status(202).json({ job: result.job });
  }));
}
module.exports = { register };
