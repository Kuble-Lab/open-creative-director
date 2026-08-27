'use strict';

// Der Poller las frueher bei JEDEM Durchlauf (alle 6 s) jede Session komplett neu ein.
// Bei vielen oder grossen Sessions kostet das dauerhaft CPU, ohne dass sich etwas
// aendert. Sessions ohne offene Jobs werden jetzt uebersprungen, solange ihre Datei
// (mtime + Groesse) unveraendert ist.

const assert = require('node:assert/strict');

// pollOnce() steigt ohne konfigurierten Anbieter sofort aus. Der Platzhalter-Key
// aktiviert nur den Durchlauf - der Testjob ist ein Higgsfield-Job und wird ohne
// verbundenes Higgsfield uebersprungen, es geht also kein Aufruf nach draussen.
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-kein-echter-aufruf';

const store = require('../lib/store');
const poller = require('../lib/poller');

async function main() {
  const session = await store.createSession();
  const originalRead = store.readSession;
  let reads = 0;
  store.readSession = async (id) => {
    if (id === session.id) reads += 1;
    return originalRead(id);
  };

  try {
    await poller.pollOnce();
    const afterFirst = reads;
    assert.ok(afterFirst >= 1, 'die Session muss beim ersten Durchlauf gelesen werden');

    await poller.pollOnce();
    assert.equal(reads, afterFirst, 'unveraenderte Session ohne offene Jobs darf nicht erneut gelesen werden');

    // Neuer offener Job: die Datei aendert sich, der Poller muss sie wieder lesen.
    const asset = await store.reserveAsset(session.id, { kind: 'video', ext: '.mp4', prompt: 'Scan-Test' });
    await store.mutateSession(session.id, (saved) => {
      saved.jobs.push({
        jobId: `scan-${Date.now()}`,
        assetId: asset.id,
        file: asset.file,
        status: 'pending',
        source: 'higgsfield',
        provider: 'higgsfield',
        kind: 'video',
        prompt: 'Scan-Test',
        createdAt: new Date().toISOString(),
        submittedAt: new Date().toISOString(),
        // Zeitlimit weit in der Zukunft: der Job darf im Test nicht anschlagen.
        timeoutAt: Date.now() + 3600000,
        cost: 0,
        error: null
      });
    });

    await poller.pollOnce();
    assert.ok(reads > afterFirst, 'nach einer Aenderung muss die Session wieder gelesen werden');

    console.log(`OK: Session-Scan-Cache greift (${reads} Lesevorgaenge statt 3)`);
  } finally {
    store.readSession = originalRead;
    await store.deleteSession(session.id);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
