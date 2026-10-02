'use strict';

// Regression: Higgsfield kann fuer einen neuen Auftrag dieselbe Job-ID liefern wie
// fuer einen vorherigen (die ID wird aus einer TEXT-Antwort geparst). Wer den Job dann
// ueber die jobId sucht, trifft den falschen; der echte bleibt offen und haengt alle
// 6 Sekunden zwei neue Nachrichten an. Jobs werden deshalb ueber die assetId gefunden.

const assert = require('node:assert/strict');

const store = require('../lib/store');
const { handleFailed } = require('../lib/poller');

async function main() {
  const session = await store.createSession();
  try {
    const first = await store.reserveAsset(session.id, { kind: 'video', ext: '.mp4', prompt: 'erster Job' });
    const second = await store.reserveAsset(session.id, { kind: 'video', ext: '.mp4', prompt: 'zweiter Job' });
    const sharedJobId = `dup-${Date.now()}`;
    const base = {
      jobId: sharedJobId,
      status: 'pending',
      source: 'higgsfield',
      provider: 'higgsfield',
      kind: 'video',
      createdAt: new Date(Date.now() - 700000).toISOString(),
      submittedAt: new Date(Date.now() - 700000).toISOString(),
      startedAt: null,
      cost: 0,
      error: null
    };
    await store.mutateSession(session.id, (saved) => {
      saved.jobs.push({ ...base, assetId: first.id, file: first.file, prompt: 'erster Job' });
      saved.jobs.push({ ...base, assetId: second.id, file: second.file, prompt: 'zweiter Job' });
    });

    const before = (await store.readSession(session.id)).messages.length;
    const failing = (await store.readSession(session.id)).jobs.find((job) => job.assetId === second.id);
    await handleFailed(session.id, failing, { error: 'Higgsfield-Job hat nach 10 Minuten das Zeitlimit erreicht.' });

    const after = await store.readSession(session.id);
    const firstJob = after.jobs.find((job) => job.assetId === first.id);
    const secondJob = after.jobs.find((job) => job.assetId === second.id);

    assert.equal(secondJob.status, 'failed', 'der gemeldete Job muss failed sein');
    assert.equal(firstJob.status, 'pending', 'der fremde Job mit gleicher jobId darf nicht angefasst werden');
    assert.equal(after.messages.length - before, 2, 'genau eine sichtbare und eine versteckte Nachricht');

    // Zweiter Aufruf (naechster Poll-Durchlauf): darf nichts mehr anhaengen.
    await handleFailed(session.id, failing, { error: 'Higgsfield-Job hat nach 10 Minuten das Zeitlimit erreicht.' });
    const repeated = await store.readSession(session.id);
    assert.equal(repeated.messages.length, after.messages.length, 'keine Wiederholung bei bereits terminalem Job');

    console.log('OK: doppelte Job-IDs trennen sauber, keine Nachrichtenschleife');
  } finally {
    await store.deleteSession(session.id);
  }
  console.log('test-duplicate-job-ids.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
