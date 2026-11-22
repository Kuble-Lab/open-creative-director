'use strict';

const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');
const { createIsolatedApp } = require('./support/isolated-app');
const moduleOnly = process.argv.includes('--module-only');
const OWNER = 'ada@staff.example.com';
const OTHER = 'bea@staff.example.com';
const viewer = { active: true, identified: true, admin: false, email: OWNER, kind: 'internal' };
const other = { ...viewer, email: OTHER };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const hasCode = (code) => (err) => err.code === code;
function fakeHost() {
  const host = { calls: [], connected: true, allowed: true, available: true, sites: [], fail: null,
    enabled: () => true,
    status() { return { enabled: true, connected: this.connected }; },
    async call(name, args) {
      this.calls.push({ name, args: JSON.parse(JSON.stringify(args)) });
      if (this.fail) await this.fail(name, args);
      if (name === 'connected_site') return { creation_permission: { can_create_site: this.allowed }, sites: this.sites };
      if (name === 'check_subdomain') return { result: { available: this.available } };
      if (name === 'claim_subdomain') {
        const site = { slug: args.slug, full_domain: 'host.example' };
        this.sites.push(site);
        return site;
      }
      return { ok: true };
    }
  };
  return host;
}
async function main() {
  const iso = await createIsolatedApp({ loadServer: !moduleOnly, env: { PUBLIC_BASE_URL: '', WEBSITE_HOST_MCP_URL: '', INTERNAL_EMAIL_DOMAINS: 'staff.example.com', ADMIN_EMAILS: 'admin@example.com' } });
  try {
    if (!moduleOnly) await iso.listen();
    await run(iso);
  } finally { await iso.cleanup(); }
  console.log('test-influencer-pages.js: ok');
}
async function run(iso) {
  const pages = iso.load('lib/influencer-pages');
  const inf = iso.load('lib/influencers');
  const store = iso.load('lib/store');
  const refs = iso.load('lib/publicrefs');
  await store.ensureDirs();
  const host = fakeHost();
  const options = { viewer, host, scaler: async (buffer, ext) => ({ buffer, ext }) };
  const make = (as = viewer) => inf.createInfluencer({ name: 'Testfigur', full: 'Eine erfundene Figur', site: { url: 'https://host.example' } }, { viewer: as, consent: true });
  const begin = (id, extra = {}) => pages.startPublish(id, { ...options, confirmPublic: true, ...extra });
  const figure = await make();
  assert.equal(figure.site, undefined);
  assert.equal(figure.siteUrl, null);
  const cachedHost = fakeHost();
  let time = Date.now();
  pages.setNowForTests(() => time);
  await pages.readSite(figure.id, { viewer, host: cachedHost });
  await pages.readSite(figure.id, { viewer, host: cachedHost });
  assert.equal(cachedHost.calls.length, 1);
  time += 60001;
  await pages.readSite(figure.id, { viewer, host: cachedHost });
  assert.equal(cachedHost.calls.length, 2);
  pages.setNowForTests(null);
  const off = iso.load('lib/rtk-host').defaultHost;
  assert.equal((await pages.readSite(figure.id, { viewer, host: off })).host.enabled, false);
  await assert.rejects(pages.updateSite(figure.id, {}, { viewer, host: off }), hasCode('SITE_DISABLED'));
  await assert.rejects(pages.readSite(figure.id, { viewer: other, host }), hasCode('INFLUENCER_NOT_FOUND'));
  const shared = await make(null);
  await assert.rejects(pages.readSite(shared.id, options), hasCode('INFLUENCER_FORBIDDEN'));
  await assert.rejects(pages.readSite('claudia', options), hasCode('INFLUENCER_READONLY'));
  const copy = await inf.duplicateInfluencer('claudia', { viewer, consent: true });
  assert.equal((await pages.readSite(copy.id, options)).site.items.length, 0);
  await assert.rejects(pages.updateSite(figure.id, { visibility: 'protected' }, options), hasCode('SITE_ACCESS_REQUIRED'));
  for (const domain of ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'gmx.ch', 'gmx.de', 'gmx.net', 'web.de', 'bluewin.ch', 'proton.me', 'protonmail.com']) {
    await assert.rejects(pages.updateSite(figure.id, { allowedDomains: [domain] }, options), hasCode('SITE_INVALID'));
  }
  for (const slug of ['ab', '-slug', 'slug-', 'Wrong', 'a'.repeat(41), '../bad']) await assert.rejects(pages.updateSite(figure.id, { slug }, options), hasCode('SITE_INVALID'));
  await pages.updateSite(figure.id, { slug: 'test-figur', about: 'Text', lang: 'de', usage: 'open' }, options);
  assert.deepEqual(await pages.checkSlug(figure.id, 'Äda Test!', options), { slug: 'ada-test', valid: true, available: true });
  const session = await store.createSession({ owner: OWNER });
  const foreign = await store.createSession({ owner: OTHER });
  const ledger = [
    { id: 'img-001', kind: 'image', file: 'image.png', createdAt: '2026-01-02T01:00:00Z', modelLabel: 'Testmodell', prompt: 'private' },
    { id: 'vid-001', kind: 'video', file: 'video.mp4', createdAt: '2026-01-03T01:00:00Z' },
    { id: 'aud-001', kind: 'audio', file: 'audio.mp3' }
  ];
  for (const s of [session, foreign]) {
    await fsp.writeFile(path.join(store.sessionAssetDir(s.id), 'ledger.json'), JSON.stringify(ledger));
    for (const asset of ledger) await fsp.writeFile(path.join(store.sessionAssetDir(s.id), asset.file), png);
  }
  const handle = await fsp.open(path.join(store.sessionAssetDir(session.id), 'video.mp4'), 'r+');
  await handle.truncate(200 * 1024 * 1024 + 1); await handle.close();
  await assert.rejects(pages.addItem(figure.id, { sessionId: session.id, assetId: 'vid-001' }, options), hasCode('SITE_INVALID'));
  await fsp.writeFile(path.join(store.sessionAssetDir(session.id), 'video.mp4'), png);
  const image = (await pages.addItem(figure.id, { sessionId: session.id, assetId: 'img-001', title: 'Bild' }, options)).item;
  const video = (await pages.addItem(figure.id, { sessionId: session.id, assetId: 'vid-001', title: 'Film' }, options)).item;
  assert.equal(image.file, undefined);
  assert.equal(image.local, true);
  assert.equal(image.date, '2026-01-02');
  assert.deepEqual(image.facts, [{ label: 'Modell', value: 'Testmodell' }]);
  await assert.rejects(pages.addItem(figure.id, { sessionId: foreign.id, assetId: 'img-001' }, options), hasCode('SITE_NOT_FOUND'));
  await assert.rejects(pages.addItem(figure.id, { sessionId: session.id, assetId: 'aud-001' }, options), hasCode('SITE_INVALID'));
  await pages.updateSite(figure.id, { items: [{ id: image.id, title: 'Neu' }, { id: video.id }] }, options);
  await assert.rejects(pages.updateSite(figure.id, { items: [{ id: 'unknown' }, { id: video.id }] }, options), hasCode('SITE_INVALID'));
  await inf.updateInfluencer(figure.id, { tagline: 'Neu' });
  assert.equal((await inf.readInfluencer(figure.id)).site.items.length, 2);
  await assert.rejects(inf.updateInfluencer(figure.id, { site: {} }), hasCode('INFLUENCER_INVALID'));
  const duplicate = await inf.duplicateInfluencer(figure.id, { viewer, consent: true });
  assert.equal(duplicate.site, undefined);
  await assert.rejects(fsp.stat(pages.siteDir(duplicate.id)), { code: 'ENOENT' });
  const localImage = (await inf.readInfluencer(figure.id)).site.items[0].file;
  assert.ok((await pages.previewFile(figure.id, 'index.html', options)).content.includes('Neu'));
  assert.deepEqual((await pages.previewFile(figure.id, `assets/work/${localImage}`, options)).content, png);
  for (const file of ['../influencer.json', 'assets/work/../../influencer.json', 'missing', 'assets/work/no.png']) await assert.rejects(pages.previewFile(figure.id, file, options), hasCode('SITE_NOT_FOUND'));
  host.calls.length = 0;
  await assert.rejects(begin(figure.id, { confirmPublic: false }), hasCode('SITE_CONFIRM_PUBLIC_REQUIRED'));
  assert.equal(host.calls.length, 0);
  host.connected = false;
  await assert.rejects(begin(figure.id), hasCode('HOST_NOT_CONNECTED'));
  host.connected = true; host.allowed = false;
  await assert.rejects(begin(figure.id), hasCode('SITE_CANNOT_CREATE'));
  host.allowed = true; host.available = false;
  await assert.rejects(begin(figure.id), hasCode('SITE_SLUG_TAKEN'));
  host.available = true; host.calls.length = 0;
  let finish = await (await begin(figure.id)).finished;
  assert.equal(finish.state, 'done');
  assert.equal(finish.errors.length, 1, 'only the video requires PUBLIC_BASE_URL');
  assert.match(finish.errors[0].message, /PUBLIC_BASE_URL/);
  let saved = await inf.readInfluencer(figure.id);
  assert.ok(saved.site.publishedAt);
  assert.equal(saved.site.publishedVisibility, 'public');
  const claim = host.calls.find((call) => call.name === 'claim_subdomain').args;
  assert.equal(claim.starter, 'empty');
  assert.equal(claim.owner_label, 'Creative Director – Testfigur');
  assert.deepEqual(claim.editor_emails, [OWNER]);
  assert.ok(host.calls.some((call) => call.name === 'check_subdomain'));
  assert.ok(host.calls.filter((call) => call.name === 'publish_site').every((call) => call.args.replace === false));
  let published = host.calls.filter((call) => call.name === 'publish_site');
  assert.ok(published.at(-1).args.files.some((file) => file.path === 'index.html'));
  assert.ok(!published.at(-1).args.files.find((file) => file.path === 'index.html').content.includes(video.id));
  assert.equal(JSON.parse(published.at(-1).args.files.find((file) => file.path === 'canon.json').content).url, 'https://host.example/');
  await assert.rejects(pages.updateSite(figure.id, { slug: 'changed' }, options), hasCode('SITE_SLUG_FIXED'));
  assert.equal((await inf.listInfluencers({ viewer })).find((entry) => entry.id === figure.id).siteUrl, saved.site.url);
  iso.setEnv('PUBLIC_BASE_URL', 'https://host.example');
  host.calls.length = 0;
  finish = await (await begin(figure.id)).finished;
  assert.equal(finish.errors.length, 0);
  const imported = host.calls.find((call) => call.name === 'import_asset_from_url');
  assert.match(imported.args.source_url, /^https:\/\/host\.example\/refs\//);
  assert.match(imported.args.path, /^assets\/work\/w[0-9a-f]{10}\.mp4$/);
  saved = await inf.readInfluencer(figure.id);
  assert.equal(saved.site.items.find((item) => item.id === video.id).file, null);
  assert.equal(saved.site.items.find((item) => item.id === video.id).hostPath, imported.args.path);
  assert.ok(!(await fsp.readdir(pages.siteDir(figure.id))).some((file) => file.endsWith('.mp4')));
  assert.deepEqual(await fsp.readdir(iso.load('lib/config').PATHS.publicRefsDir), []);
  assert.ok(!host.calls.some((call) => call.name === 'claim_subdomain'));
  assert.ok(!host.calls.some((call) => call.name === 'configure_site_access'));
  assert.ok((await pages.previewFile(figure.id, 'index.html', options)).content.includes(`https://host.example/${imported.args.path}`));
  await pages.updateSite(figure.id, { visibility: 'protected', allowedDomains: ['staff.example.com'] }, options);
  host.calls.length = 0;
  await (await begin(figure.id)).finished;
  assert.equal(host.calls.find((call) => call.name === 'configure_site_access').args.site_visibility, 'protected');
  await pages.removeItem(figure.id, video.id, options);
  host.fail = async (name) => { if (name === 'delete_file') throw new Error('refused'); };
  await (await begin(figure.id)).finished;
  assert.ok((await inf.readInfluencer(figure.id)).site.removedPaths.includes(imported.args.path));
  host.fail = null;
  await (await begin(figure.id)).finished;
  assert.ok(host.calls.some((call) => call.name === 'delete_file' && call.args.path === imported.args.path));
  assert.deepEqual((await inf.readInfluencer(figure.id)).site.removedPaths, []);
  // An in-flight request holds the lock, even during preflight.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reached;
  const waiting = new Promise((resolve) => { reached = resolve; });
  host.fail = async (name) => { if (name === 'connected_site') { reached(); await gate; } };
  const pending = begin(figure.id);
  // Wait until the first run is inside its preflight: a fixed tick is not enough on a busy machine.
  await waiting;
  await assert.rejects(begin(figure.id), hasCode('SITE_BUSY'));
  release(); await (await pending).finished; host.fail = null;
  // A rejected media batch is retried once, then omitted from the final page.
  const failedFigure = await make();
  const failedItem = (await pages.addItem(failedFigure.id, { sessionId: session.id, assetId: 'img-001' }, options)).item;
  let failures = 0;
  host.fail = async (name, args) => { if (name === 'publish_site' && args.files.some((file) => file.encoding === 'base64')) { failures++; throw { code: 'HOST_REFUSED', detail: '  Bild   abgelehnt. ' }; } };
  finish = await (await begin(failedFigure.id)).finished;
  assert.equal(failures, 2);
  assert.equal(finish.errors[0].itemId, failedItem.id);
  assert.match(finish.errors[0].message, /Bild abgelehnt/);
  assert.ok((await inf.readInfluencer(failedFigure.id)).site.publishedAt);
  host.fail = null;
  // Final text failure does not mark an unpublished page as published.
  const textFailure = await make();
  host.fail = async (name, args) => { if (name === 'publish_site' && args.files.some((file) => file.path === 'index.html')) throw new Error('refused'); };
  await (await begin(textFailure.id)).finished;
  assert.equal((await inf.readInfluencer(textFailure.id)).site.publishedAt, null);
  host.fail = null;
  const many = Array.from({ length: 181 }, (_, i) => ({ path: `assets/work/${i}.jpg`, content: 'x'.repeat(100000), encoding: 'base64' }));
  const packs = pages.batches(many);
  assert.ok(packs.length > 2);
  assert.ok(pages.batches(many.map((file) => ({ ...file, content: 'x' }))).every((batch) => batch.length <= 80));
  assert.ok(packs.every((batch) => batch.length <= 80 && batch.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) <= pages.MAX_BATCH));
  // Exercise the actual publisher with more than 80 media files and several content-limited calls.
  const packedFigure = await make();
  await fsp.mkdir(pages.siteDir(packedFigure.id), { recursive: true });
  const packedItems = [];
  for (let i = 0; i < 60; i++) {
    const itemId = `w${i.toString(16).padStart(10, '0')}`;
    const item = { id: itemId, kind: 'image', title: '', description: '', facts: [], date: '', file: `${itemId}.png`, hostPath: null, poster: i < 30 ? `${itemId}-poster.png` : null };
    packedItems.push(item);
    await fsp.writeFile(path.join(pages.siteDir(packedFigure.id), item.file), png);
    if (item.poster) await fsp.writeFile(path.join(pages.siteDir(packedFigure.id), item.poster), png);
  }
  await pages.writeSite(packedFigure.id, (site) => { site.items = packedItems; });
  host.calls.length = 0;
  await (await begin(packedFigure.id, { scaler: async () => ({ buffer: Buffer.alloc(110000), ext: '.jpg' }) })).finished;
  const packedCalls = host.calls.filter((call) => call.name === 'publish_site');
  assert.ok(packedCalls.length >= 4);
  assert.equal(packedCalls.slice(0, -1).flatMap((call) => call.args.files).length, 90);
  assert.ok(packedCalls.every((call) => call.args.files.length <= 80 && call.args.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) <= pages.MAX_BATCH));
  assert.ok(packedCalls.at(-1).args.files.every((file) => file.encoding === 'utf8'));
  assert.ok(packedCalls.slice(0, -1).every((call) => call.args.files.every((file) => file.encoding === 'base64')));
  const limitFigure = await make();
  await pages.writeSite(limitFigure.id, (site) => { site.items = Array.from({ length: 60 }, (_, i) => ({ id: `w${i.toString(16).padStart(10, '0')}`, kind: 'image' })); });
  await assert.rejects(pages.addItem(limitFigure.id, { sessionId: session.id, assetId: 'img-001' }, options), hasCode('SITE_ITEM_LIMIT'));
  const deleted = await make();
  let resumeDeleted;
  const deleteGate = new Promise((resolve) => { resumeDeleted = resolve; });
  host.fail = async (name) => { if (name === 'connected_site') await deleteGate; };
  const deletedRun = begin(deleted.id);
  await new Promise((resolve) => setImmediate(resolve));
  await inf.deleteInfluencer(deleted.id);
  resumeDeleted();
  assert.deepEqual((await (await deletedRun).finished).errors, []);
  await assert.rejects(fsp.stat(inf.influencerDir(deleted.id)), { code: 'ENOENT' });
  host.fail = null;
  assert.ok(!JSON.stringify(host.calls).includes('site_token'));
  // Public refs also reject a symbolic link outside the explicitly allowed root.
  const root = pages.siteDir(figure.id);
  await fsp.symlink(path.join(store.sessionAssetDir(session.id), 'image.png'), path.join(root, 'outside.png'));
  await assert.rejects(refs.publishLocalFile(path.join(root, 'outside.png'), root));
  if (!moduleOnly) await httpChecks(iso, figure.id, host, png);
  else await directRouteChecks(iso, figure.id, host);
}
// Execute the real app's registered handlers without a listening socket in restricted sandboxes.
async function directRouteChecks(iso, id, host) {
  const app = iso.load('server').app;
  const routes = app._router.stack.filter((layer) => layer.route).flatMap((layer) => Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path}`)).sort();
  assert.deepEqual(routes, Object.keys(require('./support/route-rules').ROUTE_RULES).sort());
  const off = iso.load('lib/rtk-host').defaultHost;
  const base = `/api/influencers/${id}/site`;
  const invoke = async (method, route, { suffix = '', file, body = {} } = {}) => {
    const layer = app._router.stack.find((entry) => entry.route?.path === `/api/influencers/:id/site${route}` && entry.route.methods[method]);
    assert.ok(layer, route);
    const result = { status: 200, headers: {} };
    const res = {
      status(code) { result.status = code; return this; },
      json(value) { result.body = value; return this; },
      send(value) { result.body = value; return this; },
      set(values) { Object.assign(result.headers, values); return this; },
      redirect(code, location) { result.status = code; result.location = location; }
    };
    const req = { params: { id, 0: file }, path: `${base}${suffix}`, baseUrl: '', body, query: { slug: 'test' } };
    await layer.route.stack[0].handle(req, res);
    return result;
  };
  assert.equal((await invoke('get', '')).body.host.enabled, false);
  for (const [method, route] of [['patch', ''], ['get', '/slug'], ['post', '/items'], ['delete', '/items/:itemId'], ['get', '/preview'], ['get', '/preview/*'], ['post', '/publish']]) {
    assert.equal((await invoke(method, route)).body.code, 'SITE_DISABLED');
  }
  Object.assign(off, host);
  let result = await invoke('get', '/preview', { suffix: '/preview' });
  assert.equal(result.status, 302);
  assert.equal(result.location, `${base}/preview/`);
  result = await invoke('get', '/preview', { suffix: '/preview/' });
  assert.equal(result.status, 200);
  assert.ok(result.body.startsWith('<!DOCTYPE html>'));
  assert.match(result.headers['Content-Security-Policy'], /default-src 'none'.*style-src 'self'.*connect-src 'none'/);
  assert.doesNotMatch(result.headers['Content-Security-Policy'], /unsafe-inline/);
  assert.match(result.headers['Content-Security-Policy'], /style-src 'self' 'sha256-[A-Za-z0-9+/=]+';/);
  assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers['Referrer-Policy'], 'no-referrer');
  assert.equal((await invoke('get', '/preview/*', { file: 'assets/styles.css' })).status, 200);
  assert.equal((await invoke('get', '/preview/*', { file: '../influencer.json' })).status, 404);
  assert.equal((await invoke('get', '/preview/*', { file: 'missing' })).status, 404);
  assert.equal((await invoke('get', '/preview/*', { file: 'index.html' })).status, 404);
  assert.equal((await invoke('patch', '', { body: { about: 'Route geprueft' } })).status, 200);
  const pages = iso.load('lib/influencer-pages');
  const original = pages.startPublish;
  let finished;
  pages.startPublish = async (...args) => { const run = await original(...args); finished = run.finished; return run; };
  try {
    assert.equal((await invoke('post', '/publish')).status, 202);
    await finished;
  } finally { pages.startPublish = original; }
}
async function httpChecks(iso, id, host, png) {
  const off = iso.load('lib/rtk-host').defaultHost;
  const route = `/api/influencers/${id}/site`;
  let result = await iso.request(route, { as: OWNER });
  assert.equal(result.status, 200);
  assert.equal(result.body.host.enabled, false);
  for (const [suffix, method, json] of [['', 'PATCH', {}], ['/slug?slug=test', 'GET'], ['/items', 'POST', {}], ['/items/nope', 'DELETE'], ['/preview/', 'GET'], ['/publish', 'POST', {}]]) {
    result = await iso.request(route + suffix, { as: OWNER, method, json });
    assert.equal(result.status, 404); assert.equal(result.body.code, 'SITE_DISABLED');
  }
  Object.assign(off, host);
  assert.equal((await iso.request(route, { as: OTHER })).status, 404);
  const inf = iso.load('lib/influencers');
  const hostCalls = host.calls.length;
  for (const open of [true, false]) {
    await inf.updateInfluencer(id, { open });
    for (const [suffix, method, json] of [
      ['', 'GET'], ['', 'PATCH', {}], ['/slug?slug=test', 'GET'], ['/items', 'POST', {}],
      ['/items/nope', 'DELETE'], ['/preview', 'GET'], ['/preview/assets/styles.css', 'GET'], ['/publish', 'POST', {}]
    ]) {
      const denied = await iso.request(route + suffix, { as: OTHER, method, json });
      assert.equal(denied.status, open ? 403 : 404);
      assert.equal(denied.body.code, open ? 'INFLUENCER_FORBIDDEN' : 'INFLUENCER_NOT_FOUND');
    }
  }
  assert.equal(host.calls.length, hostCalls, 'denied requests never contact the website host');
  assert.equal((await iso.request('/api/influencers/claudia/site', { as: OWNER })).status, 403);
  result = await iso.request(route + '/preview/', { as: OWNER });
  assert.equal(result.status, 200);
  assert.match(result.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(result.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await iso.request(route + '/preview/assets/styles.css', { as: OWNER })).status, 200);
  assert.equal((await iso.request(route + '/preview/nope', { as: OWNER })).status, 404);
  assert.equal(await iso.rawStatus(route + '/preview/%2e%2e/influencer.json', { as: OWNER }), 404);
  result = await iso.request(route, { as: OWNER, method: 'PATCH', json: { about: 'HTTP' } });
  assert.equal(result.status, 200);
  const pages = iso.load('lib/influencer-pages');
  const original = pages.startPublish;
  let finished;
  pages.startPublish = async (...args) => { const run = await original(...args); finished = run.finished; return run; };
  try {
    result = await iso.request(route + '/publish', { as: OWNER, method: 'POST', json: {} });
    assert.equal(result.status, 202);
    await finished;
  } finally { pages.startPublish = original; }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
