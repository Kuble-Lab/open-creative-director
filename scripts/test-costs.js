'use strict';

const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { recordCost, readCosts, summariseCosts } = require('../lib/costs');

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} ist nicht ${expected}`);
}

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vcd-costs-'));
  const file = path.join(dir, 'costs.jsonl');
  const fixtures = [
    { ts: '2026-07-31T21:30:00.000Z', sessionId: 's-juli', type: 'brain', model: 'brain-a', cost: 0.2, user: 'a@example.com' },
    { ts: '2026-07-31T22:30:00.000Z', sessionId: 's-august', assetId: 'img-001', type: 'image', model: 'image-a', cost: 0.01, user: 'a@example.com' },
    { ts: '2026-08-09T21:59:00.000Z', sessionId: 's-august', assetId: 'vid-001', type: 'video', model: 'video-a', cost: 1.25, user: 'b@example.com' },
    { ts: '2026-08-09T22:01:00.000Z', sessionId: 's-woche', type: 'brain', model: 'brain-a', cost: 0.04, user: 'b@example.com' },
    { ts: '2026-08-11T08:00:00.000Z', sessionId: 's-woche', assetId: 'vid-002', type: 'motion', model: 'hyperframes/rendernode', cost: 0, user: 'b@example.com' }
  ];

  for (const fixture of fixtures) await recordCost(fixture, file);
  await fsp.appendFile(file, '{kaputte zeile}\n', 'utf8');
  const read = await readCosts(file);
  assert.equal(read.length, fixtures.length);

  const summary = summariseCosts(read, {
    now: new Date('2026-08-11T12:00:00.000Z'),
    sessionTitles: { 's-august': 'August-Kampagne', 's-woche': 'Wochenprojekt' }
  });
  close(summary.total, 1.5);
  close(summary.currentMonth, 1.3);
  close(summary.currentWeek, 0.04);
  assert.deepEqual(summary.byMonth.map((row) => row.month), ['2026-08', '2026-07']);
  assert.deepEqual(summary.byWeek.map((row) => row.week), ['2026-KW33', '2026-KW32', '2026-KW31']);
  assert.equal(summary.byType.find((row) => row.type === 'motion').count, 1);
  assert.equal(summary.bySession[0].title, 'August-Kampagne');
  await fsp.rm(dir, { recursive: true, force: true });
  console.log('costs.js: record, read und Summary mit Europe/Zurich sind korrekt.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
