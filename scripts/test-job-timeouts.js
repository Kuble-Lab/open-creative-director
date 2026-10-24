'use strict';

// Frueher hatten nur Higgsfield-Jobs ein Zeitlimit (timeoutAt). Ein Render-Node- oder
// OpenRouter-Job, den der Anbieter nie abschliesst, blieb dadurch fuer immer offen:
// alle 6 Sekunden eine Statusabfrage, und der Nutzer sah dauerhaft einen laufenden
// Job. Jetzt hat jede Quelle eine Frist, die auch fuer Alt-Jobs ohne timeoutAt greift.

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-kein-echter-aufruf';

const assert = require('node:assert/strict');

const store = require('../lib/store');
const rendernode = require('../lib/rendernode');
const poller = require('../lib/poller');
const higgsfield = require('../lib/higgsfield');

const STUNDE = 60 * 60 * 1000;

async function jobAnlegen(sessionId, { source, alterMs, timeoutAt = null }) {
  const asset = await store.reserveAsset(sessionId, { kind: 'video', ext: '.mp4', prompt: `Timeout-Test ${source}` });
  const ts = new Date(Date.now() - alterMs).toISOString();
  await store.mutateSession(sessionId, (saved) => {
    saved.jobs.push({
      jobId: `timeout-${source}-${saved.jobs.length}`,
      assetId: asset.id,
      file: asset.file,
      status: 'pending',
      source,
      provider: source === 'higgsfield' ? 'higgsfield' : null,
      kind: 'video',
      prompt: `Timeout-Test ${source}`,
      createdAt: ts,
      submittedAt: ts,
      timeoutAt,
      cost: 0,
      error: null
    });
  });
  return asset.id;
}

function jobLesen(session, assetId) {
  return session.jobs.find((job) => job.assetId === assetId);
}

async function main() {
  const session = await store.createSession();
  const originalListNodes = rendernode.listConfiguredNodes;
  const originalJobStatus = rendernode.jobStatus;
  // Ohne konfigurierten Node ueberspringt der Poller Render-Jobs; die Statusabfrage
  // darf im Test nicht wirklich stattfinden.
  rendernode.listConfiguredNodes = () => [{ id: 'node-test', name: 'Test-Node' }];
  rendernode.jobStatus = async () => {
    throw new Error('Statusabfrage haette nicht stattfinden duerfen - der Job ist ueberfaellig');
  };

  try {
    // Alt-Job ohne timeoutAt, 3 Stunden alt: ueber der Render-Frist von 2 Stunden.
    const alterRenderJob = await jobAnlegen(session.id, { source: 'rendernode', alterMs: 3 * STUNDE });
    // Frischer Render-Job: muss offen bleiben.
    const frischerRenderJob = await jobAnlegen(session.id, { source: 'rendernode', alterMs: 60000 });
    // OpenRouter-Job, 2 Stunden alt: ueber der Frist von 1 Stunde.
    const alterVideoJob = await jobAnlegen(session.id, { source: null, alterMs: 2 * STUNDE });

    await poller.pollOnce();

    const nachher = await store.readSession(session.id);
    const render = jobLesen(nachher, alterRenderJob);
    const frisch = jobLesen(nachher, frischerRenderJob);
    const video = jobLesen(nachher, alterVideoJob);

    assert.equal(render.status, 'failed', 'ueberfaelliger Render-Job muss beendet werden');
    assert.match(render.error, /Render-Job hat nach 2 Stunden das Zeitlimit erreicht/);
    assert.equal(video.status, 'failed', 'ueberfaelliger OpenRouter-Job muss beendet werden');
    assert.match(video.error, /Video-Job hat nach einer Stunde das Zeitlimit erreicht/);
    assert.equal(frisch.status, 'pending', 'ein frischer Job darf nicht abgebrochen werden');

    const meldungen = nachher.messages.filter((m) => m.type === 'job_update');
    assert.equal(meldungen.length, 2, 'genau eine sichtbare Meldung je beendetem Job');

    console.log('OK: jede Job-Quelle hat ein Zeitlimit, auch ohne timeoutAt');
  } finally {
    rendernode.listConfiguredNodes = originalListNodes;
    rendernode.jobStatus = originalJobStatus;
    await store.mutateSession(session.id, (saved) => { for (const job of saved.jobs) job.status = 'cancelled'; });
    await store.deleteSession(session.id);
  }
  await higgsfieldFaelle();
  console.log('test-job-timeouts.js: ok');
}

// Higgsfield: vor dem Zeitlimit eine letzte Statusabfrage (ein inzwischen fertiger Job wird uebernommen), die Meldung
// nennt die Frist des Jobs, und ein fertiger Job, dessen Download einmal scheitert, wird im naechsten Durchlauf geholt.
async function higgsfieldFaelle() {
  const session = await store.createSession();
  const original = { status: higgsfield.status, mcpCall: higgsfield.mcpCall, downloadResult: higgsfield.downloadResult };
  const statusById = new Map();
  let downloadFehler = 0;
  let downloadFehlerJob = '';
  higgsfield.status = () => ({ connected: true });
  higgsfield.mcpCall = async (name, args) => {
    assert.equal(name, 'job_status');
    const status = statusById.get(args.jobId) || 'in_progress';
    return status === 'completed'
      ? `Job ${args.jobId}: completed\nhttps://cdn.example/${args.jobId}.mp4`
      : `Job ${args.jobId}: ${status}`;
  };
  higgsfield.downloadResult = async (url) => {
    if (downloadFehler > 0 && url.includes(downloadFehlerJob)) {
      downloadFehler -= 1;
      throw new Error('fetch failed');
    }
    return { buffer: Buffer.from(`video ${url}`), contentType: 'video/mp4', url };
  };
  const MINUTE = 60 * 1000;
  try {
    const spaetFertig = await jobAnlegen(session.id, { source: 'higgsfield', alterMs: 30 * MINUTE, timeoutAt: Date.now() - 5 * MINUTE });
    const nochAmRechnen = await jobAnlegen(session.id, { source: 'higgsfield', alterMs: 30 * MINUTE, timeoutAt: Date.now() - 5 * MINUTE });
    const downloadHakt = await jobAnlegen(session.id, { source: 'higgsfield', alterMs: MINUTE, timeoutAt: Date.now() + 20 * MINUTE });
    const vorher = await store.readSession(session.id);
    statusById.set(jobLesen(vorher, spaetFertig).jobId, 'completed');
    statusById.set(jobLesen(vorher, downloadHakt).jobId, 'completed');
    downloadFehler = 1;
    downloadFehlerJob = jobLesen(vorher, downloadHakt).jobId;

    await poller.pollOnce();
    let nachher = await store.readSession(session.id);
    assert.equal(jobLesen(nachher, spaetFertig).status, 'completed', 'ein inzwischen fertiger Job wird trotz Frist uebernommen');
    const laeuft = jobLesen(nachher, nochAmRechnen);
    assert.equal(laeuft.status, 'failed');
    assert.match(laeuft.error, /Higgsfield-Job hat nach 25 Minuten das Zeitlimit erreicht/, 'die Meldung nennt die Frist des Jobs');
    assert.match(laeuft.error, /Higgsfield-Bibliothek/);
    assert.equal(jobLesen(nachher, downloadHakt).status, 'pending', 'ein gescheiterter Download laesst den Job offen');

    await poller.pollOnce();
    nachher = await store.readSession(session.id);
    assert.equal(jobLesen(nachher, downloadHakt).status, 'completed', 'der naechste Durchlauf holt das Ergebnis');
    console.log('OK: Higgsfield-Frist mit letzter Abfrage und wiederholtem Download');
  } finally {
    Object.assign(higgsfield, original);
    await store.mutateSession(session.id, (saved) => { for (const job of saved.jobs) if (job.status === 'pending') job.status = 'cancelled'; });
    await store.deleteSession(session.id);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
