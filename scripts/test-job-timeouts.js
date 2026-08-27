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
    await store.deleteSession(session.id);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
