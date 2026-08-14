'use strict';

const fsp = require('fs/promises');
const path = require('path');

const { loadEnv, loadConfig } = require('../lib/config');
const store = require('../lib/store');
const costs = require('../lib/costs');

async function main() {
  loadEnv();
  store.ensureDirs();

  try {
    await fsp.access(costs.COSTS_FILE);
    console.log('Backfill uebersprungen: data/costs.jsonl existiert bereits.');
    return;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const config = loadConfig();
  const { sessions } = await store.listSessions({ limit: Infinity });
  const entries = [];

  for (const meta of sessions) {
    let session;
    try {
      session = await store.readSession(meta.id);
    } catch (_) {
      continue;
    }
    const jobsByAsset = new Map((session.jobs || []).map((job) => [job.assetId, job]));
    const ledger = await store.readLedger(meta.id);
    for (const asset of ledger) {
      if (!(typeof asset.cost === 'number' && asset.cost > 0)) continue;
      const job = jobsByAsset.get(asset.id);
      const type = asset.kind === 'video' ? 'video' : 'image';
      entries.push({
        ts: job?.completedAt || job?.submittedAt || asset.createdAt || session.updatedAt || session.createdAt,
        sessionId: session.id,
        assetId: asset.id,
        type,
        model: job?.model || (type === 'video' ? config.videoModel : config.imageModel),
        cost: asset.cost,
        user: 'unbekannt'
      });
    }
  }

  entries.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  await fsp.mkdir(path.dirname(costs.COSTS_FILE), { recursive: true });
  const body = entries.map((entry) => JSON.stringify(entry)).join('\n');
  await fsp.writeFile(costs.COSTS_FILE, body ? `${body}\n` : '', { encoding: 'utf8', flag: 'wx' });
  console.log(`Backfill abgeschlossen: ${entries.length} Kosten-Eintraege geschrieben.`);
}

main().catch((err) => {
  console.error(`Backfill fehlgeschlagen: ${err.message}`);
  process.exitCode = 1;
});
