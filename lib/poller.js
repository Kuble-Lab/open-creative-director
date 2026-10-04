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
const glbPreview = require('./glb-preview');
const videoRefusal = require('./video-refusal');

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
  const completedVerb = job.kind === 'image' || job.kind === 'audio' || job.kind === 'model3d' ? 'generiert' : 'gerendert';
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
          user: job.user || 'unbekannt',
          ...costs.viaFields(job)
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
      cost: 0,
      model: job.model
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
    // The provider refused the image only after the start (real person): a stable code and a readable sentence instead of
    // the raw answer. Whether the job was charged is not known, so the sentence says nothing about it.
    const refusal = videoRefusal.jobRefusalOf(info?.error, { model: job.model });
    const message = refusal ? refusal.message : String(info?.error?.message || info?.error || 'unbekannter Fehler').slice(0, 500);
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
        // a stable code lets the interface say the cause in its own language (a refusal of the provider, or a code of our own
        // such as MESH_FILE_NOT_GLB for a 3D result)
        if (refusal) target.errorCode = refusal.code;
        else if (typeof info?.code === 'string' && /^[A-Z]+(_[A-Z]+)+$/.test(info.code)) target.errorCode = info.code;
        target.completedAt = completedAt;
        delete target.publicRefFiles;
      }
      appendJobUpdateMessage(session, job, 'failed', { completedAt, error: message });
      session.messages.push({
        role: 'user',
        hidden: true,
        content: `[System] Video-Job ${job.assetId} ist fehlgeschlagen: ${refusal ? refusal.directorText : message}`,
        ts: completedAt
      });
    });
    if (reported) console.warn(`[poller] ${sessionId}/${job.assetId} fehlgeschlagen: ${message}`);
    // fal finished the job and bills it, but nothing usable came out (a 3D result without a GLB): the price goes into the journal
    // under the operator, not under the person, so the monitoring shows what was paid and a participant's budget is not charged
    if (reported && Number.isFinite(info?.operatorCost) && info.operatorCost >= 0) {
      try {
        await costs.recordCost({
          ts: completedAt,
          sessionId,
          assetId: job.assetId,
          type: 'fal',
          model: job.endpoint || job.model || 'unbekannt',
          cost: info.operatorCost,
          billing: UNUSABLE_RESULT_BILLING,
          user: OPERATOR_COST_USER
        });
      } catch (err) {
        console.warn(`[costs] fal-Kosten fuer ${sessionId}/${job.assetId} konnten nicht erfasst werden: ${err.message}`);
      }
    }
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

const FAL_KIND_LABEL = { video: 'Video', image: 'Bild', audio: 'Audio', model3d: '3D-Modell', auto: 'Medien' };
const FAL_MAX_EXPANDED_PROMPT = 2000;
const FAL_MAX_RESULT_JSON = 50 * 1024;
// A textured GLB of 1.5 million faces is some 100 MB; more than this is not a model the page could show anyway. The
// preview image of a 3D result is a render or a thumbnail of the provider.
const FAL_MODEL3D_MAX_BYTES = 256 * 1024 * 1024;
const FAL_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
const GLB_HEADER_BYTES = 12;
// A 3D job that fal finished (and bills) without a usable GLB is booked under this name, never under the person: the operator
// pays for it, the budget of a participant stays as it was. The monitoring shows it with this text.
const OPERATOR_COST_USER = 'betreiber';
const UNUSABLE_RESULT_BILLING = 'Kein Ergebnis (Listenpreis)';

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

async function readHead(file, bytes) {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function resultFailure(message, code, retryable = false) {
  const err = new fal.FalError(message, 0, { retryable });
  err.code = code;
  return err;
}

// Extensions a viewer has to load a decoder for (Draco, KTX2 / Basis, Meshopt): the bundled viewer fetches that decoder from
// the address of its default settings (README), so a model that requires one is stored but named in the log.
const GLB_COMPRESSED_EXTENSIONS = Object.freeze(['KHR_draco_mesh_compression', 'KHR_texture_basisu', 'EXT_meshopt_compression', 'KHR_meshopt_compression']);
// The JSON chunk of a GLB is some kilobytes (a few hundred for a plain model); a larger one is not a model to show.
const GLB_JSON_MAX_BYTES = 32 * 1024 * 1024;
const GLB_CHUNK_JSON = 0x4e4f534a;

// What the glTF JSON of a GLB points at outside the file: every "uri" that is not a data: URI (images and buffers may name a
// file or an address; the viewer of the person who opens the model would load it), and the compression extensions the
// model requires. Pure: { external: [uri, ...], compressed: [name, ...] }.
function inspectGlbJson(json) {
  const external = [];
  const stack = [json];
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    for (const [key, value] of Object.entries(item)) {
      if (key === 'uri' && typeof value === 'string' && !/^data:/i.test(value.trim())) external.push(value);
      else if (value && typeof value === 'object') stack.push(value);
    }
  }
  const required = Array.isArray(json?.extensionsRequired) ? json.extensionsRequired.map(String) : [];
  return { external, compressed: required.filter((name) => GLB_COMPRESSED_EXTENSIONS.includes(name)) };
}

// A 3D result is only stored when it is a GLB (glTF binary): the first 12 bytes are the magic "glTF", the version 2 and
// the length of the whole file; the JSON chunk behind them is read and must not point at anything outside the file. The
// page shows the model in the browser of whoever opens it, and that viewer loads every address a model names: a model with
// an external image or buffer is refused (MESH_FILE_EXTERNAL), so what the README says about requests holds for every
// stored model. What else comes back (an FBX, an HTML page, a splat) is refused with a stable code.
async function assertGlb(file) {
  const head = await readHead(file, GLB_HEADER_BYTES);
  if (head.length < GLB_HEADER_BYTES || head.toString('ascii', 0, 4) !== 'glTF' || head.readUInt32LE(4) !== 2) {
    throw resultFailure('fal.ai lieferte keine GLB-Datei (die Datei ist kein glTF-Binaerformat). Es wurde nichts gespeichert.', 'MESH_FILE_NOT_GLB');
  }
  const { size } = await fsp.stat(file);
  // a cut-off download is asked for again in the next round
  if (head.readUInt32LE(8) > size) throw resultFailure('Die GLB-Datei von fal.ai ist unvollstaendig angekommen.', 'MESH_FILE_NOT_GLB', true);
  const notGlb = () => resultFailure('fal.ai lieferte keine lesbare GLB-Datei (der JSON-Teil fehlt oder ist defekt). Es wurde nichts gespeichert.', 'MESH_FILE_NOT_GLB');
  const chunk = (await readHead(file, GLB_HEADER_BYTES + 8)).subarray(GLB_HEADER_BYTES);
  if (chunk.length < 8 || chunk.readUInt32LE(4) !== GLB_CHUNK_JSON) throw notGlb();
  const length = chunk.readUInt32LE(0);
  if (length > GLB_JSON_MAX_BYTES || GLB_HEADER_BYTES + 8 + length > size) throw notGlb();
  let json;
  try {
    json = JSON.parse((await readHead(file, GLB_HEADER_BYTES + 8 + length)).subarray(GLB_HEADER_BYTES + 8).toString('utf8'));
  } catch (_) {
    throw notGlb();
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw notGlb();
  const found = inspectGlbJson(json);
  if (found.external.length) {
    throw resultFailure('Das GLB von fal.ai verweist auf Dateien ausserhalb der Datei (Bilder oder Daten ueber eine Adresse). Es wurde nichts gespeichert.', 'MESH_FILE_EXTERNAL');
  }
  return found;
}

// Extension of an image by its first bytes (PNG, JPEG, WebP), or '' for anything else.
function imageExtensionOf(head) {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return '.jpg';
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return '';
}

// Container of a video by its first bytes: '.webm' for an EBML header (WebM; the DocType is not read, Matroska uses the same
// header), '.mp4' for an ISO base media file (the first box is ftyp, or one of the boxes a file may start with, as lib/mcp/uploads.js
// accepts them), '' for anything else. A WebM with an alpha channel (VP9, fal.video_segment) must keep the name .webm.
const MP4_FIRST_BOXES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide']);
function videoExtensionOf(head) {
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return '.webm';
  if (head.length >= 8 && MP4_FIRST_BOXES.has(head.toString('latin1', 4, 8))) return '.mp4';
  return '';
}

// Extension of a downloaded fal result. A video is named by what the file is, not by what the endpoint says: SAM 3 video sends
// application/octet-stream and a URL without a usable extension, and a WebM stored as .mp4 would be wrongly named. What the
// bytes do not decide (and every other kind) follows the content type, then the address (higgsfieldResultExtension).
async function falResultExtension(media, contentType, file) {
  if (media.kind === 'video') {
    try {
      const ext = videoExtensionOf(await readHead(file, 16));
      if (ext) return ext;
    } catch (_) {
      /* the content type decides */
    }
  }
  return higgsfieldResultExtension(media.kind, media.contentType || contentType, media.url);
}

// The preview image of a 3D result (Tripo rendered_image, otherwise thumbnail) as an image asset. The model is the result
// that was paid for: a preview that cannot be fetched or is not an image never fails the job (null: renderModelPreview steps in).
async function saveModelPreview(sessionId, job, preview, dir) {
  if (!preview || !preview.url) return null;
  const temp = path.join(dir, `.fal-${String(job.assetId).replace(/[^A-Za-z0-9_-]/g, '_')}-preview.part`);
  try {
    await fal.downloadToFile(preview.url, temp, { maxBytes: FAL_PREVIEW_MAX_BYTES });
    const ext = imageExtensionOf(await readHead(temp, 16));
    if (!ext) throw new Error('keine PNG-, JPEG- oder WebP-Datei');
    const saved = await store.saveAsset(sessionId, { kind: 'image', buffer: await fsp.readFile(temp), ext, prompt: job.prompt, model: job.model });
    return saved.id;
  } catch (err) {
    console.warn(`[poller] Vorschaubild von ${sessionId}/${job.assetId} konnte nicht gespeichert werden: ${err.message}`);
    return null;
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => {});
  }
}

// The preview image of a 3D result that has none from the provider (SAM 3D renders none, or the render could not be fetched):
// drawn by the app from the stored GLB, in a child process (lib/glb-preview.js), and saved like the provider's image. The model
// is the result that was paid for: a model that cannot be drawn never fails the job, it simply has no preview (null).
async function renderModelPreview(sessionId, job, glbFile) {
  try {
    const png = await glbPreview.renderGlbPreview(glbFile);
    if (!png) return null;
    const saved = await store.saveAsset(sessionId, { kind: 'image', buffer: png, ext: '.png', prompt: job.prompt, model: job.model });
    return saved.id;
  } catch (err) {
    console.warn(`[poller] Gerendertes Vorschaubild von ${sessionId}/${job.assetId} konnte nicht gespeichert werden: ${err.message}`);
    return null;
  }
}

// Downloads the GLB of a 3D result and checks it. The file that comes first is tried first; when it is not a GLB (a model_mesh
// without an extension that is an FBX), the next file that may be one is tried (media.fallbacks) before the job fails. A cut-off
// download or a network problem is not a reason to switch: it is asked for again in the next round. Returns what assertGlb found.
async function fetchGlb(media, temp) {
  const candidates = [media, ...(media.fallbacks || [])];
  let failure = null;
  for (const candidate of candidates) {
    try {
      await fal.downloadToFile(candidate.url, temp, { maxBytes: FAL_MODEL3D_MAX_BYTES });
      return await assertGlb(temp);
    } catch (err) {
      if (!(err instanceof fal.FalError) || err.retryable || !/^MESH_FILE_/.test(String(err.code))) throw err;
      failure = failure || err;
    }
  }
  throw failure;
}

// Whether a stored WebM result has an alpha channel (a cutout of fal.video_segment): the node view then shows a chequerboard behind it.
// Only a WebM is looked at, and a probe that fails (no ffprobe, an unreadable file) just says no: the result is stored in any case.
async function webmHasAlpha(file) {
  try {
    const paths = ffmpeg.binaries();
    if (!paths.available) return false;
    const { stdout } = await ffmpeg.runProcess(paths.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', file], { timeoutMs: 20000 });
    const stream = (JSON.parse(stdout).streams || [])[0];
    return ffmpeg.streamHasAlpha(stream);
  } catch (_) {
    return false;
  }
}

async function handleFalCompleted(sessionId, job, result, media) {
  const dir = store.sessionAssetDir(sessionId);
  await fsp.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.fal-${String(job.assetId).replace(/[^A-Za-z0-9_-]/g, '_')}.part`);
  const isModel = media.kind === 'model3d';
  let downloaded;
  try {
    if (isModel) {
      const checked = await fetchGlb(media, temp);
      if (checked.compressed.length) console.warn(`[poller] 3D-Modell ${sessionId}/${job.assetId} verlangt einen Dekoder (${checked.compressed.join(', ')}); die Anzeige laedt ihn nach (README).`);
    } else {
      downloaded = await fal.downloadToFile(media.url, temp);
    }
    const ext = isModel ? '.glb' : await falResultExtension(media, downloaded.contentType, temp);
    const cost = falJobCost(job, result);
    const seconds = Number(result?.duration);
    const alpha = media.kind === 'video' && ext === '.webm' ? await webmHasAlpha(temp) : false;
    const completedAsset = await store.completeAssetFile(sessionId, job.assetId, temp, {
      cost: cost === null ? undefined : cost,
      costEstimated: cost !== null,
      duration: Number.isFinite(seconds) && seconds > 0 && seconds < 86400 && media.kind !== 'image' && !isModel ? seconds : undefined,
      ext,
      kind: media.kind,
      // a WebM was probed above (true or false); anything else is looked at by the store
      ...(media.kind === 'video' && ext === '.webm' ? { extra: { alpha } } : {})
    });
    // 3D: the first result is the model, the second its preview image: the render of the provider, else one drawn from the GLB
    // (none only when both fail). The cost stays with the model.
    let previewId = null;
    if (isModel) {
      previewId = await saveModelPreview(sessionId, job, media.preview, dir);
      if (!previewId) previewId = await renderModelPreview(sessionId, job, path.join(dir, completedAsset.file));
    }
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
        target.resultAssetIds = previewId ? [completedAsset.id, previewId] : [completedAsset.id];
        if (Number.isFinite(Number(result?.seed))) target.seed = Number(result.seed);
        if (expanded) target.expanded_prompt = expanded;
        if (job.keepResult) target.resultJson = resultJsonText(result);
        if (Number.isFinite(seconds) && seconds > 0 && !isModel) target.duration = seconds;
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
          user: job.user || 'unbekannt',
          ...costs.viaFields(job)
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

// Why a finished 3D job has no GLB, as { error, code } (the code has a translated text in the node view).
function modelFailure(result) {
  const problem = fal.modelProblem(result);
  if (problem === 'splat_only') {
    return { error: 'fal.ai lieferte nur eine Gaussian-Splat-Datei (.ply), kein GLB. Es wurde nichts gespeichert.', code: 'MESH_SPLAT_ONLY' };
  }
  if (problem === 'other_format') {
    return { error: 'fal.ai lieferte das Modell nur in einem anderen Format als GLB. Es wurde nichts gespeichert.', code: 'MESH_NO_GLB' };
  }
  return { error: 'fal.ai meldet fertig, lieferte aber kein GLB im Ergebnis.', code: 'MESH_NO_GLB' };
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
  const resultKind = job.resultKind || job.kind || 'auto';
  const media = fal.extractMedia(result, resultKind);
  if (!media) {
    terminalHandled.add(key);
    await handleFailed(sessionId, job, resultKind === 'model3d' ? { ...modelFailure(result), operatorCost: falJobCost(job, result) } : { error: 'fal.ai meldet fertig, lieferte aber kein Medium im Ergebnis.' });
    return;
  }
  try {
    await handleFalCompleted(sessionId, job, result, media);
    terminalHandled.add(key);
  } catch (err) {
    if (err instanceof fal.FalError && !err.retryable) {
      terminalHandled.add(key);
      // a result file that is no usable GLB: the job is finished at fal, so it is billed
      await handleFailed(sessionId, job, { error: falFailureMessage(err), code: err.code, ...(media.kind === 'model3d' && /^MESH_FILE_/.test(String(err.code)) ? { operatorCost: falJobCost(job, result) } : {}) });
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
  inspectGlbJson,
  higgsfieldResultExtension,
  videoExtensionOf,
  falResultExtension,
  webmHasAlpha,
  appendJobUpdateMessage,
  POLL_INTERVAL_MS
};
