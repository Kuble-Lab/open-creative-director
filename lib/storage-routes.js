'use strict';

// Routes of the storage overview (lib/storage-overview.js, page public/storage.html).
//   GET  /api/storage[?scope=all]   the files with their sizes, the totals and the room left on the disk
//   POST /api/storage/delete        { files: [{ sessionId, file }] } deletes them; the page asks for confirmation first
// Archive (admins; lib/dropbox-archive.js), only when the installation has one:
//   POST   /api/storage/archive                 { files } moves them into the Dropbox (background, the overview shows the state)
//                                               or { sessions: [id] }: every finished file of these chats or workflows
//   POST   /api/storage/restore                 { files } and/or { sessions } fetches them back; for everybody who may use
//                                               the chat or workflow (the note where an archived file is missing asks for it)
//   GET    /api/storage/archived?sessionId=&file=   is this file in the archive, is it on its way back
//   POST   /api/storage/archive/auto            { enabled, minMb, minDays } the automatic archive for large old videos
//   POST   /api/storage/archive/connect         { appKey } -> { url } of the Dropbox page that shows the code
//   POST   /api/storage/archive/connect/finish  { code } stores the connection
//   DELETE /api/storage/archive/connect         forgets the connection (the files in the Dropbox stay)

const { StorageError } = require('./storage-overview');
const { ArchiveError } = require('./dropbox-archive');

function registerStorageRoutes(app, { storage, access, archive = null }) {
  const route = (fn) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof StorageError || err instanceof ArchiveError) return res.status(err.status).json({ error: err.message, code: err.code });
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
  app.post('/api/storage/archive', route(async (req, res) => {
    res.json(await storage.archive({ viewer: access.viewerOf(req), items: req.body && req.body.files, sessions: req.body && req.body.sessions }));
  }));
  app.post('/api/storage/restore', route(async (req, res) => {
    res.json(await storage.restore({ viewer: access.viewerOf(req), items: req.body && req.body.files, sessions: req.body && req.body.sessions }));
  }));
  app.get('/api/storage/archived', route(async (req, res) => {
    res.json(await storage.archivedState({ viewer: access.viewerOf(req), sessionId: String(req.query.sessionId || ''), file: String(req.query.file || '') }));
  }));
  app.post('/api/storage/archive/auto', route(async (req, res) => {
    res.json(await storage.setAuto({ viewer: access.viewerOf(req), settings: req.body }));
  }));
  // The connection is a credential of the installation: admins only (the single user in the local mode).
  const connection = (fn) => route(async (req, res) => {
    if (!access.viewerOf(req).admin) throw new StorageError('FORBIDDEN', 'Zugriff verweigert.', 403);
    if (!archive) throw new StorageError('NO_ARCHIVE', 'Es ist kein Archiv eingerichtet.', 404);
    res.json(await fn(req));
  });
  app.post('/api/storage/archive/connect', connection((req) => archive.startConnect(req.body && req.body.appKey)));
  app.post('/api/storage/archive/connect/finish', connection((req) => archive.finishConnect(req.body && req.body.code)));
  app.delete('/api/storage/archive/connect', connection(() => archive.disconnect()));
}

module.exports = { registerStorageRoutes };
