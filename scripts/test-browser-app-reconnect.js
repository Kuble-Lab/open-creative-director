'use strict';
const assert = require('node:assert/strict');
const { runBrowserTest, ready, status, waitFor } = require('./support/browser');

runBrowserTest('test-browser-app-reconnect.js', async ({ page, workflow, open, engine, gates, streams, setDisconnected }) => {
  await page.evaluateOnNewDocument(() => {
    const NativeEventSource = window.EventSource;
    window.__streamErrors = 0;
    window.EventSource = class extends NativeEventSource {
      constructor(...args) {
        super(...args);
        this.addEventListener('error', () => { window.__streamErrors += 1; });
      }
    };
  });
  const id = await workflow();
  await open(id);
  await ready(page);
  await page.click('.nv-apprun');
  await status(page, 'running');
  await waitFor(() => gates.has('gate'), 'controlled node starts');
  const runId = engine.activeRun(id).runId;
  setDisconnected(true);
  await page.setOfflineMode(true);
  // Force the real EventSource down even when Chrome keeps an established TCP connection alive.
  for (const stream of streams) stream.destroy();
  await page.waitForFunction(() => window.__streamErrors > 0);
  gates.get('gate').finish('Synthetic reconnect failure');
  const record = await engine.whenFinished(id, runId);
  assert.equal(record.status, 'failed');
  assert.equal(record.cost.usd, 1.25);
  await page.setOfflineMode(false);
  await status(page, 'failed');
  await page.waitForFunction(() => document.querySelector('.nv-appstatus')?.textContent.includes('Synthetic reconnect failure'));
  assert.match(await page.$eval('.nv-appstatus-cost', element => element.textContent), /1[.,]25/);
  await ready(page);
  assert(await page.$eval('.nv-appcancel', element => element.classList.contains('hidden')));
  setDisconnected(false);
}).catch(error => { console.error(error); process.exitCode = 1; });
