'use strict';

// The character sheet of an influencer (lib/influencers.js): four reference-image PROPOSALS of the figure, made from its saved
// description with the standard image model of the installation (config.imageModel, the model of the chat tool generate_image):
// portrait frontal, three-quarter, profile and full body in front of a neutral studio background. The existing reference images
// and the shots already made go along as references where the model takes them, so the figure stays the same.
//
//   estimate()   what the four images cost (null = unknown) and whether they can be made (no_model, no_key, budget)
//   start()      checks rights, the confirmed estimate, the lock per influencer and the budget (lib/budget.js begin, as every paid
//                place), removes the earlier proposals and makes the images in the background; status() shows the job
//   paidShot()   THE one place where an image is paid and booked (billedImageCall + recordToolCost, the way of generate_image)
//   proposals    data/influencers/<id>/assets/proposals/sheet-<shot>-<hex>.<ext>; not reference images until accepted
//                (saveInfluencerImage, limit of six); removed by the next start() or after seven days
//
// Jobs and locks live in memory: a restart forgets a running job (images made so far stay proposals).

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const influencers = require('./influencers');
const imageModels = require('./image-models');
const imagesAssets = require('./tools/images-assets');
const { recordToolCost, extFromMediaType } = require('./tools/shared');
const access = require('./access');
const budget = require('./budget');
const openrouter = require('./openrouter');
const gemini = require('./gemini-images');
const store = require('./store');

const COST_SESSION = 'influencer-sheet';
const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SHOTS = Object.freeze([
  Object.freeze({ shot: 'front', description: 'portrait, frontal view', aspect_ratio: '3:4' }),
  Object.freeze({ shot: 'threequarter', description: 'portrait, three-quarter view', aspect_ratio: '3:4' }),
  Object.freeze({ shot: 'profile', description: 'portrait, side profile', aspect_ratio: '3:4' }),
  Object.freeze({ shot: 'fullbody', description: 'full body standing', aspect_ratio: '9:16' })
]);
const FILE_PATTERN = /^sheet-(front|threequarter|profile|fullbody)-[a-f0-9]{8}\.(png|jpg|webp)$/;
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const jobs = new Map();
const busy = new Set();
let imageCall = imagesAssets.createImage;
const error = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const missing = () => error('INFLUENCER_NOT_FOUND', 'Bildvorschlag nicht gefunden.');
const busyError = () => error('INFLUENCER_SHEET_BUSY', 'Fuer diesen Influencer wird bereits ein Charakterbogen erzeugt.');
const proposalDir = (id) => path.join(influencers.influencerDir(id), 'assets', 'proposals');
const round = (n) => Math.round(n * 1e6) / 1e6;
const snapshot = (job) => job ? { ...job } : null;
const maxReferences = (model) => imageModels.referenceLimits(model)?.max || 0;

function shotPrompt(influencer, shot) {
  const entry = typeof shot === 'string' ? SHOTS.find((item) => item.shot === shot) : shot;
  if (!entry || !SHOTS.some((item) => item.shot === entry.shot)) throw new Error('Unbekannte Ansicht.');
  return [
    ...['full', 'looks', 'face', 'style'].filter((key) => influencer[key]?.trim()).map((key) => `${key.toUpperCase()}: ${influencer[key].trim()}`),
    influencer.never?.trim() ? `Never show: ${influencer.never.trim()}` : '',
    `View: ${entry.description}.`,
    'Neutral light-grey seamless studio background, soft even studio light, the same person in every image, photographic character reference image, one person only, no text, no watermark, no collage, no split frames.'
  ].filter(Boolean).join('\n');
}

async function estimate(influencer, { config, viewer } = {}) {
  await imageModels.load();
  const model = String(config?.imageModel || '').trim();
  const max = maxReferences(model);
  const references = Math.min(max, influencer.images.length);
  const price = imageModels.estimateUsd(model);
  const surcharge = imageModels.referenceUsd(model) || 0;
  const usd = price === null ? null : round(SHOTS.reduce((sum, _, i) => sum + price + surcharge * Math.min(max, influencer.images.length + i), 0));
  const info = { count: 4, model, modelLabel: imageModels.displayName(model), usd, references, available: true, reason: null };
  if (!model) return { ...info, available: false, reason: 'no_model' };
  if (!openrouter.hasKey() && !gemini.accepts({ model, prompt: 'x', n: 1 })) return { ...info, available: false, reason: 'no_key' };
  const remaining = access.isRestricted(viewer) ? await budget.status(viewer) : null;
  if (remaining && (remaining.remainingUsd <= budget.REMAINING_EPSILON || (usd !== null && usd > remaining.remainingUsd + budget.REMAINING_EPSILON))) {
    return { ...info, available: false, reason: 'budget' };
  }
  return info;
}

async function listProposals(id, { now = Date.now() } = {}) {
  const dir = proposalDir(id);
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const proposals = [];
  for (const entry of entries) {
    const match = FILE_PATTERN.exec(entry.name);
    if (!match || !entry.isFile()) continue;
    try {
      const file = path.join(dir, entry.name);
      const stat = await fsp.stat(file);
      if (Number(now) - stat.mtimeMs > PROPOSAL_TTL_MS) await fsp.unlink(file);
      else proposals.push({ file: entry.name, shot: match[1], createdAt: stat.mtime.toISOString() });
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  return proposals.sort((a, b) => SHOTS.findIndex((s) => s.shot === a.shot) - SHOTS.findIndex((s) => s.shot === b.shot) || a.file.localeCompare(b.file));
}

async function readProposal(id, file) {
  if (typeof file !== 'string' || !FILE_PATTERN.test(file)) throw missing();
  if (!(await listProposals(id)).some((entry) => entry.file === file)) throw missing();
  try { return await fsp.readFile(path.join(proposalDir(id), file)); } catch (err) {
    if (err.code === 'ENOENT') throw missing();
    throw err;
  }
}

async function acceptProposal(id, file) {
  if (busy.has(id)) throw busyError();
  busy.add(id);
  try {
    const buffer = await readProposal(id, file);
    const influencer = await influencers.saveInfluencerImage(id, { filename: file, buffer });
    await fsp.unlink(path.join(proposalDir(id), file));
    return { influencer, proposals: await listProposals(id) };
  } finally { busy.delete(id); }
}

async function discardProposal(id, file) {
  if (busy.has(id)) throw busyError();
  busy.add(id);
  try {
    await readProposal(id, file);
    await fsp.unlink(path.join(proposalDir(id), file));
    return { proposals: await listProposals(id) };
  } finally { busy.delete(id); }
}

// This is the single place where a sheet image is paid and booked; an installation with its own billing hooks it in here.
async function paidShot(payload, { user, grant, job }) {
  let result;
  try {
    result = await imagesAssets.billedImageCall({ sessionId: COST_SESSION, user, budgetKey: grant.key }, payload, imageCall);
  } catch (err) {
    // billedImageCall already books a refused response's reported usage exactly once.
    if (Number.isFinite(err?.usage?.cost) && err.usage.cost >= 0) job.costUsd = round(job.costUsd + err.usage.cost);
    throw err;
  }
  if (typeof result?.usage?.cost === 'number') {
    await recordToolCost({ ts: new Date().toISOString(), sessionId: COST_SESSION, type: 'image', model: payload.model, cost: result.usage.cost, user }, { budgetKey: grant.key });
    job.costUsd = round(job.costUsd + result.usage.cost);
  }
  return result;
}

async function referencesFor(influencer, made, max) {
  const selected = [
    ...influencer.images.map((file) => ({ file, read: () => influencers.readInfluencerAsset(influencer.id, file) })),
    ...made.map((file) => ({ file, read: () => readProposal(influencer.id, file) }))
  ].slice(0, max);
  const refs = [];
  for (const item of selected) {
    const buffer = await item.read();
    refs.push({ type: 'image_url', image_url: { url: `data:${MIME[path.extname(item.file).toLowerCase()]};base64,${buffer.toString('base64')}` } });
  }
  return refs;
}

async function generate(influencer, info, grant, user, job) {
  const id = influencer.id;
  const made = [];
  try {
    for (const shot of SHOTS) {
      try {
        await influencers.readInfluencer(id);
        const refs = await referencesFor(influencer, made, maxReferences(info.model));
        const payload = { model: info.model, prompt: shotPrompt(influencer, shot), n: 1, aspect_ratio: shot.aspect_ratio };
        if (refs.length) payload.input_references = refs;
        const result = await paidShot(payload, { user, grant, job });
        const item = result?.data?.[0];
        if (!item?.b64_json) throw new Error('Antwort der Bild-API enthielt keine Bilddaten.');
        const ext = extFromMediaType(item.media_type);
        if (!MIME[ext]) throw new Error('Das Bildmodell hat kein PNG-, JPEG- oder WebP-Bild geliefert.');
        const file = `sheet-${shot.shot}-${crypto.randomBytes(4).toString('hex')}${ext}`;
        // Share the deletion lock: a removed influencer must never be recreated by a late image.
        await store.withLock(`influencer-${id}`, async () => {
          await influencers.readInfluencer(id);
          const dir = proposalDir(id);
          await fsp.mkdir(dir, { recursive: true });
          const target = path.join(dir, file);
          const tmp = `${target}.${process.pid}.tmp`;
          try {
            await fsp.writeFile(tmp, Buffer.from(item.b64_json, 'base64'));
            await fsp.rename(tmp, target);
          } finally { await fsp.rm(tmp, { force: true }); }
        });
        made.push(file);
        job.done = made.length;
      } catch (err) {
        // Deletion cancels remaining shots without showing an error on a deleted figure.
        try { await influencers.readInfluencer(id); } catch (gone) {
          if (gone.code === 'INFLUENCER_NOT_FOUND') break;
        }
        job.error = `Das Bildmodell hat das ${made.length + 1}. Bild nicht geliefert: ${String(err.message).replace(/ß/g, 'ss')}`;
        break;
      }
    }
  } finally {
    try { grant.release(); } finally {
      busy.delete(id);
      job.state = 'done';
      job.finishedAt = new Date().toISOString();
    }
  }
  return snapshot(job);
}

async function start(id, { viewer, user = 'lokal', config, confirmed, confirmedUsd } = {}) {
  const influencer = await influencers.readEditableInfluencer(id, viewer);
  if (confirmed !== true) throw error('INFLUENCER_SHEET_CONFIRM_REQUIRED', 'Bitte bestaetige zuerst die Kosten fuer den Charakterbogen.');
  const info = await estimate(influencer, { config, viewer });
  if (info.reason === 'no_model' || info.reason === 'no_key') throw error('INFLUENCER_SHEET_UNAVAILABLE', 'Der Charakterbogen ist ohne Bildmodell und passenden API-Key nicht verfuegbar.', { reason: info.reason });
  if (!(confirmedUsd === null && info.usd === null) && !(typeof confirmedUsd === 'number' && typeof info.usd === 'number' && Math.abs(confirmedUsd - info.usd) < 0.005)) {
    throw error('INFLUENCER_SHEET_ESTIMATE_CHANGED', 'Die Kostenschaetzung hat sich geaendert. Bitte bestaetige sie erneut.', { estimate: info });
  }
  if (busy.has(id)) throw busyError();
  busy.add(id);
  let grant;
  try {
    grant = await budget.begin(viewer, { estimateUsd: info.usd, label: 'Character sheet' });
    await fsp.rm(proposalDir(id), { recursive: true, force: true });
    const job = { state: 'running', total: 4, done: 0, costUsd: 0, error: null, startedAt: new Date().toISOString(), finishedAt: null };
    jobs.set(id, job);
    const initial = snapshot(job);
    // All failures resolve as a final job, including unexpected storage/release failures.
    const finished = generate(influencer, info, grant, String(user || 'lokal'), job).catch((err) => {
      job.error = String(err.message).replace(/ß/g, 'ss');
      return snapshot(job);
    });
    return { job: initial, estimate: info, finished };
  } catch (err) {
    try { grant?.release(); } finally { busy.delete(id); }
    throw err;
  }
}

async function status(id, { viewer, config } = {}) {
  const influencer = await influencers.readEditableInfluencer(id, viewer);
  return { estimate: await estimate(influencer, { viewer, config }), proposals: await listProposals(id), job: snapshot(jobs.get(id)), imageCount: influencer.images.length, maxImages: influencers.MAX_IMAGES };
}

function setImageCallForTests(fn) { imageCall = fn === null ? imagesAssets.createImage : fn; }

module.exports = { SHOTS, COST_SESSION, PROPOSAL_TTL_MS, shotPrompt, estimate, start, status, listProposals, readProposal, acceptProposal, discardProposal, setImageCallForTests };
