'use strict';
const assert = require('node:assert/strict');
const { runBrowserTest, ready, status, waitFor } = require('./support/browser');

runBrowserTest('test-browser-app-approval.js', async ({ page, workflow, open, calls, gates, engine }) => {
  const id = await workflow({ approval: true });
  await open(id);
  await ready(page);
  await page.click('.nv-apprun');
  await status(page, 'completed');
  await page.waitForSelector('.nv-appswitches [role=switch]:not([disabled])', { visible: true });
  assert.deepEqual(calls, ['preview'], 'approval holds back the second step');
  await ready(page);
  assert.equal(await page.$eval('.nv-apprun-label', element => element.textContent.trim()), 'Approve and finish', 'the final step requires explicit approval');
  await page.click('.nv-apprun');
  await waitFor(() => gates.has('gate'), 'approved step starts');
  await status(page, 'running');
  const runId = engine.activeRun(id).runId;
  gates.get('gate').finish();
  assert.equal((await engine.whenFinished(id, runId)).status, 'completed');
  await status(page, 'completed');
  await ready(page);
  assert.deepEqual(calls, ['preview', 'gate', 'after'], 'each step executes exactly once');
  assert(await page.$eval('.nv-appcancel', element => element.classList.contains('hidden')));
  await page.waitForFunction(() => document.querySelector('.nv-appresults')?.textContent.includes('Initial brief'));
}).catch(error => { console.error(error); process.exitCode = 1; });
