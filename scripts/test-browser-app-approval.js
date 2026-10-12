'use strict';
const assert = require('node:assert/strict');
const { runBrowserTest, ready, status, waitFor } = require('./support/browser');

runBrowserTest('test-browser-app-approval.js', async ({ page, workflow, open, calls, gates, engine, events, streams, setDisconnected }) => {
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

  let previewResponse = null;
  page.on('response', async (response) => {
    if (!response.url().endsWith('/card-preview')) return;
    const body = await response.json().catch(() => null);
    previewResponse = { status: response.status(), code: body?.code, formats: body?.previews?.map((item) => item.format), request: response.request().postData() };
  });
  const cardId = await workflow({ cards: true });
  await open(cardId);
  await ready(page);
  await page.click('.nv-apprun');
  await status(page, 'completed');
  await page.waitForFunction(() => document.querySelectorAll('.nv-cardpreview iframe').length === 3);
  const frames = await page.$$('.nv-cardpreview iframe');
  for (const handle of frames) {
    assert.equal(await handle.evaluate((element) => element.getAttribute('sandbox')), '');
    const frame = await handle.contentFrame();
    await frame.waitForSelector('.eline');
    await frame.evaluate(() => document.fonts.ready);
    assert.equal((await frame.$$('script')).length, 0);
    const font = await frame.$eval('.eline', (element) => getComputedStyle(element).fontFamily);
    assert.match(font, /Montserrat/);
    assert.equal(await frame.evaluate(() => document.fonts.check('700 40px Montserrat')), true);
    assert.equal(await frame.evaluate(() => { try { return !!parent.document; } catch (_) { return false; } }), false, 'opaque sandbox origin');
  }
  await page.click('.nv-cardpreview-controls button:first-child');
  const input = await page.$('.nv-apptexts input');
  await page.waitForFunction(() => !document.querySelector('.nv-apptexts input')?.disabled);
  await input.evaluate((element) => { element.focus(); element.select(); });
  await input.type('Live corrected title');
  try {
    assert.equal(await input.evaluate((element) => element.value), 'Live corrected title', 'typing replaces the whole title');
    assert.equal(await input.evaluate((element) => element.getAttribute('aria-invalid')), 'false');
    await page.waitForFunction(() => [...document.querySelectorAll('.nv-cardpreview iframe')].every((frame) => frame.srcdoc.includes('Live') && frame.srcdoc.includes('corrected')) && document.querySelectorAll('.nv-cardpreview iframe').length === 3);
  } catch (error) {
    console.error('Card preview diagnostics:', { previewResponse, ui: await page.evaluate(() => ({
      value: document.querySelector('.nv-apptexts input')?.value,
      invalid: document.querySelector('.nv-apptexts input')?.getAttribute('aria-invalid'),
      status: document.querySelector('.nv-cardpreview [role=status]')?.textContent,
      section: document.querySelector('.nv-cardpreview-controls [aria-pressed=true]')?.textContent,
      frames: document.querySelectorAll('.nv-cardpreview iframe').length
    })) });
    throw error;
  }
  for (const reconnect of [false, true]) {
    await page.$eval('.nv-cardpreview', (element) => { element.dataset.beforeRefresh = 'true'; });
    if (reconnect) {
      setDisconnected(true);
      for (const stream of streams) stream.destroy();
    } else events.emit(cardId, { type: 'results_changed' });
    await page.waitForFunction(() => document.querySelector('.nv-cardpreview') && !document.querySelector('.nv-cardpreview').dataset.beforeRefresh && document.querySelectorAll('.nv-cardpreview iframe').length === 3);
    assert.equal(await page.$eval('.nv-cardpreview-controls button:first-child', (element) => element.getAttribute('aria-pressed')), 'true', 'title remains selected after refresh/reconnect');
    assert.equal(await page.$eval('.nv-apptexts input', (element) => element.value), 'Live corrected title');
    assert.ok(await page.$$eval('.nv-cardpreview iframe', (items) => items.every((frame) => frame.srcdoc.includes('Live') && frame.srcdoc.includes('corrected'))));
    if (reconnect) setDisconnected(false);
  }
  assert.deepEqual(calls.slice(-1), ['card-plan'], 'preview never starts a paid step or render');
  for (const width of [1200, 390]) {
    await page.setViewport({ width, height: 900 });
    const boxes = await page.$$eval('.nv-cardpreview-grid figure', (items) => items.map((item) => { const r = item.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width }; }));
    assert.equal(boxes.length, 3);
    assert.ok(boxes.every((box) => box.width > 0 && box.x + box.width <= width));
    if (width === 390) assert.ok(boxes[1].y > boxes[0].y, 'mobile previews stack');
    else assert.equal(boxes[1].y, boxes[0].y, 'desktop previews sit side by side');
  }
}).catch(error => { console.error(error); process.exitCode = 1; });
