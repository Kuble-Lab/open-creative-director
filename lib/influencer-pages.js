'use strict';

// Page storage and the installation-wide host connection are separate: all remote work is injectable.
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const influencers = require('./influencers');
const store = require('./store');
const access = require('./access');
const publicrefs = require('./publicrefs');
const ffmpeg = require('./ffmpeg');
const { buildSite, slugOf, safeSource, MAX_ITEMS } = require('./influencer-site');
const { defaultHost } = require('./rtk-host');

const jobs = new Map();
const busy = new Set();
const connections = new WeakMap();
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO = new Set(['.mp4', '.webm', '.mov']);
const LOCAL = /^w[a-f0-9]{10}(?:-poster)?\.(?:png|jpg|jpeg|webp|mp4|webm|mov)$/;
const HOST_PATH = /^assets\/work\/w[a-f0-9]{10}(?:-poster)?\.(?:png|jpg|jpeg|webp|mp4|webm|mov)$/;
const FREEMAIL = new Set('gmail.com googlemail.com outlook.com hotmail.com yahoo.com icloud.com gmx.ch gmx.de gmx.net web.de bluewin.ch proton.me protonmail.com'.split(' '));
const MAX_BATCH = 6 * 1024 * 1024;
let clock = () => Date.now();
const timestamp = () => new Date(clock()).toISOString();
const clone = (value) => value == null ? null : JSON.parse(JSON.stringify(value));
const error = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const invalid = (message = 'Die Angaben zur Seite sind ungültig.') => error('SITE_INVALID', message);
const missing = () => error('SITE_NOT_FOUND', 'Datei oder Arbeit nicht gefunden.', 404);
const busyError = () => error('SITE_BUSY', 'Diese Seite wird bereits publiziert.', 409);
const siteDir = (id) => path.join(influencers.influencerDir(id), 'site');
const text = (value, max) => {
  if (typeof value !== 'string' || [...value].length > max) throw invalid();
  return value.trim();
};
function enabled(host) {
  if (!host.enabled()) throw error('SITE_DISABLED', 'Der Website-Host ist nicht eingerichtet.', 404);
}
function defaults(influencer) {
  const site = influencer.site || {};
  return { slug: slugOf(influencer.name), visibility: 'public', allowedEmails: [], allowedDomains: [], lang: 'de', about: '', usage: 'closed',
    items: [], removedPaths: [], publishedAt: null, publishedVisibility: null, url: null, lastError: null, ...clone(site) };
}
function shown(site) {
  const { publishedAccess, ...result } = clone(site);
  // `preview` is the path of the local copy below .../site/preview/ (for a thumbnail in the editor), never the file's place on disk.
  result.items = result.items.map(({ file, ...item }) => ({ ...item, local: Boolean(file), hosted: Boolean(item.hostPath),
    preview: LOCAL.test(file || '') ? `assets/work/${file}` : null }));
  return result;
}
function safeMessage(err) {
  if (err?.code === 'HOST_REFUSED') return `Der Website-Host hat die Aktion abgelehnt. ${String(err.detail || '').replace(/\s+/g, ' ').trim().slice(0, 300)}`.trim();
  if (err?.code === 'HOST_AUTH') return 'Die Verbindung zum Website-Host muss neu hergestellt werden.';
  if (String(err?.code || '').startsWith('SITE_')) return String(err.message).replace(/ß/g, 'ss');
  return 'Die Seite konnte nicht vollständig zum Website-Host übertragen werden.';
}
async function connectedSite(host, fresh = false) {
  const cached = connections.get(host);
  if (!fresh && cached && clock() - cached.at < 60000) return cached.value;
  try {
    const value = await host.call('connected_site', {});
    connections.set(host, { at: clock(), value });
    return value;
  } catch (err) {
    connections.delete(host);
    throw err;
  }
}
const ownsSlug = (value, slug) => Array.isArray(value?.sites) && value.sites.some((site) => site.slug === slug);
function availability(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.available === 'boolean') return value.available;
  for (const nested of Object.values(value)) {
    const found = availability(nested);
    if (found !== null) return found;
  }
  return null;
}
async function readSite(id, { viewer = access.LOCAL_VIEWER, host = defaultHost } = {}) {
  const influencer = await influencers.readEditableInfluencer(id, viewer);
  const active = Boolean(host.enabled());
  const connected = active && Boolean(host.status().connected);
  const hostState = { enabled: active, connected, canCreate: null, canManage: Boolean(viewer?.admin) };
  if (!active) return { host: hostState, site: null, job: null };
  const site = defaults(influencer);
  if (connected) {
    try {
      const value = await connectedSite(host);
      hostState.canCreate = ownsSlug(value, site.slug) ? true : typeof value?.creation_permission?.can_create_site === 'boolean' ? value.creation_permission.can_create_site : null;
    } catch (_) { /* A temporarily unavailable host must not hide the local draft. */ }
  }
  return { host: hostState, site: shown(site), slugSuggestion: slugOf(influencer.name), published: Boolean(site.publishedAt), maxItems: MAX_ITEMS, job: clone(jobs.get(id)) };
}

// Every site write rereads under the same lock as influencer updates and deletion.
async function writeSite(id, change, { internal = false, viewer = access.LOCAL_VIEWER } = {}) {
  return store.withLock(`influencer-${id}`, async () => {
    if (!internal && busy.has(id)) throw busyError();
    const influencer = internal ? await influencers.readInfluencer(id) : await influencers.readEditableInfluencer(id, viewer);
    const site = defaults(influencer);
    const result = await change(site, influencer);
    await influencers.writeInfluencer({ ...influencer, site });
    return result === undefined ? site : result;
  });
}
function validateAccess(site) {
  if (site.visibility === 'protected' && !site.allowedEmails.length && !site.allowedDomains.length) {
    throw error('SITE_ACCESS_REQUIRED', 'Für eine geschützte Seite braucht es mindestens eine E-Mail-Adresse oder Domain.');
  }
}
function list(value, max, normalise) {
  if (!Array.isArray(value) || value.length > max) throw invalid();
  return [...new Set(value.map((entry) => {
    const result = normalise(entry);
    if (!result) throw invalid();
    return result;
  }))];
}
async function updateSite(id, patch, { viewer = access.LOCAL_VIEWER, host = defaultHost } = {}) {
  enabled(host);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid();
  await writeSite(id, (site) => {
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'slug') {
        if (site.publishedAt && value !== site.slug) throw error('SITE_SLUG_FIXED', 'Die Adresse kann nach dem ersten Publizieren nicht mehr geändert werden.');
        if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/.test(value)) throw invalid('Die Adresse braucht 3 bis 40 Kleinbuchstaben, Ziffern oder Bindestriche.');
        site.slug = value;
      } else if (key === 'allowedEmails') site[key] = list(value, 50, access.normalizeEmail);
      else if (key === 'allowedDomains') site[key] = list(value, 20, (entry) => {
        if (typeof entry !== 'string') return null;
        const domain = entry.trim().toLowerCase();
        return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) && !FREEMAIL.has(domain) ? domain : null;
      });
      else if (key === 'about') site.about = text(value, 2000);
      else if (['visibility', 'lang', 'usage'].includes(key)) {
        const choices = { visibility: ['public', 'protected'], lang: ['de', 'en', 'es'], usage: ['open', 'closed'] };
        if (!choices[key].includes(value)) throw invalid();
        site[key] = value;
      } else if (key === 'items') {
        if (!Array.isArray(value) || value.length !== site.items.length || new Set(value.map((item) => item?.id)).size !== site.items.length) throw invalid();
        site.items = value.map((item) => {
          const old = site.items.find((entry) => entry.id === item?.id);
          if (!old || Object.keys(item).some((field) => !['id', 'title', 'description'].includes(field))) throw invalid();
          return { ...old, ...(item.title !== undefined ? { title: text(item.title, 120) } : {}), ...(item.description !== undefined ? { description: text(item.description, 1200) } : {}) };
        });
      } else throw invalid();
    }
    validateAccess(site);
  }, { viewer });
  return readSite(id, { viewer, host });
}
async function checkSlug(id, value, { viewer = access.LOCAL_VIEWER, host = defaultHost } = {}) {
  enabled(host);
  await influencers.readEditableInfluencer(id, viewer);
  const slug = slugOf(value);
  const result = { slug, valid: Boolean(slug), available: null };
  if (slug && host.status().connected) {
    try { result.available = availability(await host.call('check_subdomain', { slug })); } catch (_) { /* Availability is optional while editing. */ }
  }
  return result;
}
async function safeLocal(root, file) {
  const resolvedRoot = await fsp.realpath(root);
  const target = path.join(root, file);
  const stat = await fsp.lstat(target);
  if (!stat.isFile() || !(await fsp.realpath(target)).startsWith(`${resolvedRoot}${path.sep}`)) throw missing();
  return { target, stat };
}
async function addItem(id, input = {}, { viewer = access.LOCAL_VIEWER, host = defaultHost } = {}) {
  enabled(host);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const { sessionId, assetId, title = '', description = '' } = input;
  await influencers.readEditableInfluencer(id, viewer);
  const notFound = () => error('SITE_NOT_FOUND', 'Session oder Asset nicht gefunden.', 404);
  if (!store.isValidId(sessionId) || typeof assetId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(assetId)) throw notFound();
  try { if (!access.canUse(await store.readSessionAccess(sessionId), viewer)) throw notFound(); } catch (_) { throw notFound(); }
  const asset = (await store.readLedger(sessionId)).find((entry) => entry.id === assetId);
  if (!asset || asset.pending) throw notFound();
  const ext = path.extname(String(asset.file || '')).toLowerCase();
  if (!(asset.kind === 'image' && IMAGE.has(ext)) && !(asset.kind === 'video' && VIDEO.has(ext))) throw invalid('Nur Bilder und Videos können als Arbeit hinzugefügt werden.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.file) || asset.file.includes('..')) throw notFound();
  let target, stat;
  try { ({ target, stat } = await safeLocal(store.sessionAssetDir(sessionId), asset.file)); } catch (_) { throw notFound(); }
  if (asset.kind === 'video' && stat.size > 200 * 1024 * 1024) throw invalid('Ein Video darf höchstens 200 MB gross sein.');
  const item = { id: `w${crypto.randomBytes(5).toString('hex')}`, kind: asset.kind, title: text(title, 120), description: text(description, 1200),
    date: /^\d{4}-\d{2}-\d{2}/.test(String(asset.createdAt || asset.ts || '')) ? String(asset.createdAt || asset.ts).slice(0, 10) : '', facts: [], file: null, hostPath: null, poster: null };
  // Only an explicit display label is public; raw model/provider metadata may contain private inputs.
  if (typeof asset.modelLabel === 'string' && !/[@\r\n]/.test(asset.modelLabel)) item.facts.push({ label: 'Modell', value: asset.modelLabel.slice(0, 200) });
  item.file = `${item.id}${ext}`;
  try {
    await writeSite(id, async (site) => {
      if (site.items.length >= MAX_ITEMS) throw error('SITE_ITEM_LIMIT', 'Die Seite hat bereits 60 Arbeiten.', 409);
      await fsp.mkdir(siteDir(id), { recursive: true });
      await fsp.copyFile(target, path.join(siteDir(id), item.file));
      site.items.unshift(item);
    }, { viewer });
  } catch (err) {
    await fsp.rm(path.join(siteDir(id), item.file), { force: true }).catch(() => {});
    throw err;
  }
  return { item: shown({ items: [item] }).items[0], site: (await readSite(id, { viewer, host })).site };
}
async function removeItem(id, itemId, { viewer = access.LOCAL_VIEWER, host = defaultHost } = {}) {
  enabled(host);
  await writeSite(id, async (site) => {
    const item = site.items.find((entry) => entry.id === itemId);
    if (!item) throw missing();
    for (const file of [item.file, item.poster]) if (LOCAL.test(file || '')) await fsp.rm(path.join(siteDir(id), file), { force: true });
    for (const file of [item.hostPath, item.poster]) if (HOST_PATH.test(file || '') && !site.removedPaths.includes(file)) site.removedPaths.push(file);
    site.items = site.items.filter((entry) => entry.id !== itemId);
  }, { viewer });
  return { site: (await readSite(id, { viewer, host })).site };
}
function looks(influencer) {
  return influencer.images.filter((file) => IMAGE.has(path.extname(file).toLowerCase())).map((file, index) => ({ file, path: `assets/looks/${index + 1}${path.extname(file).toLowerCase()}` }));
}
function absolute(site, file) {
  if (!site.url || !HOST_PATH.test(file || '')) return '';
  try { return safeSource(new URL(file, site.url.endsWith('/') ? site.url : `${site.url}/`).href); } catch (_) { return ''; }
}
function build(influencer, site, { preview = false, images = looks(influencer), items = site.items } = {}) {
  return buildSite({ influencer, ...site, images, items: items.map((item) => ({ ...item,
    // The preview prefers the local copy: a protected page would not hand its media to the preview frame.
    src: preview && LOCAL.test(item.file || '') ? `assets/work/${item.file}`
      : item.hostPath ? (preview ? absolute(site, item.hostPath) : item.hostPath) : LOCAL.test(item.file || '') ? `assets/work/${item.file}` : '',
    poster: LOCAL.test(item.poster || '') ? `assets/work/${item.poster}` : preview ? absolute(site, item.poster) : item.poster
  })) });
}
async function previewFile(id, file = 'index.html', { viewer = access.LOCAL_VIEWER, host = defaultHost } = {}) {
  enabled(host);
  const influencer = await influencers.readEditableInfluencer(id, viewer);
  if (typeof file !== 'string' || file.includes('..') || file.includes('\\') || file.includes('\0')) throw missing();
  const site = defaults(influencer);
  const generated = build(influencer, site, { preview: true }).files.find((entry) => entry.path === file);
  if (generated) return { content: generated.content, path: file, siteUrl: site.publishedAt ? site.url : null };
  const look = looks(influencer).find((entry) => entry.path === file);
  if (look) return { content: await influencers.readInfluencerAsset(id, look.file), path: file, siteUrl: site.publishedAt ? site.url : null };
  const local = file.startsWith('assets/work/') ? file.slice('assets/work/'.length) : '';
  if (!LOCAL.test(local) || !site.items.some((item) => item.file === local || item.poster === local)) throw missing();
  try { return { content: await fsp.readFile((await safeLocal(siteDir(id), local)).target), path: file, siteUrl: site.publishedAt ? site.url : null }; } catch (_) { throw missing(); }
}

async function scaleImage(buffer, ext) {
  const command = ffmpeg.resolveBinary('ffmpeg');
  if (!command) {
    if (buffer.length > 5 * 1024 * 1024) throw invalid('Das Bild ist ohne ffmpeg grösser als 5 MB.');
    return { buffer, ext };
  }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'influencer-image-'));
  try {
    const input = path.join(dir, `input${ext}`);
    const output = path.join(dir, 'output.jpg');
    await fsp.writeFile(input, buffer);
    await ffmpeg.runProcess(command, ['-nostdin', '-v', 'error', '-i', input, '-vf', "scale=w='min(2000,iw)':h='min(2000,ih)':force_original_aspect_ratio=decrease", '-frames:v', '1', '-q:v', '3', '-y', output]);
    return { buffer: await fsp.readFile(output), ext: '.jpg' };
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
}
function batches(files) {
  const result = [];
  let batch = [], size = 0;
  for (const file of files) {
    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > MAX_BATCH) throw invalid('Eine Datei ist für die Übertragung zu gross.');
    if (batch.length === 80 || size + bytes > MAX_BATCH) { result.push(batch); batch = []; size = 0; }
    batch.push(file); size += bytes;
  }
  if (batch.length) result.push(batch);
  return result;
}
// The host answers a claim and a listing in different shapes: the address sits on the answer itself or on its "site".
function findHostUrl(value) {
  for (const entry of [value, value?.site]) {
    const candidate = entry?.url || (entry?.full_domain ? `https://${entry.full_domain}` : '');
    const url = /^https:/.test(candidate) ? safeSource(candidate) : '';
    if (url) return url;
  }
  return '';
}
function hostUrl(value) {
  const url = findHostUrl(value);
  if (!url) throw invalid('Der Website-Host hat keine gültige HTTPS-Adresse geliefert.');
  return url;
}
function accessArgs(site) {
  return { slug: site.slug, site_visibility: site.visibility, allowed_emails: site.allowedEmails, allowed_domains: site.allowedDomains };
}
async function retryCall(host, args) {
  try { return await host.call('publish_site', args); } catch (_) { return host.call('publish_site', args); }
}

async function publish(id, influencer, site, remote, { host, scaler, refs }, job) {
  const failed = new Set();
  const report = (itemId, err) => {
    if (itemId && failed.has(itemId)) return;
    if (itemId) failed.add(itemId);
    job.errors.push({ itemId: itemId || null, message: safeMessage(err) });
  };
  const alive = () => influencers.readInfluencer(id);
  try {
    await alive();
    if (!site.publishedAt && !ownsSlug(remote, site.slug)) {
      job.step = 'claim';
      const claimed = await host.call('claim_subdomain', { ...accessArgs(site), editor_emails: influencers.ownerOf(influencer) ? [influencers.ownerOf(influencer)] : [], owner_label: `Creative Director – ${influencer.name}`, starter: 'empty' });
      // The claim is done and cannot be repeated: if its answer carries no address, read it from the listing instead of failing.
      site.url = findHostUrl(claimed) || hostUrl((await connectedSite(host, true))?.sites?.find((entry) => entry.slug === site.slug));
      // The claim already set the access rules; do not send them a second time.
      site.publishedAccess = accessArgs(site);
      connections.delete(host);
    } else if (!site.url) site.url = hostUrl(remote.sites.find((entry) => entry.slug === site.slug));
    job.url = site.url;
    // Keep an acquired address even if a later upload fails, so a retry can find the claimed site.
    await writeSite(id, (current) => { current.url = site.url; }, { internal: true });
    job.step = 'files';
    const media = [];
    const images = [];
    const posterCopies = [];
    for (const look of looks(influencer)) {
      try {
        const scaled = await scaler(await influencers.readInfluencerAsset(id, look.file), path.extname(look.file).toLowerCase());
        const target = look.path.replace(/\.[^.]+$/, scaled.ext);
        media.push({ path: target, content: scaled.buffer.toString('base64'), encoding: 'base64', itemId: null });
        images.push({ path: target });
      } catch (err) { report(null, err); }
    }
    for (const item of site.items) {
      for (const [field, suffix] of [['file', ''], ['poster', '-poster']]) {
        if (!LOCAL.test(item[field] || '') || (field === 'file' && (item.kind !== 'image' || item.hostPath))) continue;
        try {
          const ext = path.extname(item[field]).toLowerCase();
          if (!IMAGE.has(ext)) continue;
          const scaled = await scaler(await fsp.readFile((await safeLocal(siteDir(id), item[field])).target), ext);
          const target = `assets/work/${item.id}${suffix}${scaled.ext}`;
          media.push({ path: target, content: scaled.buffer.toString('base64'), encoding: 'base64', itemId: item.id, field });
        } catch (err) { report(item.id, err); }
      }
    }
    // A single oversized file fails its piece, not the other media or the text batch.
    const usable = media.filter((file) => {
      if (Buffer.byteLength(file.content) <= MAX_BATCH) return true;
      report(file.itemId, invalid('Das Bild ist für die Übertragung zu gross.'));
      return false;
    });
    const missingLooks = new Set(media.filter((file) => !usable.includes(file)).map((file) => file.path));
    for (const batch of batches(usable)) {
      await alive();
      try {
        await retryCall(host, { slug: site.slug, replace: false, files: batch.map(({ itemId, field, ...file }) => file) });
        for (const file of batch) {
          const item = site.items.find((entry) => entry.id === file.itemId);
          if (item && file.field === 'file') item.hostPath = file.path;
          if (item && file.field === 'poster') {
            posterCopies.push(item.poster);
            item.poster = file.path;
          }
        }
      } catch (err) {
        for (const file of batch) { report(file.itemId, err); if (!file.itemId) missingLooks.add(file.path); }
      }
    }
    job.done = site.items.filter((item) => item.kind === 'image').length;
    job.step = 'videos';
    for (const item of site.items) {
      if (item.kind !== 'video' || item.hostPath || !LOCAL.test(item.file || '')) continue;
      await alive();
      let ref;
      try {
        ref = await refs.publishLocalFile((await safeLocal(siteDir(id), item.file)).target, siteDir(id));
        if (!safeSource(ref.url) || !ref.url.startsWith('https:')) throw invalid('Videos brauchen PUBLIC_BASE_URL als öffentliche HTTPS-Adresse.');
        const target = `assets/work/${item.id}${path.extname(item.file).toLowerCase()}`;
        await host.call('import_asset_from_url', { slug: site.slug, source_url: ref.url, path: target });
        const local = item.file;
        item.hostPath = target;
        item.file = null;
        // Persist the remote path before removing the only local copy.
        await writeSite(id, (current) => { const entry = current.items.find((row) => row.id === item.id); if (entry) Object.assign(entry, { hostPath: target, file: null }); }, { internal: true });
        await fsp.rm(path.join(siteDir(id), local), { force: true });
      } catch (err) {
        if (/PUBLIC_BASE_URL/.test(err.message || '')) report(item.id, invalid('Videos brauchen PUBLIC_BASE_URL als öffentliche HTTPS-Adresse für die Übertragung.'));
        else report(item.id, err);
      } finally {
        if (ref) await refs.removeRef(ref.file).catch((err) => report(item.id, err));
        job.done++;
      }
    }
    // Successful media paths survive a failed final text batch and are reused on the next run.
    await writeSite(id, (current) => { current.items = clone(site.items); }, { internal: true });
    for (const file of posterCopies) await fsp.rm(path.join(siteDir(id), file), { force: true });
    job.step = 'files';
    const visible = site.items.filter((item) => !failed.has(item.id) && item.hostPath);
    const generated = build(influencer, site, { images: images.filter((look) => !missingLooks.has(look.path)), items: visible });
    for (const batch of batches(generated.files.map((file) => ({ ...file, encoding: 'utf8' })))) {
      await alive();
      await retryCall(host, { slug: site.slug, replace: false, files: batch });
    }
    job.done = site.items.length;
    job.step = 'access';
    const sentAccess = accessArgs(site);
    if (JSON.stringify(site.publishedAccess) !== JSON.stringify(sentAccess)) {
      await alive();
      await host.call('configure_site_access', sentAccess);
      site.publishedAccess = sentAccess;
    }
    job.step = 'cleanup';
    for (const removed of [...site.removedPaths]) {
      if (!HOST_PATH.test(removed)) continue;
      await alive();
      try {
        await host.call('delete_file', { slug: site.slug, path: removed });
        site.removedPaths = site.removedPaths.filter((entry) => entry !== removed);
      } catch (err) { report(null, err); }
    }
    await writeSite(id, (current) => Object.assign(current, site, { publishedAt: timestamp(), publishedVisibility: site.visibility,
      lastError: job.errors.length ? `${job.errors.length} Stück(e) konnten nicht publiziert werden` : null }), { internal: true });
  } catch (err) {
    if (err.code === 'INFLUENCER_NOT_FOUND') {
      job.errors = [];
    } else {
      report(null, err);
      await writeSite(id, (current) => { current.lastError = `Die Seite konnte nicht publiziert werden. ${safeMessage(err)}`; }, { internal: true }).catch(() => {});
    }
  } finally {
    busy.delete(id);
    job.state = 'done'; job.step = 'done'; job.finishedAt = timestamp();
  }
  return clone(job);
}
async function startPublish(id, { viewer = access.LOCAL_VIEWER, user, host = defaultHost, confirmPublic, scaler = scaleImage, refs = publicrefs } = {}) {
  enabled(host);
  const influencer = await influencers.readEditableInfluencer(id, viewer);
  if (busy.has(id)) throw busyError();
  // Reserve before any host request; concurrent starts cannot pass the preflight together.
  busy.add(id);
  try {
    const site = defaults(influencer);
    if (!host.status().connected) throw error('HOST_NOT_CONNECTED', 'Der Website-Host ist noch nicht verbunden.', 409);
    validateAccess(site);
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(site.slug)) throw invalid('Bitte wähle eine gültige Adresse.');
    if (site.visibility === 'public' && (!site.publishedAt || site.publishedVisibility !== 'public') && confirmPublic !== true) {
      throw error('SITE_CONFIRM_PUBLIC_REQUIRED', 'Bitte bestätige, dass diese Seite öffentlich sichtbar sein darf.', 409);
    }
    const remote = await connectedSite(host, true);
    if (!site.publishedAt && !ownsSlug(remote, site.slug)) {
      if (remote?.creation_permission?.can_create_site !== true) throw error('SITE_CANNOT_CREATE', 'Diese Verbindung darf keine neue Seite erstellen.', 409);
      if (availability(await host.call('check_subdomain', { slug: site.slug })) === false) throw error('SITE_SLUG_TAKEN', 'Diese Adresse ist bereits vergeben.', 409);
    }
    const job = { state: 'running', step: 'claim', done: 0, total: site.items.length, errors: [], url: site.url, startedAt: timestamp(), finishedAt: null };
    jobs.set(id, job);
    const initial = clone(job);
    const finished = publish(id, influencer, site, remote, { host, scaler, refs }, job).catch(() => {
      busy.delete(id); job.state = 'done'; job.step = 'done'; job.finishedAt = timestamp(); return clone(job);
    });
    return { job: initial, finished };
  } catch (err) { busy.delete(id); throw err; }
}
function setNowForTests(fn) { clock = fn || (() => Date.now()); }
module.exports = { readSite, updateSite, checkSlug, addItem, removeItem, previewFile, startPublish, status: readSite,
  setNowForTests, scaleImage, batches, MAX_BATCH, siteDir, writeSite, defaults, safeMessage };
