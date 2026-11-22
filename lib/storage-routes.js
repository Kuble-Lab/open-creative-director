'use strict';

// Routes of the storage overview (lib/storage-overview.js, page public/storage.html).
//   GET  /api/storage[?scope=all]   the files with their sizes, the totals and the room left on the disk
//   POST /api/storage/delete        { files: [{ sessionId, file }] } deletes them; the page asks for confirmation first

const { StorageError } = require('./storage-overview');

function registerStorageRoutes(app, { storage, access }) {
  const route = (fn) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof StorageError) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error('[storage]', err);
      return res.status(500).json({ error: 'Speicherübersicht fehlgeschlagen.' });
    }
  };
  app.get('/api/storage', route(async (req, res) => {
    res.json(await storage.overview({ viewer: access.viewerOf(req), scope: req.query.scope === 'all' ? 'all' : 'mine' }));
  }));
  app.post('/api/storage/delete', route(async (req, res) => {
    res.json(await storage.remove({ viewer: access.viewerOf(req), items: req.body && req.body.files }));
  }));
}

module.exports = { registerStorageRoutes };
