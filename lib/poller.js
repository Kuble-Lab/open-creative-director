'use strict';

const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const store = require('./store');
const or = require('./openrouter');
const rendernode = require('./rendernode');
const costs = require('./costs');
const publicrefs = require('./publicrefs');
const higgsfield = require('./higgsfield');

const POLL_INTERVAL_MS = 6000;
const OPEN_STATES = new Set(['pending', 'running', 'in_progress', 'queued', 'processing']);
const execFileAsync = promisify(execFile);

let running = false;
const inFlight = new Set();

function isOpen(job) {
  return OPEN_STATES.has(String(job.status || 'pending'));
}

async function extractVideoFrames(videoPath) {
  const probe = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 }
  );
  const duration = Number.parseFloat(String(probe.stdout).trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Videodauer konnte nicht ermittelt werden');

  const frames = [];
  for (const fraction of [0.1, 0.5, 0.95]) {
    const timestamp = Math.max(0, duration * fraction).toFixed(3);
    const result = await execFileAsync(
      'ffmpeg',
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
      { encoding: 'buffer', maxBuffer: 12 * 1024 * 1024 }
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
    let frames = [];
    try {
      frames = await extractVideoFrames(path.join(store.sessionAssetDir(sessionId), completedAsset.file));
    } catch (err) {
      console.warn(`[poller] Frames fuer ${sessionId}/${job.assetId} konnten nicht extrahiert werden: ${err.message}`);
    }
    await store.mutateSession(sessionId, (session) => {
      const target = session.jobs.find((j) => j.jobId === job.jobId);
      if (target) {
        target.status = 'completed';
        target.cost = cost;
        target.completedAt = completedAt;
        if (!isRenderNode && Array.isArray(info?.unsigned_urls)) target.unsignedUrls = info.unsigned_urls;
        delete target.publicRefFiles;
      }
      session.messages.push({
        role: 'user',
        hidden: true,
        content: `[System] Video-Job ${job.assetId} ist fertig und wurde gespeichert.`,
        ts: completedAt
      });
      if (frames.length === 3) {
        session.messages.push({
          role: 'user',
          hidden: true,
          content: [
            {
              type: 'text',
              text: `[System] Automatische Frames aus ${job.assetId} (Anfang/Mitte/Ende) zur Konsistenz-Pruefung:`
            },
            ...frames.map((frame) => ({
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${frame.toString('base64')}` }
            }))
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
    console.log(`[poller] ${sessionId}/${job.assetId} fertig.`);
  } finally {
    await cleanupJobRefs(job);
  }
}

function higgsfieldResultExtension(kind, contentType, url) {
  const mime = String(contentType || '').toLowerCase().split(';')[0].trim();
  const byMime = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/webm': '.webm'
  };
  if (byMime[mime]) return byMime[mime];
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm'].includes(ext)) return ext;
  } catch (_) {
    /* Fallback nach Asset-Art. */
  }
  return kind === 'image' ? '.png' : '.mp4';
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
      kind: job.kind === 'image' ? 'image' : 'video',
      buffer: result.buffer,
      ext: higgsfieldResultExtension(job.kind, result.contentType, result.url),
      prompt: job.prompt,
      cost: 0
    }));
  }

  const completedAt = new Date().toISOString();
  await store.mutateSession(sessionId, (session) => {
    const target = session.jobs.find((entry) => entry.jobId === job.jobId);
    if (target) {
      target.status = 'completed';
      target.file = completedAsset.file;
      target.cost = 0;
      target.completedAt = completedAt;
      target.resultAssetIds = assets.map((asset) => asset.id);
      target.resultUrls = urls;
    }
    session.messages.push({
      role: 'user',
      hidden: true,
      content:
        `[System] Higgsfield-${job.kind === 'image' ? 'Bild' : 'Video'}-Job ${job.assetId} ist fertig. ` +
        `Gespeicherte Session-Assets: ${assets.map((asset) => asset.id).join(', ')}. Abrechnung in Higgsfield-Credits.`,
      ts: completedAt
    });
  });
  console.log(`[poller] Higgsfield ${sessionId}/${job.assetId} fertig (${assets.length} Ergebnis(se)).`);
}

async function handleFailed(sessionId, job, info) {
  try {
    const message = String(info?.error?.message || info?.error || 'unbekannter Fehler').slice(0, 500);
    await store.mutateSession(sessionId, (session) => {
      const target = session.jobs.find((j) => j.jobId === job.jobId);
      if (target) {
        target.status = 'failed';
        target.error = message;
        target.completedAt = new Date().toISOString();
        delete target.publicRefFiles;
      }
      session.messages.push({
        role: 'user',
        hidden: true,
        content: `[System] Video-Job ${job.assetId} ist fehlgeschlagen: ${message}`,
        ts: new Date().toISOString()
      });
    });
    console.warn(`[poller] ${sessionId}/${job.assetId} fehlgeschlagen: ${message}`);
  } finally {
    await cleanupJobRefs(job);
  }
}

async function handleHiggsfieldFailed(sessionId, job, info) {
  const status = String(info?.status || 'failed').toLowerCase();
  const messages = {
    ip_detected: 'Higgsfield hat den Auftrag wegen einer erkannten IP-/Markenreferenz abgelehnt.',
    nsfw: 'Higgsfield hat den Auftrag durch den Inhaltsfilter abgelehnt.',
    failed: 'Higgsfield konnte den Auftrag nicht abschliessen.',
    timeout: 'Higgsfield-Job hat nach 10 Minuten das Zeitlimit erreicht.'
  };
  const detail = String(info?.text || '').trim();
  return handleFailed(sessionId, job, {
    error: detail ? `${messages[status] || messages.failed} ${detail}`.slice(0, 500) : messages[status] || messages.failed
  });
}

async function pollOnce() {
  if (running || (!or.hasKey() && rendernode.listConfiguredNodes().length === 0 && !higgsfield.status().connected)) return;
  running = true;
  try {
    const { sessions } = await store.listSessions({ limit: Infinity });
    for (const meta of sessions) {
      let session;
      try {
        session = await store.readSession(meta.id);
      } catch (_) {
        continue;
      }
      for (const job of session.jobs.filter(isOpen)) {
        const isRenderNode = job.source === 'rendernode';
        const isHiggsfield = job.source === 'higgsfield' || job.provider === 'higgsfield';
        if (isHiggsfield && !higgsfield.status().connected) continue;
        if (!isHiggsfield && (isRenderNode ? rendernode.listConfiguredNodes().length === 0 : !or.hasKey())) continue;
        const key = `${meta.id}:${job.jobId}`;
        if (inFlight.has(key)) continue;
        inFlight.add(key);
        try {
          if (isHiggsfield && Number(job.timeoutAt) > 0 && Date.now() >= Number(job.timeoutAt)) {
            await handleHiggsfieldFailed(meta.id, job, { status: 'timeout' });
            continue;
          }
          const info = isHiggsfield
            ? higgsfield.parseJobStatus(await higgsfield.mcpCall('job_status', { jobId: job.jobId }))
            : isRenderNode
              ? await rendernode.jobStatus(job.jobId, job.renderNodeId)
              : await or.getVideoJob(job.jobId);
          const status = String(info?.status || 'pending');
          if (status === 'completed') {
            if (isHiggsfield) await handleHiggsfieldCompleted(meta.id, job, info);
            else await handleCompleted(meta.id, job, info);
          } else if (status === 'failed' || status === 'cancelled' || status === 'ip_detected' || status === 'nsfw') {
            if (isHiggsfield) await handleHiggsfieldFailed(meta.id, job, info);
            else await handleFailed(meta.id, job, info);
          } else if (status !== job.status) {
            await store.mutateSession(meta.id, (s) => {
              const target = s.jobs.find((j) => j.jobId === job.jobId);
              if (target) target.status = status;
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

module.exports = { start, pollOnce, extractVideoFrames, POLL_INTERVAL_MS };
