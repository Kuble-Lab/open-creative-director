'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const store = require('./store');
const or = require('./openrouter');
const rendernode = require('./rendernode');
const costs = require('./costs');
const budget = require('./budget');
const publicrefs = require('./publicrefs');
const higgsfield = require('./higgsfield');
const fal = require('./fal');
const ffmpeg = require('./ffmpeg');

const POLL_INTERVAL_MS = 6000;
const OPEN_STATES = new Set(['pending', 'running', 'in_progress', 'queued', 'processing']);
// Obergrenze pro Quelle. Ohne sie bleibt ein Auftrag, den der Anbieter nie
// abschliesst, fuer immer offen: der Poller fragt ihn alle 6 Sekunden ab und der
// Nutzer sieht dauerhaft einen laufenden Job. Higgsfield brachte sein Limit schon
// als timeoutAt mit, Render-Node- und OpenRouter-Jobs hatten gar keines.
const JOB_TIMEOUT_MS = {
  higgsfield: 10 * 60 * 1000,
  rendernode: 2 * 60 * 60 * 1000,
  openrouter: 60 * 60 * 1000,
  fal: 90 * 60 * 1000
};
const execFileAsync = promisify(execFile);

let running = false;
const inFlight = new Set();
// Notbremse: pro Prozess wird ein Job genau einmal terminal gemeldet, auch wenn
// er in der Session-Datei wider Erwarten offen bleibt.
const terminalHandled = new Set();
// sessionId -> { mtimeMs, size, hasOpenJobs }: Sessions ohne offene Jobs muessen
// nicht bei jedem Durchlauf neu geparst werden, solange die Datei unveraendert ist.
const sessionScanCache = new Map();

function isOpen(job) {
  return OPEN_STATES.has(String(job.status || 'pending'));
}

// assetId ist pro Session eindeutig, jobId NICHT: Higgsfield kann dieselbe Job-ID
// fuer zwei Auftraege liefern. Ueber jobId zu suchen trifft dann den falschen Job,
// der eigentliche bleibt offen und der Poller wiederholt sich endlos.
function findJob(session, job) {
  const jobs = Array.isArray(session?.jobs) ? session.jobs : [];
  if (job.assetId) {
    const byAsset = jobs.find((entry) => entry.assetId === job.assetId);
    if (byAsset) return byAsset;
  }
  return jobs.find((entry) => entry.jobId === job.jobId);
}

function jobSource(job) {
  if (job.source === 'higgsfield' || job.provider === 'higgsfield') return 'higgsfield';
  if (job.source === 'rendernode') return 'rendernode';
  if (job.source === 'fal' || job.provider === 'fal') return 'fal';
  return 'openrouter';
}

// Faellig, wenn das mitgelieferte timeoutAt erreicht ist oder - auch bei Alt-Jobs
// ohne timeoutAt - die Frist der Quelle seit dem Start abgelaufen ist.
function isTimedOut(job, source) {
  const explicit = Number(job.timeoutAt);
  if (explicit > 0) return Date.now() >= explicit;
  const started = Date.parse(job.createdAt || job.submittedAt || job.startedAt || '');
  if (!Number.isFinite(started)) return false;
  return Date.now() >= started + JOB_TIMEOUT_MS[source];
}

function timeoutMessage(source) {
  const minutes = Math.round(JOB_TIMEOUT_MS[source] / 60000);
  const stunden = Math.round(minutes / 60);
  const frist = minutes < 60 || minutes % 60 !== 0 ? `${minutes} Minuten` : stunden === 1 ? 'einer Stunde' : `${stunden} Stunden`;
  const anbieter = { higgsfield: 'Higgsfield-Job', rendernode: 'Render-Job', openrouter: 'Video-Job', fal: 'fal.ai-Job' }[source];
  return `${anbieter} hat nach ${frist} das Zeitlimit erreicht.`;
}

function elapsedSeconds(job, completedAt) {
  const start = Date.parse(job.createdAt || job.submittedAt || job.startedAt || '');
  const end = Date.parse(completedAt || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.max(0, Math.round((end - start) / 1000));
}

function formatElapsed(seconds) {
  if (!Number.isFinite(seconds)) return null;
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

function appendJobUpdateMessage(session, job, status, { completedAt, cost = null, error = '' } = {}) {
  const details = [];
  const elapsed = formatElapsed(elapsedSeconds(job, completedAt));
  if (elapsed) details.push(elapsed);
  if (typeof cost === 'number' && !(job.source === 'higgsfield' || job.provider === 'higgsfield')) {
    // fal.ai costs are list-price estimates (the API reports no price): mark them as such.
    details.push(`${job.source === 'fal' ? '~' : ''}$${cost.toFixed(2)}`);
  }
  const suffix = details.length ? ` (${details.join(', ')})` : '';
  const completedVerb = job.kind === 'image' || job.kind === 'audio' ? 'generiert' : 'gerendert';
  const content = status === 'completed'
    ? `${job.assetId} ist fertig ${completedVerb}${suffix} ✅`
    : `${job.assetId} ist fehlgeschlagen: ${String(error || 'unbekannter Fehler')} ❌`;
  session.messages.push({
    role: 'assistant',
    type: 'job_update',
    hidden: false,
    content,
    ts: completedAt
  });
}

async function extractVideoFrames(videoPath) {
  const paths = ffmpeg.binaries();
  if (!paths.available) throw new Error('ffmpeg/ffprobe wurde nicht gefunden');
  const metadata = await ffmpeg.probeVideo(videoPath, { ffprobePath: paths.ffprobe });
  const duration = metadata.duration;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Videodauer konnte nicht ermittelt werden');

  const frames = [];
  for (const fraction of [0.1, 0.5, 0.95]) {
    const timestamp = Math.max(0, duration * fraction).toFixed(3);
    const result = await execFileAsync(
      paths.ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-i',
        videoPath,
        '-ss',
        timestamp,
        '-frames:v',
        '1',
        '-vf',
        'scale=640:-2',
        '-c:v',
        'mjpeg',
        '-q:v',
        '5',
        '-f',
        'image2pipe',
        'pipe:1'
      ],
      { encoding: 'buffer', maxBuffer: 12 * 1024 * 1024, timeout: 30000 }
    );
    const frame = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
    if (!frame.length) throw new Error(`Kein Frame bei ${timestamp} Sekunden extrahiert`);
    frames.push(frame);
  }
  return frames;
}

async function cleanupJobRefs(job) {
  await Promise.all((Array.isArray(job.publicRefFiles) ? job.publicRefFiles : []).map(async (file) => {
    try {
      await publicrefs.removeRef(file);
    } catch (err) {
      console.warn(`[poller] Referenz ${file} konnte nicht entfernt werden: ${err.message}`);
    }
  }));
}

async function handleCompleted(sessionId, job, info) {
  try {
    const isRenderNode = job.source === 'rendernode';
    const buffer = isRenderNode
      ? await rendernode.download(job.jobId, job.renderNodeId)
      : await or.downloadVideo(job.jobId, 0);
    const cost = isRenderNode ? null : typeof info?.usage?.cost === 'number' ? info.usage.cost : null;
    const completedAt = new Date().toISOString();
    const completedAsset = await store.completeAsset(sessionId, job.assetId, buffer, cost);
    let frameRefs = [];
    try {
      const frames = await extractVideoFrames(path.join(store.sessionAssetDir(sessionId), completedAsset.file));
      frameRefs = await Promise.all(frames.map((frame) => store.saveInlineImage(sessionId, frame, '.jpg')));
    } catch (err) {
      console.warn(`[poller] Frames fuer ${sessionId}/${job.assetId} konnten nicht extrahiert werden: ${err.message}`);
    }
    await store.mutateSession(sessionId, (session) => {
      const target = findJob(session, job);
      if (target) {
        target.status = 'completed';
        target.cost = cost;
        target.completedAt = completedAt;
        if (!isRenderNode && Array.isArray(info?.unsigned_urls)) target.unsignedUrls = info.unsigned_urls;
        delete target.publicRefFiles;
      }
      appendJobUpdateMessage(session, job, 'completed', { completedAt, cost });
      session.messages.push({
        role: 'user',
        hidden: true,
        content: `[System] Video-Job ${job.assetId} ist fertig und wurde gespeichert.`,
        ts: completedAt
      });
      if (frameRefs.length === 3) {
        session.messages.push({
          role: 'user',
          hidden: true,
          content: [
            {
              type: 'text',
              text: `[System] Automatische Frames aus ${job.assetId} (Anfang/Mitte/Ende) zur Konsistenz-Pruefung:`
            },
            // Verweis statt base64 - die Frames liegen als Dateien im Asset-Ordner.
            ...frameRefs.map((ref) => ({ type: 'image_ref', file: ref.file, mime: 'image/jpeg' }))
          ],
          ts: completedAt
        });
      }
    });
    if (!isRenderNode && cost !== null) {
      try {
        await costs.recordCost({
          ts: completedAt,
          sessionId,
          assetId: job.assetId,
          type: 'video',
          model: job.model || info?.model || 'unbekannt',
          cost,
          user: job.user || 'unbekannt'
        });
      } catch (err) {
        console.warn(`[costs] Video-Kosten fuer ${sessionId}/${job.assetId} konnten nicht erfasst werden: ${err.message}`);
      }
    }
    // Participants (lib/budget.js): what the job had reserved is now booked (or unknown and counted as 0).
    budget.settleJob(job, cost ?? 0);
    console.log(`[poller] ${sessionId}/${job.assetId} fertig.`);
  } finally {
    await cleanupJobRefs(job);
  }
}

// Nur Endungen, die die App auch als Bild/Video/Audio akzeptiert (Audio: mp3, wav, m4a, aac). Ohne verwertbaren
// MIME-Typ und ohne Endung in der URL gilt fuer Audio .wav (das Standardformat von seed_audio).
function higgsfieldResultExtension(kind, contentType, url) {
  const mime = String(contentType || '').toLowerCase().split(';')[0].trim();
  const byMime = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/wave': '.wav',
    'audio/vnd.wave': '.wav',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/m4a': '.m4a',
    'audio/aac': '.aac',
    'audio/x-aac': '.aac'
  };
  if (byMime[mime]) return byMime[mime];
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mp3', '.wav', '.m4a', '.aac'].includes(ext)) return ext;
  } catch (_) {
    /* Fallback nach Asset-Art. */
  }
  return kind === 'image' ? '.png' : kind === 'audio' ? '.wav' : '.mp4';
}

async function handleHiggsfieldCompleted(sessionId, job, info) {
  const urls = Array.isArray(info?.urls) ? info.urls : [];
  if (!urls.length) throw new Error('Higgsfield meldet completed, aber lieferte keine Ergebnis-URL.');
  const downloads = [];
  for (const url of urls) downloads.push(await higgsfield.downloadResult(url));

  const first = downloads[0];
  const completedAsset = await store.completeAsset(
    sessionId,
    job.assetId,
    first.buffer,
    0,
    higgsfieldResultExtension(job.kind, first.contentType, first.url)
  );
  const assets = [completedAsset];
  for (const result of downloads.slice(1)) {
    assets.push(await store.saveAsset(sessionId, {
      kind: job.kind === 'image' || job.kind === 'audio' ? job.kind : 'video',
      buffer: result.buffer,
      ext: higgsfieldResultExtension(job.kind, result.contentType, result.url),
      prompt: job.prompt,
      cost: 0
    }));
  }

  const completedAt = new Date().toISOString();
  await store.mutateSession(sessionId, (session) => {
    const target = findJob(session, job);
    if (target) {
      target.status = 'completed';
      target.file = completedAsset.file;
      target.cost = 0;
      target.completedAt = completedAt;
      target.resultAssetIds = assets.map((asset) => asset.id);
      target.resultUrls = urls;
    }
    appendJobUpdateMessage(session, job, 'completed', { completedAt, cost: 0 });
    session.messages.push({
      role: 'user',
      hidden: true,
      content:
        `[System] Higgsfield-${job.kind === 'image' ? 'Bild' : job.kind === 'audio' ? 'Audio' : 'Video'}-Job ${job.assetId} ist fertig. ` +
        `Gespeicherte Session-Assets: ${assets.map((asset) => asset.id).join(', ')}. Abrechnung in Higgsfield-Credits.`,
      ts: completedAt
    });
  });
  console.log(`[poller] Higgsfield ${sessionId}/${job.assetId} fertig (${assets.length} Ergebnis(se)).`);
}

async function handleFailed(sessionId, job, info) {
  try {
    const message = String(info?.error?.message || info?.error || 'unbekannter Fehler').slice(0, 500);
    const completedAt = new Date().toISOString();
    let reported = true;
    await store.mutateSession(sessionId, (session) => {
      const target = findJob(session, job);
      // Nur melden, solange der Job offen ist - sonst wuerde jede Wiederholung
      // erneut zwei Nachrichten in die Session schreiben.
      if (target && !isOpen(target)) {
        reported = false;
        return;
      }
      if (target) {
        target.status = 'failed';
        target.error = message;
        target.completedAt = completedAt;
        delete target.publicRefFiles;
      }
      appendJobUpdateMessage(session, job, 'failed', { completedAt, error: message });
      session.messages.push({
        role: 'user',
        hidden: true,
        content: `[System] Video-Job ${job.assetId} ist fehlgeschlagen: ${message}`,
        ts: completedAt
      });
    });
    if (reported) console.warn(`[poller] ${sessionId}/${job.assetId} fehlgeschlagen: ${message}`);
  } finally {
    budget.releaseJob(job);
    await cleanupJobRefs(job);
  }
}

async function handleHiggsfieldFailed(sessionId, job, info) {
  const status = String(info?.status || 'failed').toLowerCase();
  const messages = {
    ip_detected: 'Higgsfield hat den Auftrag wegen einer erkannten IP-/Markenreferenz abgelehnt.',
    nsfw: 'Higgsfield hat den Auftrag durch den Inhaltsfilter abgelehnt.',
    failed: 'Higgsfield konnte den Auftrag nicht abschliessen.',
    timeout: timeoutMessage('higgsfield')
  };
  const detail = String(info?.text || '').trim();
  return handleFailed(sessionId, job, {
    error: detail ? `${messages[status] || messages.failed} ${detail}`.slice(0, 500) : messages[status] || messages.failed
  });
}

// ---------- fal.ai ----------

const FAL_KIND_LABEL = { video: 'Video', image: 'Bild', audio: 'Audio', auto: 'Medien' };
const FAL_MAX_EXPANDED_PROMPT = 2000;
const FAL_MAX_RESULT_JSON = 50 * 1024;

// USD of a finished fal job: billed seconds x list price (x multiplier above a length), else the estimate of the
// submit. Always an estimate; fal reports no price. Null when nothing is known.
function falJobCost(job, result) {
  const pricing = job.pricing && typeof job.pricing === 'object' ? job.pricing : null;
  const field = pricing ? (pricing.durationField === undefined ? 'duration' : pricing.durationField) : null;
  const seconds = field && result ? Number(result[field]) : NaN;
  if (pricing && Number.isFinite(pricing.perSecond) && Number.isFinite(seconds) && seconds > 0) {
    let usd = seconds * pricing.perSecond;
    if (Number.isFinite(pricing.overSeconds) && Number.isFinite(pricing.overMultiplier) && seconds > pricing.overSeconds) usd *= pricing.overMultiplier;
    return Math.round(usd * 1e6) / 1e6;
  }
  const estimate = Number(job.costEstimateUsd);
  return job.costEstimateUsd !== null && job.costEstimateUsd !== undefined && Number.isFinite(estimate) && estimate >= 0 ? estimate : null;
}

// The result JSON for nodes that show it (the free fal node), capped at 50 KB.
function resultJsonText(result) {
  try {
    return JSON.stringify(result, null, 2).slice(0, FAL_MAX_RESULT_JSON);
  } catch (_) {
    return '';
  }
}

async function handleFalCompleted(sessionId, job, result, media) {
  const dir = store.sessionAssetDir(sessionId);
  await fsp.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.fal-${String(job.assetId).replace(/[^A-Za-z0-9_-]/g, '_')}.part`);
  let downloaded;
  try {
    downloaded = await fal.downloadToFile(media.url, temp);
    const ext = higgsfieldResultExtension(media.kind, media.contentType || downloaded.contentType, media.url);
    const cost = falJobCost(job, result);
    const seconds = Number(result?.duration);
    const completedAsset = await store.completeAssetFile(sessionId, job.assetId, temp, {
      cost: cost === null ? undefined : cost,
      duration: Number.isFinite(seconds) && seconds > 0 && seconds < 86400 && media.kind !== 'image' ? seconds : undefined,
      ext,
      kind: media.kind
    });
    const completedAt = new Date().toISOString();
    const expanded = typeof result?.expanded_prompt === 'string' ? result.expanded_prompt.slice(0, FAL_MAX_EXPANDED_PROMPT) : null;
    await store.mutateSession(sessionId, (session) => {
      const target = findJob(session, job);
      if (target) {
        target.status = 'completed';
        target.file = completedAsset.file;
        target.cost = cost;
        target.costEstimated = true;
        target.completedAt = completedAt;
        target.resultAssetIds = [completedAsset.id];
        if (Number.isFinite(Number(result?.seed))) target.seed = Number(result.seed);
        if (expanded) target.expanded_prompt = expanded;
        if (job.keepResult) target.resultJson = resultJsonText(result);
        if (Number.isFinite(seconds) && seconds > 0) target.duration = seconds;
        delete target.statusUrl;
        delete target.responseUrl;
      }
      appendJobUpdateMessage(session, job, 'completed', { completedAt, cost });
      session.messages.push({
        role: 'user',
        hidden: true,
        content: `[System] fal-${FAL_KIND_LABEL[media.kind] || 'Medien'}-Job ${job.assetId} ist fertig und wurde gespeichert. Kosten: Schaetzung nach Listenpreis.`,
        ts: completedAt
      });
    });
    if (cost !== null) {
      try {
        await costs.recordCost({
          ts: completedAt,
          sessionId,
          assetId: job.assetId,
          type: 'fal',
          model: job.endpoint || job.model || 'unbekannt',
          cost,
          billing: 'Schaetzung (Listenpreis)',
          user: job.user || 'unbekannt'
        });
      } catch (err) {
        console.warn(`[costs] fal-Kosten fuer ${sessionId}/${job.assetId} konnten nicht erfasst werden: ${err.message}`);
      }
    }
    budget.settleJob(job, cost ?? 0);
    console.log(`[poller] fal ${sessionId}/${job.assetId} fertig.`);
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => {});
  }
}

function falFailureMessage(err) {
  if (err?.status === 404) return 'Der fal.ai-Job wurde nicht gefunden (abgelaufen oder gehoert zu einem anderen Konto).';
  return String(err?.message || err || 'unbekannter Fehler');
}

// One polling round for one fal job. Temporary problems (network, timeouts, 5xx, 429) leave the job open so the next
// round asks again; a rejected key or an unknown job fails it. Returns nothing.
async function pollFalJob(sessionId, job, key) {
  let status;
  try {
    status = await fal.getStatus(job);
  } catch (err) {
    if (err instanceof fal.FalError && !err.retryable) {
      terminalHandled.add(key);
      await handleFailed(sessionId, job, { error: falFailureMessage(err) });
    } else {
      console.warn(`[poller] fal-Status fuer ${job.jobId} nicht abrufbar: ${err.message}`);
    }
    return;
  }

  if (status.status !== 'COMPLETED') {
    const mapped = status.status === 'IN_PROGRESS' ? 'in_progress' : 'queued';
    if (mapped !== job.status) {
      await store.mutateSession(sessionId, (s) => {
        const target = findJob(s, job);
        if (target) {
          target.status = mapped;
          if (mapped === 'in_progress' && !target.startedAt) target.startedAt = new Date().toISOString();
        }
      });
    }
    return;
  }

  if (status.error) {
    terminalHandled.add(key);
    await handleFailed(sessionId, job, { error: `fal.ai meldet einen Fehler: ${status.error}` });
    return;
  }

  let result;
  try {
    result = await fal.getResult(job);
  } catch (err) {
    if (err instanceof fal.FalError && !err.retryable) {
      terminalHandled.add(key);
      await handleFailed(sessionId, job, { error: falFailureMessage(err) });
    } else {
      console.warn(`[poller] fal-Ergebnis fuer ${job.jobId} nicht abrufbar: ${err.message}`);
    }
    return;
  }
  const media = fal.extractMedia(result, job.resultKind || job.kind || 'auto');
  if (!media) {
    terminalHandled.add(key);
    await handleFailed(sessionId, job, { error: 'fal.ai meldet fertig, lieferte aber kein Medium im Ergebnis.' });
    return;
  }
  try {
    await handleFalCompleted(sessionId, job, result, media);
    terminalHandled.add(key);
  } catch (err) {
    if (err instanceof fal.FalError && !err.retryable) {
      terminalHandled.add(key);
      await handleFailed(sessionId, job, { error: falFailureMessage(err) });
    } else {
      // temporary (or local) problem: the file is fetched again in the next round
      console.warn(`[poller] fal-Ergebnis fuer ${job.jobId} konnte nicht gespeichert werden: ${err.message}`);
    }
  }
}

async function pollOnce() {
  if (running || (!or.hasKey() && rendernode.listConfiguredNodes().length === 0 && !higgsfield.status().connected && !fal.hasKey())) return;
  running = true;
  try {
    const { sessions } = await store.listSessions({ limit: Infinity, includeHidden: true });
    const knownIds = new Set(sessions.map((meta) => meta.id));
    for (const id of sessionScanCache.keys()) {
      if (!knownIds.has(id)) sessionScanCache.delete(id);
    }
    for (const meta of sessions) {
      const stat = await store.sessionStat(meta.id);
      const cached = sessionScanCache.get(meta.id);
      if (stat && cached && !cached.hasOpenJobs && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        continue;
      }
      let session;
      try {
        session = await store.readSession(meta.id);
      } catch (_) {
        continue;
      }
      const openJobs = session.jobs.filter(isOpen);
      if (stat) {
        sessionScanCache.set(meta.id, { mtimeMs: stat.mtimeMs, size: stat.size, hasOpenJobs: openJobs.length > 0 });
      }
      if (!openJobs.length) continue;
      for (const job of openJobs) {
        budget.ensureJob(job); // reservations of participants survive a restart of the app
        const isRenderNode = job.source === 'rendernode';
        const isHiggsfield = job.source === 'higgsfield' || job.provider === 'higgsfield';
        const isFal = job.source === 'fal' || job.provider === 'fal';
        if (isFal && !fal.hasKey()) continue;
        if (isHiggsfield && !higgsfield.status().connected) continue;
        if (!isHiggsfield && !isFal && (isRenderNode ? rendernode.listConfiguredNodes().length === 0 : !or.hasKey())) continue;
        // Schluessel ueber assetId: jobId ist nicht garantiert eindeutig.
        const key = `${meta.id}:${job.assetId || job.jobId}`;
        if (inFlight.has(key) || terminalHandled.has(key)) continue;
        inFlight.add(key);
        try {
          const source = jobSource(job);
          if (isTimedOut(job, source)) {
            terminalHandled.add(key);
            if (isHiggsfield) await handleHiggsfieldFailed(meta.id, job, { status: 'timeout' });
            else await handleFailed(meta.id, job, { error: timeoutMessage(source) });
            continue;
          }
          if (isFal) {
            await pollFalJob(meta.id, job, key);
            continue;
          }
          const info = isHiggsfield
            ? higgsfield.parseJobStatus(await higgsfield.mcpCall('job_status', { jobId: job.jobId }))
            : isRenderNode
              ? await rendernode.jobStatus(job.jobId, job.renderNodeId)
              : await or.getVideoJob(job.jobId);
          const status = String(info?.status || 'pending');
          if (status === 'completed') {
            terminalHandled.add(key);
            if (isHiggsfield) await handleHiggsfieldCompleted(meta.id, job, info);
            else await handleCompleted(meta.id, job, info);
          } else if (status === 'failed' || status === 'cancelled' || status === 'ip_detected' || status === 'nsfw') {
            terminalHandled.add(key);
            if (isHiggsfield) await handleHiggsfieldFailed(meta.id, job, info);
            else await handleFailed(meta.id, job, info);
          } else if (status !== job.status) {
            await store.mutateSession(meta.id, (s) => {
              const target = findJob(s, job);
              if (target) {
                target.status = status;
                if (!target.startedAt && ['running', 'in_progress', 'processing'].includes(status.toLowerCase())) {
                  target.startedAt = new Date().toISOString();
                }
              }
            });
          }
        } catch (err) {
          console.warn(`[poller] Fehler bei Job ${job.jobId}: ${err.message}`);
        } finally {
          inFlight.delete(key);
        }
      }
    }
  } catch (err) {
    console.warn('[poller] Durchlauf fehlgeschlagen:', err.message);
  } finally {
    running = false;
  }
}

function start() {
  const timer = setInterval(() => {
    pollOnce().catch((err) => console.warn('[poller]', err.message));
  }, POLL_INTERVAL_MS);
  timer.unref?.();
  setTimeout(() => pollOnce().catch(() => {}), 3000).unref?.();
  return timer;
}

module.exports = {
  start,
  pollOnce,
  extractVideoFrames,
  handleCompleted,
  handleFailed,
  handleHiggsfieldCompleted,
  handleFalCompleted,
  falJobCost,
  higgsfieldResultExtension,
  appendJobUpdateMessage,
  POLL_INTERVAL_MS
};
